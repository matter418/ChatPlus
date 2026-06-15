import { Plugin, SettingsTypes } from "@ryelite/core";

/*
 * Chat+ — a RyeLite plugin that reorganises the game's chat into WoW-style tabs.
 *
 * The game keeps a single combined "public" message list and tells channels apart
 * only by a colour class on each line (orange = global, yellow = local, white =
 * system); whispers live in a *separate* list outside the chat menu. Chat+ adds a
 * tab bar and filters/relocates those real nodes — it never clones or rebuilds
 * them, so every game-attached behaviour (right-click menus, player-name actions)
 * keeps working, and the chat input is never touched, so sending is unchanged.
 *
 * Everything below is layered onto that idea: drag-reorderable tabs, a fixed
 * (adjustable) chat height, a font-size override, and per-channel colours.
 */

// ---------------------------------------------------------------------------
// Game DOM the plugin hooks into
// ---------------------------------------------------------------------------
const CHAT_MENU_ID = "hs-chat-menu"; // outer chat wrapper (tabs are inserted here)
const INPUT_MENU_ID = "hs-chat-input-menu"; // the free-type input area
const PUBLIC_LIST_ID = "hs-public-message-list__container"; // scrollable public list
const PRIVATE_LIST_ID = "hs-private-message-list"; // separate whispers list (sibling of the menu)
const MESSAGE_SELECTOR = ".hs-chat-message-container"; // one chat line

// Per-line colour classes the game uses to mark each channel. SYSTEM isn't matched
// directly (it's the classify() fallback) but is listed here for completeness.
const CLASS_GLOBAL = "hs-text--orange";
const CLASS_LOCAL = "hs-text--yellow";
const CLASS_SYSTEM = "hs-text--white";
const CLASS_PRIVATE = "hs-text--cyan"; // whispers: From / name / text all use this

// The game's own message colours, hardcoded (verified against the live client) so
// the plugin doesn't have to detect them. These are the picker defaults.
const DEFAULT_GLOBAL_COLOR = "#ffb400"; // orange
const DEFAULT_LOCAL_COLOR = "#ffff00"; // yellow
const DEFAULT_PRIVATE_COLOR = "#00ffff"; // cyan

// ---------------------------------------------------------------------------
// Nodes / identifiers this plugin injects (all namespaced "chatplus-")
// ---------------------------------------------------------------------------
const TABBAR_ID = "chatplus-tabbar";
const STYLE_ID = "chatplus-style";
const DRAG_BLOCKER_ID = "chatplus-drag-blocker";
const TAB_MENU_ID = "chatplus-tab-menu";

// Marks a message the user has "cleared" from a tab. A stylesheet rule hides it
// with !important, so it stays hidden through re-filtering (only new lines appear).
const CLEARED_CLASS = "chatplus-cleared";

// Pixels the pointer must travel before a press counts as a drag (vs a click).
const DRAG_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Channels & tabs
// ---------------------------------------------------------------------------
type Channel = "local" | "global" | "system" | "private";
type TabId = "all" | "local" | "global" | "system" | "private";

interface TabDef {
    id: TabId;
    label: string;
    /** The channel this tab flashes for (null = never flashes on its own). */
    channel: Channel | null;
}

// The always-present tabs. "All" shows everything; the rest filter to one channel.
const TABS: TabDef[] = [
    { id: "all", label: "All", channel: null },
    { id: "local", label: "Local", channel: "local" },
    { id: "global", label: "Global", channel: "global" },
];

// Optional tabs, appended only when their setting is on (System with "show system
// messages", Whispers with "put private in a tab"). Whispers come from a separate
// list, so that tab is handled specially (see the Whispers section).
const SYSTEM_TAB: TabDef = { id: "system", label: "System", channel: "system" };
const PRIVATE_TAB: TabDef = { id: "private", label: "Whispers", channel: "private" };

// Maps each colour-picker setting to the CSS variable that drives its override.
const COLOR_BINDINGS = [
    { setting: "globalColor", var: "--chatplus-color-global" },
    { setting: "localColor", var: "--chatplus-color-local" },
    { setting: "privateColor", var: "--chatplus-color-private" },
] as const;

export default class ChatPlus extends Plugin {
    pluginName = "Chat+";
    author = "matter";

    // --- Runtime state ------------------------------------------------------
    private activeTab: TabId = "all";
    private readonly unreadCounts = new Map<TabId, number>();

    private tabbar: HTMLElement | null = null;
    private readonly tabButtons = new Map<TabId, HTMLElement>();

    private listObserver: MutationObserver | null = null;
    private privateObserver: MutationObserver | null = null;
    private bootObserver: MutationObserver | null = null;

