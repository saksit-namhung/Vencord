// src/userplugins/notificationOverlay/overlay-preload.js
// Shared contextBridge preload for overlay window AND log viewer window.
// Each page uses only the channels relevant to it.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__bridge", {
    // Overlay channels
    onNotif:      (cb) => ipcRenderer.on("notif-show",   (_, p)       => cb(p)),
    onTrim:       (cb) => ipcRenderer.on("notif-trim",   (_, max)     => cb(max)),
    resize:       (h)  => ipcRenderer.send("overlay-resize", h),
    hide:         ()   => ipcRenderer.send("overlay-hide"),
    // Log viewer channels
    onLogData:    (cb) => ipcRenderer.on("log-data",    (_, entries)  => cb(entries)),
    onLogCleared: (cb) => ipcRenderer.on("log-cleared", ()            => cb()),
    clearLog:     ()   => ipcRenderer.send("log-clear"),
    openUrl:      (url)=> ipcRenderer.send("log-open-url",   { url }),
    openImage:    (url)=> ipcRenderer.send("log-open-image", { url }),
});
