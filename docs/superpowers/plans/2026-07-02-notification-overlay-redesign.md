# NotificationOverlay Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the NotificationOverlay Vencord userplugin to support stackable notification cards (top-left, up to 5), an expanded Compact+ card design, and a persistent JSON notification log viewable as a timeline website inside Discord.

**Architecture:** A single persistent always-on-top overlay BrowserWindow receives cards via Electron IPC (not page reloads). Both the overlay and log viewer share one preload file (`overlay-preload.js`) that exposes a contextBridge. All HTML is embedded as template literals in `native.ts` to avoid asset bundling issues.

**Tech Stack:** TypeScript (Vencord plugin API), Electron (BrowserWindow, IPC, shell), Node.js fs (JSON log), HTML/CSS/JS (embedded templates), pnpm build

**Spec:** `docs/superpowers/specs/2026-07-02-notification-overlay-redesign-design.md`

---

## Chunk 1: Preload file + log types + JSON I/O

### Task 1: Create `overlay-preload.js`

**Files:**
- Create: `src/userplugins/notificationOverlay/overlay-preload.js`

- [ ] **Step 1: Create the preload file**

```js
// src/userplugins/notificationOverlay/overlay-preload.js
// Shared contextBridge preload for overlay window AND log viewer window.
// Each page uses only the channels relevant to it.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__bridge", {
    // Overlay channels
    onNotif:     (cb) => ipcRenderer.on("notif-show",   (_, p)       => cb(p)),
    resize:      (h)  => ipcRenderer.send("overlay-resize", h),
    hide:        ()   => ipcRenderer.send("overlay-hide"),
    // Log viewer channels
    onLogData:   (cb) => ipcRenderer.on("log-data",    (_, entries)  => cb(entries)),
    onLogCleared:(cb) => ipcRenderer.on("log-cleared", ()            => cb()),
    clearLog:    ()   => ipcRenderer.send("log-clear"),
    openUrl:     (url)=> ipcRenderer.send("log-open-url", { url }),
    openImage:   (url)=> ipcRenderer.send("log-open-image", { url }),
});
```

- [ ] **Step 2: Verify the file exists**

Run: `Test-Path "D:\Projects\Vencord\src\userplugins\notificationOverlay\overlay-preload.js"`
Expected: `True`

- [ ] **Step 3: Commit**

```
git add src/userplugins/notificationOverlay/overlay-preload.js
git commit -m "feat(notif-overlay): add shared contextBridge preload"
```

---

### Task 2: Rewrite `native.ts` — types, constants, log I/O

**Files:**
- Modify: `src/userplugins/notificationOverlay/native.ts`

Replace the entire file. Build up in stages. Start with types and log I/O only (no windows yet).

- [ ] **Step 1: Replace native.ts with types + log I/O skeleton**

```ts
/*
 * NotificationOverlay — native.ts
 * Runs in Electron main process.
 * Responsibilities: overlay window, log viewer window, JSON log I/O.
 */

import { app, BrowserWindow, ipcMain, screen, shell } from "electron";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// ─── Constants ───────────────────────────────────────────────────────────────

const CARD_HEIGHT = 100;  // px per card
const CARD_GAP    = 8;    // px gap between cards
const PADDING     = 16;   // px top+bottom window inset
const LOG_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days in ms
const LOG_FILE    = join(app.getPath("userData"), "vencord-notification-log.json");

// ─── Types ───────────────────────────────────────────────────────────────────

export interface NotifPayload {
    id: string;
    title: string;
    serverLine: string;
    body: string;
    avatarUrl: string;
    type: "dm" | "server" | "call";
    timeout: number;
}

export interface LogEntry {
    id: string;
    timestamp: number;
    type: "dm" | "server" | "call";
    title: string;
    serverLine: string;
    body: string;
    avatarUrl: string;
    imageUrls: string[];
    channelId: string;
    guildId: string | null;
    messageId: string | null;
}

// ─── Log I/O ─────────────────────────────────────────────────────────────────

let logEntries: LogEntry[] = [];

function loadLog(): void {
    try {
        if (!existsSync(LOG_FILE)) { logEntries = []; return; }
        const raw = readFileSync(LOG_FILE, "utf-8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error("not an array");
        const cutoff = Date.now() - LOG_MAX_AGE;
        logEntries = parsed.filter((e: LogEntry) => e.timestamp > cutoff);
        writeFileSync(LOG_FILE, JSON.stringify(logEntries), "utf-8");
    } catch {
        logEntries = [];
        writeFileSync(LOG_FILE, "[]", "utf-8");
    }
}

function saveLog(): void {
    try {
        writeFileSync(LOG_FILE, JSON.stringify(logEntries), "utf-8");
    } catch { /* silently ignore write failures */ }
}

function appendLog(entry: LogEntry): void {
    logEntries.push(entry);
    saveLog();
}

function clearLog(): void {
    logEntries = [];
    saveLog();
}

// Called once at module load — prunes entries older than 30 days.
loadLog();

// ─── Settings helpers ─────────────────────────────────────────────────────────

function clamp(val: number, min: number, max: number, fallback: number): number {
    if (typeof val !== "number" || isNaN(val)) return fallback;
    return Math.max(min, Math.min(max, val));
}

// Placeholder exports — overlay + viewer added in later tasks
export function showNotification(_: any, payload: NotifPayload & {
    imageUrls: string[];
    channelId: string;
    guildId: string | null;
    messageId: string | null;
}): void {
    const entry: LogEntry = {
        id:         payload.id,
        timestamp:  Date.now(),
        type:       payload.type,
        title:      payload.title,
        serverLine: payload.serverLine,
        body:       payload.body,
        avatarUrl:  payload.avatarUrl,
        imageUrls:  payload.imageUrls,
        channelId:  payload.channelId,
        guildId:    payload.guildId,
        messageId:  payload.messageId,
    };
    appendLog(entry);
    // Overlay window integration added in Task 3
}

export function openLogViewer(_: any): void {
    // Log viewer window integration added in Task 5
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `pnpm tsc --noEmit 2>&1 | Select-Object -First 30`
Expected: no errors related to `notificationOverlay/native.ts`

- [ ] **Step 3: Commit**

```
git add src/userplugins/notificationOverlay/native.ts
git commit -m "feat(notif-overlay): add log types, I/O, and clamp helper to native.ts"
```

---

## Chunk 2: Overlay window + OVERLAY_HTML

### Task 3: Add overlay window + OVERLAY_HTML to `native.ts`

**Files:**
- Modify: `src/userplugins/notificationOverlay/native.ts`

Add the `OVERLAY_HTML` constant, `ensureOverlay()`, and the overlay IPC handlers. Also wire `showNotification` to use the overlay.

- [ ] **Step 1: Add OVERLAY_HTML constant after the `clamp` helper**

Append this block to `native.ts` (above the `showNotification` export):

```ts
// ─── Overlay HTML ─────────────────────────────────────────────────────────────