    // Drag-to-reorder: a flag to swallow the click that ends a drag, and the
    // overlay that captures pointer movement during one.
    private justDragged = false;
    private dragBlocker: HTMLElement | null = null;

    // The open right-click tab menu and the listener that dismisses it.
    private tabMenu: HTMLElement | null = null;
    private tabMenuDismiss: ((e: PointerEvent) => void) | null = null;

    // Where the private list normally lives, so we can put it back. It sits OUTSIDE
    // the chat menu (as a sibling), so we relocate it into the menu's message slot
    // while the Whispers tab feature is on.
    private privateOrigParent: HTMLElement | null = null;
    private privateOrigNext: Element | null = null;

    // ------------------------------------------------------------------------
    // Settings (rendered top-to-bottom in this order)
    // ------------------------------------------------------------------------
    constructor() {
        super();

        // Toggles
        this.settings.flashOnUnread = {
            text: "Flash tab on new message",
            description:
                "Highlight a tab when a message arrives on a channel you're not currently viewing.",
            type: SettingsTypes.checkbox,
            value: true,
            callback: () => {},
        };

        this.settings.showSystemInAll = {
            text: "Show system messages in All",
            description:
                "Include white system/server messages in the All tab. Turn this off (with the System tab on) to keep All clean while still getting them — and their notifications — in the System tab.",
            type: SettingsTypes.checkbox,
            value: true,
            callback: () => this.refilterIfActive(),
        };

        this.settings.showSystemTab = {
            text: "System tab",
            description:
                "Add a dedicated System tab for white system/server messages. When off, there's no System tab and no system notifications.",
            type: SettingsTypes.checkbox,
            value: true,
            callback: () => this.onShowSystemTabChanged(),
        };

        this.settings.privateInTab = {
            text: "Put private messages in a tab",
            description:
                "Add a Whispers tab for private messages and remove them from their normal spot. When off, private messages behave as the game shows them.",
            type: SettingsTypes.checkbox,
            value: false,
            callback: () => this.onPrivateInTabChanged(),
        };

        // Sliders
        this.settings.chatHeight = {
            text: "Chat height (px)",
            description:
                "Fixed height of the message area so the tabs stay put when you switch between them. Slide to resize.",
            type: SettingsTypes.range,
            value: 160,
            min: 80,
            max: 600,
            callback: () => this.applyHeight(),
        };

        this.settings.fontSize = {
            text: "Font size (px)",
            description: "Size of the chat message text.",
            type: SettingsTypes.range,
            value: 13,
            min: 9,
            max: 28,
            callback: () => this.applyFont(),
        };

        // Colours
        this.settings.globalColor = {
            text: "Global text colour",
            description: "Colour of global chat messages.",
            type: SettingsTypes.color,
            value: DEFAULT_GLOBAL_COLOR,
            callback: () => this.applyColors(),
        };

        this.settings.localColor = {
            text: "Local text colour",
            description: "Colour of local chat messages.",
            type: SettingsTypes.color,
            value: DEFAULT_LOCAL_COLOR,
            callback: () => this.applyColors(),
        };

        this.settings.privateColor = {
            text: "Whisper text colour",
            description: "Colour of private/whisper messages.",
            type: SettingsTypes.color,
            value: DEFAULT_PRIVATE_COLOR,
            callback: () => this.applyColors(),
        };

        this.settings.resetColors = {
            text: "Reset colours to default",
            description: "Restore the global, local, and whisper colours to the game's defaults.",
            type: SettingsTypes.button,
            value: "Reset",
            callback: () => this.resetColors(),
        };
    }

    // ------------------------------------------------------------------------
    // Plugin lifecycle
    // ------------------------------------------------------------------------
    init(): void {
        this.log("Initialized");
    }

    start(): void {
        this.log("Started");
        this.injectStyle();
        this.attachWhenReady();
    }

    stop(): void {
        this.log("Stopped");
        this.teardown();
    }

    // ------------------------------------------------------------------------
    // Attach / detach
    // ------------------------------------------------------------------------

    /**
     * The chat UI may not exist yet at enable/login time. Attach immediately if
     * the list is present, otherwise watch the DOM until it appears.
     */
    private attachWhenReady(): void {
        if (this.getList()) {
            this.attach();
            return;
        }
        this.bootObserver = new MutationObserver(() => {
            if (this.getList()) {
                this.bootObserver?.disconnect();
                this.bootObserver = null;
                this.attach();
            }
        });
        this.bootObserver.observe(document.body, { childList: true, subtree: true });
    }

