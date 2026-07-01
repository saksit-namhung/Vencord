# NotificationOverlay Redesign — Design Spec

**Date:** 2026-07-02
**Status:** Approved
**Scope:** Vencord userplugin `src/userplugins/notificationOverlay/`

---

## Overview

Upgrade the existing `NotificationOverlay` Vencord plugin with three major improvements:

1. **Stackable overlay** — up to 5 notification cards visible simultaneously, stacked vertically in the top-left corner of the screen
2. **Expanded card design** — larger Compact+ cards showing full username, server/channel line, and up to 2-line message body (no timestamp in overlay)
3. **Notification log website** — persistent JSON log of all notifications, viewable as a timeline feed in an Electron BrowserWindow with jump-to-message links

---

## Files

The plugin already has `index.tsx` and `native.ts`. Both are **rewritten** as part of this redesign. Two new files are added:

```
src/userplugins/notificationOverlay/
├── index.tsx            — REWRITE: renderer flux listeners, settings, IPC bridge calls
├── native.ts            — REWRITE: overlay window, log file I/O, IPC handlers
├── overlay.html         — NEW: persistent overlay page; cards added/removed via IPC
├── overlay-preload.js   — NEW: contextBridge preload for overlay window
└── logViewer.html       — NEW: standalone log website; populated via executeJavaScript
```

---

## Architecture

### Data Flow

```
Discord event (MESSAGE_CREATE / CALL_UPDATE)
  → index.tsx (renderer)
    → Native.showNotification(payload)         [IPC → main]
      → native.ts: append entry to JSON log
      → native.ts: send IPC → overlay window   [notif-show]
        → overlay.html: prepend card DOM node
        → card auto-removes after timeout
        → window resizes to fit remaining cards

"View Logs" button in Vencord plugin settings
  → Native.openLogViewer()                     [IPC → main]
    → native.ts: open logViewer BrowserWindow
    → native.ts: read JSON → executeJavaScript("loadLogs(...)")
    → logViewer.html: render timeline feed
```

### Key Principle

`overlay.html` is loaded **once** on first notification and stays alive for the Discord session. Every subsequent notification is a lightweight IPC message — no full-page reload, no visual flash.

---

## Overlay Window

### BrowserWindow Config (`native.ts`)

| Property | Value |
|---|---|
| Width | 436px (420px card + 16px padding) |
| Height | Dynamic — resized on each card add/remove |
| Position | `x: 16, y: 16` (top-left, 16px inset) |
| `frame` | `false` |
| `transparent` | `true` |
| `alwaysOnTop` | `true` (`"screen-saver"` level) |
| `focusable` | `false` |
| `skipTaskbar` | `true` |
| `resizable` | `false` |
| `movable` | `false` |

Window width formula: `cardWidth + 16` px (16px padding). Window height formula: `(cardCount × 108) + 16` px. Window hides when `cardCount === 0`.

When the `cardWidth` setting changes, the new value takes effect on the **next notification** — the window is resized and `overlay.html` re-renders all current cards at the new width.

### IPC Message: `notif-show`

Sent from `native.ts` → `overlay.html` via `webContents.executeJavaScript`:

```ts
interface NotifPayload {
  id: string;           // unique: `${Date.now()}-${Math.random().toString(36).slice(2,7)}`
  title: string;        // username / "📞 Incoming Call"
  serverLine: string;   // "#channel · Server Name" | "Direct Message" | "Voice Chat"
  body: string;         // message text, stripped of Discord markup (see rules below)
  avatarUrl: string;    // CDN URL or "" for calls
  type: "dm" | "server" | "call";
  timeout: number;      // seconds from settings
}
```

### Card Lifecycle (`overlay.html`)

1. Receive `notif-show` payload
2. Create card DOM element, **prepend** to stack (newest on top)
3. If `cardCount > maxCards` → remove last (oldest) card immediately
4. Resize window: `ipcRenderer.send("overlay-resize", newHeight)`
5. Each card sets its own `setTimeout(timeout * 1000)` → removes itself → resize again
6. When `cardCount === 0` → `ipcRenderer.send("overlay-hide")`

---

## Card Design (Compact+)

**Dimensions:** `cardWidth` px wide (default 420) × ~100px tall per card, 8px gap between cards

**Layout:**
```
┌─────────────────────────────────────────────────┐
│  [Avatar]  Username                             │
│  40×40px   #channel · Server Name   (blue)      │
│            Message body, max 2 lines, ellipsis  │
└─────────────────────────────────────────────────┘
```

