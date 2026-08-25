const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("loginAPI", {
  checkLogin: (username, password) =>
    ipcRenderer.invoke("check-login", username, password),
  changeUsernamePassword: (authKey, username, password) =>
    ipcRenderer.invoke("change-username-password", authKey, username, password),
  resetPassword: (authKey) => ipcRenderer.invoke("reset-password", authKey),
  getRemembered: () => ipcRenderer.invoke("login-get-remembered"),
  saveRemembered: (payload) => ipcRenderer.invoke("login-save-remembered", payload),
  clearRemembered: () => ipcRenderer.invoke("login-clear-remembered"),
  loginSuccess: () => ipcRenderer.send("login-success"),
  closeLoginWindow: () => ipcRenderer.send("close-current-window"),
  getAuthKey: () => ipcRenderer.invoke("get-auth-key"),
});
