# Chat+

A [RyeLite](https://github.com/ash-of-the-meadow/RyeliteDesktop) plugin that reorganises the game's combined chat into WoW-style tabs, so you can read just the channel you care about.

## What it does

The game shows every channel in one combined list. Chat+ adds a tab bar at the top of the chat panel that filters it into separate tabs:

| Tab | Shows |
|---|---|
| **All** | Everything — Local + Global, plus the system messages you choose to include |
| **Local** | Local chat only (yellow) |
| **Global** | Global chat only (orange) |
| **System** | System/server messages — status (white), death (red), trade (purple) |
| **Whispers** | Private messages (optional; off by default) |

Each tab can be shown or hidden, and you can **drag tabs to reorder** them (the order is remembered). A tab shows an **unread count** and flashes when a message arrives on a channel you're not viewing; the count clears when you open it.

A few more touches:

- **Right-click a tab** → *Clear all messages* hides that tab's current messages (client-side only — it can't touch the server's history; new messages still arrive).
- The **▼ button** at the far right of the tab bar collapses the whole chat out of the way (▲ to bring it back); the state is remembered.
- Adjustable **height, width, font size, font, and per-channel text colours**.

Chat+ only changes which messages are **visible** — it reuses the game's real chat nodes underneath, so right-click menus on chat lines and everything else keep working. Your chat **input is never touched**: sending behaves exactly as the game does.

### Settings

- **Flash tabs on:** — per-channel toggles for which tabs flash when a new message arrives while you're not viewing them: **Local**, **Global**, **System**, **Whispers** (all on by default), and **Login** for "X Logged In/Out" notifications (off by default).
- **Show tabs:** — show/hide each tab individually: **All**, **Local**, **Global**, **System** (all on by default), and **Private** (off by default; turning it on adds the Whispers tab and moves whispers into it). Hiding the active tab switches you to the next visible one.
- **System in 'All':** — per-type toggles for which system messages appear in the All tab: **Status** (white), **Death** (red "X died"), and **Trade** (purple trade requests) — all on by default. Untick any to keep it out of All while it still shows in the System tab.
- **Chat height (px)** / **Chat width (px)** — size of the chat panel.
- **Font size (px)** — size of the chat message text (default 13).
- **Font** — choose the chat font from a list of common fonts (default is the game's font).
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
2. Public messages in `#hs-public-message-list__container` are classified by colour class — orange = Global, yellow = Local, and white/red/magenta = system sub-types (status/death/trade). Whispers come from the separate `#hs-private-message-list`.
3. Switching tabs toggles each message's `display`; the real nodes are never cloned or removed, so the game's own handlers survive. The Whispers list is temporarily relocated into the chat menu while its tab is enabled.
4. A `MutationObserver` filters new messages to the active tab, updates per-tab unread counts, and flashes tabs you're not currently viewing.

## License

GPL-3.0-or-later. See [LICENSE](./LICENSE).
