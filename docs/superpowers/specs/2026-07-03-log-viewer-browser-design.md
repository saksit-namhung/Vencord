# Log Viewer — Browser-Based Redesign

**Date:** 2026-07-03
**Status:** Approved
**Scope:** `src/userplugins/notificationOverlay/`

---

## Problem

The existing log viewer opens an Electron `BrowserWindow` and populates it with notification data via IPC (`log-data` event). In practice the UI skeleton renders but the data never arrives — most likely because the Vencord preload patcher replaces the custom preload, leaving `__bridge` undefined in the log viewer renderer. The `__bridge.onLogData(loadLogs)` call throws silently and the callback is never registered, so the page shows "No notifications yet." regardless of log contents.

Additionally, the user prefers the log to open in the system browser rather than an Electron window.

---

## Approach

**Embed data in the HTML at open time, write to disk, open with `shell.openExternal`.**

`openLogViewer()` calls `buildLogViewerHtml(logEntries)` to produce a fully self-contained HTML file with the notification data serialised as a JSON literal. The file is written to disk (overwriting the previous snapshot) and opened with `shell.openExternal("file:///...")`. No `BrowserWindow`, no IPC, no preload needed.

---

## Files Changed

| File | Change |
|---|---|
| `native.ts` | Replace `LOG_VIEWER_HTML` constant + `openLogViewer` + `sendLogData` with `buildLogViewerHtml` function + updated `openLogViewer`; add `clearNotificationLog` export; remove `log-clear`, `log-open-url`, `log-open-image` IPC handlers; remove `logViewerWin` state |
| `index.tsx` | Add `clearLog` `OptionType.COMPONENT` setting rendering a red "🗑 Clear Notification Log" button |
| `overlay-preload.js` | Remove log-viewer-only channels: `onLogData`, `onLogCleared`, `clearLog`, `openUrl`, `openImage` |

**Unchanged:** overlay window, overlay IPC, notification triggering (`MESSAGE_CREATE` / `CALL_UPDATE`), log storage (JSON file), all overlay behaviour.

---

## Architecture

### `buildLogViewerHtml(entries: LogEntry[]): string`

Replaces the static `LOG_VIEWER_HTML` template. Differences from the current template:

- **Data embedding:** `var LOG_DATA = ${JSON.stringify(entries)};` at the top of the inline `<script>` block.
- **Initialisation:** `document.addEventListener("DOMContentLoaded", () => loadLogs(LOG_DATA));` — no IPC, no `__bridge`.
- **Clear button removed** from the top bar.
- **`discord://` links** rendered as `<a href="discord://..." >` — the OS/browser dispatches the protocol to Discord.
- **Image thumbnails** wrapped in `<a href="..." target="_blank">` — click opens the full image in a new browser tab.
- **No `__bridge` references** anywhere in the generated page.

### `openLogViewer(_: any): void`

```
1. html = buildLogViewerHtml(logEntries)
2. writeFileSync(LOG_VIEWER_HTML_FILE, html, "utf-8")   // overwrite — always fresh snapshot
3. url = "file:///" + LOG_VIEWER_HTML_FILE.replace(/\\/g, "/")
4. shell.openExternal(url)
```

- Each button click produces a fresh snapshot and opens a new browser tab.
- If `writeFileSync` throws: log the error, return silently.
- `logViewerWin` state variable and `sendLogData()` helper are removed entirely.

### `clearNotificationLog(_: any): void` (new export)

```ts
export function clearNotificationLog(_: any): void {
    clearLog(); // wipes logEntries + writes [] to JSON file
}
```

### Plugin Settings (`index.tsx`)

Two buttons in the Vencord plugin settings panel:

```
[ 📋 View Notification Log   ]
[ 🗑 Clear Notification Log  ]
```

`clearLog` setting:

```tsx
clearLog: {
    type: OptionType.COMPONENT,
    description: "Clear all saved notification history",
    component: () => (
        <Button color={Button.Colors.RED} onClick={() => Native.clearNotificationLog()}>
            🗑 Clear Notification Log
        </Button>
    ),
},
```

No confirmation dialog — consistent with the original spec.

### `overlay-preload.js` cleanup

Remove channels that were only used by the log viewer window (now a browser page):

```js
// REMOVE:
onLogData:    (cb) => ipcRenderer.on("log-data",    (_, entries) => cb(entries)),
onLogCleared: (cb) => ipcRenderer.on("log-cleared", ()           => cb()),
clearLog:     ()   => ipcRenderer.send("log-clear"),
openUrl:      (url)=> ipcRenderer.send("log-open-url",   { url }),
openImage:    (url)=> ipcRenderer.send("log-open-image", { url }),
```

Keep all overlay channels (`onNotif`, `onTrim`, `resize`, `hide`).

---

## IPC Changes

### Handlers removed from `native.ts`

| Channel | Reason |
|---|---|
| `log-clear` | Browser page cannot send IPC; clear moved to plugin settings |
| `log-open-url` | Browser handles `discord://` protocol natively |
| `log-open-image` | Browser opens URLs with `target="_blank"` |

### Handlers unchanged

All overlay IPC handlers (`overlay-resize`, `overlay-hide`) are unaffected.

---

## Error Handling

| Case | Behaviour |
|---|---|
| `writeFileSync` fails | Log warning, return — browser not opened |
| `logEntries` empty | Valid state — `buildLogViewerHtml([])` renders "No notifications yet." empty state |
| Browser not available | `shell.openExternal` is a no-op / logs system error; no crash |

---

## Out of Scope

- Live-updating the browser tab as new notifications arrive (snapshot model only)
- Clearing the log from within the browser tab
- Search within the log viewer
- Any changes to the overlay window behaviour