const OVERLAY_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; background: transparent; overflow: hidden; }
#stack {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
}
.card {
    width: 100%;
    background: rgba(15, 15, 18, 0.96);
    border: 1px solid rgba(255,255,255,0.10);
    border-radius: 10px;
    padding: 12px 14px;
    display: flex;
    gap: 10px;
    align-items: flex-start;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #fff;
    height: 100px;
    overflow: hidden;
    flex-shrink: 0;
}
.card.newest { border-color: rgba(88,101,242,0.5); }
.card.old { opacity: 0.75; }
.avatar {
    width: 40px; height: 40px;
    border-radius: 50%;
    object-fit: cover;
    flex-shrink: 0;
    border: 2px solid rgba(88,101,242,0.6);
}
.avatar-fallback {
    width: 40px; height: 40px;
    border-radius: 50%;
    background: #5865f2;
    display: flex; align-items: center; justify-content: center;
    font-size: 18px; flex-shrink: 0;
}
.txt { flex: 1; min-width: 0; overflow: hidden; }
.title {
    font-size: 13px; font-weight: 700; color: #fff;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.server {
    font-size: 11px; color: #7289da;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    margin-bottom: 4px;
}
.body {
    font-size: 12px; color: rgba(255,255,255,0.82);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}
</style>
</head>
<body>
<div id="stack"></div>
<script>
const CARD_HEIGHT = 100, CARD_GAP = 8, PADDING = 16;

function calcHeight(count) {
    if (count === 0) return 0;
    return count * CARD_HEIGHT + (count - 1) * CARD_GAP + PADDING;
}