    /** Build the UI and start observing, then apply all the current settings. */
    private attach(): void {
        const menu = document.getElementById(CHAT_MENU_ID);
        const list = this.getList();
        if (!menu || !list) return;

        this.buildTabBar(menu);
        this.observeList(list);
        this.observePrivate();

        this.applyFilter();
        this.updateListVisibility();
        this.applyHeight();
        this.applyFont();
        this.applyColors();
        this.scrollToBottom();
    }

    /** Undo everything: observers, injected nodes, styles, and DOM we moved. */
    private teardown(): void {
        this.bootObserver?.disconnect();
        this.bootObserver = null;
        this.listObserver?.disconnect();
        this.listObserver = null;
        this.privateObserver?.disconnect();
        this.privateObserver = null;

        this.closeTabMenu();

        // Restore every message to visible and hand the lists back to the game.
        this.unclearAll();
        for (const msg of this.messages()) msg.style.display = "";
        this.getList()?.style.removeProperty("display");
        this.restorePrivateList();
        this.privateOrigParent = null;
        this.privateOrigNext = null;

        // Drop our layout overrides from the menu.
        const menu = document.getElementById(CHAT_MENU_ID);
        menu?.classList.remove("chatplus-private");
        menu?.style.removeProperty("--chatplus-h");
        menu?.style.removeProperty("--chatplus-font");
        menu?.style.removeProperty("--chatplus-menu-h");

        // Drop the colour overrides from the document root.
        const root = document.documentElement;
        for (const c of COLOR_BINDINGS) root.style.removeProperty(c.var);

        this.tabbar?.remove();
        this.tabbar = null;
        this.tabButtons.clear();
        this.unreadCounts.clear();

        this.dragBlocker?.remove();
        this.dragBlocker = null;

        document.getElementById(STYLE_ID)?.remove();
    }

    // ------------------------------------------------------------------------
    // Tab bar
    // ------------------------------------------------------------------------

    private buildTabBar(menu: HTMLElement): void {
        document.getElementById(TABBAR_ID)?.remove();
        this.tabButtons.clear();

        const bar = document.createElement("div");
        bar.id = TABBAR_ID;

        for (const tab of this.orderedTabs()) {
            const btn = document.createElement("button");
            btn.className = "chatplus-tab";
            btn.dataset.tab = tab.id;
            btn.dataset.label = tab.label; // base label; the count is appended live
            if (tab.id === this.activeTab) btn.classList.add("active");
            // Selection goes through bindClick (the game's overlay eats plain
            // clicks); the justDragged guard ignores the click that ends a drag.
            this.bindClick(btn, () => {
                if (this.justDragged) return;
                this.selectTab(tab.id);
            });
            this.makeDraggable(btn, bar);
            this.bindTabContextMenu(btn, tab.id);
            this.tabButtons.set(tab.id, btn);
            this.updateTabLabel(tab.id); // render label (+ any carried-over count)
            bar.appendChild(btn);
        }

        // Sit at the top of the chat panel.
        menu.insertBefore(bar, menu.firstChild);
        this.tabbar = bar;
    }

    /** The tab set: the base tabs plus System / Whispers when their settings are on. */
    private allTabDefs(): TabDef[] {
        const tabs = [...TABS];
        if (this.showSystemTab()) tabs.push(SYSTEM_TAB);
        if (this.privateInTab()) tabs.push(PRIVATE_TAB);
        return tabs;
    }

    /** Tabs in the user's saved order, with any new/unknown tabs appended. */
    private orderedTabs(): TabDef[] {
        const source = this.allTabDefs();
        const saved: TabId[] = Array.isArray(this.data?.tabOrder) ? this.data.tabOrder : [];
        const byId = new Map(source.map((t) => [t.id, t]));
        const result: TabDef[] = [];
        for (const id of saved) {
            const tab = byId.get(id);
            if (tab && !result.includes(tab)) result.push(tab);
        }
        for (const tab of source) if (!result.includes(tab)) result.push(tab);
        return result;
    }

    private selectTab(id: TabId): void {
        this.activeTab = id;
        for (const [tabId, btn] of this.tabButtons) {
            btn.classList.toggle("active", tabId === id);
        }
        this.clearSeenUnread();
        this.updateListVisibility();
        this.applyFilter();
        this.scrollToBottom();
    }

    /** Rebuild the bar when the System tab is toggled on/off. */
    private onShowSystemTabChanged(): void {
        if (!this.showSystemTab() && this.activeTab === "system") this.activeTab = "all";
        const menu = document.getElementById(CHAT_MENU_ID);
        if (!menu || !this.tabbar) return;
        this.buildTabBar(menu);
        this.clearUnread("system");
        this.applyFilter();
        this.applyHeight();
        this.scrollToBottom();
    }