**Visual details:**
- Background: `rgba(15, 15, 18, 0.96)`, `border-radius: 10px`
- Border: `1px solid rgba(255,255,255,0.10)` — newest card gets `rgba(88,101,242,0.5)` (Discord blurple)
- Avatar: 40×40px, circular, `border: 2px solid rgba(88,101,242,0.6)`; fallback emoji `💬` or `📞`
- Username: `13px`, `font-weight: 700`, white
- Server line: `11px`, `color: #7289da`
- Message body: `12px`, `color: rgba(255,255,255,0.82)`, `-webkit-line-clamp: 2`
- Older cards fade to `opacity: 0.75` as more cards stack
- **No timestamp** — all cards in overlay are current

---

## Log Storage

### File Location

```
{app.getPath("userData")}/vencord-notification-log.json
```

### Entry Schema

```ts
interface LogEntry {
  id: string;
  timestamp: number;          // Unix ms
  type: "dm" | "server" | "call";
  title: string;              // username / "📞 Incoming Call"
  serverLine: string;
  body: string;
  avatarUrl: string;
  imageUrls: string[];        // message attachment image URLs (empty for calls)
  channelId: string;
  guildId: string | null;     // null for DMs
  messageId: string | null;   // null for calls
}
```

### Lifecycle

- **On `showNotification`:** append entry to in-memory array → write full array to JSON file
- **On plugin start (Discord launch):** read JSON → filter out entries where `Date.now() - timestamp > 30 * 24 * 60 * 60 * 1000` → write pruned array back
- **On "Clear Log":** wipe array → write empty `[]` to JSON

### Discord Markup Stripping Rules

Applied in `index.tsx` before passing body to native:

| Pattern | Replacement |
|---|---|
| `<@!?(\d+)>` | `@user` |
| `<#(\d+)>` | `#channel` |
| `<@&(\d+)>` | `@role` |
| `<:[^:]+:\d+>` | `[emoji]` |
| `<a:[^:]+:\d+>` | `[emoji]` |
| `\*\*(.+?)\*\*` | `$1` (strip bold) |
| `__(.+?)__` | `$1` (strip underline) |
| `` `(.+?)` `` | `$1` (strip inline code) |

---

## Notification Trigger Rules (`index.tsx`)

### MESSAGE_CREATE

A notification is shown only when **all** of the following are true:

| Condition | Detail |
|---|---|
| Not optimistic | `optimistic === false` |
| Not own message | `message.author.id !== UserStore.getCurrentUser().id` |
| Not a bot | `message.author.bot !== true` |
| Should notify | `notificationsShouldNotify(message, message.channel_id)` returns true (handles muted channels, suppressed notifications, Do Not Disturb) |
| Channel exists | `ChannelStore.getChannel(message.channel_id)` is non-null |
| Setting enabled | DM/Group DM → `dmNotifications`; server channel → `serverNotifications` |

### CALL_UPDATE

A call notification is shown only when:
- `call.ringing` array includes the current user's ID
- `settings.store.callNotifications` is true
- Deduplication: a call notification for the same `channel_id` is not shown again until the call stops ringing (tracked via a `Set<string>` of active ringing channel IDs in `native.ts`, cleared on next `CALL_UPDATE` where the channel is no longer ringing)

---

## Overlay IPC Contract

### webPreferences for `overlay.html` BrowserWindow

```ts
webPreferences: {
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: false,          // must be false to allow preload
  preload: path.join(__dirname, "overlay-preload.js"),
}
```

A minimal preload (`overlay-preload.js`, also a new file) exposes a bridge:

```ts
// overlay-preload.js
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("__bridge", {
  onNotif: (cb: (p: NotifPayload) => void) => ipcRenderer.on("notif-show", (_, p) => cb(p)),
  resize:  (h: number) => ipcRenderer.send("overlay-resize", h),
  hide:    ()          => ipcRenderer.send("overlay-hide"),
});
```

### Page-Ready Sequencing

1. `native.ts` calls `win.loadFile("overlay.html")`
2. `overlay.html` fires `window.__bridge.onNotif(handler)` in its `<script>` on DOMContentLoaded
3. `native.ts` waits for the `did-finish-load` event before sending any `notif-show` messages
4. Notifications that arrive before `did-finish-load` are queued in a `pending: NotifPayload[]` array in `native.ts` and flushed after the event fires

### Full IPC Channel Table

