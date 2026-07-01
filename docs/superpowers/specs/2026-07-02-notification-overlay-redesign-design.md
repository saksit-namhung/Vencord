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

The plugin already has `index.tsx` and `native.ts`. Both are **rewritten** as part of this redesign. One new file is added:

```
src/userplugins/notificationOverlay/
├── index.tsx            — REWRITE: renderer flux listeners, settings, IPC bridge calls
├── native.ts            — REWRITE: overlay window, log file I/O, IPC handlers
├── overlay-preload.js   — NEW: contextBridge preload for overlay window (plain JS, no bundling)
└── native.ts            (logViewer HTML embedded as template literal — see below)
```

### Asset Strategy

Vencord's build system compiles TypeScript but does not automatically copy arbitrary asset files. To avoid a custom build step:

- **Overlay HTML** — embedded as a template literal constant `OVERLAY_HTML` inside `native.ts`. Loaded via `win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(OVERLAY_HTML))`.
- **Log viewer HTML** — embedded as a template literal constant `LOG_VIEWER_HTML` inside `native.ts`. Loaded the same way.
- **`overlay-preload.js`** — a plain `.js` file (no TypeScript compilation needed) placed alongside `native.ts`. Referenced via `path.join(__dirname, "overlay-preload.js")` in `webPreferences.preload`. Vencord copies non-TS files in userplugin directories to the build output alongside compiled JS. **Implementation note:** verify `__dirname` resolves correctly in Vencord's native plugin context at runtime before committing to this path strategy. If it does not, the fallback is to inline the bridge using `webContents.executeJavaScript` after `did-finish-load` instead of a preload file.

Final file list:

```
src/userplugins/notificationOverlay/
├── index.tsx            — REWRITE
├── native.ts            — REWRITE (OVERLAY_HTML and LOG_VIEWER_HTML as template literal constants)
└── overlay-preload.js   — NEW (shared preload for both BrowserWindows)
```

---

## Architecture

### Data Flow

```
Discord event (MESSAGE_CREATE / CALL_UPDATE)
  → index.tsx (renderer)
    → Native.showNotification(payload)         [IPC → main]
      → native.ts: append entry to JSON log
      → native.ts: win.webContents.send("notif-show", payload) → overlay
        → overlay: prepend card DOM node
        → card auto-removes after timeout
        → overlay sends overlay-resize → window height updates

"View Logs" button in Vencord plugin settings
  → Native.openLogViewer()                     [IPC → main]
    → native.ts: open logViewer BrowserWindow (data: URL)
    → on did-finish-load: win.webContents.send("log-data", entries)
    → log viewer: loadLogs(entries) → render timeline feed
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

After creation: `win.setIgnoreMouseEvents(true)` — the overlay is fully click-through; all mouse events pass to the window beneath it. This is intentional: clicking overlay cards is out of scope (see Out of Scope section).

Window width: `cardWidth + 16` px. Window hides when `cardCount === 0`.

The single authoritative height formula (defined in overlay page, sent to main via `overlay-resize`):
```
windowHeight = cardCount * CARD_HEIGHT + (cardCount - 1) * CARD_GAP + PADDING
// CARD_HEIGHT=100, CARD_GAP=8, PADDING=16
// 1 card → 116px, 2 cards → 224px, 5 cards → 548px
```

When the `cardWidth` setting changes, the new value takes effect on the **next notification** — the window is resized and the overlay re-renders all current cards at the new width.

### IPC Message: `notif-show`

Sent from `native.ts` → overlay window via **`win.webContents.send("notif-show", payload)`** (Electron IPC — not `executeJavaScript`). The preload exposes `ipcRenderer.on("notif-show", ...)` to the page via contextBridge.

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

**Dimensions:** `cardWidth` px wide (default 420) × 100px tall per card, 8px gap between cards

**Height constants:**
```
CARD_HEIGHT = 100   // px, fixed per card
CARD_GAP    = 8     // px between cards
PADDING     = 16    // px — window top/bottom inset
windowHeight = (cardCount * (CARD_HEIGHT + CARD_GAP)) - CARD_GAP + PADDING
```

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

### CALL_UPDATE — Call Deduplication

Ringing state is tracked entirely in **`index.tsx`** (where `CALL_UPDATE` is handled), not in `native.ts`:

```ts
const ringingChannels = new Set<string>();