function esc(s) {
    return String(s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function updateClasses() {
    const cards = stack.children;
    for (let i = 0; i < cards.length; i++) {
        cards[i].classList.toggle("newest", i === 0);        // index 0: blurple border
        cards[i].classList.toggle("old",    i >= 2);         // index 2+: opacity 0.75; index 1: no modifier (full opacity, no border)
    }
}

function resize() {
    const h = calcHeight(stack.children.length);
    window.__bridge.resize(h);
    if (stack.children.length === 0) window.__bridge.hide();
}

function removeCard(el) {
    el.remove();
    updateClasses();
    resize();
}

const stack = document.getElementById("stack");

window.__bridge.onNotif(function(p) {
    // Enforce maxCards: remove oldest if over limit
    // maxCards is embedded in the payload timeout field is not — pass maxCards via payload
    // (native.ts sends maxCards in payload, we use p.maxCards)
    while (p.maxCards && stack.children.length >= p.maxCards) {
        stack.lastElementChild.remove();
    }

    const avatar = p.avatarUrl
        ? \`<img class="avatar" src="\${esc(p.avatarUrl)}" onerror="this.outerHTML='<div class=\\\\"avatar-fallback\\\\">\${p.type === \\"call\\" ? \\"📞\\" : \\"💬\\"}</div>'">\`
        : \`<div class="avatar-fallback">\${p.type === "call" ? "📞" : "💬"}</div>\`;

    const card = document.createElement("div");
    card.className = "card newest";
    card.dataset.id = p.id;
    card.innerHTML = \`
        \${avatar}
        <div class="txt">
            <div class="title">\${esc(p.title)}</div>
            <div class="server">\${esc(p.serverLine)}</div>
            <div class="body">\${esc(p.body)}</div>
        </div>
    \`;

    stack.prepend(card);
    updateClasses();
    resize();

    setTimeout(() => { removeCard(card); }, p.timeout * 1000);
});
</script>
</body>
</html>`;
```

- [ ] **Step 2: Add overlay window management + IPC handlers after `OVERLAY_HTML`**

```ts
// ─── Overlay Window ───────────────────────────────────────────────────────────

let overlayWin: BrowserWindow | null = null;
let overlayReady = false;
let pendingNotifs: Array<NotifPayload & { imageUrls: string[]; channelId: string; guildId: string | null; messageId: string | null; maxCards: number; }> = [];
const PRELOAD = join(__dirname, "overlay-preload.js");

function ensureOverlay(cardWidth: number): BrowserWindow {
    const winWidth = clamp(cardWidth, 280, 600, 420) + 16;

    if (overlayWin && !overlayWin.isDestroyed()) {
        // Update window width if cardWidth changed (takes effect next notification per spec)
        const current = overlayWin.getBounds();
        if (current.width !== winWidth) {
            overlayWin.setSize(winWidth, current.height);
        }
        return overlayWin;
    }

    const { x, y } = screen.getPrimaryDisplay().bounds;

    overlayWin = new BrowserWindow({
        width: winWidth,
        height: 116, // 1 card height
        x: x + 16,
        y: y + 16,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        focusable: false,
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            preload: PRELOAD,
        },
    });

    overlayWin.setAlwaysOnTop(true, "screen-saver");
    overlayWin.setIgnoreMouseEvents(true);

    if (process.platform !== "win32") {
        try { overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /**/ }
    }

    overlayReady = false;

    overlayWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(OVERLAY_HTML));

    overlayWin.webContents.once("did-finish-load", () => {
        overlayReady = true;
        for (const p of pendingNotifs) {
            overlayWin!.webContents.send("notif-show", p);
            overlayWin!.showInactive();
        }
        pendingNotifs = [];
    });

    overlayWin.on("closed", () => { overlayWin = null; overlayReady = false; });

    return overlayWin;
}

// IPC: overlay → main
ipcMain.on("overlay-resize", (event, height: number) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    win.setSize(win.getBounds().width, Math.max(1, height));
    win.showInactive();
});

ipcMain.on("overlay-hide", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    win.hide();
});
```

- [ ] **Step 3: Replace the placeholder `showNotification` export with the real one**

Replace the placeholder export from Task 2 with:

```ts
export function showNotification(_: any, payload: NotifPayload & {
    imageUrls: string[];
    channelId: string;
    guildId: string | null;
    messageId: string | null;
    cardWidth: number;
    maxCards: number;
}): void {
    const entry: LogEntry = {
        id:         payload.id,
        timestamp:  Date.now(),
        type:       payload.type,
        title:      payload.title,
        serverLine: payload.serverLine,
        body:       payload.body,
        avatarUrl:  payload.avatarUrl,
        imageUrls:  payload.imageUrls,
        channelId:  payload.channelId,
        guildId:    payload.guildId,
        messageId:  payload.messageId,
    };
    appendLog(entry);

    const cardWidth = clamp(payload.cardWidth, 280, 600, 420);
    const maxCards  = clamp(payload.maxCards,  1,  10,   5);
    const timeout   = clamp(payload.timeout,   1,  60,   5);

    const notifMsg = { ...payload, cardWidth, maxCards, timeout };
    const win = ensureOverlay(cardWidth);

    if (overlayReady) {
        win.webContents.send("notif-show", notifMsg);
        win.showInactive();
    } else {
        pendingNotifs.push(notifMsg);
    }
}
```

- [ ] **Step 4: Verify preload resolves — run a quick build and check path**

Run: `pnpm build 2>&1 | Select-String -Pattern "error|Error" | Select-Object -First 20`
Expected: no errors from `notificationOverlay`

Then run Discord with the plugin enabled and open DevTools for the overlay BrowserWindow.
In the console, type: `window.__bridge`
Expected: object with `onNotif`, `resize`, `hide`, etc.

If `window.__bridge` is `undefined`, the preload did not load. Apply the complete concrete fallback documented in **Task 6, Step 3**. Do not improvise an alternative here — follow those steps exactly.

- [ ] **Step 5: Commit**

```
git add src/userplugins/notificationOverlay/native.ts
git commit -m "feat(notif-overlay): add overlay window, OVERLAY_HTML, and IPC handlers"
```

---

## Chunk 3: index.tsx rewrite

### Task 4: Rewrite `index.tsx`

**Files:**
- Modify: `src/userplugins/notificationOverlay/index.tsx`

Replace entire file.

- [ ] **Step 1: Write the markup stripping helper**

This is the first part of the new `index.tsx`:

```tsx
/*
 * NotificationOverlay — index.tsx (renderer)
 * Intercepts Discord events and sends notifications to the overlay via native IPC.
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Button } from "@webpack/common";
import { findByCodeLazy, findLazy } from "@webpack";
import { ChannelStore, GuildStore, UserStore } from "@webpack/common";

const ChannelTypes = findLazy(m => m.ANNOUNCEMENT_THREAD === 10);
const notificationsShouldNotify = findByCodeLazy(".SUPPRESS_NOTIFICATIONS))return!1");

const Native = VencordNative.pluginHelpers.NotificationOverlay as PluginNative<typeof import("./native")>;

// ─── Markup stripper ─────────────────────────────────────────────────────────

function stripMarkup(s: string): string {
    return s
        .replace(/<@!?(\d+)>/g,      "@user")
        .replace(/<#(\d+)>/g,        "#channel")
        .replace(/<@&(\d+)>/g,       "@role")
        .replace(/<a?:[^:]+:\d+>/g,  "[emoji]")
        .replace(/\*\*(.+?)\*\*/gs,  "$1")
        .replace(/__(.+?)__/gs,      "$1")
        .replace(/`(.+?)`/gs,        "$1");
}
```

- [ ] **Step 2: Add settings definition**

```tsx
// ─── Settings ────────────────────────────────────────────────────────────────

