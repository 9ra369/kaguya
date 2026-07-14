// ============================================================
// Kaguya - project environment builder
// 仕様書 v0.1 準拠:
//   プロジェクト名 → Houdini packages 形式 JSON を生成し、
//   ランチャーのプロジェクトレジストリ(config/projects.json)へ登録する。
//
// 構成 (§6.5 マルチDCC拡張を見据えたアダプタ方式):
//   - コア: JOB / PRJ の構築、バリデーション、ファイル I/O
//   - アダプタ: DCC 固有変数と出力形式 (現状 houdini のみ)
// ============================================================

const fs = require("fs");
const path = require("path");

const KAGUYA_VERSION = "0.3.0";

// ディレクトリ区切りは OS に関係なく '/' (§3.2-1)
const toSlash = (p) => String(p).replace(/\\/g, "/");

// ------------------------------------------------------------
// DCC アダプタ
//   buildEnv():       DCC 固有の env エントリを返す (順序保証あり)
//   packageExtras():  env 以外のトップレベルキー (path 等)
//   batchTemplate():  動的層 bat の中身
// ------------------------------------------------------------
const adapters = {
  houdini: {
    id: "houdini",

    buildEnv(ctx, settings) {
      const env = [];
      env.push({ JOB: ctx.jobPath });
      env.push({ PRJ: ctx.name });
      // 末尾 '&' 問題は method:prepend で回避 (§3.1)
      env.push({
        HOUDINI_OTLSCAN_PATH: { value: "$JOB/otls", method: "prepend" },
      });
      if (settings.tempDir) env.push({ HOUDINI_TEMP_DIR: toSlash(settings.tempDir) });
      if (settings.author) env.push({ HOUDINI_AUTHOR: settings.author });
      if (settings.anonymousStatistics === false)
        env.push({ HOUDINI_ANONYMOUS_STATISTICS: "0" });
      return env;
    },

    // HOUDINI_PATH は直接触らず packages の path キーで追加 (§4.1)
    packageExtras() {
      return { path: "$JOB/houdini" };
    },

    batchTemplate(ctx) {
      return [
        "@echo off",
        "rem ============================================================",
        `rem ${ctx.name} - dynamic layer (Kaguya generated)`,
        "rem   %1 = 起動する exe / %2 = 開くシーン (省略可)",
        "rem   JOB / PRJ などの静的変数は package JSON 側で定義される:",
        `rem   ${ctx.jsonPath}`,
        "rem ============================================================",
        "",
        "rem ---- ショットコンテキスト (ランチャーの選択から継承) ----",
        "set SHOTCODE=%LAUNCHER_SHOTCODE%",
        "set SEQ=%LAUNCHER_SEQ%",
        "set SUBSCENE=%LAUNCHER_SUBSCENE%",
        "set CUT=%LAUNCHER_CUT%",
        "set SHOT_ROOT=%LAUNCHER_SHOT_ROOT%",
        "",
        "rem ---- packages: プロジェクト側 + ランチャー共通 の二層 ----",
        `set HOUDINI_PACKAGE_DIR=${ctx.jobPath}/packages;%LAUNCHER_ROOT%\\packages_common`,
        "set HOUDINI_NO_ENV_FILE=1",
        "",
        'if "%~2"=="" (',
        '  start "" "%~1"',
        ") else (",
        '  start "" "%~1" "%~2"',
        ")",
        "",
      ].join("\r\n");
    },
  },
};

