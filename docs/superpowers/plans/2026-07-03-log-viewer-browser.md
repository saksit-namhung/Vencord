# Log Viewer — Browser-Based Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Electron `BrowserWindow` log viewer with a self-contained HTML file opened in the system browser, fixing the no-content bug and adding a "Clear Log" button to the plugin settings panel.

**Architecture:** `openLogViewer()` in `native.ts` now serialises `logEntries` as a JSON literal directly into the generated HTML (`buildLogViewerHtml`), writes it to disk, and calls `shell.openExternal` with a `file://` URL. All `BrowserWindow`/IPC code for the log viewer is removed. A new `clearNotificationLog` export is called from a new button in `index.tsx`.

**Tech Stack:** TypeScript (Vencord plugin API), Electron (`shell`), Node.js (`fs`, `url.pathToFileURL`), HTML/CSS/JS (embedded template), pnpm build

**Spec:** `docs/superpowers/specs/2026-07-03-log-viewer-browser-design.md`

---

## Chunk 1: native.ts + overlay-preload.js

### Task 1: Strip dead log-viewer channels from `overlay-preload.js`

**Files:**
- Modify: `src/userplugins/notificationOverlay/overlay-preload.js`

The log viewer is now a static browser page — it cannot send or receive Electron IPC. Remove the five log-viewer channels from the contextBridge, keeping only the four overlay channels.

- [ ] **Step 1: Replace the full file content**

Replace the entire contents of `src/userplugins/notificationOverlay/overlay-preload.js` with:

```js
// src/userplugins/notificationOverlay/overlay-preload.js
// contextBridge preload for the overlay window only.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__bridge", {
    onNotif: (cb) => ipcRenderer.on("notif-show", (_, p)   => cb(p)),
    onTrim:  (cb) => ipcRenderer.on("notif-trim", (_, max) => cb(max)),
    resize:  (h)  => ipcRenderer.send("overlay-resize", h),
    hide:    ()   => ipcRenderer.send("overlay-hide"),
});
```

- [ ] **Step 2: Verify the file has no `__bridge` log-viewer references**

Run: `Select-String -Path "src\userplugins\notificationOverlay\overlay-preload.js" -Pattern "onLogData|onLogCleared|clearLog|openUrl|openImage"`
Expected: no matches (empty output)

- [ ] **Step 3: Commit**

```
git add src/userplugins/notificationOverlay/overlay-preload.js
git commit -m "refactor(notif-overlay): remove dead log-viewer channels from preload"
```

---

### Task 2: Add `pathToFileURL` import to `native.ts`

**Files:**
- Modify: `src/userplugins/notificationOverlay/native.ts`

- [ ] **Step 1: Add the import**

Find this line near the top of `native.ts`:
```ts
import { join } from "path";
```

Replace it with:
```ts
import { join } from "path";
import { pathToFileURL } from "url";
```

- [ ] **Step 2: Verify**

Run: `Select-String -Path "src\userplugins\notificationOverlay\native.ts" -Pattern "pathToFileURL"`
Expected: one match on the import line

---

### Task 3: Replace `LOG_VIEWER_HTML` constant with `safeJson` + `buildLogViewerHtml`

**Files:**
- Modify: `src/userplugins/notificationOverlay/native.ts`

The static `LOG_VIEWER_HTML` constant (~170 lines) is removed. In its place, a `safeJson` helper and a `buildLogViewerHtml(entries)` function are added. The function produces the same visual UI but with data baked in, no `__bridge` calls, `discord://` links as `<a href>` tags, and image thumbnails wrapped in `<a href target="_blank">`.

- [ ] **Step 1: Delete the static `LOG_VIEWER_HTML` constant**

Find the block that begins with:
```ts
// ─── Log Viewer HTML ──────────────────────────────────────────────────────────

const LOG_VIEWER_HTML = `<!DOCTYPE html>
```

…and ends with the closing backtick + semicolon of that constant (just before the comment `// Write HTML templates to disk`). Delete the entire block including the section header comment.

- [ ] **Step 2: In its place, insert `safeJson` and `buildLogViewerHtml`**