flux: {
  CALL_UPDATE({ call }) {
    if (!settings.store.callNotifications) return;
    const channelId: string = call.channel_id;
    const isRinging: boolean = call?.ringing?.includes(currentUserId);

    if (isRinging && !ringingChannels.has(channelId)) {
      ringingChannels.add(channelId);
      Native.showNotification(/* call payload */);
    }
    if (!isRinging) {
      ringingChannels.delete(channelId); // call ended or answered — reset for future
    }
  }
}
```

`native.ts` receives a plain `showNotification` call and has no knowledge of call state.

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

A minimal preload (`overlay-preload.js`, shared by both BrowserWindows) exposes a unified bridge:

```js
// overlay-preload.js  — shared by overlay window AND log viewer window
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("__bridge", {
  // Overlay channels
  onNotif:  (cb) => ipcRenderer.on("notif-show",   (_, p) => cb(p)),
  resize:   (h)  => ipcRenderer.send("overlay-resize", h),
  hide:     ()   => ipcRenderer.send("overlay-hide"),
  // Log viewer channels
  onLogData:   (cb) => ipcRenderer.on("log-data",    (_, entries) => cb(entries)),
  onLogCleared:(cb) => ipcRenderer.on("log-cleared", ()           => cb()),
  clearLog:    ()   => ipcRenderer.send("log-clear"),
  openUrl:     (url)=> ipcRenderer.send("log-open-url", { url }),
});
```

Each page only uses the channels relevant to it — the overlay ignores log channels and vice versa.

### Page-Ready Sequencing

1. `native.ts` calls `win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(OVERLAY_HTML))` (embedded template literal — **not** `loadFile`)
2. Overlay page registers `window.__bridge.onNotif(handler)` on `DOMContentLoaded`
3. `native.ts` waits for the `did-finish-load` event before sending any `notif-show` messages
4. Notifications that arrive before `did-finish-load` are queued in a `pending: NotifPayload[]` array in `native.ts` and flushed once the event fires

Log viewer follows the same sequencing: `did-finish-load` fires → `native.ts` sends `log-data`.

### Full IPC Channel Table

**Overlay window:**

| Channel | Direction | Payload | Handler |
|---|---|---|---|
| `notif-show` | main → overlay | `NotifPayload` | Prepend card, resize |
| `overlay-resize` | overlay → main | `number` (height px) | `win.setSize(cardWidth + 16, height)` |
| `overlay-hide` | overlay → main | — | `win.hide()` |

**Log viewer window:**

| Channel | Direction | Payload | Handler |
|---|---|---|---|
| `log-data` | main → logViewer | `LogEntry[]` | `loadLogs(entries)` — render timeline |
| `log-clear` | logViewer → main | — | Wipe JSON to `[]`; send `log-cleared` back |
| `log-cleared` | main → logViewer | — | Clear feed in-place; show empty state |
| `log-open-url` | logViewer → main | `{ url: string }` | Validate URL starts with `discord://-/channels/`; call `shell.openExternal(url)`. Invalid URLs silently ignored. |

All external URLs are opened via `shell.openExternal` in main — never `window.open` in the renderer.

---

## Log Viewer Website

### Access

Button in Vencord plugin settings panel: **"📋 View Notification Log"**

In `index.tsx`, implemented as a setting of type `OptionType.COMPONENT` rendering a `<Button>` that calls `Native.openLogViewer()`. This is the standard Vencord pattern for action buttons in plugin settings.

`Native.openLogViewer()` → opens a new `BrowserWindow` (1000×700px, framed, not always-on-top). If a viewer window is already open and not destroyed, it is focused instead of opening a second one.

### Population

`native.ts` reads the JSON file on `did-finish-load` and sends entries via `win.webContents.send("log-data", entries)`. The log viewer page receives them via `window.__bridge.onLogData(loadLogs)`.

The viewer shows a **snapshot** of the log at the time it was opened. It does not live-update as new notifications arrive.

### IPC

All log viewer IPC channels are defined in the Full IPC Channel Table above. The log viewer uses: `log-data` (receive), `log-clear` (send), `log-cleared` (receive), `log-open-url` (send).

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

| Setting | Type | Default | Valid Range | When it takes effect |
|---|---|---|---|---|
| `timeout` | Number | `5` | 1–60 (clamped) | Next notification shown |
| `maxCards` | Number | `5` | 1–10 (clamped) | Immediately — excess oldest cards removed if current count exceeds new value |
| `cardWidth` | Number | `420` | 280–600 (clamped) | Next notification shown |
| `dmNotifications` | Boolean | `true` | — | Immediately (next event) |
| `serverNotifications` | Boolean | `true` | — | Immediately (next event) |
| `callNotifications` | Boolean | `true` | — | Immediately (next event) |

Values outside the valid range are clamped silently in `native.ts` before use. Invalid types (e.g. non-numeric) fall back to the default.

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
