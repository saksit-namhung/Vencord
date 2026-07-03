// src/userplugins/notificationOverlay/overlay-preload.js
// contextBridge preload for the overlay window only.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__bridge", {
    onNotif: (cb) => ipcRenderer.on("notif-show", (_, p)   => cb(p)),
    onTrim:  (cb) => ipcRenderer.on("notif-trim", (_, max) => cb(max)),
    resize:  (h)  => ipcRenderer.send("overlay-resize", h),
    hide:    ()   => ipcRenderer.send("overlay-hide"),
});