Insert the following immediately before the comment `// Write HTML templates to disk` (i.e. where the deleted constant was):

```ts
// ─── Log Viewer HTML ─────────────────────────────────────────────────────────

function safeJson(data: any): string {
    return JSON.stringify(data)
        .replace(/<\/script>/gi, "<\\/script>")  // prevent script-tag injection
        .replace(/\u2028/g, "\\u2028")           // U+2028 LINE SEPARATOR — not valid in JS string literals
        .replace(/\u2029/g, "\\u2029");          // U+2029 PARAGRAPH SEPARATOR — same
}

function buildLogViewerHtml(entries: LogEntry[]): string {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Notification Log</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #1e1e2e; color: #cdd6f4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; min-height: 100vh; }
.topbar { background: #181825; border-bottom: 1px solid rgba(255,255,255,0.08); padding: 14px 24px; display: flex; align-items: center; gap: 12px; position: sticky; top: 0; z-index: 10; }
.topbar-title { font-size: 18px; font-weight: 700; color: #fff; }
.topbar-count { font-size: 12px; color: rgba(255,255,255,0.4); background: rgba(255,255,255,0.08); padding: 2px 10px; border-radius: 20px; }
.filters { padding: 12px 24px; display: flex; gap: 8px; background: #1e1e2e; border-bottom: 1px solid rgba(255,255,255,0.06); }
.filter { font-size: 12px; padding: 5px 14px; border-radius: 20px; cursor: pointer; border: 1px solid rgba(255,255,255,0.12); color: rgba(255,255,255,0.6); background: transparent; }
.filter.active { background: #5865f2; border-color: #5865f2; color: #fff; font-weight: 600; }
.feed { max-width: 780px; margin: 0 auto; padding: 20px 24px; }
.empty { text-align: center; color: rgba(255,255,255,0.3); padding: 60px 0; font-size: 14px; }
.day-divider { text-align: center; font-size: 11px; color: rgba(255,255,255,0.3); text-transform: uppercase; letter-spacing: 1px; padding: 12px 0 4px; position: relative; }
.day-divider::before { content: ''; position: absolute; left: 0; right: 0; top: 50%; height: 1px; background: rgba(255,255,255,0.07); }
.day-divider span { background: #1e1e2e; padding: 0 12px; position: relative; }
.entry { display: flex; gap: 14px; padding: 16px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
.entry:last-child { border-bottom: none; }
.avatar { width: 46px; height: 46px; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 20px; border: 2px solid rgba(255,255,255,0.1); object-fit: cover; }
.entry-body { flex: 1; min-width: 0; }
.entry-header { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; flex-wrap: wrap; }
.entry-name { font-size: 14px; font-weight: 700; color: #fff; }
.badge { font-size: 10px; padding: 2px 7px; border-radius: 10px; font-weight: 600; }
.badge-server { background: rgba(88,101,242,0.25); color: #7289da; }
.badge-dm { background: rgba(59,165,93,0.2); color: #3ba55d; }
.badge-call { background: rgba(237,66,69,0.2); color: #ed4245; }
.entry-server { font-size: 12px; color: #7289da; margin-bottom: 6px; }
.entry-message { font-size: 13px; color: rgba(255,255,255,0.85); line-height: 1.55; word-break: break-word; }
.entry-images { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.entry-images img { max-width: 200px; max-height: 160px; border-radius: 6px; object-fit: cover; border: 1px solid rgba(255,255,255,0.1); }
.entry-footer { display: flex; align-items: center; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
.entry-time { font-size: 11px; color: rgba(255,255,255,0.3); }
.jump-btn { font-size: 11px; color: #5865f2; background: rgba(88,101,242,0.12); border: 1px solid rgba(88,101,242,0.3); padding: 3px 10px; border-radius: 5px; cursor: pointer; text-decoration: none; display: inline-block; }
.jump-btn:hover { background: rgba(88,101,242,0.25); }
.chan-btn { font-size: 11px; color: rgba(255,255,255,0.45); background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); padding: 3px 10px; border-radius: 5px; cursor: pointer; text-decoration: none; display: inline-block; }
.chan-btn:hover { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.7); }
</style>
</head>
<body>
<div class="topbar">
  <span style="font-size:22px;">💬</span>
  <span class="topbar-title">Notification Log</span>
  <span class="topbar-count" id="count">0 notifications</span>
</div>
<div class="filters">
  <button class="filter active" data-filter="all">All</button>
  <button class="filter" data-filter="server">💬 Servers</button>
  <button class="filter" data-filter="dm">✉️ DMs</button>
  <button class="filter" data-filter="call">📞 Calls</button>
</div>
<div class="feed" id="feed">
  <div class="empty">No notifications yet.</div>
</div>
<script>
var LOG_DATA = ${safeJson(entries)};

function esc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function formatDate(ts) {
  return new Date(ts).toLocaleString(undefined, {
    weekday:"long", day:"numeric", month:"short", year:"numeric",
    hour:"2-digit", minute:"2-digit"
  });
}
function dayLabel(ts) {
  var d = new Date(ts), today = new Date();
  if (d.toDateString() === today.toDateString())
    return "Today \u2014 " + d.toLocaleDateString(undefined, {weekday:"long",day:"numeric",month:"long",year:"numeric"});
  var yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString())
    return "Yesterday \u2014 " + d.toLocaleDateString(undefined, {weekday:"long",day:"numeric",month:"long",year:"numeric"});
  return d.toLocaleDateString(undefined, {weekday:"long",day:"numeric",month:"long",year:"numeric"});
}

var allEntries = [];
var activeFilter = "all";

function renderEntries(entries) {
  var feed = document.getElementById("feed");
  var count = document.getElementById("count");
  var filtered = activeFilter === "all" ? entries : entries.filter(function(e) { return e.type === activeFilter; });
  count.textContent = entries.length + " notification" + (entries.length !== 1 ? "s" : "");
  if (filtered.length === 0) { feed.innerHTML = '<div class="empty">No notifications yet.</div>'; return; }
  var sorted = filtered.slice().sort(function(a,b) { return b.timestamp - a.timestamp; });
  var html = "";
  var lastDay = "";
  for (var i = 0; i < sorted.length; i++) {
    var e = sorted[i];
    var day = dayLabel(e.timestamp);
    if (day !== lastDay) { html += '<div class="day-divider"><span>' + esc(day) + '</span></div>'; lastDay = day; }
    var badge = ({server:"Server",dm:"DM",call:"Call"})[e.type] || e.type;
    var badgeCls = "badge-" + e.type;
    var avatarEl = e.avatarUrl
      ? '<img class="avatar" src="' + esc(e.avatarUrl) + '" onerror="this.outerHTML=\'<div class=\\"avatar\\" style=\\"background:#5865f2;font-size:20px;\\">&#x1F4AC;</div>\'">'
      : '<div class="avatar" style="background:' + (e.type==="call"?"#ed4245":e.type==="dm"?"#3ba55d":"#5865f2") + ';font-size:20px;">' + (e.type==="call"?"&#x1F4DE;":e.type==="dm"?"&#x2709;&#xFE0F;":"&#x1F4AC;") + '</div>';
    var imagesHtml = (e.imageUrls && e.imageUrls.length)
      ? '<div class="entry-images">' + e.imageUrls.map(function(u) {
          return '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer"><img src="' + esc(u) + '" onerror="this.style.display=\'none\'"></a>';
        }).join("") + '</div>'
      : "";
    var jumpUrl = e.messageId ? 'discord://-/channels/' + (e.guildId || "@me") + '/' + e.channelId + '/' + e.messageId : null;
    var chanUrl = 'discord://-/channels/' + (e.guildId || "@me") + '/' + e.channelId;
    var chanLabel = ({server:"# Open Channel",dm:"\u2709\uFE0F Open DM",call:"\uD83D\uDD0A Open Channel"})[e.type] || "Open";
    var jumpBtn = jumpUrl ? '<a class="jump-btn" href="' + esc(jumpUrl) + '">\u2197 Jump to Message</a>' : "";
    html += '<div class="entry">' + avatarEl +
      '<div class="entry-body">' +
        '<div class="entry-header"><span class="entry-name">' + esc(e.title) + '</span><span class="badge ' + badgeCls + '">' + badge + '</span></div>' +
        '<div class="entry-server">' + esc(e.serverLine) + '</div>' +
        '<div class="entry-message">' + esc(e.body) + '</div>' +
        imagesHtml +
        '<div class="entry-footer"><span class="entry-time">' + esc(formatDate(e.timestamp)) + '</span>' +
          jumpBtn +
          '<a class="chan-btn" href="' + esc(chanUrl) + '">' + chanLabel + '</a>' +
        '</div>' +
      '</div></div>';
  }
  feed.innerHTML = html;
}

function loadLogs(entries) {
  allEntries = entries;
  renderEntries(entries);
}

document.querySelectorAll(".filter").forEach(function(btn) {
  btn.addEventListener("click", function() {
    document.querySelectorAll(".filter").forEach(function(b) { b.classList.remove("active"); });
    btn.classList.add("active");
    activeFilter = btn.dataset.filter;
    renderEntries(allEntries);
  });
});

document.addEventListener("DOMContentLoaded", function() { loadLogs(LOG_DATA); });
</script>
</body>
</html>`;
}
```

- [ ] **Step 3: Verify `buildLogViewerHtml` exists and the old static constant is gone**

Run: `Select-String -Path "src\userplugins\notificationOverlay\native.ts" -Pattern "buildLogViewerHtml"`
Expected: at least one match (the function declaration — the call site is added in Task 5)

Run: `Select-String -Path "src\userplugins\notificationOverlay\native.ts" -Pattern "^const LOG_VIEWER_HTML\b"`
Expected: no matches (the static constant is removed; `LOG_VIEWER_HTML_FILE` is fine to remain)

---

### Task 4: Remove log-viewer startup write + log-viewer IPC handlers + `logViewerWin` state + `sendLogData`

**Files:**
- Modify: `src/userplugins/notificationOverlay/native.ts`

- [ ] **Step 1: Remove `LOG_VIEWER_HTML_FILE` write from startup block**

Find this block (near where `PRELOAD` is defined, just before the overlay window section):
```ts
try {
    writeFileSync(OVERLAY_HTML_FILE, OVERLAY_HTML, "utf-8");
    writeFileSync(LOG_VIEWER_HTML_FILE, LOG_VIEWER_HTML, "utf-8");
    log("HTML templates written to userData, PRELOAD =", PRELOAD);
} catch (e) {
    warn("Failed to write HTML templates —", e);
}
```

Replace it with (remove the `LOG_VIEWER_HTML_FILE` line only):
```ts
try {
    writeFileSync(OVERLAY_HTML_FILE, OVERLAY_HTML, "utf-8");
    log("Overlay HTML written to userData, PRELOAD =", PRELOAD);
} catch (e) {
    warn("Failed to write overlay HTML —", e);
}
```

- [ ] **Step 2: Remove `logViewerWin` state variable**

Find and delete this line (it is in the Log Viewer Window section):
```ts
let logViewerWin: BrowserWindow | null = null;
```

- [ ] **Step 3: Remove `sendLogData` function**

Find and delete the entire `sendLogData` function:
```ts
function sendLogData(win: BrowserWindow): void {
    win.webContents.once("did-finish-load", () => {
        win.webContents.send("log-data", logEntries);
    });
}
```

- [ ] **Step 4: Remove `log-clear` IPC handler**

Find and delete:
```ts
ipcMain.on("log-clear", (event) => {
    clearLog();
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.webContents.send("log-cleared");
});
```

- [ ] **Step 5: Remove `log-open-url` IPC handler**

Find and delete:
```ts
ipcMain.on("log-open-url", (_event, { url }: { url: string }) => {
    if (typeof url === "string" && url.startsWith("discord://-/channels/")) {
        shell.openExternal(url);
    }
    // invalid URLs silently ignored
});
```

- [ ] **Step 6: Remove `log-open-image` IPC handler**

Find and delete:
```ts
ipcMain.on("log-open-image", (_event, { url }: { url: string }) => {
    // Allow CDN image URLs only (Discord attachments and avatars)
    if (typeof url === "string" && (
        url.startsWith("https://cdn.discordapp.com/") ||
        url.startsWith("https://media.discordapp.net/")
    )) {
        shell.openExternal(url);
    }
    // non-CDN URLs silently ignored
});
```

- [ ] **Step 7: Clean up stale log-viewer section comments in `native.ts`**

Find and delete or update these now-misleading comment headers:

- The section comment `// ─── Log Viewer Window ───...` (and nearby `// IPC: log viewer → main` comment if present) — delete these, as the log viewer window no longer exists.
- In the file's top block comment or `Responsibilities` comment, remove any mention of "log viewer window" if present.

