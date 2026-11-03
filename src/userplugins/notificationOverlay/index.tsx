/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addServerListElement, removeServerListElement, ServerListRenderPosition } from "@api/ServerList";
import { definePluginSettings } from "@api/Settings";
import { TextButton } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findLazy } from "@webpack";
import { Button, ChannelStore, GuildStore, NavigationRouter, UserGuildSettingsStore, UserStore } from "@webpack/common";

const ChannelTypes = findLazy(m => m.ANNOUNCEMENT_THREAD === 10);

// Discord's UserNotificationSetting enum values
const enum NotifSetting { ALL_MESSAGES = 0, ONLY_MENTIONS = 1, NO_MESSAGES = 2 }
// Message flag bit for SUPPRESS_NOTIFICATIONS
const SUPPRESS_NOTIF_FLAG = 1 << 12;

/**
 * Determine whether to show an overlay notification for a message.
 * Uses UserGuildSettingsStore directly instead of Discord's internal shouldNotify,
 * which can break across Discord updates and suppresses when the window is focused.
 */
function checkShouldNotify(message: any, channel: any, currentUserId: string): boolean {
    // Message explicitly opted out of notifications
    if (message.flags & SUPPRESS_NOTIF_FLAG) return false;

    const guildId: string | null = channel.guild_id ?? null;

    if (!guildId) {
        // DM / Group DM — always notify unless the conversation is muted
        return !UserGuildSettingsStore.isChannelMuted("", channel.id);
    }

    // Server channel — respect mute + notification mode
    if (UserGuildSettingsStore.isGuildOrCategoryOrChannelMuted(guildId, channel.id)) return false;

    const setting: number = UserGuildSettingsStore.resolvedMessageNotifications(channel) as number;

    if (setting === NotifSetting.NO_MESSAGES) return false;

    if (setting === NotifSetting.ONLY_MENTIONS) {
        // Direct @mention
        if (message.mentions?.some((m: any) => m.id === currentUserId)) return true;
        // @everyone / @here (unless the guild suppresses it)
        if (message.mention_everyone && !UserGuildSettingsStore.isSuppressEveryoneEnabled(guildId)) return true;
        // Role mention — treat any mentioned role as a potential match (avoids needing member data)
        if (message.mention_roles?.length > 0) return true;
        return false;
    }

    // ALL_MESSAGES (0) or unrecognised value
    return true;
}

const Native = VencordNative.pluginHelpers.NotificationOverlay as PluginNative<typeof import("./native")>;

// ─── Server list quick-access button ─────────────────────────────────────────

const NotifLogButton = () => (
    <TextButton
        variant="secondary"
        onClick={() => Native.openLogViewer()}
        style={{ color: "var(--interactive-icon-default)", padding: "0 0.5em", width: "100%", fontSize: "14px", whiteSpace: "nowrap", boxSizing: "border-box" }}
    >
        📋 Noti
    </TextButton>
);

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
        .replace(/<@!?(\d+)>/g, "@user")
        .replace(/<#(\d+)>/g, "#channel")
        .replace(/<@&(\d+)>/g, "@role")
        .replace(/<a?:[^:]+:\d+>/g, "[emoji]")
        .replace(/\*\*(.+?)\*\*/gs, "$1")
        .replace(/__(.+?)__/gs, "$1")
        .replace(/`(.+?)`/gs, "$1");
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
    dependencies: ["ServerListAPI"],
    settings,

    renderNotifLogButton: ErrorBoundary.wrap(NotifLogButton, { noop: true }),

    start() {
        if (!Native || typeof Native.showNotification !== "function") {
            warn("start: Native.showNotification is NOT a function — pluginHelpers may not be set up. Native =", Native);
        } else {
            log("start: Native.showNotification OK");
        }
        addServerListElement(ServerListRenderPosition.Above, this.renderNotifLogButton);
        // Register global handler so native.ts can navigate Discord via executeJavaScript.
        // This avoids discord:// protocol which may target the wrong Discord instance.
        (window as any).__notifOverlayNavigate = (guildId: string | null, channelId: string, messageId: string | null) => {
            try {
                const path = guildId && guildId !== ""
                    ? `/channels/${guildId}/${channelId}${messageId ? `/${messageId}` : ""}`
                    : `/channels/@me/${channelId}`;
                log("navigate: transitioning to", path);
                NavigationRouter.transitionTo(path);
            } catch (e) {
                warn("navigate: NavigationRouter.transitionTo failed —", e);
            }
        };
    },

    stop() {
        removeServerListElement(ServerListRenderPosition.Above, this.renderNotifLogButton);
        delete (window as any).__notifOverlayNavigate;
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
                    id: makeId(),
                    title: "📞 Incoming Call",
                    serverLine: "Voice Chat",
                    body: `${channel?.name ?? "Someone"} is calling you...`,
                    avatarUrl: "",
                    type: "call",
                    timeout: settings.store.timeout,
                    cardWidth: settings.store.cardWidth,
                    maxCards: settings.store.maxCards,
                    imageUrls: [],
                    channelId: channelId,
                    guildId: channel?.guild_id ?? null,
                    messageId: null,
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

            const channel = ChannelStore.getChannel(message.channel_id);
            if (!channel) { warn(`MESSAGE_CREATE: skipped — channel not found (id=${message.channel_id})`); return; }

            if (!checkShouldNotify(message, channel, currentUser.id)) {
                log(`MESSAGE_CREATE: skipped — muted/suppressed (channelId=${message.channel_id})`);
                return;
            }

            const isDM = channel.type === ChannelTypes.DM;
            const isGroupDM = channel.type === ChannelTypes.GROUP_DM;
            const isServer = !isDM && !isGroupDM;

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
            if (!body && message.attachments?.length) body = "📎 Sent an attachment";
            if (!body && message.embeds?.length) body = "🔗 Sent an embed";
            if (!body) body = "(no content)";
            body = stripMarkup(body);

            const avatarUrl = message.author?.avatar
                ? `https://cdn.discordapp.com/avatars/${message.author.id}/${message.author.avatar}.png?size=64`
                : "";

            Native.showNotification({
                id: makeId(),
                title,
                serverLine,
                body,
                avatarUrl,
                type: isServer ? "server" : "dm",
                timeout: settings.store.timeout,
                cardWidth: settings.store.cardWidth,
                maxCards: settings.store.maxCards,
                imageUrls: getImageUrls(message),
                channelId: message.channel_id,
                guildId: channel.guild_id ?? null,
                messageId: message.id ?? null,
            }).catch((e: any) => warn("MESSAGE_CREATE: showNotification IPC rejected —", e));
        },
    },
});
