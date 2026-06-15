# Chat+

A [RyeLite](https://github.com/ash-of-the-meadow/RyeliteDesktop) plugin that splits the game's combined chat into WoW-style tabs — **All / Local / Global** — so you can read just the channel you care about.

## What it does

The game shows Local and Global chat in one combined list. This plugin adds a tab bar at the top of the chat panel:

| Tab | Shows |
|---|---|
| **All** | Local + Global (and system messages, unless you hide them — see settings) |
| **Local** | Local chat only (yellow) |
| **Global** | Global chat only (orange) |
| **System** | System/server messages only (white) |

When a message arrives on a channel you're **not** currently viewing, that tab flashes until you click it (WoW-style unread cue). This can be turned off in settings.

**Drag any tab to reorder it** (e.g. put Global before Local); the order is remembered. **Right-click a tab** for a *Clear all messages* option that hides that tab's current messages (client-side only — it can't touch the server's history; new messages still arrive). The chat area is a **fixed, adjustable height** so the tabs never jump around as you switch between them — set it with the *Chat height* slider.

The plugin only changes which messages are **visible** — it reuses the game's real chat list underneath, so right-click menus on chat lines and everything else keep working. Your chat **input is never touched**: sending behaves exactly as the game does.

### Settings

- **Flash tab on new message** — highlight a tab when a message arrives on a channel you're not viewing (default on).
- **Show system messages in All** — include white system/server messages in the All tab (default on). Turn this off, with the System tab on, to keep All clean while still getting system messages and their notifications in the System tab.
- **System tab** — add a dedicated System tab for system/server messages (default on). When off, there's no System tab and no system notifications.
- **Chat height (px)** — fixed height of the message area so the tabs don't jump (default 160).
- **Font size (px)** — size of the chat message text (default 13).
- **Put private messages in a tab** — add a Whispers tab for private messages and pull them out of their normal spot (default off).
- **Global / Local / Whisper text colour** — recolour each channel's messages. Defaults to the game's own colours.
- **Reset colours to default** — restore the three colours to the game's defaults.

## Installation

The intended way to install is through RyeLite's built-in plugin hub once the plugin is published there. Open RyeLite, go to the plugins menu, find **Chat+**, and enable it.

## Building from source

```bash
git clone https://github.com/matter418/ChatPlus.git
cd ChatPlus
yarn install
yarn build
```

The bundled output ends up at `dist/ChatPlus.js`. To test it locally against a development copy of RyeLite, copy that file into `RyeliteDesktop/src/renderer/client/plugins/` and launch the client with `yarn dev`.

## How it works (briefly)

1. On enable it waits for the chat UI to exist, then inserts a tab bar at the top of `#hs-chat-menu`.
2. Each message in `#hs-public-message-list__container` is classified by its colour class — orange = Global, yellow = Local, white = system.
3. Switching tabs toggles each message's `display`; the real nodes are never cloned or removed, so game handlers survive.
4. A `MutationObserver` catches new messages, filters them to the active tab, auto-scrolls, and flashes the relevant tab if you're looking elsewhere.

## License

GPL-3.0-or-later. See [LICENSE](./LICENSE).