- [ ] **Step 8: Verify no log-viewer IPC handlers remain**

Run: `Select-String -Path "src\userplugins\notificationOverlay\native.ts" -Pattern "log-clear|log-open-url|log-open-image|logViewerWin|sendLogData"`
Expected: no matches

---

### Task 5: Replace `openLogViewer` and add `clearNotificationLog` export

**Files:**
- Modify: `src/userplugins/notificationOverlay/native.ts`

- [ ] **Step 1: Replace the `openLogViewer` function**

Find the existing `openLogViewer` export (starting with `export function openLogViewer`). Replace the entire function with:

```ts
export function openLogViewer(_: any): void {
    log("openLogViewer: building HTML snapshot with", logEntries.length, "entries");
    let html: string;
    try {
        html = buildLogViewerHtml(logEntries);
    } catch (e) {
        warn("openLogViewer: buildLogViewerHtml failed —", e);
        return;
    }
    try {
        writeFileSync(LOG_VIEWER_HTML_FILE, html, "utf-8");
        log("openLogViewer: wrote snapshot to", LOG_VIEWER_HTML_FILE);
    } catch (e) {
        warn("openLogViewer: failed to write HTML file —", e);
        return;
    }
    const url = pathToFileURL(LOG_VIEWER_HTML_FILE).href;
    log("openLogViewer: opening", url);
    shell.openExternal(url).catch(e => warn("openLogViewer: shell.openExternal failed —", e));
}
```