const settings = definePluginSettings({
    timeout: {
        type: OptionType.NUMBER,
        description: "How long to show each notification (seconds, 1–60)",
        default: 5,
    },
    maxCards: {
        type: OptionType.NUMBER,
        description: "Max notification cards visible at once (1–10)",
        default: 5,
    },
    cardWidth: {
        type: OptionType.NUMBER,
        description: "Notification card width in pixels (280–600)",
        default: 420,
    },
    dmNotifications: {
        type: OptionType.BOOLEAN,
        description: "Show DM notifications",
        default: true,
    },
    serverNotifications: {
        type: OptionType.BOOLEAN,
        description: "Show server message notifications",
        default: true,
    },
    callNotifications: {
        type: OptionType.BOOLEAN,
        description: "Show incoming call notifications",
        default: true,
    },
    viewLogs: {
        type: OptionType.COMPONENT,
        description: "Open the notification log",
        component: () => (
            <Button onClick={() => Native.openLogViewer()}>
                📋 View Notification Log
            </Button>
        ),
    },
});
```

- [ ] **Step 3: Add plugin definition with flux handlers**

```tsx
// ─── Call dedup state ─────────────────────────────────────────────────────────

const ringingChannels = new Set<string>();

// ─── Plugin ───────────────────────────────────────────────────────────────────

function makeId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function getImageUrls(message: any): string[] {
    const urls: string[] = [];
    for (const a of (message.attachments ?? [])) {
        if (a.content_type?.startsWith("image/") && a.url) urls.push(a.url);
    }
    return urls;
}

