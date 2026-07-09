const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("launcher", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  getProjectDetail: (projectId, shotCode) =>
    ipcRenderer.invoke("project:detail", projectId, shotCode ?? null),
  launch: (payload) => ipcRenderer.invoke("launch", payload),
  openFolder: (rel) => ipcRenderer.invoke("openFolder", rel),
  openPathAbs: (abs) => ipcRenderer.invoke("openPathAbs", abs),
  showInFolder: (abs) => ipcRenderer.invoke("showInFolder", abs),
  pickFolder: (defaultPath) => ipcRenderer.invoke("dialog:pickFolder", defaultPath ?? null),
  // project environment builder
  builderDefaults: () => ipcRenderer.invoke("builder:defaults"),
  projectPreview: (form) => ipcRenderer.invoke("project:preview", form),
  projectCreate: (form) => ipcRenderer.invoke("project:create", form),
});
