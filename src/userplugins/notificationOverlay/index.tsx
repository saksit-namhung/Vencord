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

// ─── Debug logger ─────────────────────────────────────────────────────────────

function log(...args: any[]): void {
    console.log("[NotifOverlay]", ...args);
}
function warn(...args: any[]): void {
    console.warn("[NotifOverlay]", ...args);
}

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

// ─── Settings ────────────────────────────────────────────────────────────────

const settings = definePluginSettings({
    timeout: {
        type: OptionType.NUMBER,
        description: "How long to show each notification (seconds, 1\u201360)",
        default: 5,
    },
    maxCards: {
        type: OptionType.NUMBER,
        description: "Max notification cards visible at once (1\u201310)",
        default: 5,
        onChange(val: number) {
            Native.trimToMaxCards(val);
        },
    },
    cardWidth: {
        type: OptionType.NUMBER,
        description: "Notification card width in pixels (280\u2013600)",
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
    clearLog: {
        type: OptionType.COMPONENT,
        description: "Clear all saved notification history",
        component: () => (
            <Button color={Button.Colors.RED} onClick={() => Native.clearNotificationLog()}>
                🗑 Clear Notification Log
            </Button>
        ),
    },
});

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

    start() {
        if (!Native || typeof Native.showNotification !== "function") {
            warn("start: Native.showNotification is NOT a function — pluginHelpers may not be set up. Native =", Native);
        } else {
            log("start: Native.showNotification OK");
        }
    },

    flux: {
        CALL_UPDATE({ call }: { call: any; }) {
            if (!settings.store.callNotifications) { log("CALL_UPDATE: skipped — callNotifications disabled"); return; }
            const channelId: string = call?.channel_id;
            if (!channelId) { warn("CALL_UPDATE: no channel_id on call", call); return; }
            const currentUserId = UserStore.getCurrentUser()?.id;
            const isRinging: boolean = Array.isArray(call?.ringing) && call.ringing.includes(currentUserId);

            log(`CALL_UPDATE: channelId=${channelId} isRinging=${isRinging} alreadyTracked=${ringingChannels.has(channelId)}`);

            if (isRinging && !ringingChannels.has(channelId)) {
                ringingChannels.add(channelId);
                const channel = ChannelStore.getChannel(channelId);
                log("CALL_UPDATE: firing showNotification for call");
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
                }).catch((e: any) => warn("CALL_UPDATE: showNotification IPC rejected —", e));
            }
            if (!isRinging) {
                ringingChannels.delete(channelId);
            }
        },

        MESSAGE_CREATE({ message, optimistic }: { message: any; optimistic: boolean; }) {
            if (optimistic) { log("MESSAGE_CREATE: skipped — optimistic"); return; }

            const currentUser = UserStore.getCurrentUser();
            if (!currentUser) { warn("MESSAGE_CREATE: no currentUser"); return; }
            if (message.author?.id === currentUser.id) { log("MESSAGE_CREATE: skipped — own message"); return; }
            if (message.author?.bot) { log("MESSAGE_CREATE: bot message — allowed"); }

            const shouldNotify = notificationsShouldNotify(message, message.channel_id);
            if (!shouldNotify) { log(`MESSAGE_CREATE: skipped — notificationsShouldNotify returned false (channelId=${message.channel_id})`); return; }

            const channel = ChannelStore.getChannel(message.channel_id);
            if (!channel) { warn(`MESSAGE_CREATE: skipped — channel not found (id=${message.channel_id})`); return; }

            const isDM      = channel.type === ChannelTypes.DM;
            const isGroupDM = channel.type === ChannelTypes.GROUP_DM;
            const isServer  = !isDM && !isGroupDM;

            if ((isDM || isGroupDM) && !settings.store.dmNotifications) { log("MESSAGE_CREATE: skipped — dmNotifications disabled"); return; }
            if (isServer && !settings.store.serverNotifications) { log("MESSAGE_CREATE: skipped — serverNotifications disabled"); return; }

            log(`MESSAGE_CREATE: showing notification — type=${isServer ? "server" : "dm"} author="${message.author?.username}" channel=${message.channel_id}`);

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
                serverLine = `#${channel.name}${guild ? ` \u00b7 ${guild.name}` : ""}`;
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
            }).catch((e: any) => warn("MESSAGE_CREATE: showNotification IPC rejected —", e));
        },
    },
});