export default definePlugin({
    name: "NotificationOverlay",
    description: "Shows Discord notifications as an always-on-top overlay visible over any app or window, with a persistent notification log",
    authors: [{ name: "Me", id: 0n }], // personal userplugin — matches existing plugin convention
    settings,

    flux: {
        CALL_UPDATE({ call }: { call: any; }) {
            if (!settings.store.callNotifications) return;
            const channelId: string = call?.channel_id;
            if (!channelId) return;
            const currentUserId = UserStore.getCurrentUser()?.id;
            const isRinging: boolean = Array.isArray(call?.ringing) && call.ringing.includes(currentUserId);

            if (isRinging && !ringingChannels.has(channelId)) {
                ringingChannels.add(channelId);
                const channel = ChannelStore.getChannel(channelId);
                Native.showNotification({
                    id:          makeId(),
                    title:       "📞 Incoming Call",
                    serverLine:  "Voice Chat",
                    body:        `${channel?.name ?? "Someone"} is calling you...`,
                    avatarUrl:   "",
                    type:        "call",
                    timeout:     settings.store.timeout,
                    cardWidth:   settings.store.cardWidth,
                    maxCards:    settings.store.maxCards,
                    imageUrls:   [],
                    channelId:   channelId,
                    guildId:     channel?.guild_id ?? null,
                    messageId:   null,
                });
            }
            if (!isRinging) {
                ringingChannels.delete(channelId);
            }
        },

        MESSAGE_CREATE({ message, optimistic }: { message: any; optimistic: boolean; }) {
            if (optimistic) return;

            const currentUser = UserStore.getCurrentUser();
            if (!currentUser) return;
            if (message.author?.id === currentUser.id) return;
            if (message.author?.bot) return;
            if (!notificationsShouldNotify(message, message.channel_id)) return;

            const channel = ChannelStore.getChannel(message.channel_id);
            if (!channel) return;

            const isDM      = channel.type === ChannelTypes.DM;
            const isGroupDM = channel.type === ChannelTypes.GROUP_DM;
            const isServer  = !isDM && !isGroupDM;

            if ((isDM || isGroupDM) && !settings.store.dmNotifications) return;
            if (isServer && !settings.store.serverNotifications) return;

            // Build title (username only — server line below)
            const title = message.author?.global_name || message.author?.username || "Unknown";

            // Build server line
            let serverLine: string;
            if (isDM) {
                serverLine = "Direct Message";
            } else if (isGroupDM) {
                const groupName = channel.name ||
                    (channel.rawRecipients?.map((r: any) => r.username).join(", ") ?? "Group DM");
                serverLine = groupName;
            } else {
                const guild = GuildStore.getGuild(channel.guild_id);
                serverLine = `#${channel.name}${guild ? ` · ${guild.name}` : ""}`;
            }

            // Build body
            let body = message.content || "";
            if (!body && message.sticker_items?.length) body = "📌 Sent a sticker";
            if (!body && message.attachments?.length)   body = "📎 Sent an attachment";
            if (!body && message.embeds?.length)         body = "🔗 Sent an embed";
            if (!body)                                   body = "(no content)";
            body = stripMarkup(body);

            const avatarUrl = message.author?.avatar
                ? `https://cdn.discordapp.com/avatars/${message.author.id}/${message.author.avatar}.png?size=64`
                : "";

            Native.showNotification({
                id:          makeId(),
                title,
                serverLine,
                body,
                avatarUrl,
                type:        isServer ? "server" : "dm",
                timeout:     settings.store.timeout,
                cardWidth:   settings.store.cardWidth,
                maxCards:    settings.store.maxCards,
                imageUrls:   getImageUrls(message),
                channelId:   message.channel_id,
                guildId:     channel.guild_id ?? null,
                messageId:   message.id ?? null,
            });
        },
    },
});
```

- [ ] **Step 3b: Add `maxCards` immediate-effect via settings `onChange` and IPC**

Per spec, reducing `maxCards` in settings must **immediately** trim visible cards — not wait for the next notification.

**In `native.ts`**, add a `trimToMaxCards` export (after `showNotification`):
```ts
export function trimToMaxCards(_: any, max: number): void {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const clamped = Math.max(1, Math.min(10, max));
    overlayWin.webContents.send("notif-trim", clamped);
}
```

**In `OVERLAY_HTML`** `<script>`, add a handler for the `notif-trim` IPC message (alongside the existing `notif-show` listener):
```js
window.__bridge.onTrim((max) => {
    // Newest card is at the top (prepended), oldest is lastElementChild
    while (stack.children.length > max) {
        stack.removeChild(stack.lastElementChild);
    }
    resize();
});
```

**In `overlay-preload.js`**, expose `onTrim` on the bridge (alongside `onNotif`):
```js
onTrim: (cb) => ipcRenderer.on("notif-trim", (_, max) => cb(max)),
```

**In `index.tsx`**, add `onChange` to the `maxCards` setting definition (Vencord calls `onChange` on every settings change via `SettingsStore.addChangeListener` in PluginManager — no manual subscription needed):
```tsx
maxCards: {
    type: OptionType.NUMBER,
    description: "Max notification cards visible at once (1–10)",
    default: 5,
    onChange(val: number) {
        Native.trimToMaxCards(val);
    },
},
```

No `start()`/`stop()` changes needed. The `onChange` hook is the authoritative pattern used throughout Vencord (see `src/api/PluginManager.ts:386`).

- [ ] **Step 4: Build to verify**

Run: `pnpm build 2>&1 | Select-String -Pattern "error|Error" | Select-Object -First 20`
Expected: no errors from `notificationOverlay`

- [ ] **Step 5: Commit**

```
git add src/userplugins/notificationOverlay/index.tsx
git commit -m "feat(notif-overlay): rewrite index.tsx with new settings, flux handlers, markup stripper"
```

---

## Chunk 4: Log viewer

### Task 5: Add log viewer window + `LOG_VIEWER_HTML` to `native.ts`

**Files:**
- Modify: `src/userplugins/notificationOverlay/native.ts`

Add `LOG_VIEWER_HTML`, `openLogViewer()`, and log viewer IPC handlers.

- [ ] **Step 1: Add `LOG_VIEWER_HTML` constant to `native.ts`** (after `OVERLAY_HTML`)

```ts
// ─── Log Viewer HTML ──────────────────────────────────────────────────────────

const LOG_VIEWER_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Notification Log</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #1e1e2e; color: #cdd6f4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; min-height: 100vh; }

