/*
 * NotificationOverlay — native.ts
 * Runs in Electron main process.
 * Responsibilities: overlay window, JSON log I/O, log viewer HTML generation.
 */

import { app, BrowserWindow, ipcMain, screen, shell } from "electron";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";

// ─── Debug logger ─────────────────────────────────────────────────────────────

const DEBUG_LOG = join(app.getPath("userData"), "vencord-notif-debug.log");

function log(...args: any[]): void {
    const line = "[NotifOverlay] " + args.map(String).join(" ");
    console.log(line);
    try { appendFileSync(DEBUG_LOG, new Date().toISOString() + " " + line + "\n"); } catch { /**/ }
}
function warn(...args: any[]): void {
    const line = "[NotifOverlay][WARN] " + args.map(String).join(" ");
    console.warn(line);
    try { appendFileSync(DEBUG_LOG, new Date().toISOString() + " " + line + "\n"); } catch { /**/ }
}

log("native.ts loaded, __dirname =", __dirname);

// ─── Constants ───────────────────────────────────────────────────────────────

const CARD_HEIGHT = 100;  // px per card
const CARD_GAP    = 8;    // px gap between cards
const PADDING     = 16;   // px top+bottom window inset
const LOG_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days in ms
const LOG_FILE        = join(app.getPath("userData"), "vencord-notification-log.json");
const OVERLAY_HTML_FILE     = join(app.getPath("userData"), "vencord-notif-overlay.html");
const LOG_VIEWER_HTML_FILE  = join(app.getPath("userData"), "vencord-notif-logviewer.html");

log("LOG_FILE =", LOG_FILE);

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
        if (!existsSync(LOG_FILE)) {
            log("loadLog: no log file found, starting fresh");
            logEntries = [];
            return;
        }
        const raw = readFileSync(LOG_FILE, "utf-8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error("not an array");
        const cutoff = Date.now() - LOG_MAX_AGE;
        const before = parsed.length;
        logEntries = parsed.filter((e: LogEntry) => e.timestamp > cutoff);
        writeFileSync(LOG_FILE, JSON.stringify(logEntries), "utf-8");
        log(`loadLog: loaded ${logEntries.length} entries (pruned ${before - logEntries.length} old)`);
    } catch (e) {
        warn("loadLog: failed to read/parse log file, resetting —", e);
        logEntries = [];
        writeFileSync(LOG_FILE, "[]", "utf-8");
    }
}

function saveLog(): void {
    try {
        writeFileSync(LOG_FILE, JSON.stringify(logEntries), "utf-8");
        log(`saveLog: wrote ${logEntries.length} entries`);
    } catch (e) {
        warn("saveLog: write failed —", e);
    }
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
    padding: 10px 14px;
    display: flex;
    gap: 10px;
    align-items: stretch;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #fff;
    height: 100px;
    overflow: hidden;
    flex-shrink: 0;
    box-sizing: border-box;
}
.card.newest { border-color: rgba(88,101,242,0.5); }
.card.old { opacity: 0.75; }
.avatar {
    width: 44px; height: 44px;
    border-radius: 50%;
    object-fit: cover;
    flex-shrink: 0;
    border: 2px solid rgba(88,101,242,0.6);
    align-self: center;
}
.avatar-fallback {
    width: 44px; height: 44px;
    border-radius: 50%;
    background: #5865f2;
    display: flex; align-items: center; justify-content: center;
    font-size: 20px; flex-shrink: 0;
    align-self: center;
}
.txt {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    overflow: hidden;
}
.title {
    font-size: 13px; font-weight: 700; color: #fff;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    line-height: 1.3;
}
.server {
    font-size: 11px; color: #7289da;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    line-height: 1.3;
}
.body {
    font-size: 12px; color: rgba(255,255,255,0.82);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    margin-top: 4px;
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
    __bridge.resize(h);
    if (stack.children.length === 0) __bridge.hide();
}

function removeCard(el) {
    el.remove();
    updateClasses();
    resize();
}

const stack = document.getElementById("stack");