- [ ] **Step 2: Add `clearNotificationLog` export directly after `openLogViewer`**

```ts
export function clearNotificationLog(_: any): void {
    log("clearNotificationLog: clearing log");
    clearLog();
}
```

- [ ] **Step 3: Verify exports exist**

Run: `Select-String -Path "src\userplugins\notificationOverlay\native.ts" -Pattern "export function"`
Expected: lines for `showNotification`, `trimToMaxCards`, `openLogViewer`, `clearNotificationLog`

- [ ] **Step 4: Run build to verify `native.ts` compiles cleanly**

Run: `pnpm build`
Initial wait: 120 seconds.
Expected: build completes with no TypeScript errors in `notificationOverlay/native.ts`.

- [ ] **Step 5: Commit all `native.ts` changes**

```
git add src/userplugins/notificationOverlay/native.ts
git commit -m "refactor(notif-overlay): replace log viewer BrowserWindow with browser-based snapshot

- Remove static LOG_VIEWER_HTML constant and logViewerWin state
- Add safeJson helper and buildLogViewerHtml(entries) function
- openLogViewer now writes HTML to disk and calls shell.openExternal
- Add clearNotificationLog export
- Remove log-clear, log-open-url, log-open-image IPC handlers"
```

---

## Chunk 2: index.tsx + build verification

