// ============================================================
// Kaguya - main process
// 役割:
//   - config/*.json の読み込み
//   - プロジェクトの env.bat を解析して環境変数プレビューを作る
//   - 起動時: cmd.exe 経由で env.bat を実行 → bat が Houdini を exec
//     (動的変数 = bat / 静的変数 = packages の二層構造)
// ============================================================

const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const os = require("os");
const builder = require("./builder");

// ------------------------------------------------------------
// ルートディレクトリの解決
//   dev:       このファイルのあるフォルダ
//   portable:  exe が置かれているフォルダ (electron-builder portable)
//   installed: exe と同階層
// config / projects / packages_common / icons は常に ROOT 直下に置く。
// ------------------------------------------------------------
// Windows タスクバーのアプリ識別子を固定する。
// これが無いと dev/packaged でタスクバー上の同一性が揺れる。
app.setAppUserModelId("dev.kurama.kaguya");

const ROOT =
  process.env.PORTABLE_EXECUTABLE_DIR ||
  (app.isPackaged ? path.dirname(process.execPath) : __dirname);

const CONFIG_DIR = path.join(ROOT, "config");

// ---------- JSON ユーティリティ ----------
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

// 壊れた設定ファイルで UI ごと死なないための安全版。
// (例: exe パスを "C:\Program Files\..." とバックスラッシュで書くと
//  \P が不正エスケープになり JSON.parse が例外を投げる)
function readJsonSafe(p, fallback, errors) {
  try {
    return readJson(p);
  } catch (e) {
    errors.push(`${path.basename(p)}: ${e.message} — use forward slashes (C:/...) in paths`);
    return fallback;
  }
}

function loadConfig() {
  const errors = [];
  const projects = readJsonSafe(path.join(CONFIG_DIR, "projects.json"), [], errors);
  const apps = readJsonSafe(path.join(CONFIG_DIR, "apps.json"), [], errors);
  // アイコンパスを絶対パス(file://用)に解決
  const resolveIcon = (rel) =>
    rel ? "file://" + path.join(ROOT, rel).replace(/\\/g, "/") : null;
  projects.forEach((p) => (p.iconUrl = resolveIcon(p.icon)));
  apps.forEach((a) => (a.iconUrl = resolveIcon(a.icon)));
  return { root: ROOT, projects, apps, platform: process.platform, configErrors: errors };
}

function loadSettings() {
  const p = path.join(CONFIG_DIR, "settings.json");
  const defaults = { defaultProjectRoot: "", author: "", tempDir: "", anonymousStatistics: null };
  if (!fs.existsSync(p)) return defaults;
  try {
    return { ...defaults, ...readJson(p) };
  } catch {
    return defaults;
  }
}

function loadTemplates() {
  const dir = path.join(CONFIG_DIR, "templates");
  if (!fs.existsSync(dir)) return [{ name: "default", dirs: ["hip", "packages"], extra_env: [] }];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      try {
        return readJson(path.join(dir, f));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ------------------------------------------------------------
// env.bat の解析
//   `set VAR=value` 行を上から順に評価し、%VAR% を展開して
//   「bat 層で確定する変数」の一覧を作る。プレビュー用途。
//   (実際の起動時は cmd.exe が本物の bat を実行するので、
//    ここの解析は表示のためだけに使う)
// ------------------------------------------------------------
function parseBatchEnv(batPath, seedVars = {}) {
  // seedVars: ランチャーが spawn 時に export する LAUNCHER_* 群
  //           (ショット選択時はここに LAUNCHER_SHOTCODE などが入る)
  const vars = { LAUNCHER_ROOT: ROOT, ...seedVars };
  if (!fs.existsSync(batPath)) return vars;
  const lines = fs.readFileSync(batPath, "utf-8").split(/\r?\n/);
  const re = /^\s*set\s+"?([A-Za-z0-9_]+)=([^"]*)"?\s*$/i;
  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    const key = m[1];
    // %VAR% を既知の値 → OS 環境変数の順で展開。
    // bat ファイル内では未定義変数は空文字列に展開されるので、それを再現する
    const value = m[2].replace(/%([A-Za-z0-9_]+)%/g, (_, name) => {
      if (name in vars) return vars[name];
      if (process.env[name] !== undefined) return process.env[name];
      return "";
    });
    vars[key] = value;
  }
  return vars;
}

