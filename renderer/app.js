// ============================================================
// Kaguya - renderer
// ============================================================

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  projectId: null,
  shotCode: null,
  detail: null,
};

// ---------------- init ----------------
async function init() {
  state.config = await window.launcher.getConfig();
  $("rootPath").textContent = state.config.root;
  $("rootPath").title = state.config.root;

  showConfigErrors(state.config.configErrors);
  buildProjectMenu();

  const first = state.config.projects[0];
  if (first) await selectProject(first.id);
  else showEmptyAll();
}

// 壊れた設定ファイルは黙殺せず画面上部に表示する
function showConfigErrors(errors) {
  document.querySelectorAll(".config-error").forEach((e) => e.remove());
  if (!errors?.length) return;
  const div = document.createElement("div");
  div.className = "config-error";
  div.textContent = "Config error — " + errors.join(" / ");
  document.querySelector(".col-left").prepend(div);
}

// ---------------- project selector ----------------
function buildProjectMenu() {
  const menu = $("projectMenu");
  menu.innerHTML = "";
  for (const p of state.config.projects) {
    const li = document.createElement("li");
    li.dataset.id = p.id;
    li.setAttribute("role", "option");
    li.innerHTML = `
      <img src="${p.iconUrl ?? ""}" alt="" onerror="this.style.visibility='hidden'">
      <div>
        <div class="p-name"></div>
        <div class="p-job"></div>
      </div>`;
    li.querySelector(".p-name").textContent = p.name;
    li.querySelector(".p-job").textContent = p.id;
    li.addEventListener("click", () => {
      closeMenu();
      selectProject(p.id);
    });
    menu.appendChild(li);
  }

  const btn = $("projectBtn");
  if (!buildProjectMenu._bound) {
    buildProjectMenu._bound = true;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const menu2 = $("projectMenu");
      const hidden = menu2.hidden;
      menu2.hidden = !hidden;
      btn.setAttribute("aria-expanded", String(hidden));
    });
    document.addEventListener("click", closeMenu);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeMenu();
    });
  }
}

function closeMenu() {
  $("projectMenu").hidden = true;
  $("projectBtn").setAttribute("aria-expanded", "false");
}

async function selectProject(id) {
  state.projectId = id;
  const p = state.config.projects.find((x) => x.id === id);

  $("projectBtnName").textContent = p.name;
  const icon = $("projectBtnIcon");
  icon.src = p.iconUrl ?? "";
  icon.style.visibility = p.iconUrl ? "visible" : "hidden";

  document
    .querySelectorAll("#projectMenu li")
    .forEach((li) => li.classList.toggle("active", li.dataset.id === id));

  state.shotCode = null; // プロジェクトを跨いだショットの持ち越しはしない
  state.detail = await window.launcher.getProjectDetail(id, null);
  renderShotSelect();
  renderApps();
  renderScenes();
  renderEnvStack();
}

