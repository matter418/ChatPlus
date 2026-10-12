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
| **Private** | Private messages (optional; off by default) |

Each tab can be shown or hidden, and you can **drag tabs to reorder** them (the order is remembered). A tab shows an **unread count** and flashes when a message arrives on a channel you're not viewing; the count clears when you open it.

A few more touches:

- **Right-click a tab** → *Clear all messages* hides that tab's current messages (client-side only — it can't touch the server's history; new messages still arrive).
- The **▼ arrow** in the tab bar (right after the tabs by default — drag it to put it wherever you like among them) collapses the whole chat out of the way (▲ to bring it back). The state is remembered, and you can do the same from the **Hide chat** setting. Don't want the arrow at all? Turn off **Show collapse arrow**.
- Adjustable **height, width, font size, font, and per-channel text colours**.

Chat+ only changes which messages are **visible** — it reuses the game's real chat nodes underneath, so right-click menus on chat lines and everything else keep working. Your chat **input is never touched**: sending behaves exactly as the game does.

### Settings

- **Flash tabs on:** — per-channel toggles for which tabs flash when a new message arrives while you're not viewing them: **Local**, **Global**, **System**, **Private** (all on by default), and **Login** for "X Logged In/Out" notifications (off by default).
- **Show tabs:** — show/hide each tab individually: **All**, **Local**, **Global**, **System** (all on by default), and **Private** (off by default; turning it on adds the Private tab and moves private messages into it). Hiding the active tab switches you to the next visible one.
- **System in 'All':** — per-type toggles for which system messages appear in the All tab: **Status** (white), **Death** (red "X died"), and **Trade** (purple trade requests) — all on by default. Untick any to keep it out of All while it still shows in the System tab.
- **Filters:** — **Ignored players** and **Blocked words** each open a chip editor (type, press Enter to add; click a chip to remove). Ignored players are treated like the game's own block list (it hooks the same check the client uses), so their public chat, whispers **and** overhead text all disappear; messages containing a blocked word/phrase (whole-word, case-insensitive) are hidden entirely and never flash a tab. An uncapped ignore list on top of the game's 50-slot one.
- **Alert words** — a third chip editor: when a new message contains one of these (whole-word, case-insensitive) you hear a ding and the line is highlighted — add your own name to get pinged. Your own messages never ding. **Alert sound** picks the tone from the client's shared list (Ding, Chime, Bell, Blip, Knock or the Idle Alert plugin's sound — changing it plays a preview), **Alert volume (%)** sets the loudness (0 = silent, highlight only) and **Test alert sound** plays it.
- **Chat window:** — **Hide chat** collapses the chat to just the tab bar (kept in sync with the ▼/▲ arrow), and **Show collapse arrow** (on by default) shows or hides the arrow itself.
- **Chat height (px)** / **Chat width (px)** — size of the chat panel.
- **Font size (px)** — size of the chat message text (default 13).
- **Font** — choose the chat font from a list of common fonts (default is the game's font).
- **Custom background** — tick to override the chat panel's background, then pick the **Background colour** and **Background opacity (%)** (0 = see-through, 100 = solid).
- **Global / Local / Private / System / Death / Trade text colour** — recolour each kind of message. Defaults to the game's own colours.
- **Reset colours to default** — restore all text colours to the game's defaults.

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
2. Public messages in `#hs-public-message-list__container` are classified by colour class — orange = Global, yellow = Local, and white/red/magenta = system sub-types (status/death/trade). Private messages come from the separate `#hs-private-message-list`.
3. Switching tabs toggles each message's `display`; the real nodes are never cloned or removed, so the game's own handlers survive. The private-message list is temporarily relocated into the chat menu while its tab is enabled.
4. A `MutationObserver` filters new messages to the active tab, updates per-tab unread counts, and flashes tabs you're not currently viewing.

## License

GPL-3.0-or-later. See [LICENSE](./LICENSE).