// ------------------------------------------------------------
// バリデーション (§2.5)
// ------------------------------------------------------------
function validateForm(form, existingProjectIds) {
  const errors = [];
  const warnings = [];
  const name = (form.name ?? "").trim();
  const root = (form.root ?? "").trim();

  if (!name) errors.push("Enter a project name");
  else if (!/^[A-Za-z0-9_\-]+$/.test(name))
    errors.push("Project name may only contain letters, digits, _ and -");

  if (!root) errors.push("Specify a project root");
  else if (!fs.existsSync(root)) errors.push(`Root does not exist: ${root}`);
  else {
    try {
      fs.accessSync(root, fs.constants.W_OK);
    } catch {
      errors.push(`Root is not writable: ${root}`);
    }
  }

  const jobPath = name && root ? toSlash(path.join(root, name)) : null;
  if (jobPath) {
    // マルチバイトパスで Houdini が起動失敗する既知問題 → 警告 (続行可)
    if (/[^\x20-\x7E]/.test(jobPath))
      warnings.push("Path contains multi-byte characters — Houdini may fail to launch (not recommended)");
    if (/\s/.test(jobPath))
      warnings.push("Path contains spaces (not recommended)");
    if (jobPath.length > 200)
      warnings.push(`Path is too long (${jobPath.length} chars) — mind the Windows 260-char limit`);
  }

  // 追加変数のキー検証
  for (const { key } of form.extraEnv ?? []) {
    if (key && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      errors.push(`Invalid extra variable name: ${key}`);
  }

  // 同名プロジェクト → 上書き確認フロー (§2.5)
  let needsOverwrite = false;
  if (name && !errors.length) {
    const jsonPath = path.join(jobPath, "packages", `${name}.json`);
    if (existingProjectIds.includes(name) || fs.existsSync(jsonPath))
      needsOverwrite = true;
  }

  return { errors, warnings, needsOverwrite, jobPath };
}

// ------------------------------------------------------------
// package JSON の構築 (§4.1)
// ------------------------------------------------------------
function buildPackageJson(ctx, settings) {
  const adapter = adapters[ctx.dcc] ?? adapters.houdini;
  const env = adapter.buildEnv(ctx, settings);

  for (const { key, value } of ctx.extraEnv ?? []) {
    if (key) env.push({ [key]: toSlash(value ?? "") });
  }

  return {
    load_package_once: true,
    env,
    ...adapter.packageExtras(ctx),
    _launcher_meta: {
      created: new Date().toISOString(),
      template: ctx.template,
      launcher_version: KAGUYA_VERSION,
    },
  };
}

// ------------------------------------------------------------
// プレビュー (フォーム → 生成予定の内容。ファイルには触れない)
// ------------------------------------------------------------
function preview(ROOT, form, settings, existingProjectIds) {
  const v = validateForm(form, existingProjectIds);
  if (!v.jobPath) return { ...v, jsonText: null, jsonPath: null, batPath: null };

  const name = form.name.trim();
  const jsonPath = toSlash(path.join(v.jobPath, "packages", `${name}.json`));
  const ctx = {
    name,
    jobPath: v.jobPath,
    jsonPath,
    dcc: form.dcc ?? "houdini",
    template: form.template ?? "default",
    extraEnv: form.extraEnv ?? [],
  };
  const pkg = buildPackageJson(ctx, settings);
  return {
    ...v,
    jsonPath,
    batPath: toSlash(path.join(ROOT, "projects", name, "env.bat")),
    jsonText: JSON.stringify(pkg, null, 4),
  };
}

// ------------------------------------------------------------
// 作成 (§2.2 処理フロー本体)
//   1. バリデーション  2. ディレクトリ生成(任意)
//   3. package JSON 出力(UTF-8 BOMなし)  4. 生成 bat 出力
//   5. config/projects.json へ登録
// ------------------------------------------------------------
function createProject(ROOT, form, settings, templates, projectsJsonPath) {
  const projects = JSON.parse(fs.readFileSync(projectsJsonPath, "utf-8"));
  const existingIds = projects.map((p) => p.id);
  const v = validateForm(form, existingIds);
  if (v.errors.length) return { ok: false, ...v };
  if (v.needsOverwrite && !form.overwrite)
    return { ok: false, ...v, message: "Project already exists" };

  const name = form.name.trim();
  const jobPath = v.jobPath;
  const tpl =
    templates.find((t) => t.name === (form.template ?? "default")) ?? templates[0];

  // 2. ディレクトリ生成: packages は JSON の置き場なので常に作る
  //    ショット管理有効時は shots も常に作る (走査対象のため)
  const always = form.enableShots ? ["packages", "shots"] : ["packages"];
  const dirs = form.createDirs ? [...new Set([...tpl.dirs, ...always])] : always;
  for (const d of dirs) fs.mkdirSync(path.join(jobPath, d), { recursive: true });

  // 3. package JSON (Node の writeFileSync utf-8 は BOM を付けない §3.2-4)
  const jsonPath = path.join(jobPath, "packages", `${name}.json`);
  const ctx = {
    name,
    jobPath,
    jsonPath: toSlash(jsonPath),
    dcc: form.dcc ?? "houdini",
    template: tpl.name,
    extraEnv: [...(tpl.extra_env ?? []).flatMap((o) =>
      Object.entries(o).map(([key, value]) => ({ key, value }))
    ), ...(form.extraEnv ?? [])],
  };
  const pkg = buildPackageJson(ctx, settings);
  fs.writeFileSync(jsonPath, JSON.stringify(pkg, null, 4) + "\n", "utf-8");

  // 4. 動的層 bat
  const adapter = adapters[ctx.dcc] ?? adapters.houdini;
  const batDir = path.join(ROOT, "projects", name);
  fs.mkdirSync(batDir, { recursive: true });
  const batPath = path.join(batDir, "env.bat");
  fs.writeFileSync(batPath, adapter.batchTemplate(ctx), "utf-8");

  // 5. レジストリ登録 (既存 id は置換 = 上書きフロー §5.2)
  const entry = {
    id: name,
    name,
    icon: null,
    batch: `projects/${name}/env.bat`,
    hipDir: "$JOB/hip",
    defaultApp: form.defaultApp ?? null,
    envJson: toSlash(jsonPath), // §5.2 の「環境変数」バッジ・JSON閲覧用メタ
  };
  if (form.enableShots) {
    // <PRJ名>_{seq}_{subscene}_{cut} 規約でフォルダ走査。
    // 命名規約を変えたい場合は projects.json の pattern を編集する
    entry.shots = {
      dir: "$JOB/shots",
      pattern: `^${name}_(?<seq>[^_]+)_(?<subscene>[^_]+)_(?<cut>[^_]+)$`,
    };
    entry.hipDirShot = "$SHOT_ROOT/hip";
  }
  const idx = projects.findIndex((p) => p.id === name);
  if (idx >= 0) projects[idx] = { ...projects[idx], ...entry };
  else projects.push(entry);
  fs.writeFileSync(projectsJsonPath, JSON.stringify(projects, null, 2) + "\n", "utf-8");

  return { ok: true, ...v, projectId: name, jsonPath: toSlash(jsonPath) };
}

module.exports = { preview, createProject, validateForm, KAGUYA_VERSION };
