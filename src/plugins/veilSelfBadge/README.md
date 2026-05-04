# VeilSelfBadge — a minimal Vencord userplugin

A tiny Vencord plugin that pins a custom badge on your own Discord profile.
Because Vencord runs entirely on your client, the badge is visible **only to
you** — nobody else sees it.

---

## What is Vencord?

[Vencord](https://vencord.dev) is a client mod for the official Discord
desktop/web app. It injects a JavaScript bundle into Discord's renderer
process and exposes a plugin API that lets you patch Discord's internal
modules at runtime (via Webpack lookups + function-source string patches).

Two important things to keep in mind:

- **Everything is client-side.** Plugins can only change what *you* see /
  what your client sends. They cannot make other users see things they
  don't have. A "badge only I can see" is the natural state for any
  Vencord plugin — making one *everyone* sees would be impossible without
  Discord's actual servers.
- **Using a client mod is technically against Discord ToS.** Vencord's
  approach (no automation, no self-bot behaviour) has historically not
  caused bans, but the risk is non-zero. Don't use it on an account you
  can't afford to lose.

## Vesktop vs Vencord

| | what it is |
|--|--|
| **Vencord** | the mod itself — a JS bundle injected into Discord. |
| **Vesktop** | a standalone desktop app (Electron) that ships Vencord pre-installed. It's a from-scratch Discord client wrapper, lighter than the official app, with better Linux screen-share support. On Windows it's optional; the regular Discord client + Vencord installer works fine. |

So: Vencord = the mod, Vesktop = a Discord-replacement desktop app that
bundles Vencord. Plugins work the same in both.

## Plugin structure

A Vencord plugin is a TypeScript module that **default-exports** the result
of `definePlugin({...})`. The common fields:

```ts
export default definePlugin({
    name: "MyPlugin",                    // unique
    description: "...",
    authors: [{ name: "you", id: 0n }],
    dependencies: ["MessageEventsAPI"],  // other plugins/APIs you need

    // One-shot lifecycle hooks:
    start() { /* runs when the plugin is enabled */ },
    stop()  { /* runs when it is disabled */ },

    // Webpack patches — replace strings in Discord's own source at load time:
    patches: [{
        find: "some unique string in the target module",
        replacement: {
            match: /someRegex/,
            replace: "$self.myInjectedFn($1)"
        }
    }],

    // React-tree injection points (settings panels, context menus, etc.):
    settings, // a definePluginSettings(...) object
    contextMenus: { "user-context": (children, props) => { /* mutate */ } },
    commands: [/* slash commands */],
});
```

### What you can do with it

- **Add UI**: profile badges, toolbar buttons, settings sections, modals,
  context-menu entries.
- **Slash commands** that only run locally (`/myCommand` → echoes,
  fetches data, transforms text before send).
- **Patch Discord internals**: hide elements, change behaviour of
  existing functions, intercept message sends, decrypt/encrypt content,
  add new keybinds.
- **Persistent settings** via `definePluginSettings`.
- **Talk to native code** via a `native.ts` sibling file (Node-side
  capabilities like reading files, spawning processes — only in the
  desktop client).

### What you *cannot* do

- Make changes visible to other users (no server access).
- Run plugins on the official Discord mobile apps.
- Bypass anything that's enforced server-side (nitro features for
  recipients, role permissions, etc.).

## How this plugin works

`index.tsx` calls `addProfileBadge(...)` on `start()` with a
`ProfileBadge` whose `shouldShow` predicate returns `true` only when the
profile being rendered matches `MY_USER_ID`. Vencord's BadgeAPI then
injects it into Discord's profile-popout React tree.

## Install (as a userplugin)

Userplugins are local-only — they're not in Vencord's official repo, so
they require a **dev build**.

1. Install [git](https://git-scm.com), [Node.js](https://nodejs.org)
   (≥18), and [`pnpm`](https://pnpm.io): `npm i -g pnpm`.
2. Clone Vencord and install deps:
   ```bash
   git clone https://github.com/Vendicated/Vencord
   cd Vencord
   pnpm install --frozen-lockfile
   ```
3. Drop this plugin into the userplugins folder. From the Vencord repo
   root:
   ```bash
   mkdir -p src/userplugins
   cp -r "C:/Users/gabriele_todaro/Documents/Veil/veil-vencord-plugin" src/userplugins/VeilSelfBadge
   ```
   (or just symlink / copy the folder there — the folder name becomes
   the plugin's directory name).
4. **Edit `index.tsx`** and replace `MY_USER_ID` with your own Discord
   user ID (Discord settings → Advanced → enable Developer Mode →
   right-click your avatar → "Copy User ID").
5. Build + inject:
   ```bash
   pnpm build
   pnpm inject
   ```
   Pick your Discord install when prompted (Stable / PTB / Canary /
   Vesktop). Restart Discord.
6. Open Discord → Settings → **Vencord → Plugins** → search
   "VeilSelfBadge" → toggle it on. Open your own profile — the badge
   appears next to the Nitro/HypeSquad ones.

To update the plugin later: edit the file, re-run `pnpm build`, restart
Discord (no need to re-inject).

To uninstall: `pnpm uninject` from the Vencord repo, or just disable
the plugin in settings.

## Customising the badge

In `index.tsx`:

- `description` — tooltip text on hover.
- `image` — any URL to a small square image (PNG/GIF/WebP). For a local
  asset, import it: `import logo from "./logo.png"` and use `logo` as
  the value.
- `position` — ordering vs. other badges.
- `link` — optional click target.
- `shouldShow` — predicate; expand it (e.g. `[id1, id2].includes(userId)`)
  if you want the badge on multiple accounts you control.
