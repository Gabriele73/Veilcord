/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Single consolidated Webpack-find module for Veil plugins. Every component
 * lookup against Discord's runtime lives here so a Discord refactor only
 * needs fixing in one place. Each find is lazy and guarded; a missing find
 * surfaces as `undefined` so calling sites can degrade gracefully.
 *
 * Do not introduce ad-hoc `findByProps` / `findComponentByCode` calls in
 * feature plugins — extend this module instead.
 */

import { findByPropsLazy, findComponentByCodeLazy, findStoreLazy } from "@webpack";
import {
    ChannelStore,
    FluxDispatcher,
    GuildChannelStore,
    GuildMemberStore,
    GuildStore,
    MessageActions,
    MessageStore,
    NavigationRouter,
    PermissionStore,
    SelectedChannelStore,
    SelectedGuildStore,
    UserProfileStore,
    UserStore
} from "@webpack/common";

// PrivateChannelsStore isn't on @webpack/common; resolve it lazily so we can
// later patch group-DM-shaped Veil rooms in. Returns undefined if Discord
// renames the store, callers must guard.
export const PrivateChannelsStore = findStoreLazy("PrivateChannelsStore") as any;

// Discord shell components.
export const Avatar = findByPropsLazy("AnimatedAvatar", "Avatar");
export const Parser = findByPropsLazy("parse", "parseTopic");
export const Forms = findByPropsLazy("FormSection", "FormText");

// Guild bar shell — used by plugins that mount items between guild icons.
// Pattern is the same one betterFolders.FolderSideBar uses.
export const GuildsBar = findComponentByCodeLazy('("guildsnav")');

// Re-exports so feature plugins import everything from one place.
export {
    ChannelStore,
    FluxDispatcher,
    GuildChannelStore,
    GuildMemberStore,
    GuildStore,
    MessageActions,
    MessageStore,
    NavigationRouter,
    PermissionStore,
    SelectedChannelStore,
    SelectedGuildStore,
    UserProfileStore,
    UserStore
};