### Task 6: Add "Clear Notification Log" button to plugin settings

**Files:**
- Modify: `src/userplugins/notificationOverlay/index.tsx`

The settings object already has a `viewLogs` entry of type `OptionType.COMPONENT`. Add a `clearLog` entry directly after it.

- [ ] **Step 1: Find the `viewLogs` setting definition**

It looks like this in `index.tsx`:
```tsx
    viewLogs: {
        type: OptionType.COMPONENT,
        description: "Open the notification log",
        component: () => (
            <Button onClick={() => Native.openLogViewer()}>
                📋 View Notification Log
            </Button>
        ),
    },
```

- [ ] **Step 2: Add the `clearLog` setting directly after `viewLogs`**

The result should be:
```tsx
    viewLogs: {
        type: OptionType.COMPONENT,
        description: "Open the notification log",
        component: () => (
            <Button onClick={() => Native.openLogViewer()}>
                📋 View Notification Log
            </Button>
        ),
    },
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

- [ ] **Step 3: Verify `clearNotificationLog` is referenced and `Button.Colors.RED` compiles**

Run: `Select-String -Path "src\userplugins\notificationOverlay\index.tsx" -Pattern "clearNotificationLog|Colors.RED"`
Expected: one match each

- [ ] **Step 4: Commit**

```
git add src/userplugins/notificationOverlay/index.tsx
git commit -m "feat(notif-overlay): add Clear Notification Log button to plugin settings"
```

---

### Task 7: Build and manual verification

**Files:** (no changes — read-only verification steps)

- [ ] **Step 1: Run the final build**

Run: `pnpm build`
Initial wait: 120 seconds.
Expected: build completes with no TypeScript errors. Look for any errors in `notificationOverlay/native.ts` or `notificationOverlay/index.tsx`.

- [ ] **Step 2: Verify overlay still works (regression check)**

Launch Discord with the plugin active. Trigger an incoming message to produce a notification.
Expected: notification card still appears as an always-on-top overlay card in the top-left corner, auto-dismisses after the configured timeout, and the overlay window resizes correctly. This confirms the `overlay-preload.js` and `native.ts` overlay plumbing are unaffected.

- [ ] **Step 3: Seed test data for log viewer verification**

Trigger or receive messages so the log contains all entry types:
- At least one **server** notification (message in a server channel)
- At least one **DM** notification
- At least one message with an **image attachment** (so thumbnails appear)
- At least one **incoming call** notification (triggers via `CALL_UPDATE` — have someone call you on Discord)

This ensures all filter tabs and link types are populated for subsequent verification steps.

- [ ] **Step 4: Click "📋 View Notification Log" and verify browser opens with content**

Expected:
- Default system browser opens a local `file://` page
- Notification entries are visible (not "No notifications yet.")
- No Electron log-viewer `BrowserWindow` appears