// ---------------- shot selector ----------------
function renderShotSelect() {
  const wrap = $("shotSelect");
  const dd = $("shotDropdown");
  const info = state.detail.shotInfo;

  if (!info) {
    // shots キーを持たないプロジェクト → セレクタ自体を隠す
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  $("newShotBtn").hidden = info.source === "json"; // shots.json 管理時は GUI 作成不可
  dd.innerHTML = "";

  const none = document.createElement("option");
  none.value = "";
  none.textContent = info.error ? `(${info.error})` : "— no shot —";
  dd.appendChild(none);

  for (const s of info.shots) {
    const opt = document.createElement("option");
    opt.value = s.code;
    opt.textContent = s.code;
    dd.appendChild(opt);
  }
  dd.value = state.shotCode ?? "";
  dd.onchange = () => selectShot(dd.value || null);
}

async function selectShot(code) {
  state.shotCode = code;
  // ショット文脈で bat を解釈し直す(env プレビュー / hipDir が切り替わる)
  state.detail = await window.launcher.getProjectDetail(state.projectId, code);
  renderScenes();
  renderEnvStack();
}

// ---------------- apps ----------------
function renderApps() {
  const grid = $("appGrid");
  grid.innerHTML = "";
  const project = state.config.projects.find((x) => x.id === state.projectId);

  // projects.json 側で apps を絞れる(未指定なら全アプリ)
  const allowed = project.apps ?? state.config.apps.map((a) => a.id);
  const apps = state.config.apps.filter((a) => allowed.includes(a.id));

  if (!apps.length) {
    grid.innerHTML = `<div class="empty">Add applications in config/apps.json</div>`;
    return;
  }

  for (const a of apps) {
    const card = document.createElement("button");
    card.className = "app-card";
    card.innerHTML = `
      <img src="${a.iconUrl ?? ""}" alt="" onerror="this.style.visibility='hidden'">
      <span class="a-name"></span>
      <span class="a-ver"></span>
      <span class="a-launch">click to launch →</span>`;
    card.querySelector(".a-name").textContent = a.name;
    card.querySelector(".a-ver").textContent = a.version ?? "";
    card.title = a.exe;
    card.addEventListener("click", () => launch(a.id, null));
    grid.appendChild(card);
  }
}

// ---------------- scenes ----------------
function renderScenes() {
  const list = $("sceneList");
  const info = state.detail.sceneInfo;
  list.innerHTML = "";
  $("sceneDir").textContent = info.dir ?? "";
  $("sceneDir").title = info.dir ?? "";

  if (!info.dir) {
    list.innerHTML = `<div class="empty">Set <span class="mono">hipDir</span> in projects.json to list scenes here</div>`;
    return;
  }
  if (info.missing) {
    list.innerHTML = `<div class="empty">Folder not found:<br><span class="mono">${info.dir}</span></div>`;
    return;
  }
  if (!info.scenes.length) {
    list.innerHTML = `<div class="empty">No .hip files yet</div>`;
    return;
  }

  const defaultApp = defaultAppId();
  for (const s of info.scenes) {
    const li = document.createElement("li");
    const d = new Date(s.mtime);
    const date = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    li.innerHTML = `
      <span class="scene-dot"></span>
      <span class="scene-name"></span>
      <span class="scene-date">${date}</span>`;
    li.querySelector(".scene-name").textContent = s.name;
    li.title = `${s.path}\nDouble-click to open`;
    li.addEventListener("dblclick", () => launch(defaultApp, s.path));
    list.appendChild(li);
  }
}

function defaultAppId() {
  const project = state.config.projects.find((x) => x.id === state.projectId);
  return project.defaultApp ?? state.config.apps[0]?.id;
}

// ---------------- environment stack ----------------
function renderEnvStack() {
  const d = state.detail;

  // ビルダー生成プロジェクトなら JSON アクションを表示 (§5.2)
  $("envActions").hidden = !d.envJson;

  // layer 3: runtime (参照専用)
  const rt = $("runtimeTable");
  rt.innerHTML = "";
  for (const { key, value, dynamic } of d.runtime ?? []) {
    const tr = document.createElement("tr");
    const k = document.createElement("td");
    const v = document.createElement("td");
    k.className = "k";
    v.className = "v" + (dynamic ? " v-dyn" : "");
    k.textContent = key;
    v.textContent = value;
    tr.append(k, v);
    rt.appendChild(tr);
  }

  // layer 1: batch
  const table = $("batchTable");
  table.innerHTML = "";
  if (!d.batchExists) {
    $("batchPath").textContent = `env.bat not found: ${d.batchPath}`;
  } else {
    $("batchPath").textContent = d.batchPath;
    for (const { key, value } of d.batchVars) {
      const tr = document.createElement("tr");
      const k = document.createElement("td");
      const v = document.createElement("td");
      k.className = "k";
      v.className = "v";
      k.textContent = key;
      v.textContent = value;
      tr.append(k, v);
      table.appendChild(tr);
    }
  }

  // layer 2: packages
  const area = $("packagesArea");
  area.innerHTML = "";
  if (!d.packages.length) {
    area.innerHTML = `<div class="empty">HOUDINI_PACKAGE_DIR is not set in the batch layer</div>`;
    return;
  }
  for (const dir of d.packages) {
    const label = document.createElement("div");
    label.className = "pkg-dir-label" + (dir.missing ? " pkg-missing" : "");
    label.textContent = dir.dir + (dir.missing ? " (not found)" : "");
    area.appendChild(label);

    for (const f of dir.files) {
      const box = document.createElement("div");
      box.className = "pkg-file";
      const name = document.createElement("div");
      name.className = "pkg-file-name";
      name.textContent = f.name;
      box.appendChild(name);

      if (f.error) {
        const err = document.createElement("div");
        err.className = "empty pkg-missing";
        err.textContent = `JSON parse error: ${f.error}`;
        box.appendChild(err);
      } else if (f.env.length) {
        const t = document.createElement("table");
        t.className = "env-table";
        for (const { key, value } of f.env) {
          const tr = document.createElement("tr");
          const k = document.createElement("td");
          const v = document.createElement("td");
          k.className = "k";
          v.className = "v";
          k.textContent = key;
          v.textContent = value;
          tr.append(k, v);
          t.appendChild(tr);
        }
        box.appendChild(t);
      }
      area.appendChild(box);
    }
  }
}

// ---------------- launch ----------------
async function launch(appId, scenePath) {
  const res = await window.launcher.launch({
    projectId: state.projectId,
    appId,
    scenePath,
    shotCode: state.shotCode,
  });
  toast(res.message, !res.ok);
}

// ---------------- misc ----------------
let toastTimer = null;
function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

function showEmptyAll() {
  $("appGrid").innerHTML = `<div class="empty">No projects yet — click <b>+ New Project</b> to create one.</div>`;
  $("sceneList").innerHTML = "";
  $("sceneDir").textContent = "";
  $("batchTable").innerHTML = "";
  $("batchPath").textContent = "";
  $("packagesArea").innerHTML = "";
  $("envActions").hidden = true;
  $("shotSelect").hidden = true;
}

init();

// ============================================================
// project environment builder (仕様書 §5.1)
// ============================================================

const builderState = {
  defaults: null,
  extraEnv: [], // [{key, value}]
  lastPreview: null,
  previewTimer: null,
};

function bindBuilder() {
  $("newProjectBtn").addEventListener("click", openBuilderModal);
  $("modalClose").addEventListener("click", closeBuilderModal);
  $("btnCancel").addEventListener("click", closeBuilderModal);
  $("modalOverlay").addEventListener("click", (e) => {
    if (e.target === $("modalOverlay")) closeBuilderModal();
  });
  $("btnBrowse").addEventListener("click", async () => {
    const dir = await window.launcher.pickFolder($("fRoot").value || null);
    if (dir) {
      $("fRoot").value = dir;
      schedulePreview();
    }
  });
  $("addEnvRow").addEventListener("click", () => {
    builderState.extraEnv.push({ key: "", value: "" });
    renderEnvRows();
  });
  $("btnCreate").addEventListener("click", submitCreate);

  // 入力に追従してプレビュー更新 (§5.1)
  for (const id of ["fName", "fRoot", "fTemplate", "fApp", "fCreateDirs"]) {
    $(id).addEventListener("input", schedulePreview);
    $(id).addEventListener("change", schedulePreview);
  }
  $("fTemplate").addEventListener("change", renderTplDirs);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("modalOverlay").hidden) closeBuilderModal();
  });
}