| Channel | Direction | Payload | Handler |
|---|---|---|---|
| `notif-show` | main → overlay | `NotifPayload` | Prepend card, resize |
| `overlay-resize` | overlay → main | `{ height: number }` | `win.setSize(cardWidth + 16, height)` |
| `overlay-hide` | overlay → main | — | `win.hide()` |
| `log-clear` | logViewer → main | — | Wipe JSON, send `log-cleared` |
| `log-cleared` | main → logViewer | — | Viewer clears feed in-place |
| `log-open-url` | logViewer → main | `{ url: string }` | `shell.openExternal(url)` |

All external URLs (Discord deep links, image thumbnails) are opened via `shell.openExternal` in main — never `window.open` in the renderer.

---

## Log Viewer Website (`logViewer.html`)

Button in Vencord plugin settings panel: **"📋 View Notification Log"**
Calls `Native.openLogViewer()` → opens a new `BrowserWindow` (1000×700px, framed, not always-on-top).

### Population

`native.ts` reads the JSON file and calls:
```js
webContents.executeJavaScript(`loadLogs(${JSON.stringify(entries)})`)
```

The viewer shows a **snapshot** of the log at the time it was opened. It does not live-update as new notifications arrive.

### IPC Surface (viewer → main)

| IPC channel | Direction | Payload | Effect |
|---|---|---|---|
| `log-clear` | renderer → main | — | Wipes JSON file to `[]`; main sends `log-cleared` back |
| `log-cleared` | main → renderer | — | Viewer re-renders with empty feed and shows "No notifications yet" state |
| `log-open-url` | renderer → main | `{ url: string }` | Main calls `shell.openExternal(url)` to open Discord deep link |

**Clear Log flow:** User clicks "🗑 Clear Log" → renderer sends `log-clear` → main wipes file → main sends `log-cleared` → viewer clears feed in-place (no window close/reopen).

### Layout

**Top bar (sticky):**
- Discord bell icon + "Notification Log" title
- Entry count badge
- "🗑 Clear Log" button (red, calls IPC back to native to wipe JSON)

**Filter tabs:**
`All` · `💬 Servers` · `✉️ DMs` · `📞 Calls` — client-side JS filter, no reload

**Timeline feed** (newest first, max-width 780px, centered):

Each entry shows:
- Avatar (46×46px, circular)
- **Username** + type badge (`Server` / `DM` / `Call`)
- **Server line:** `#channel · Server Name` or "Direct Message" (Discord blue)
- **Full message body** — no line clamp, all text visible
- **Images** — attachment images rendered as thumbnails (click → opens full size in new window)
- **Day dividers** between date groups (e.g. "Today — Wednesday, 2 July 2026")
- **Footer row:**
  - Timestamp: `Wednesday 2 Jul 2026, 9:12 PM`
  - **↗ Jump to Message** button → opens `discord://-/channels/{guildId|@me}/{channelId}/{messageId}` (hidden for calls)
  - **# Open Channel / ✉️ Open DM / 🔊 Open Channel** button → opens `discord://-/channels/{guildId|@me}/{channelId}`

---

## Plugin Settings

All configurable in Discord → Vencord Settings → Plugins → NotificationOverlay (⚙️). No Discord restart required.

| Setting | Type | Default | When it takes effect |
|---|---|---|---|
| `timeout` | Number | `5` | Next notification shown |
| `maxCards` | Number | `5` | Immediately — if current card count exceeds new value, excess oldest cards are removed |
| `cardWidth` | Number | `420` | Next notification shown — window and all cards resize at that point |
| `dmNotifications` | Boolean | `true` | Immediately (next event) |
| `serverNotifications` | Boolean | `true` | Immediately (next event) |
| `callNotifications` | Boolean | `true` | Immediately (next event) |

---

## Error Handling

- **Avatar load failure:** `onerror="this.style.display='none'"` — fallback emoji shown instead
- **Image load failure:** same `onerror` pattern
- **JSON file missing/corrupt:** catch on read → treat as empty array, write fresh `[]`
- **Overlay window destroyed unexpectedly:** `ensureWindow()` recreates it and reloads `overlay.html` on next notification; pending queue mechanism handles the ready-sequencing again
- **`discord://` deep link:** opened via `shell.openExternal` in main process — silently no-ops if Discord is not installed; no user-visible error needed
- **logViewer opened twice:** if a `logViewer` window already exists and is not destroyed, `openLogViewer()` focuses it instead of opening a second one

---

## Out of Scope

- Clicking overlay cards to jump to messages (overlay is `focusable: false`, mouse events ignored)
- Notification sounds (handled by Discord natively)
- Read/unread state tracking in the log
- Search within the log viewer
- Multiple monitor support (always uses primary display)