// ------------------------------------------------------------
// ショット一覧の解決
//   優先1: shots.file (JSON) … Shot Tracker エクスポートの接続口
//   優先2: shots.dir + pattern … フォルダ名を正規表現でパース
//   shots キー自体が無ければ null(= ショット管理しないプロジェクト)
// ------------------------------------------------------------
function listShots(project, batchVars) {
  const cfg = project.shots;
  if (!cfg) return null;

  if (cfg.file) {
    const p = path.join(ROOT, cfg.file);
    if (!fs.existsSync(p)) return { error: `shots ファイルがありません: ${p}`, shots: [] };
    try {
      const data = readJson(p);
      return {
        source: "json",
        shots: data.map((s) => ({
          ...s,
          root: s.root ? expandPath(s.root, { ...batchVars, SHOTCODE: s.code }) : null,
        })),
      };
    } catch (e) {
      return { error: `shots JSON 解析エラー: ${e.message}`, shots: [] };
    }
  }

  if (cfg.dir) {
    const dir = expandPath(cfg.dir, batchVars).replace(/[\\/]/g, path.sep);
    if (!fs.existsSync(dir)) return { error: `ショットフォルダがありません: ${dir}`, shots: [] };
    let re = null;
    try {
      if (cfg.pattern) re = new RegExp(cfg.pattern);
    } catch (e) {
      return { error: `pattern が不正です: ${e.message}`, shots: [] };
    }
    const shots = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const m = re ? e.name.match(re) : null;
        if (re && !m) return null; // パターン不一致のフォルダは無視
        return { code: e.name, ...(m?.groups ?? {}), root: path.join(dir, e.name) };
      })
      .filter(Boolean)
      .sort((a, b) => a.code.localeCompare(b.code));
    return { source: "scan", shots };
  }
  return null;
}

// ショット → spawn 時に export する LAUNCHER_* 変数
function shotSeedVars(shot) {
  if (!shot) return {};
  return {
    LAUNCHER_SHOTCODE: shot.code ?? "",
    LAUNCHER_SEQ: shot.seq ?? "",
    LAUNCHER_SUBSCENE: shot.subscene ?? "",
    LAUNCHER_CUT: shot.cut ?? "",
    LAUNCHER_SHOT_ROOT: shot.root ?? "",
  };
}

// ------------------------------------------------------------
// packages 層のプレビュー
//   bat が組み立てた HOUDINI_PACKAGE_DIR を辿り、
//   各 *.json の env キーを読み出して一覧化する。
// ------------------------------------------------------------
function collectPackagesPreview(batchVars) {
  const result = [];
  const pkgDirVar = batchVars["HOUDINI_PACKAGE_DIR"];
  if (!pkgDirVar) return result;
  // Windows のパス区切りは ';'(':' で切るとドライブレターが壊れる)
  const dirs = pkgDirVar
    .split(";")
    .filter(Boolean)
    .map((d) => d.replace(/[\\/]/g, path.sep));
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      result.push({ dir, missing: true, files: [] });
      continue;
    }
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".json"))
      .sort() // Houdini はアルファベット順に処理する
      .map((f) => {
        const entry = { name: f, env: [], error: null };
        try {
          const data = readJson(path.join(dir, f));
          for (const item of data.env || []) {
            for (const [k, v] of Object.entries(item)) {
              if (k === "enable" || k === "method") continue;
              if (v && typeof v === "object" && !Array.isArray(v)) {
                // {"value": "...", "method": "prepend"} 形式
                entry.env.push({
                  key: k,
                  value: `${v.method ?? "set"}: ${v.value ?? ""}`,
                  plain: null, // append/prepend は単純代入でないためマージ対象外
                });
              } else {
                const s = Array.isArray(v) ? v.join(" ; ") : String(v);
                entry.env.push({ key: k, value: s, plain: Array.isArray(v) ? null : s });
              }
            }
          }
        } catch (e) {
          entry.error = e.message;
        }
        return entry;
      });
    result.push({ dir, missing: false, files });
  }
  return result;
}

// ------------------------------------------------------------
// bat 変数 + packages 変数のマージ
//   ビルダー生成プロジェクトは JOB/PRJ を package JSON 側に置くため、
//   ランチャーの hipDir / ショット走査でもそれを解決できるようにする。
//   bat(ランチャー確定値)を優先し、packages はファイル処理順に
//   未定義の変数のみ埋める。append/prepend 形式は対象外。
// ------------------------------------------------------------
function mergePackageVars(batchVars, packages) {
  const merged = { ...batchVars };
  for (const dir of packages) {
    for (const f of dir.files ?? []) {
      for (const e of f.env ?? []) {
        if (e.plain == null) continue;
        if (!(e.key in merged) || merged[e.key] === "") {
          merged[e.key] = expandPath(e.plain, merged);
        }
      }
    }
  }
  return merged;
}