async function openBuilderModal() {
  builderState.defaults = await window.launcher.builderDefaults();
  const d = builderState.defaults;
  if (d.configErrors?.length) {
    d.configErrors.forEach((e) => toast(e, true));
  }

  $("fName").value = "";
  $("fRoot").value = d.defaultRoot;
  $("fCreateDirs").checked = true;
  builderState.extraEnv = [];
  renderEnvRows();

  const tpl = $("fTemplate");
  tpl.innerHTML = "";
  for (const t of d.templates) {
    const o = document.createElement("option");
    o.value = t.name;
    o.textContent = t.name;
    tpl.appendChild(o);
  }
  renderTplDirs();

  const appSel = $("fApp");
  appSel.innerHTML = "";
  for (const a of d.apps) {
    const o = document.createElement("option");
    o.value = a.id;
    o.textContent = `${a.name} ${a.version}`.trim();
    appSel.appendChild(o);
  }

  $("jsonPreview").innerHTML = "";
  $("previewPath").textContent = "";
  $("warnArea").innerHTML = "";
  $("btnCreate").disabled = true;
  $("modalOverlay").hidden = false;
  $("fName").focus();
}

function closeBuilderModal() {
  $("modalOverlay").hidden = true;
}

function renderTplDirs() {
  const t = builderState.defaults?.templates.find((x) => x.name === $("fTemplate").value);
  $("tplDirs").textContent = t ? "<JOB>/ " + t.dirs.join(" · ") : "";
}

function renderEnvRows() {
  const wrap = $("extraEnvRows");
  wrap.innerHTML = "";
  builderState.extraEnv.forEach((row, i) => {
    const div = document.createElement("div");
    div.className = "env-row";
    div.innerHTML = `
      <input type="text" placeholder="KEY" spellcheck="false" value="">
      <span class="eq">=</span>
      <input type="text" placeholder="VALUE" spellcheck="false" value="">
      <button class="mini-btn">−</button>`;
    const [kIn, vIn] = div.querySelectorAll("input");
    kIn.value = row.key;
    vIn.value = row.value;
    kIn.addEventListener("input", () => { row.key = kIn.value; schedulePreview(); });
    vIn.addEventListener("input", () => { row.value = vIn.value; schedulePreview(); });
    div.querySelector("button").addEventListener("click", () => {
      builderState.extraEnv.splice(i, 1);
      renderEnvRows();
      schedulePreview();
    });
    wrap.appendChild(div);
  });
}