    // ------------------------------------------------------------------------
    // Drag-to-reorder
    // ------------------------------------------------------------------------

    private makeDraggable(btn: HTMLElement, bar: HTMLElement): void {
        btn.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return; // left button only
            this.startDrag(btn, bar, e);
        });
    }

    /**
     * Reorder tabs by dragging. Uses Pointer Events, not mouse events: this client
     * calls preventDefault() on pointerdown, which suppresses the legacy
     * mousedown/mousemove/mouseup compatibility events entirely (the same reason a
     * plain click is dead and selection goes through bindOnClickBlockHsMask).
     * Move/up are watched on document (capture) so the drag keeps tracking even
     * when the pointer leaves the tab, and a full-screen blocker stops the game
     * underneath from reacting while dragging.
     */
    private startDrag(btn: HTMLElement, bar: HTMLElement, down: PointerEvent): void {
        const startX = down.clientX;
        let dragging = false;

        const onMove = (e: PointerEvent) => {
            if (!dragging) {
                if (Math.abs(e.clientX - startX) < DRAG_THRESHOLD) return;
                dragging = true;
                btn.classList.add("dragging");
                this.showDragBlocker(true);
            }
            e.preventDefault();

            // Insert the dragged tab before the first sibling whose midpoint is to
            // the right of the cursor; otherwise it goes to the end.
            const siblings = Array.from(
                bar.querySelectorAll<HTMLElement>(".chatplus-tab")
            ).filter((t) => t !== btn);
            const after = siblings.find((sib) => {
                const r = sib.getBoundingClientRect();
                return e.clientX < r.left + r.width / 2;
            });
            if (after) bar.insertBefore(btn, after);
            else bar.appendChild(btn);
        };

        const onUp = () => {
            document.removeEventListener("pointermove", onMove, true);
            document.removeEventListener("pointerup", onUp, true);
            document.removeEventListener("pointercancel", onUp, true);
            if (!dragging) return;
            btn.classList.remove("dragging");
            this.showDragBlocker(false);
            this.saveOrderFromDom(bar);
            // Swallow the click that follows this drag, then re-arm selection.
            // (The click may not fire at all if the pointer ended over the blocker,
            // so a timeout — not the click itself — clears the flag.)
            this.justDragged = true;
            setTimeout(() => (this.justDragged = false), 50);
        };

        document.addEventListener("pointermove", onMove, true);
        document.addEventListener("pointerup", onUp, true);
        document.addEventListener("pointercancel", onUp, true);
    }

    /** Persist the current tab order from the DOM into plugin data. */
    private saveOrderFromDom(bar: HTMLElement): void {
        const ids = Array.from(bar.querySelectorAll<HTMLElement>(".chatplus-tab"))
            .map((el) => el.dataset.tab as TabId)
            .filter(Boolean);
        if (this.data) this.data.tabOrder = ids;
    }

    /** A transparent full-screen overlay shown during a drag to capture movement. */
    private showDragBlocker(show: boolean): void {
        if (show) {
            if (!this.dragBlocker) {
                const b = document.createElement("div");
                b.id = DRAG_BLOCKER_ID;
                b.style.cssText =
                    "position:fixed;inset:0;z-index:99998;cursor:grabbing;background:transparent;";
                document.body.appendChild(b);
                this.dragBlocker = b;
            }
            this.dragBlocker.style.display = "block";
        } else if (this.dragBlocker) {
            this.dragBlocker.style.display = "none";
        }
    }

    // ------------------------------------------------------------------------
    // Tab context menu ("Clear all messages")
    //
    // Clearing only hides the tab's current lines client-side (we can't touch the
    // server's history). Lines are marked with CLEARED_CLASS, hidden by an
    // !important rule so they stay hidden through re-filtering; new lines still show.
    // ------------------------------------------------------------------------

    private bindTabContextMenu(btn: HTMLElement, tabId: TabId): void {
        // Trigger on right-button pointerdown (reliable in this client) and
        // suppress the native browser menu.
        btn.addEventListener("pointerdown", (e) => {
            if (e.button !== 2) return;
            e.preventDefault();
            e.stopPropagation();
            this.openTabMenu(e.clientX, e.clientY, tabId);
        });
        btn.addEventListener("contextmenu", (e) => e.preventDefault());
    }

    private openTabMenu(x: number, y: number, tabId: TabId): void {
        this.closeTabMenu();

        const menu = document.createElement("div");
        menu.id = TAB_MENU_ID;
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;

        const item = document.createElement("button");
        item.className = "chatplus-menu-item";
        item.textContent = "Clear all messages";
        this.bindClick(item, () => {
            this.clearTab(tabId);
            this.closeTabMenu();
        });
        menu.appendChild(item);

        document.body.appendChild(menu);
        this.tabMenu = menu;

        // Dismiss on the next pointerdown outside the menu. Registered async so the
        // right-click that opened it doesn't immediately close it.
        this.tabMenuDismiss = (e) => {
            if (this.tabMenu && !this.tabMenu.contains(e.target as Node)) this.closeTabMenu();
        };
        setTimeout(() => {
            if (this.tabMenuDismiss) {
                document.addEventListener("pointerdown", this.tabMenuDismiss, true);
            }
        }, 0);
    }

    private closeTabMenu(): void {
        this.tabMenu?.remove();
        this.tabMenu = null;
        if (this.tabMenuDismiss) {
            document.removeEventListener("pointerdown", this.tabMenuDismiss, true);
            this.tabMenuDismiss = null;
        }
    }

    /**
     * Hide the messages belonging to a tab (all of them for All / Whispers) and
     * stop that tab flashing, until a new message arrives for it.
     */
    private clearTab(tabId: TabId): void {
        if (tabId === "private") {
            document
                .getElementById(PRIVATE_LIST_ID)
                ?.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR)
                .forEach((m) => m.classList.add(CLEARED_CLASS));
            this.clearUnread("private");
            return;
        }
        for (const msg of this.messages()) {
            if (tabId === "all" || this.classify(msg) === tabId) msg.classList.add(CLEARED_CLASS);
        }
        // "All" covers every public channel, so clear all of their flashes too.
        if (tabId === "all") {
            this.clearUnread("local");
            this.clearUnread("global");
            this.clearUnread("system");
        } else {
            this.clearUnread(tabId);
        }
    }

    /** Un-hide everything we've cleared (used on teardown). */
    private unclearAll(): void {
        for (const list of [this.getList(), document.getElementById(PRIVATE_LIST_ID)]) {
            list?.querySelectorAll<HTMLElement>(`.${CLEARED_CLASS}`).forEach((m) =>
                m.classList.remove(CLEARED_CLASS)
            );
        }
    }

    // ------------------------------------------------------------------------
    // Whispers / private list
    //
    // Whispers are a separate list (#hs-private-message-list) that lives OUTSIDE
    // the chat menu. When the feature is on we move it into the menu so it shares
    // the message area, show it only on the Whispers tab, and move it back when off.
    // ------------------------------------------------------------------------

    private privateInTab(): boolean {
        return this.settings.privateInTab?.value === true;
    }

    /** Rebuild the bar when the Whispers tab is toggled on/off. */
    private onPrivateInTabChanged(): void {
        if (!this.privateInTab() && this.activeTab === "private") this.activeTab = "all";
        const menu = document.getElementById(CHAT_MENU_ID);
        if (!menu || !this.tabbar) return;
        this.buildTabBar(menu);
        this.clearUnread("private");
        this.updateListVisibility();
        this.applyFilter();
        this.applyHeight();
        this.scrollToBottom();
    }

    /**
     * Show the right list for the active tab: the Whispers tab shows the private
     * list (and hides the public one); every other tab shows the public list. When
     * the setting is off we don't touch the private list at all.
     */
    private updateListVisibility(): void {
        const pub = this.getList();
        const pm = document.getElementById(PRIVATE_LIST_ID);
        const enabled = this.privateInTab();
        const onPrivate = this.activeTab === "private";

        // Only style the private list while the feature is on (its CSS rules are
        // gated behind this class), so we never touch its normal layout when off.
        document.getElementById(CHAT_MENU_ID)?.classList.toggle("chatplus-private", enabled);
        this.placePrivateList();

        if (pub) pub.style.display = onPrivate ? "none" : "";
        if (pm && !enabled) pm.style.removeProperty("display");
        if (pm && enabled) pm.style.display = onPrivate ? "" : "none";
    }

    /**
     * Move the private list into the menu's message slot (just above the input)
     * while the feature is on, remembering where it came from so restorePrivateList
     * can put it back.
     */
    private placePrivateList(): void {
        const pm = document.getElementById(PRIVATE_LIST_ID);
        const menu = document.getElementById(CHAT_MENU_ID);
        if (!pm || !menu) return;

        if (!this.privateInTab()) {
            this.restorePrivateList();
            return;
        }
        if (pm.parentElement === menu) return; // already placed

        // Remember the original location the first time we move it.
        if (!this.privateOrigParent) {
            this.privateOrigParent = pm.parentElement;
            this.privateOrigNext = pm.nextElementSibling;
        }
        const input = document.getElementById(INPUT_MENU_ID);
        if (input && input.parentElement === menu) menu.insertBefore(pm, input);
        else menu.appendChild(pm);
    }

    /** Return the private list to where the game originally had it. */
    private restorePrivateList(): void {
        const pm = document.getElementById(PRIVATE_LIST_ID);
        if (!pm || !this.privateOrigParent) return;
        if (pm.parentElement !== this.privateOrigParent) {
            const ref =
                this.privateOrigNext && this.privateOrigNext.parentElement === this.privateOrigParent
                    ? this.privateOrigNext
                    : null;
            this.privateOrigParent.insertBefore(pm, ref);
        }
        pm.style.removeProperty("display");
    }

    // ------------------------------------------------------------------------
    // Messages: observe, filter, classify
    // ------------------------------------------------------------------------

    /** Watch the public list for new lines, filter them, and keep it scrolled. */
    private observeList(list: HTMLElement): void {
        this.listObserver?.disconnect();
        this.listObserver = new MutationObserver((records) => {
            let added = false;
            for (const rec of records) {
                rec.addedNodes.forEach((node) => {
                    if (!(node instanceof HTMLElement)) return;
                    const msgs = node.matches(MESSAGE_SELECTOR)
                        ? [node]
                        : Array.from(node.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR));
                    for (const msg of msgs) {
                        this.onNewMessage(msg);
                        added = true;
                    }
                });
            }
            if (added) this.scrollToBottom();
        });
        this.listObserver.observe(list, { childList: true, subtree: true });
    }

    /**
     * Watch the separate private list so the Whispers tab can flash on a new
     * whisper (and auto-scroll while it's the active tab). Only acts when the
     * "put private in a tab" setting is on.
     */
    private observePrivate(): void {
        const pm = document.getElementById(PRIVATE_LIST_ID);
        if (!pm) return;
        this.privateObserver?.disconnect();
        this.privateObserver = new MutationObserver((records) => {
            const added = records.some((rec) =>
                Array.from(rec.addedNodes).some(
                    (n) =>
                        n instanceof HTMLElement &&
                        (n.matches(MESSAGE_SELECTOR) || n.querySelector(MESSAGE_SELECTOR))
                )
            );
            if (!added || !this.privateInTab()) return;
            if (this.activeTab === "private") this.scrollToBottom();
            else if (this.flashEnabled()) this.bumpUnread("private");
        });
        this.privateObserver.observe(pm, { childList: true, subtree: true });
    }

    /** Filter a freshly added line to the active tab, and flash its tab if hidden. */
    private onNewMessage(msg: HTMLElement): void {
        const channel = this.classify(msg);
        const visibleHere = this.shouldShow(channel, this.activeTab);
        msg.style.display = visibleHere ? "" : "none";

        // Flash the channel's own tab only when the message isn't already visible
        // in the tab we're looking at.
        if (this.flashEnabled() && !visibleHere) {
            // Look up the channel's tab in the active set, so a hidden System tab
            // (system messages off) never gets an unread count.
            const tab = this.allTabDefs().find((t) => t.channel === channel);
            if (tab && tab.id !== this.activeTab) this.bumpUnread(tab.id);
        }
    }

    /** Re-evaluate visibility of every public message for the current tab. */
    private applyFilter(): void {
        for (const msg of this.messages()) {
            const channel = this.classify(msg);
            msg.style.display = this.shouldShow(channel, this.activeTab) ? "" : "none";
        }
    }

    /** Re-filter when a setting changes, but only if we're actually attached. */
    private refilterIfActive(): void {
        if (this.tabbar) this.applyFilter();
    }

    /** Determine a public line's channel from its colour class. */
    private classify(msg: HTMLElement): Channel {
        if (msg.querySelector(`.${CLASS_GLOBAL}`)) return "global";
        if (msg.querySelector(`.${CLASS_LOCAL}`)) return "local";
        return "system"; // white / anything else
    }

    /** Whether a line of `channel` should be visible on `tab`. */
    private shouldShow(channel: Channel, tab: TabId): boolean {
        // All shows everything except system when system messages are hidden.
        if (tab === "all") return channel !== "system" || this.showSystemInAll();
        // Local / Global / System each show only their own channel.
        return channel === tab;
    }

    // ------------------------------------------------------------------------
    // Unread counts
    //
    // Each tab tracks how many messages arrived while it wasn't being viewed; the
    // count shows as "Label (n)" and the tab flashes until it's read or cleared.
    // ------------------------------------------------------------------------

    private bumpUnread(id: TabId): void {
        this.unreadCounts.set(id, (this.unreadCounts.get(id) ?? 0) + 1);
        this.updateTabLabel(id);
    }

    private clearUnread(id: TabId): void {
        this.unreadCounts.set(id, 0);
        this.updateTabLabel(id);
    }

    /**
     * Clear the count for the tab just opened, plus — when opening All — every
     * channel whose messages are visible there (local, global, and system if it's
     * shown in All). Whispers are never in All, so they keep their count.
     */
    private clearSeenUnread(): void {
        this.clearUnread(this.activeTab);
        if (this.activeTab === "all") {
            this.clearUnread("local");
            this.clearUnread("global");
            if (this.showSystemInAll()) this.clearUnread("system");
        }
    }

    /** Render a tab's label with its unread count, and flash it while non-zero. */
    private updateTabLabel(id: TabId): void {
        const btn = this.tabButtons.get(id);
        if (!btn) return;
        const count = this.unreadCounts.get(id) ?? 0;
        const label = btn.dataset.label ?? "";
        const badge = count > 99 ? "99+" : String(count);
        btn.textContent = count > 0 ? `${label} (${badge})` : label;
        btn.classList.toggle("unread", count > 0);
    }

    // ------------------------------------------------------------------------
    // Layout: height & font
    //
    // Both are driven through CSS variables read by !important stylesheet rules, so
    // the game's per-render inline styles can't override them. The variables are set
    // on the menu and inherit down to the public/private lists.
    // ------------------------------------------------------------------------

    /**
     * Pin the message list to a fixed height so the tab bar never shifts as the
     * visible message count changes.
     */
    private applyHeight(): void {
        const menu = document.getElementById(CHAT_MENU_ID);
        if (!menu) return;
        const h = Number(this.settings.chatHeight?.value) || 160;
        menu.style.setProperty("--chatplus-h", `${h}px`);

        // The chat panel has a fixed total height, so growing the list alone just
        // squeezes the input. Grow the whole menu to fit list + tabs + input.
        const inputH = document.getElementById(INPUT_MENU_ID)?.offsetHeight ?? 0;
        const tabsH = this.tabbar?.offsetHeight ?? 0;
        menu.style.setProperty("--chatplus-menu-h", `${h + inputH + tabsH + 10}px`);
        this.scrollToBottom();
    }

    /** Override the chat message font size. */
    private applyFont(): void {
        const menu = document.getElementById(CHAT_MENU_ID);
        if (!menu) return;
        const size = Number(this.settings.fontSize?.value) || 13;
        menu.style.setProperty("--chatplus-font", `${size}px`);
        this.scrollToBottom();
    }

    // ------------------------------------------------------------------------
    // Colours
    //
    // Each picker's value feeds a CSS variable on the document root, read by an
    // !important rule on that channel's colour class. An empty value clears the
    // override so the game's native colour shows through.
    // ------------------------------------------------------------------------

    private resetColors(): void {
        if (this.settings.globalColor) this.settings.globalColor.value = DEFAULT_GLOBAL_COLOR;
        if (this.settings.localColor) this.settings.localColor.value = DEFAULT_LOCAL_COLOR;
        if (this.settings.privateColor) this.settings.privateColor.value = DEFAULT_PRIVATE_COLOR;
        this.applyColors();
        (document as any).highlite?.managers?.SettingsManager?.updatePluginSettingsUI?.(this);
    }

    private applyColors(): void {
        const root = document.documentElement;
        for (const c of COLOR_BINDINGS) {
            const val = String(this.settings[c.setting]?.value || "");
            if (val) root.style.setProperty(c.var, val);
            else root.style.removeProperty(c.var);
        }
    }

    // ------------------------------------------------------------------------
    // DOM & settings helpers
    // ------------------------------------------------------------------------

    private getList(): HTMLElement | null {
        return document.getElementById(PUBLIC_LIST_ID);
    }

    private messages(): HTMLElement[] {
        const list = this.getList();
        return list ? Array.from(list.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR)) : [];
    }

    /** Scroll whichever list the active tab is showing to the newest message. */
    private scrollToBottom(): void {
        const list =
            this.activeTab === "private"
                ? document.getElementById(PRIVATE_LIST_ID)
                : this.getList();
        if (list) list.scrollTo(0, list.scrollHeight);
    }

    private flashEnabled(): boolean {
        return this.settings.flashOnUnread?.value !== false;
    }

    private showSystemInAll(): boolean {
        return this.settings.showSystemInAll?.value !== false;
    }

    private showSystemTab(): boolean {
        return this.settings.showSystemTab?.value !== false;
    }

    /**
     * Bind a click that survives the game's click-blocking overlay ("hs-mask").
     * A plain addEventListener('click') never fires because the mask sits over the
     * UI — the game exposes UIManager.bindOnClickBlockHsMask for exactly this.
     * Falls back to a normal listener if the manager isn't available.
     */
    private bindClick(el: HTMLElement, handler: () => void): void {
        const ui = (document as any).highlite?.managers?.UIManager;
        if (typeof ui?.bindOnClickBlockHsMask === "function") {
            ui.bindOnClickBlockHsMask(el, handler);
        } else {
            el.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                handler();
            });
        }
    }

    // ------------------------------------------------------------------------
    // Styling — one injected stylesheet, all rules namespaced/scoped to our nodes
    // ------------------------------------------------------------------------

    private injectStyle(): void {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
/* Fixed-height message area (public, and private only while the feature is on). */
#${PUBLIC_LIST_ID} {
    height: var(--chatplus-h, 160px) !important;
    max-height: none !important;
    overflow-y: auto !important;
}
#${CHAT_MENU_ID}.chatplus-private #${PRIVATE_LIST_ID} {
    height: var(--chatplus-h, 160px) !important;
    max-height: none !important;
    overflow-y: auto !important;
}
/* Grow the whole menu so the taller list doesn't squeeze the input. */
#${CHAT_MENU_ID} {
    height: var(--chatplus-menu-h, auto) !important;
    max-height: none !important;
}
/* Message font size. */
#${PUBLIC_LIST_ID} .hs-chat-message-container,
#${PUBLIC_LIST_ID} .hs-chat-message-container *,
#${CHAT_MENU_ID}.chatplus-private #${PRIVATE_LIST_ID} .hs-chat-message-container,
#${CHAT_MENU_ID}.chatplus-private #${PRIVATE_LIST_ID} .hs-chat-message-container * {
    font-size: var(--chatplus-font, 13px) !important;
    line-height: 1.25 !important;
}
/* Per-channel colours (unset variable = native game colour). */
#${PUBLIC_LIST_ID} .${CLASS_GLOBAL} {
    color: var(--chatplus-color-global) !important;
}
#${PUBLIC_LIST_ID} .${CLASS_LOCAL} {
    color: var(--chatplus-color-local) !important;
}
.${CLASS_PRIVATE} {
    color: var(--chatplus-color-private) !important;
}
/* Messages the user cleared from a tab (client-side only). */
.${CLEARED_CLASS} {
    display: none !important;
}
/* Tab bar. */
#${TABBAR_ID} {
    display: flex;
    gap: 2px;
    padding: 2px 2px 0 2px;
    box-sizing: border-box;
    width: 100%;
}
#${TABBAR_ID} .chatplus-tab {
    flex: 0 0 auto;
    padding: 3px 12px;
    font: inherit;
    font-size: 12px;
    line-height: 1.2;
    color: #b8b8b8;
    background: rgba(0, 0, 0, 0.35);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-bottom: none;
    border-radius: 5px 5px 0 0;
    cursor: grab;
    user-select: none;
}
#${TABBAR_ID} .chatplus-tab.dragging {
    opacity: 0.6;
    cursor: grabbing;
}
#${TABBAR_ID} .chatplus-tab:hover {
    color: #e6e6e6;
    background: rgba(255, 255, 255, 0.08);
}
#${TABBAR_ID} .chatplus-tab.active {
    color: #ffffff;
    background: rgba(255, 255, 255, 0.14);
    border-color: rgba(255, 255, 255, 0.28);
}
#${TABBAR_ID} .chatplus-tab.unread:not(.active) {
    color: #ffd34d;
    animation: chatplus-flash 1s ease-in-out infinite;
}
@keyframes chatplus-flash {
    0%, 100% { background: rgba(255, 211, 77, 0.10); }
    50%      { background: rgba(255, 211, 77, 0.32); }
}
/* Right-click tab menu. */
#${TAB_MENU_ID} {
    position: fixed;
    z-index: 99999;
    min-width: 140px;
    padding: 3px;
    background: #2a2a2a;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
}
#${TAB_MENU_ID} .chatplus-menu-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 5px 10px;
    font: inherit;
    font-size: 12px;
    color: #e0e0e0;
    background: transparent;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    white-space: nowrap;
}
#${TAB_MENU_ID} .chatplus-menu-item:hover {
    background: rgba(255, 255, 255, 0.12);
}`;
        document.head.appendChild(style);
    }
}
