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
bridge`.
- **Clear button removed** from the top bar.
- **Data embedding:** `var LOG_DATA = ${safeJson(entries)};` at the top of the inline `<script>` block, where `safeJson` is:
  ```ts
  JSON.stringify(entries)
    .replace(/<\/script>/gi, "<\\/script>")   // prevent script-tag injection
    .replace(/\u2028/g, "\\u2028")            // U+2028 LINE SEPARATOR — invalid in JS string literals
    .replace(/\u2029/g, "\\u2029");           // U+2029 PARAGRAPH SEPARATOR — same
  ```
- **Initialisation:** `document.addEventListener("DOMContentLoaded", () => loadLogs(LOG_DATA));` — no IPC, no `__
- **`discord://` links** rendered as `<a href="discord://..." >` — the OS/browser dispatches the protocol to Discord.
- **Image thumbnails** wrapped in `<a href="..." target="_blank">` — click opens the full image in a new browser tab.
- **No `__bridge` references** anywhere in the generated page.

### `openLogViewer(_: any): void`

```
1. html = buildLogViewerHtml(logEntries)
2. writeFileSync(LOG_VIEWER_HTML_FILE, html, "utf-8")   // overwrite — always fresh snapshot
3. url = pathToFileURL(LOG_VIEWER_HTML_FILE).href
        (Node's url.pathToFileURL handles Windows drive letters, backslashes, spaces, non-ASCII)
4. shell.openExternal(url).catch(e => warn("openLogViewer: shell.openExternal failed —", e))
```

- Each button click writes a new HTML file and calls `shell.openExternal`, which opens a new browser tab (or window, depending on browser settings — both are acceptable).
- The shared `LOG_VIEWER_HTML_FILE` path is overwritten on each open. Tabs that are **already loaded** are unaffected: they hold an in-memory copy of the HTML they originally loaded; overwriting the file on disk does not change them. If the user manually refreshes a stale tab, they will see the current state of the file.
- `pathToFileURL` from Node's built-in `url` module is used for correct cross-platform file URL construction (handles Windows drive letters, backslashes, spaces, and non-ASCII characters in the `userData` path).
- If `writeFileSync` throws: log the error and return — browser is not opened. The on-disk file may be left in an inconsistent state; the next successful open will overwrite it.
- `shell.openExternal` returns a Promise; rejection is caught and logged as a warning. No user-visible error is shown (consistent with `discord://` deep-link failure handling elsewhere in the plugin).
- `logViewerWin` state variable and `sendLogData()` helper are removed entirely.

### `clearNotificationLog(_: any): void` (new export)

```ts
export function clearNotificationLog(_: any): void {
    clearLog(); // wipes logEntries + writes [] to JSON file
}
```

Clearing the log does **not** affect any already-open browser tabs — those tabs hold an in-memory copy of the HTML and are not aware that the source file has changed. Open tabs become stale immediately after a clear; they remain readable as a historical snapshot until the user closes or refreshes them. The next click of "📋 View Notification Log" will open a fresh snapshot reflecting the cleared (empty) state.

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

### URL / data trust boundary

All data embedded in the generated HTML originates from `logEntries`, which are written by `appendLog()` in `native.ts` (main process) — not from untrusted renderer input. Fields that appear in URLs (`channelId`, `guildId`, `messageId`, `avatarUrl`, `imageUrls`) are stored verbatim from Discord's own event payloads.

- **`discord://` deep links**: `channelId`, `guildId`, `messageId` are Discord snowflakes (numeric strings). They are HTML-escaped by the `esc()` function inside `buildLogViewerHtml` before being rendered into `href` attributes. Clicking these links dispatches a protocol-handler open to the OS — no HTTP fetch occurs. No additional validation needed beyond HTML-escaping.
- **`avatarUrl` / `imageUrls`**: Discord CDN URLs (`cdn.discordapp.com` / `media.discordapp.net`). They are HTML-escaped before rendering into `src` and `href` attributes. Clicking image links opens a new browser tab to the CDN URL — a standard browser navigation, not a fetch from a `file://` origin. The main-process CDN allowlist (`log-open-image`) is intentionally removed; no cross-origin fetching is performed from the `file://` page itself.

No raw `innerHTML` injection of unescaped user-controlled strings. The `safeJson` escaping (plus `esc()` HTML-escaping inside `buildLogViewerHtml`) forms the complete trust boundary for injected content.

### Viewer UI behaviour

All existing log viewer UI features are preserved unchanged: filter tabs (All / Servers / DMs / Calls), day-group dividers, entry layout (avatar, name, badge, server line, message body, images, footer), and "↗ Jump to Message" / channel-open buttons. The only removal is the "🗑 Clear Log" button from the top bar.

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
| `log-open-image` | Removed along with main-process CDN URL allowlist (intentional). Images are now direct `<a href target="_blank">` links; the browser's own security model applies. Only Discord CDN avatar and attachment URLs are stored in the log, so risk is low. |

### Handlers unchanged

All overlay IPC handlers (`overlay-resize`, `overlay-hide`) are unaffected.

---

## Error Handling

| Case | Behaviour |
|---|---|
| `writeFileSync` fails in `openLogViewer` | Log warning, return — browser not opened; on-disk file may be stale |
| `shell.openExternal` rejects | Catch and log warning; no user-visible error |
| `logEntries` empty | Valid state — `buildLogViewerHtml([])` renders the "No notifications yet." empty state |
| `writeFileSync` fails in `clearNotificationLog` | `clearLog()` catches the write error and logs a warning; `logEntries` is wiped in memory regardless, so the in-memory state is cleared even if the file write failed. The file will be corrected on the next successful `saveLog()` call (e.g. when the next notification arrives). |

---

## Out of Scope

- Live-updating the browser tab as new notifications arrive (snapshot model only)
- Clearing the log from within the browser tab
- Search within the log viewer
- Any changes to the overlay window behaviour