// ------------------------------------------------------------
// シーン(.hip*)一覧
//   projects.json の hipDir を $VAR / %VAR% 両記法で展開して走査
// ------------------------------------------------------------
function expandPath(template, vars) {
  return template
    .replace(/\$\{?([A-Za-z0-9_]+)\}?/g, (_, n) => vars[n] ?? `$${n}`)
    .replace(/%([A-Za-z0-9_]+)%/g, (_, n) => vars[n] ?? `%${n}%`);
}

function listScenes(project, batchVars) {
  if (!project.hipDir) return { dir: null, scenes: [] };
  const dir = expandPath(project.hipDir, batchVars);
  if (!fs.existsSync(dir)) return { dir, missing: true, scenes: [] };
  const scenes = fs
    .readdirSync(dir)
    .filter((f) => /\.hip(lc|nc)?$/i.test(f))
    .map((f) => {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      return { name: f, path: full, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return { dir, missing: false, scenes };
}

// ------------------------------------------------------------
// runtime 層のプレビュー (参照専用)
//   Kaguya が set する変数ではなく、Houdini 自身が解決する変数。
//   HFS は exe パスから、HOUDINI_USER_PREF_DIR はバージョンから予測する。
// ------------------------------------------------------------
function buildRuntimePreview(project, vars) {
  const apps = readJsonSafe(path.join(CONFIG_DIR, "apps.json"), [], []);
  const appDef = apps.find((a) => a.id === project.defaultApp) ?? apps[0];

  let hfs = null;
  if (appDef?.exe) {
    // .../Houdini 21.0.440/bin/houdini.exe → .../Houdini 21.0.440
    hfs = path.dirname(path.dirname(appDef.exe)).replace(/\\/g, "/");
  }

  let pref = process.env.HOUDINI_USER_PREF_DIR ?? null;
  if (!pref && appDef?.version) {
    const mm = appDef.version.split(".").slice(0, 2).join(".");
    pref = path.join(os.homedir(), "Documents", `houdini${mm}`).replace(/\\/g, "/");
  }

  return [
    { key: "HFS", value: hfs ?? "— set exe in config/apps.json —", dynamic: !hfs },
    { key: "JOB", value: vars.JOB ?? "— undefined —", dynamic: !vars.JOB },
    { key: "HIP", value: "scene directory — set when a scene opens", dynamic: true },
    { key: "HIPNAME", value: "scene name (no ext) — set when a scene opens", dynamic: true },
    { key: "HOUDINI_USER_PREF_DIR", value: pref ?? "— houdini default —", dynamic: !pref },
    { key: "HOUDINI_PATH", value: "merged from packages at startup — verify with hconfig", dynamic: true },
  ];
}

// ---------- IPC ----------
function getProject(id) {
  const projects = readJsonSafe(path.join(CONFIG_DIR, "projects.json"), [], []);
  return projects.find((p) => p.id === id);
}
function getApp(id) {
  const apps = readJsonSafe(path.join(CONFIG_DIR, "apps.json"), [], []);
  return apps.find((a) => a.id === id);
}

ipcMain.handle("config:get", () => loadConfig());

ipcMain.handle("project:detail", (_e, projectId, shotCode) => {
  const project = getProject(projectId);
  if (!project) return { error: `project not found: ${projectId}` };
  const batPath = path.join(ROOT, project.batch);

  // 1パス目: ショットなしで bat を解析 → packages をマージして
  //          $JOB(bat 由来でも package 由来でも)を確定させ、ショット一覧を引く
  const baseVars = parseBatchEnv(batPath);
  const basePackages = collectPackagesPreview(baseVars);
  const baseMerged = mergePackageVars(baseVars, basePackages);
  const shotInfo = listShots(project, baseMerged);
  const shot = shotInfo?.shots.find((s) => s.code === shotCode) ?? null;

  // 2パス目: 選択ショットの LAUNCHER_* を注入して解析し直す
  const batchVars = shot ? parseBatchEnv(batPath, shotSeedVars(shot)) : baseVars;
  const packages = shot ? collectPackagesPreview(batchVars) : basePackages;
  const merged = shot ? mergePackageVars(batchVars, packages) : baseMerged;
  const {
    LAUNCHER_ROOT,
    LAUNCHER_SHOTCODE,
    LAUNCHER_SEQ,
    LAUNCHER_SUBSCENE,
    LAUNCHER_CUT,
    LAUNCHER_SHOT_ROOT,
    ...displayVars
  } = batchVars;

  // ショット選択中は hipDirShot を優先(未定義なら通常の hipDir)
  const projForScenes =
    shot && project.hipDirShot ? { ...project, hipDir: project.hipDirShot } : project;

  return {
    batchPath: batPath,
    batchExists: fs.existsSync(batPath),
    batchVars: Object.entries(displayVars).map(([key, value]) => ({ key, value })),
    packages,
    sceneInfo: listScenes(projForScenes, merged),
    shotInfo,
    activeShot: shot?.code ?? null,
    runtime: buildRuntimePreview(project, merged),
    // ビルダー生成プロジェクトのメタ(§5.2 「環境変数」バッジ用)
    envJson:
      project.envJson && fs.existsSync(project.envJson) ? project.envJson : null,
  };
});

// 起動: cmd /c "env.bat" "houdini.exe" ["scene.hip"]
//   → bat 内で set 群を評価してから start するので、
//     子プロセス(Houdini)には bat の変数がそのまま継承される。
ipcMain.handle("launch", (_e, { projectId, appId, scenePath, shotCode }) => {
  const project = getProject(projectId);
  const appDef = getApp(appId);
  if (!project || !appDef) return { ok: false, message: "Configuration not found" };

  // ショット解決(選択されていれば LAUNCHER_* として bat へ渡す)
  let shot = null;
  if (shotCode) {
    const baseVars = parseBatchEnv(path.join(ROOT, project.batch));
    const merged = mergePackageVars(baseVars, collectPackagesPreview(baseVars));
    shot = listShots(project, merged)?.shots.find((s) => s.code === shotCode) ?? null;
  }

  const batPath = path.join(ROOT, project.batch);
  if (!fs.existsSync(batPath))
    return { ok: false, message: `env.bat not found: ${batPath}` };
  if (!fs.existsSync(appDef.exe))
    return { ok: false, message: `Executable not found: ${appDef.exe}\nCheck "exe" in config/apps.json` };

  if (process.platform !== "win32")
    return { ok: false, message: "Launching is Windows-only (preview still works)" };

  // cmd /s /c "" で囲むことで、パスに空白があっても安全に渡せる
  let cmdline = `""${batPath}" "${appDef.exe}"`;
  if (scenePath) cmdline += ` "${scenePath}"`;
  cmdline += `"`;

  const child = spawn("cmd.exe", ["/d", "/s", "/c", cmdline], {
    windowsVerbatimArguments: true,
    detached: true,
    stdio: "ignore",
    // bat 内で %LAUNCHER_ROOT% / %LAUNCHER_SHOTCODE% 等を参照可能に
    env: { ...process.env, LAUNCHER_ROOT: ROOT, ...shotSeedVars(shot) },
  });
  child.unref();

  const ctx = shot ? ` [${shot.code}]` : "";
  return {
    ok: true,
    message: scenePath
      ? `Launched ${appDef.name}${ctx}: ${path.basename(scenePath)}`
      : `Launched ${appDef.name}${ctx}`,
  };
});

ipcMain.handle("openFolder", (_e, rel) => {
  shell.openPath(path.join(ROOT, rel));
});

// 生成済み package JSON をエディタで開く / エクスプローラで表示 (§5.2)
ipcMain.handle("openPathAbs", (_e, abs) => shell.openPath(abs));
ipcMain.handle("showInFolder", (_e, abs) => shell.showItemInFolder(abs));

// 新規ショット作成: shots/<code> と hip ディレクトリを生成
ipcMain.handle("shot:create", (_e, { projectId, code }) => {
  const project = getProject(projectId);
  if (!project?.shots) return { ok: false, message: "This project has no shot configuration" };
  if (project.shots.file)
    return { ok: false, message: "Shots for this project are managed by a shots JSON file" };
  if (!project.shots.dir)
    return { ok: false, message: "shots.dir is not configured for this project" };
  if (!/^[A-Za-z0-9_\-]+$/.test(code ?? ""))
    return { ok: false, message: "Shot code may only contain letters, digits, _ and -" };

  // ショット命名規約 (pattern) に合わないコードは一覧に出ないため弾く
  if (project.shots.pattern) {
    let re = null;
    try { re = new RegExp(project.shots.pattern); } catch {}
    if (re && !re.test(code))
      return { ok: false, message: `Code does not match this project's shot pattern:\n${project.shots.pattern}` };
  }

  const baseVars = parseBatchEnv(path.join(ROOT, project.batch));
  const merged = mergePackageVars(baseVars, collectPackagesPreview(baseVars));
  const dir = expandPath(project.shots.dir, merged).replace(/[\\/]/g, path.sep);
  const shotRoot = path.join(dir, code);
  if (fs.existsSync(shotRoot)) return { ok: false, message: `Shot already exists: ${code}` };

  fs.mkdirSync(shotRoot, { recursive: true });
  if (project.hipDirShot) {
    const hip = expandPath(project.hipDirShot, {
      ...merged,
      SHOT_ROOT: shotRoot.replace(/\\/g, "/"),
    }).replace(/[\\/]/g, path.sep);
    fs.mkdirSync(hip, { recursive: true });
  }
  return { ok: true, code };
});

// ---------- project environment builder (§6.1 IPC) ----------
ipcMain.handle("builder:defaults", () => {
  const errors = [];
  const settings = loadSettings();
  const templates = loadTemplates();
  const apps = readJsonSafe(path.join(CONFIG_DIR, "apps.json"), [], errors);
  return {
    defaultRoot: settings.defaultProjectRoot || "",
    templates: templates.map((t) => ({ name: t.name, dirs: t.dirs })),
    apps: apps.map((a) => ({ id: a.id, name: a.name, version: a.version ?? "" })),
    configErrors: errors,
  };
});

// プロジェクトルートを File Explorer で選択 (§5.1 [参照])
ipcMain.handle("dialog:pickFolder", async (_e, defaultPath) => {
  const win = BrowserWindow.getFocusedWindow();
  const r = await dialog.showOpenDialog(win, {
    title: "Select project root",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: defaultPath && fs.existsSync(defaultPath) ? defaultPath : undefined,
  });
  return r.canceled ? null : r.filePaths[0].replace(/\\/g, "/");
});

ipcMain.handle("project:preview", (_e, form) => {
  const settings = loadSettings();
  const projects = readJsonSafe(path.join(CONFIG_DIR, "projects.json"), [], []);
  return builder.preview(ROOT, form, settings, projects.map((p) => p.id));
});

ipcMain.handle("project:create", (_e, form) => {
  const settings = loadSettings();
  const templates = loadTemplates();
  try {
    return builder.createProject(
      ROOT,
      form,
      settings,
      templates,
      path.join(CONFIG_DIR, "projects.json")
    );
  } catch (e) {
    return { ok: false, errors: [`Failed to create project: ${e.message}`], warnings: [] };
  }
});

// ---------- window ----------
function createWindow() {
  const candidates =
    process.platform === "win32"
      ? ["icon.ico", "icon.png"]
      : ["icon.png"];
  const iconPath = candidates
    .map((f) => path.join(__dirname, "build", f))
    .find((p) => fs.existsSync(p));
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#17181b",
    autoHideMenuBar: true,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

// ------------------------------------------------------------
// --make-shortcut: タスクバーにピン留め可能なショートカットを生成
//   npm run shortcut で ROOT に Kaguya.lnk を作って終了する。
//   - target が electron.exe 直叩きなのでコンソールは出ない (VBS 不要)
//   - icon = build/icon.ico
//   - appUserModelId を本体と一致させることで、ピン留めした .lnk と
//     実行中ウィンドウが同一のタスクバーボタンに統合される
// ------------------------------------------------------------
function makeShortcut() {
  if (process.platform !== "win32") {
    console.log("Shortcut creation is Windows-only.");
    return false;
  }
  const lnkPath = path.join(ROOT, "Kaguya.lnk");
  const ok = shell.writeShortcutLink(lnkPath, "create", {
    target: process.execPath, // dev: electron.exe / packaged: Kaguya.exe
    args: app.isPackaged ? "" : `"${__dirname}"`,
    cwd: ROOT,
    icon: path.join(__dirname, "build", "icon.ico"),
    iconIndex: 0,
    appUserModelId: "dev.kurama.kaguya",
    description: "Kaguya DCC Launcher",
  });
  console.log(ok ? `Shortcut created: ${lnkPath}` : "Failed to create shortcut");
  return ok;
}

if (process.argv.includes("--make-shortcut")) {
  app.whenReady().then(() => {
    makeShortcut();
    app.quit();
  });
} else {
  app.whenReady().then(createWindow);
}
app.on("window-all-closed", () => app.quit());