/* Top bar */
.topbar { background: #181825; border-bottom: 1px solid rgba(255,255,255,0.08); padding: 14px 24px; display: flex; align-items: center; gap: 12px; position: sticky; top: 0; z-index: 10; }
.topbar-title { font-size: 18px; font-weight: 700; color: #fff; }
.topbar-count { font-size: 12px; color: rgba(255,255,255,0.4); background: rgba(255,255,255,0.08); padding: 2px 10px; border-radius: 20px; }
.topbar-spacer { flex: 1; }
.clear-btn { font-size: 12px; color: #ed4245; background: rgba(237,66,69,0.12); border: 1px solid rgba(237,66,69,0.3); padding: 6px 14px; border-radius: 6px; cursor: pointer; }
.clear-btn:hover { background: rgba(237,66,69,0.25); }

/* Filter tabs */
.filters { padding: 12px 24px; display: flex; gap: 8px; background: #1e1e2e; border-bottom: 1px solid rgba(255,255,255,0.06); }
.filter { font-size: 12px; padding: 5px 14px; border-radius: 20px; cursor: pointer; border: 1px solid rgba(255,255,255,0.12); color: rgba(255,255,255,0.6); background: transparent; }
.filter.active { background: #5865f2; border-color: #5865f2; color: #fff; font-weight: 600; }

/* Feed */
.feed { max-width: 780px; margin: 0 auto; padding: 20px 24px; }
.empty { text-align: center; color: rgba(255,255,255,0.3); padding: 60px 0; font-size: 14px; }

/* Day divider */
.day-divider { text-align: center; font-size: 11px; color: rgba(255,255,255,0.3); text-transform: uppercase; letter-spacing: 1px; padding: 12px 0 4px; position: relative; }
.day-divider::before { content: ''; position: absolute; left: 0; right: 0; top: 50%; height: 1px; background: rgba(255,255,255,0.07); }
.day-divider span { background: #1e1e2e; padding: 0 12px; position: relative; }

/* Entry */
.entry { display: flex; gap: 14px; padding: 16px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
.entry:last-child { border-bottom: none; }
.avatar { width: 46px; height: 46px; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 20px; border: 2px solid rgba(255,255,255,0.1); object-fit: cover; }
.entry-body { flex: 1; min-width: 0; }
.entry-header { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; flex-wrap: wrap; }
.entry-name { font-size: 14px; font-weight: 700; color: #fff; }
.badge { font-size: 10px; padding: 2px 7px; border-radius: 10px; font-weight: 600; }
.badge-server { background: rgba(88,101,242,0.25); color: #7289da; }
.badge-dm     { background: rgba(59,165,93,0.2);   color: #3ba55d; }
.badge-call   { background: rgba(237,66,69,0.2);   color: #ed4245; }
.entry-server { font-size: 12px; color: #7289da; margin-bottom: 6px; }
.entry-message { font-size: 13px; color: rgba(255,255,255,0.85); line-height: 1.55; word-break: break-word; }
.entry-images { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.entry-images img { max-width: 200px; max-height: 160px; border-radius: 6px; object-fit: cover; border: 1px solid rgba(255,255,255,0.1); cursor: pointer; }
.entry-footer { display: flex; align-items: center; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
.entry-time { font-size: 11px; color: rgba(255,255,255,0.3); }
.jump-btn { font-size: 11px; color: #5865f2; background: rgba(88,101,242,0.12); border: 1px solid rgba(88,101,242,0.3); padding: 3px 10px; border-radius: 5px; cursor: pointer; }
.jump-btn:hover { background: rgba(88,101,242,0.25); }
.chan-btn { font-size: 11px; color: rgba(255,255,255,0.45); background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); padding: 3px 10px; border-radius: 5px; cursor: pointer; }
.chan-btn:hover { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.7); }
</style>
</head>
<body>
<div class="topbar">
  <span style="font-size:22px;">💬</span>
  <span class="topbar-title">Notification Log</span>
  <span class="topbar-count" id="count">0 notifications</span>
  <div class="topbar-spacer"></div>
  <button class="clear-btn" id="clearBtn">🗑 Clear Log</button>
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
function esc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function formatDate(ts) {
  return new Date(ts).toLocaleString(undefined, {
    weekday: "long", day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}

function dayLabel(ts) {
  const d = new Date(ts), today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  if (isToday) return "Today — " + d.toLocaleDateString(undefined, { weekday:"long", day:"numeric", month:"long", year:"numeric" });
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday — " + d.toLocaleDateString(undefined, { weekday:"long", day:"numeric", month:"long", year:"numeric" });
  return d.toLocaleDateString(undefined, { weekday:"long", day:"numeric", month:"long", year:"numeric" });
}

function openUrl(url) { window.__bridge.openUrl(url); }

let allEntries = [];
let activeFilter = "all";

function renderEntries(entries) {
  const feed = document.getElementById("feed");
  const count = document.getElementById("count");

  const filtered = activeFilter === "all" ? entries : entries.filter(e => e.type === activeFilter);
  count.textContent = entries.length + " notification" + (entries.length !== 1 ? "s" : "");

  if (filtered.length === 0) {
    feed.innerHTML = '<div class="empty">No notifications yet.</div>';
    return;
  }

  // Sort newest first
  const sorted = [...filtered].sort((a,b) => b.timestamp - a.timestamp);

  let html = "";
  let lastDay = "";
  for (const e of sorted) {
    const day = dayLabel(e.timestamp);
    if (day !== lastDay) {
      html += \`<div class="day-divider"><span>\${esc(day)}</span></div>\`;
      lastDay = day;
    }

    const badge = { server: "Server", dm: "DM", call: "Call" }[e.type] ?? e.type;
    const badgeCls = "badge-" + e.type;

    const avatarEl = e.avatarUrl
      ? \`<img class="avatar" src="\${esc(e.avatarUrl)}" onerror="this.outerHTML='<div class=\\\\"avatar\\\\" style=\\\\"background:#5865f2;font-size:20px;\\\\">\${e.type==="call"?"📞":"💬"}</div>'">\`
      : \`<div class="avatar" style="background:\${e.type==="call"?"#ed4245":e.type==="dm"?"#3ba55d":"#5865f2"};font-size:20px;">\${e.type==="call"?"📞":e.type==="dm"?"✉️":"💬"}</div>\`;

    const imagesEl = e.imageUrls?.length
      ? \`<div class="entry-images">\${e.imageUrls.map(u => \`<img src="\${esc(u)}" onerror="this.style.display='none'" onclick="window.__bridge.openImage('\${esc(u)}')">\`).join("")}</div>\`
      : "";

    const jumpUrl = e.messageId
      ? \`discord://-/channels/\${e.guildId ?? "@me"}/\${e.channelId}/\${e.messageId}\`
      : null;
    const chanUrl = \`discord://-/channels/\${e.guildId ?? "@me"}/\${e.channelId}\`;
    const chanLabel = { server: "# Open Channel", dm: "✉️ Open DM", call: "🔊 Open Channel" }[e.type];

    const jumpBtn = jumpUrl
      ? \`<button class="jump-btn" onclick="openUrl('\${esc(jumpUrl)}')">↗ Jump to Message</button>\`
      : "";

    html += \`
      <div class="entry">
        \${avatarEl}
        <div class="entry-body">
          <div class="entry-header">
            <span class="entry-name">\${esc(e.title)}</span>
            <span class="badge \${badgeCls}">\${badge}</span>
          </div>
          <div class="entry-server">\${esc(e.serverLine)}</div>
          <div class="entry-message">\${esc(e.body)}</div>
          \${imagesEl}
          <div class="entry-footer">
            <span class="entry-time">\${esc(formatDate(e.timestamp))}</span>
            \${jumpBtn}
            <button class="chan-btn" onclick="openUrl('\${esc(chanUrl)}')">\${chanLabel}</button>
          </div>
        </div>
      </div>
    \`;
  }
  feed.innerHTML = html;
}

function loadLogs(entries) {
  allEntries = entries;
  renderEntries(entries);
}

// Filter buttons
document.querySelectorAll(".filter").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeFilter = btn.dataset.filter;
    renderEntries(allEntries);
  });
});

// Clear button
document.getElementById("clearBtn").addEventListener("click", () => {
  window.__bridge.clearLog();
});

// IPC listeners
window.__bridge.onLogData(loadLogs);
window.__bridge.onLogCleared(() => {
  allEntries = [];
  renderEntries([]);
});
</script>
</body>
</html>`;
```

- [ ] **Step 2: Add log viewer window + IPC handlers + replace `openLogViewer` placeholder**

Add after `LOG_VIEWER_HTML`:

```ts
// ─── Log Viewer Window ────────────────────────────────────────────────────────

let logViewerWin: BrowserWindow | null = null;

function sendLogData(win: BrowserWindow): void {
    win.webContents.once("did-finish-load", () => {
        win.webContents.send("log-data", logEntries);
    });
}

// IPC: log viewer → main
ipcMain.on("log-clear", (event) => {
    clearLog();
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.webContents.send("log-cleared");
});

ipcMain.on("log-open-url", (_event, { url }: { url: string }) => {
    if (typeof url === "string" && url.startsWith("discord://-/channels/")) {
        shell.openExternal(url);
    }
    // invalid URLs silently ignored
});

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

Replace the placeholder `openLogViewer` export:

```ts
export function openLogViewer(_: any): void {
    if (logViewerWin && !logViewerWin.isDestroyed()) {
        logViewerWin.focus();
        return;
    }

    logViewerWin = new BrowserWindow({
        width: 1000,
        height: 700,
        title: "Notification Log",
        alwaysOnTop: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            preload: PRELOAD,
        },
    });

    logViewerWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(LOG_VIEWER_HTML));
    sendLogData(logViewerWin);
    logViewerWin.on("closed", () => { logViewerWin = null; });
}
```

- [ ] **Step 3: Build to verify**

Run: `pnpm build 2>&1 | Select-String -Pattern "error|Error" | Select-Object -First 20`
Expected: no errors from `notificationOverlay`

- [ ] **Step 4: Commit**

```
git add src/userplugins/notificationOverlay/native.ts
git commit -m "feat(notif-overlay): add log viewer window, LOG_VIEWER_HTML, and IPC handlers"
```

---

### Task 6: Verify `__dirname` preload path + full build

**Files:** none — verification only

- [ ] **Step 1: Full build**

Run: `pnpm build`
Expected: exits 0 with no errors

- [ ] **Step 2: Inject and test in Discord**

Run: `pnpm inject` (or use Vencord installer)
Launch Discord and enable NotificationOverlay plugin in Vencord settings.

Verify each behavior:

**Overlay:**
- [ ] Cards appear top-left when messages arrive in DMs and servers
- [ ] Card shows: username (bold), server/channel line (blue), up to 2-line message body
- [ ] Newest card has blurple border; older cards are faded (opacity 0.75)
- [ ] Up to `maxCards` (default 5) cards stack — sending a 6th notification removes the oldest
- [ ] Cards auto-dismiss after `timeout` (default 5s)
- [ ] Overlay window is fully click-through (clicks pass to windows beneath)
- [ ] Call notification shows "📞 Incoming Call" title, "Voice Chat" server line
- [ ] No duplicate call notification for the same ringing channel

**Log viewer:**
- [ ] "📋 View Notification Log" button appears in Vencord plugin settings
- [ ] Clicking it opens the log viewer (1000×700px window)
- [ ] Clicking it a second time focuses the existing window instead of opening a new one
- [ ] Entries appear in newest-first order with day dividers
- [ ] Full message body shown (no line clamp)
- [ ] Type badges (Server / DM / Call) appear correctly
- [ ] Filter tabs (All / Servers / DMs / Calls) filter entries client-side
- [ ] "↗ Jump to Message" button opens Discord to that exact message (hidden for calls)
- [ ] "# Open Channel / ✉️ Open DM / 🔊 Open Channel" button opens the channel in Discord
- [ ] Image thumbnails render; clicking one opens the full image in the browser
- [ ] "🗑 Clear Log" clears the feed in-place without closing the window
- [ ] Log is a snapshot — new notifications that arrive while viewer is open do NOT appear in it

- [ ] **Step 3: Verify `__dirname` resolves to preload**

Open Discord's DevTools for the overlay BrowserWindow (from Discord's DevTools → process list). In its console run: `window.__bridge`

**If `window.__bridge` is defined:** preload works. No action needed — skip to Step 4.

**If `window.__bridge` is `undefined`:** the preload file path did not resolve. Apply the spec-prescribed fallback: inline the bridge via `webContents.executeJavaScript` after `did-finish-load`. Follow these steps exactly:

- [ ] Remove `preload: PRELOAD` from both BrowserWindow `webPreferences` blocks. Keep `sandbox: false` and `nodeIntegration: false` unchanged.

- [ ] In `OVERLAY_HTML`, replace the `window.__bridge.*` setup block with plain global functions. Rename all `window.__bridge.onNotif(cb)` → expose a global `handleNotif(p)` function; remove `window.__bridge.resize(h)` and `window.__bridge.hide()` calls from the card JS (main will poll for these — see below):
```html
<script>
function handleNotif(p) { /* existing card-add logic unchanged */ }
// resize() and hide() are called internally; main polls card count — no bridge call needed
</script>
```

- [ ] In `native.ts`, replace `win.webContents.send("notif-show", notifMsg)` with:
```ts
win.webContents.executeJavaScript(`handleNotif(${JSON.stringify(notifMsg)})`);
```

- [ ] In `native.ts`, replace `win.webContents.send("notif-trim", clamped)` with:
```ts
win.webContents.executeJavaScript(`
    while (document.getElementById('stack').children.length > ${clamped})
        document.getElementById('stack').removeChild(document.getElementById('stack').lastElementChild);
`);
```

- [ ] For resize/hide (previously driven by the renderer bridge): remove the `ipcMain.on("overlay-resize")` and `ipcMain.on("overlay-hide")` handlers and add a polling interval in `ensureOverlay` after `did-finish-load`:
```ts
overlayWin.webContents.on("did-finish-load", () => {
    overlayReady = true;
    for (const p of pendingNotifs) {
        overlayWin!.webContents.executeJavaScript(`handleNotif(${JSON.stringify(p)})`);
    }
    pendingNotifs = [];

    const poll = setInterval(async () => {
        if (!overlayWin || overlayWin.isDestroyed()) { clearInterval(poll); return; }
        const count: number = await overlayWin.webContents.executeJavaScript(
            "document.getElementById('stack').children.length"
        );
        const h = count === 0 ? 0 : count * 100 + (count - 1) * 8 + 16;
        if (count === 0) overlayWin.hide();
        else { overlayWin.showInactive(); overlayWin.setSize(overlayWin.getBounds().width, h); }
    }, 200);
});
```

- [ ] In `LOG_VIEWER_HTML`, replace the `window.__bridge.*` setup with plain global functions. For outbound events (openUrl, openImage, clearLog), expose them as `window.__pendingAction` flags that main polls, OR use the same `executeJavaScript`-from-main pattern. Concrete approach: add a polling interval in `openLogViewer` after log viewer `did-finish-load` that runs `executeJavaScript("window.__pendingAction")` every 300ms, checks for `{ type: "open-url", url }` / `{ type: "open-image", url }` / `{ type: "clear-log" }`, handles each (shell.openExternal for allowed URLs; clearLog + executeJavaScript("loadLogs([])") for clear), then resets the flag via `executeJavaScript("window.__pendingAction = null")`. In LOG_VIEWER_HTML, replace all `window.__bridge.openUrl(url)` calls with `window.__pendingAction = { type: "open-url", url }` etc.

- [ ] Re-build and re-verify that the overlay and log viewer work without a preload file.

**Log storage edge cases:**
- [ ] Manually corrupt `vencord-notification-log.json` (write `"not json"` to it), restart Discord — verify the log viewer opens with an empty feed (no crash)
- [ ] To verify 30-day pruning: open `vencord-notification-log.json` in a text editor, manually set one entry's `timestamp` to `Date.now() - 31 * 24 * 60 * 60 * 1000`, save, restart Discord — verify that entry does not appear in the log viewer
- [ ] To verify settings clamp: set `cardWidth` to `9999` in plugin settings, send a message — verify window width is capped at `616px` (600 + 16)
- [ ] To verify `maxCards` immediate effect: with 4 cards visible, reduce `maxCards` to `2` in settings — verify the 2 oldest cards are removed immediately

- [ ] **Step 4: Final commit**

```
git add -A
git commit -m "feat(notif-overlay): complete NotificationOverlay redesign — stacking, expanded cards, log viewer"
```

---

## Push to GitHub

- [ ] **Push to the active branch**

```
git push
```