__bridge.onNotif(function(p) {
    // Enforce maxCards: remove oldest cards if over limit
    while (p.maxCards && stack.children.length >= p.maxCards) {
        stack.lastElementChild.remove();
    }

    const avatar = p.avatarUrl
        ? '<img class="avatar" src="' + esc(p.avatarUrl) + '" onerror="this.outerHTML=\\'<div class=&quot;avatar-fallback&quot;>' + (p.type === 'call' ? '📞' : '💬') + '</div>\\'">'
        : '<div class="avatar-fallback">' + (p.type === 'call' ? '📞' : '💬') + '</div>';

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

__bridge.onTrim(function(max) {
    // Newest card is at the top (prepended), oldest is lastElementChild
    while (stack.children.length > max) {
        stack.removeChild(stack.lastElementChild);
    }
    resize();
});
</script>
</body>
</html>`;

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

// Write overlay HTML to disk so loadFile() works (data: URLs block preload scripts)
const PRELOAD = join(__dirname, "overlay-preload.js");
try {
    writeFileSync(OVERLAY_HTML_FILE, OVERLAY_HTML, "utf-8");
    log("Overlay HTML written to userData, PRELOAD =", PRELOAD);
} catch (e) {
    warn("Failed to write overlay HTML —", e);
}

// ─── Overlay Window ───────────────────────────────────────────────────────────

let overlayWin: BrowserWindow | null = null;
let overlayReady = false;
let pendingNotifs: Array<NotifPayload & { imageUrls: string[]; channelId: string; guildId: string | null; messageId: string | null; maxCards: number; cardWidth: number; }> = [];

function ensureOverlay(cardWidth: number): BrowserWindow {
    const winWidth = clamp(cardWidth, 280, 600, 420) + 16;

    if (overlayWin && !overlayWin.isDestroyed()) {
        const current = overlayWin.getBounds();
        if (current.width !== winWidth) {
            log("ensureOverlay: resizing existing window to width", winWidth);
            overlayWin.setSize(winWidth, current.height);
        }
        return overlayWin;
    }

    log("ensureOverlay: creating new overlay window, width =", winWidth);
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

    overlayWin.setIgnoreMouseEvents(true);

    if (process.platform !== "win32") {
        try { overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /**/ }
    }

    overlayReady = false;

    overlayWin.loadFile(OVERLAY_HTML_FILE);
    log("ensureOverlay: loadFile called");

    overlayWin.webContents.on("did-fail-load", (_e, code, desc) => {
        warn("ensureOverlay: did-fail-load —", code, desc);
    });

    overlayWin.webContents.on("console-message", (_e, level, message, line) => {
        const lvlStr = ["verbose", "info", "warning", "error"][level] ?? "log";
        log(`[overlay-page][${lvlStr}] (line ${line}) ${message}`);
    });

    overlayWin.webContents.once("did-finish-load", () => {
        log(`ensureOverlay: did-finish-load — flushing ${pendingNotifs.length} pending notif(s)`);
        overlayReady = true;
        for (const p of pendingNotifs) {
            overlayWin!.webContents.send("notif-show", p);
            overlayWin!.showInactive();
        }
        pendingNotifs = [];
    });

    overlayWin.on("closed", () => {
        log("ensureOverlay: overlay window closed");
        overlayWin = null;
        overlayReady = false;
    });

    return overlayWin;
}

// IPC: overlay → main
ipcMain.on("overlay-resize", (event, height: number) => {
    log("IPC overlay-resize: height =", height);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) { warn("overlay-resize: sender window not found"); return; }
    win.setSize(win.getBounds().width, Math.max(1, height));
    win.showInactive();
});

ipcMain.on("overlay-hide", (event) => {
    log("IPC overlay-hide");
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) { warn("overlay-hide: sender window not found"); return; }
    win.hide();
});

// ─── Exports ──────────────────────────────────────────────────────────────────

export function showNotification(_: any, payload: NotifPayload & {
    imageUrls: string[];
    channelId: string;
    guildId: string | null;
    messageId: string | null;
    cardWidth: number;
    maxCards: number;
}): void {
    log(`showNotification: type=${payload.type} title="${payload.title}" overlayReady=${overlayReady} pendingCount=${pendingNotifs.length}`);

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
        log("showNotification: sending notif-show immediately");
        win.webContents.send("notif-show", notifMsg);
        win.showInactive();
    } else {
        log("showNotification: overlay not ready, queuing (total queued:", pendingNotifs.length + 1, ")");
        pendingNotifs.push(notifMsg);
    }
}

export function trimToMaxCards(_: any, max: number): void {
    if (!overlayWin || overlayWin.isDestroyed()) {
        warn("trimToMaxCards: overlay window not available");
        return;
    }
    const clamped = Math.max(1, Math.min(10, max));
    log("trimToMaxCards: sending notif-trim max =", clamped);
    overlayWin.webContents.send("notif-trim", clamped);
}

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

export function clearNotificationLog(_: any): void {
    log("clearNotificationLog: clearing log");
    clearLog();
}