- [ ] **Step 5: Verify filter tabs work in the browser**

Click the "💬 Servers", "✉️ DMs", "📞 Calls" tabs.
Expected: feed filters without page reload, entry counts update correctly.

- [ ] **Step 6: Verify "↗ Jump to Message" and "Open Channel" links**

Click a "↗ Jump to Message" link in the browser.
Expected: Discord opens to the correct message.

Click a "# Open Channel" / "✉️ Open DM" link.
Expected: Discord opens to the correct channel.

- [ ] **Step 7: Verify image thumbnails open in a new browser tab**

Using the image-attachment notification seeded in Step 3, locate the image thumbnail in the log viewer.
Click the thumbnail.
Expected: a new browser tab opens with the Discord CDN image URL (`cdn.discordapp.com` or `media.discordapp.net`). No Electron window opens. No `__bridge.openImage` IPC is involved.

- [ ] **Step 8: Verify "🗑 Clear Notification Log" in plugin settings**

Click "🗑 Clear Notification Log" in Discord → Vencord Settings → NotificationOverlay.
Then click "📋 View Notification Log".
Expected: browser opens a fresh page showing "No notifications yet."

- [ ] **Step 9: Confirm stale-tab behaviour**

Leave the previously opened browser tab open (from Step 4). After clearing (Step 8), switch back to that tab.
Expected: the tab still shows the old entries (it is a static snapshot and is not affected by the clear).

- [ ] **Step 10: Inspect the generated HTML file for cleanliness**

After clicking "📋 View Notification Log" at least once, find `vencord-notif-logviewer.html` in the Discord `userData` folder (typically `%APPDATA%\discord\` on Windows). Run:

```
Select-String -Path "$env:APPDATA\discord\vencord-notif-logviewer.html" -Pattern "__bridge|onLogData|clearBtn"
```
Expected: no matches — file is a standalone HTML document with embedded `LOG_DATA`.

- [ ] **Step 11: Commit final verification**

```
git add -A
git commit -m "chore(notif-overlay): log viewer browser migration complete"
```
