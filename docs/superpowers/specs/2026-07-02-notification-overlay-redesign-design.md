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
├── index.tsx        — REWRITE: renderer flux listeners, settings, IPC bridge calls
├── native.ts        — REWRITE: overlay window, log file I/O, IPC handlers
├── overlay.html     — NEW: persistent overlay page; cards added/removed via IPC
└── logViewer.html   — NEW: standalone log website; populated via executeJavaScript
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

--- (`logViewer.html`)

### Access

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

All configurable in Discord → Vencord Settings → Plugins → NotificationOverlay (⚙️). Changes apply instantly with no restart.

| Setting | Type | Default | Description |
|---|---|---|---|
| `timeout` | Number | `5` | Seconds each card stays visible |
| `maxCards` | Number | `5` | Max cards on screen at once |
| `cardWidth` | Number | `420` | Overlay card width in px |
| `dmNotifications` | Boolean | `true` | Show DM notifications |
| `serverNotifications` | Boolean | `true` | Show server message notifications |
| `callNotifications` | Boolean | `true` | Show incoming call notifications |

---

## Error Handling

- **Avatar load failure:** `onerror="this.style.display='none'"` — fallback emoji shown instead
- **Image load failure:** same `onerror` pattern
- **JSON file missing/corrupt:** catch on read → treat as empty array, write fresh `[]`
- **Overlay window destroyed unexpectedly:** `ensureWindow()` recreates it on next notification
- **`discord://` deep link on unsupported OS:** `window.open()` silently fails — no user-visible error needed

---

## Out of Scope

- Clicking overlay cards to jump to messages (overlay is `focusable: false`, mouse events ignored)
- Notification sounds (handled by Discord natively)
- Read/unread state tracking in the log
- Search within the log viewer
- Multiple monitor support (always uses primary display)