function collectForm(overwrite = false) {
  return {
    name: $("fName").value,
    root: $("fRoot").value,
    template: $("fTemplate").value,
    dcc: "houdini", // 現状 Houdini のみ。将来は fApp から DCC 種別を引く
    defaultApp: $("fApp").value || null,
    createDirs: $("fCreateDirs").checked,
    enableShots: $("fShots").checked,
    extraEnv: builderState.extraEnv.filter((r) => r.key),
    overwrite,
  };
}

// リアルタイム反応が必要な形式チェックは renderer 側で先に (§6.1)
function localNameCheck() {
  const el = $("fName");
  const ok = el.value === "" || /^[A-Za-z0-9_\-]+$/.test(el.value);
  el.classList.toggle("invalid", !ok);
  return ok;
}

function schedulePreview() {
  localNameCheck();
  clearTimeout(builderState.previewTimer);
  builderState.previewTimer = setTimeout(refreshPreview, 180);
}

async function refreshPreview() {
  const p = await window.launcher.projectPreview(collectForm());
  builderState.lastPreview = p;

  $("previewPath").textContent = p.jsonPath ?? "";
  $("jsonPreview").innerHTML = p.jsonText ? highlightJson(p.jsonText) : "";

  const warn = $("warnArea");
  warn.innerHTML = "";
  for (const e of p.errors) warn.appendChild(warnItem(e, "err"));
  for (const w of p.warnings) warn.appendChild(warnItem(w, "warn"));
  if (p.needsOverwrite)
    warn.appendChild(warnItem("A project with this name already exists — you will be asked to overwrite", "warn"));

  $("btnCreate").disabled = p.errors.length > 0 || !p.jsonText;
}

function warnItem(text, cls) {
  const div = document.createElement("div");
  div.className = `warn-item ${cls}`;
  div.textContent = (cls === "err" ? "✕ " : "⚠ ") + text;
  return div;
}

function highlightJson(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"([^"]+)"(\s*:)/g, '<span class="j-key">"$1"</span>$2')
    .replace(/: "([^"]*)"/g, ': <span class="j-str">"$1"</span>')
    .replace(/: (true|false|null|-?\d+)/g, ': <span class="j-lit">$1</span>');
}

async function submitCreate() {
  let res = await window.launcher.projectCreate(collectForm(false));

  if (!res.ok && res.needsOverwrite) {
    const yes = confirm(
      "A project / package JSON with this name already exists. Overwrite?\n(The package JSON and env.bat will be regenerated)"
    );
    if (!yes) return;
    res = await window.launcher.projectCreate(collectForm(true));
  }

  if (!res.ok) {
    (res.errors ?? ["Failed to create project"]).forEach((e) => toast(e, true));
    return;
  }

  closeBuilderModal();
  // レジストリ再読込 → 新プロジェクトを選択
  state.config = await window.launcher.getConfig();
  buildProjectMenu();
  await selectProject(res.projectId);
  toast(`Project "${res.projectId}" created\n${res.jsonPath}`);
}

// ---------------- env json actions (§5.2) ----------------
function bindEnvActions() {
  $("openEnvJson").addEventListener("click", () => {
    if (state.detail?.envJson) window.launcher.openPathAbs(state.detail.envJson);
  });
  $("revealEnvJson").addEventListener("click", () => {
    if (state.detail?.envJson) window.launcher.showInFolder(state.detail.envJson);
  });
}

// ---------------- new shot creation ----------------
function bindNewShot() {
  const btn = $("newShotBtn");
  const input = $("newShotInput");

  btn.addEventListener("click", () => {
    input.hidden = !input.hidden;
    if (!input.hidden) {
      input.value = state.projectId ? `${state.projectId}_` : "";
      input.focus();
    }
  });

  input.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") {
      input.hidden = true;
      return;
    }
    if (e.key !== "Enter") return;
    const code = input.value.trim();
    if (!code) return;
    const res = await window.launcher.shotCreate({ projectId: state.projectId, code });
    if (!res.ok) {
      toast(res.message, true);
      return;
    }
    input.hidden = true;
    // 一覧を更新して作成したショットを選択
    state.shotCode = res.code;
    state.detail = await window.launcher.getProjectDetail(state.projectId, res.code);
    renderShotSelect();
    renderScenes();
    renderEnvStack();
    toast(`Shot "${res.code}" created`);
  });
}

bindBuilder();
bindEnvActions();
bindNewShot();
