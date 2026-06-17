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
 * Everything below is layered onto that idea: per-tab show/hide, drag-reorderable
 * tabs, unread counts, a right-click "clear", a collapse toggle, and adjustable
 * height / width / font / per-channel colours.
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
// System sub-types (all classify as "system"; split for per-type "show in All").
const CLASS_DEATH = "hs-text--red"; // death messages ("X died") — assumed, verify in-game
const CLASS_TRADE = "hs-text--magenta"; // incoming trade requests (purple)

// The game's own message colours, hardcoded (verified against the live client) so
// the plugin doesn't have to detect them. These are the picker defaults.
const DEFAULT_GLOBAL_COLOR = "#ffb400"; // orange
const DEFAULT_LOCAL_COLOR = "#ffff00"; // yellow
const DEFAULT_PRIVATE_COLOR = "#00ffff"; // cyan

// Curated font choices — we can't reliably enumerate the user's installed fonts,
// so we offer common ones (bare family names; applyFont appends the game's own font
// as the fallback so an absent font degrades to the normal chat font, not a generic).
// "Default" = no override.
const FONT_FAMILIES: Record<string, string> = {
    Default: "",
    "Sans-serif": "sans-serif",
    Serif: "serif",
    Monospace: "monospace",
    Arial: "Arial",
    Verdana: "Verdana",
    Tahoma: "Tahoma",
    "Trebuchet MS": "'Trebuchet MS'",
    "Segoe UI": "'Segoe UI'",
    Georgia: "Georgia",
    "Times New Roman": "'Times New Roman'",
    "Courier New": "'Courier New'",
    Consolas: "Consolas",
    "Comic Sans MS": "'Comic Sans MS'",
    Impact: "Impact",
    // Symbol/dingbat fonts — turn chat into glorious nonsense.
    Wingdings: "Wingdings",
    Webdings: "Webdings",
    Symbol: "Symbol",
};
const FONT_OPTIONS = Object.keys(FONT_FAMILIES);

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

// Setting keys for the plain-text section labels (SettingsTypes.info rows restyled
// into subtitles by injectStyle).
const HEADER_KEYS = ["flashHeader", "showTabsHeader", "allInHeader", "customizeHeader"];

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
    /** Checkbox setting key that controls whether this tab is shown. */
    showSetting: string;
}

// Every tab is optional now — each is shown only when its "Show tabs" checkbox is
// on. The Whispers (Private) tab also pulls whispers out of their normal spot and
// is handled specially (see the Whispers section).
const TABS: TabDef[] = [
    { id: "all", label: "All", channel: null, showSetting: "showAllTab" },
    { id: "local", label: "Local", channel: "local", showSetting: "showLocalTab" },
    { id: "global", label: "Global", channel: "global", showSetting: "showGlobalTab" },
    { id: "system", label: "System", channel: "system", showSetting: "showSystemTab" },
    { id: "private", label: "Whispers", channel: "private", showSetting: "showPrivateTab" },
];

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
    private collapseBtn: HTMLElement | null = null;
    private collapsed = false;

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

        // "Flash tabs on:" — which channels light up their tab on a new message.
        // (Each *Header is a plain-text section label: an info row restyled by injectStyle.)
        this.settings.flashHeader = {
            text: "Flash tabs on:",
            type: SettingsTypes.info,
            value: "Flash tabs on:",
            callback: () => {},
        };

        this.settings.flashLocal = {
            text: "Local",
            type: SettingsTypes.checkbox,
            value: true,
            callback: () => {},
        };

        this.settings.flashGlobal = {
            text: "Global",
            type: SettingsTypes.checkbox,
            value: true,
            callback: () => {},
        };

        this.settings.flashSystem = {
            text: "System",
            type: SettingsTypes.checkbox,
            value: true,
            callback: () => {},
        };

        this.settings.flashWhispers = {
            text: "Whispers",
            type: SettingsTypes.checkbox,
            value: true,
            callback: () => {},
        };

        this.settings.flashLogin = {
            text: "Login",
            description: "Flash the Whispers tab for 'X Logged In/Out' notifications.",
            type: SettingsTypes.checkbox,
            value: false,
            callback: () => {},
        };

        // "Show tabs:" — show or hide each tab individually.
        this.settings.showTabsHeader = {
            text: "Show tabs:",
            type: SettingsTypes.info,
            value: "Show tabs:",
            callback: () => {},
        };

        this.settings.showAllTab = {
            text: "All",
            type: SettingsTypes.checkbox,
            value: true,
            callback: () => this.onTabsChanged(),
        };

        this.settings.showLocalTab = {
            text: "Local",
            type: SettingsTypes.checkbox,
            value: true,
            callback: () => this.onTabsChanged(),
        };

        this.settings.showGlobalTab = {
            text: "Global",
            type: SettingsTypes.checkbox,
            value: true,
            callback: () => this.onTabsChanged(),
        };

        this.settings.showSystemTab = {
            text: "System",
            type: SettingsTypes.checkbox,
            value: true,
            callback: () => this.onTabsChanged(),
        };

        this.settings.showPrivateTab = {
            text: "Private",
            description:
                "Show a Whispers tab for private messages (moves them out of their normal spot while on).",
            type: SettingsTypes.checkbox,
            value: false,
            callback: () => this.onTabsChanged(),
        };

        // "System in 'All':" — which system sub-types appear in the All tab.
        this.settings.allInHeader = {
            text: "System in 'All':",
            type: SettingsTypes.info,
            value: "System in 'All':",
            callback: () => {},
        };

        this.settings.showSystemInAll = {
            text: "Status messages",
            description:
                "Include normal white status messages in the All tab. They always stay available in the System tab.",
            type: SettingsTypes.checkbox,
            value: true,
            callback: () => this.refilterIfActive(),
        };

        this.settings.deathInAll = {
            text: "Death messages",
            description: "Include red death messages ('X died') in the All tab.",
            type: SettingsTypes.checkbox,
            value: true,
            callback: () => this.refilterIfActive(),
        };

        this.settings.tradeInAll = {
            text: "Trade messages",
            description: "Include purple trade-request messages in the All tab.",
            type: SettingsTypes.checkbox,
            value: true,
            callback: () => this.refilterIfActive(),
        };

        // "Customize" — size, font, and colours.
        this.settings.customizeHeader = {
            text: "Customize",
            type: SettingsTypes.info,
            value: "Customize",
            callback: () => {},
        };

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

        this.settings.chatWidth = {
            text: "Chat width (px)",
            description: "Width of the chat window.",
            type: SettingsTypes.range,
            value: 560,
            min: 300,
            max: 1200,
            callback: () => this.applyWidth(),
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

        this.settings.fontFamily = {
            text: "Font",
            description: "Font for chat text. 'Default' uses the game's font.",
            type: SettingsTypes.combobox,
            value: "Default",
            options: FONT_OPTIONS,
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

        this.collapsed = this.data?.collapsed === true;
        this.buildTabBar(menu);
        this.observeList(list);
        this.observePrivate();

        this.applyFilter();
        this.updateListVisibility();
        this.applyHeight();
        this.applyWidth();
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
        menu?.classList.remove("chatplus-collapsed");
        menu?.style.removeProperty("--chatplus-h");
        menu?.style.removeProperty("--chatplus-w");
        menu?.style.removeProperty("--chatplus-font");
        menu?.style.removeProperty("--chatplus-font-family");
        menu?.style.removeProperty("--chatplus-menu-h");

        // Drop the colour overrides from the document root.
        const root = document.documentElement;
        for (const c of COLOR_BINDINGS) root.style.removeProperty(c.var);

        this.tabbar?.remove();
        this.tabbar = null;
        this.tabButtons.clear();
        this.collapseBtn = null;
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
        this.ensureActiveVisible();

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

        // Collapse/expand control, pinned to the far right of the bar.
        const collapseBtn = document.createElement("button");
        collapseBtn.className = "chatplus-collapse-btn";
        this.bindClick(collapseBtn, () => this.toggleCollapse());
        bar.appendChild(collapseBtn);
        this.collapseBtn = collapseBtn;

        // Sit at the top of the chat panel.
        menu.insertBefore(bar, menu.firstChild);
        this.tabbar = bar;
        this.applyCollapsed(); // set the rebuilt collapse button's arrow + state
    }

    /** The visible tab set — each tab shows only when its "Show tabs" toggle is on. */
    private allTabDefs(): TabDef[] {
        return TABS.filter((t) => this.settings[t.showSetting]?.value !== false);
    }

    /** If the active tab is hidden, fall back to the first visible one. */
    private ensureActiveVisible(): void {
        const tabs = this.allTabDefs();
        if (tabs.length && !tabs.some((t) => t.id === this.activeTab)) {
            this.activeTab = tabs[0].id;
        }
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

    /** Rebuild the bar when the set of shown tabs changes. */
    private onTabsChanged(): void {
        const menu = document.getElementById(CHAT_MENU_ID);
        if (!menu || !this.tabbar) return;
        this.buildTabBar(menu); // ensures the active tab is still one that's visible
        this.updateListVisibility();
        this.applyFilter();
        this.applyHeight();
        this.scrollToBottom();
    }

    private toggleCollapse(): void {
        this.collapsed = !this.collapsed;
        if (this.data) this.data.collapsed = this.collapsed;
        this.applyCollapsed();
        if (!this.collapsed) this.scrollToBottom();
    }

    /** Collapsed hides everything but the collapse button; the arrow points the way out. */
    private applyCollapsed(): void {
        document
            .getElementById(CHAT_MENU_ID)
            ?.classList.toggle("chatplus-collapsed", this.collapsed);
        if (this.collapseBtn) {
            this.collapseBtn.textContent = this.collapsed ? "▲" : "▼";
            this.collapseBtn.title = this.collapsed ? "Expand chat" : "Collapse chat";
        }
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

    /** Whether the Whispers (Private) tab is shown — also gates the whisper relocation. */
    private privateInTab(): boolean {
        return this.settings.showPrivateTab?.value === true;
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
     * Private tab is enabled.
     */
    private observePrivate(): void {
        const pm = document.getElementById(PRIVATE_LIST_ID);
        if (!pm) return;
        this.privateObserver?.disconnect();
        this.privateObserver = new MutationObserver((records) => {
            // Track whether any visible message was added (so the view follows when
            // you're on the Whispers tab) and whether any of them should flash the
            // tab (gated per the Whispers/Login flash settings). Login/logout lines
            // are bare "X Logged In/Out" (no "From" prefix) and use the Login toggle.
            let visibleAdded = false;
            let notify = false;
            for (const rec of records) {
                rec.addedNodes.forEach((node) => {
                    if (!(node instanceof HTMLElement)) return;
                    const msgs = node.matches(MESSAGE_SELECTOR)
                        ? [node]
                        : Array.from(node.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR));
                    for (const m of msgs) {
                        if (!this.isMessageVisible(m)) continue;
                        visibleAdded = true;
                        if (this.shouldNotify(m)) notify = true;
                    }
                });
            }
            if (!this.privateInTab()) return;
            if (this.activeTab === "private") {
                if (visibleAdded) this.scrollToBottom();
            } else if (notify) {
                this.bumpUnread("private");
            }
        });
        this.privateObserver.observe(pm, { childList: true, subtree: true });
    }

    /** Filter a freshly added line to the active tab, and flash its tab if hidden. */
    private onNewMessage(msg: HTMLElement): void {
        const channel = this.classify(msg);
        const visibleHere = this.shouldShow(channel, this.activeTab, msg);
        msg.style.display = visibleHere ? "" : "none";

        // Flash the channel's own tab only when the message isn't already visible
        // in the tab we're looking at, and the channel's flash is enabled.
        if (!visibleHere && this.flashesForChannel(channel)) {
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
            msg.style.display = this.shouldShow(channel, this.activeTab, msg) ? "" : "none";
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
    private shouldShow(channel: Channel, tab: TabId, msg: HTMLElement): boolean {
        // All shows everything except the system sub-types hidden from it.
        if (tab === "all") {
            if (channel !== "system") return true;
            return this.systemKindShownInAll(this.systemKind(msg));
        }
        // Local / Global / System each show only their own channel.
        return channel === tab;
    }

    /** Sub-categorise a system message by its colour. */
    private systemKind(msg: HTMLElement): "status" | "death" | "trade" {
        if (msg.querySelector(`.${CLASS_DEATH}`)) return "death";
        if (msg.querySelector(`.${CLASS_TRADE}`)) return "trade";
        return "status"; // white / anything else
    }

    private systemKindShownInAll(kind: "status" | "death" | "trade"): boolean {
        switch (kind) {
            case "death": return this.deathInAll();
            case "trade": return this.tradeInAll();
            default: return this.showSystemInAll();
        }
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
            // Only clear System unread if All actually shows every system sub-type;
            // otherwise the System tab may hold messages you haven't seen.
            if (this.systemFullyInAll()) this.clearUnread("system");
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
    // Layout: height, width & font
    //
    // All driven through CSS variables read by !important stylesheet rules, so the
    // game's per-render inline styles can't override them. The variables are set on
    // the menu and inherit down to the public/private lists.
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

    /** Override the chat window width. */
    private applyWidth(): void {
        const menu = document.getElementById(CHAT_MENU_ID);
        if (!menu) return;
        const w = Number(this.settings.chatWidth?.value) || 560;
        menu.style.setProperty("--chatplus-w", `${w}px`);
    }

    /** Override the chat message font size and family. */
    private applyFont(): void {
        const menu = document.getElementById(CHAT_MENU_ID);
        if (!menu) return;
        const size = Number(this.settings.fontSize?.value) || 13;
        menu.style.setProperty("--chatplus-font", `${size}px`);

        const family = FONT_FAMILIES[String(this.settings.fontFamily?.value ?? "Default")] ?? "";
        if (family) {
            // Fall back to the game's own chat font if the chosen font isn't installed.
            // (Read from the menu, which we never override, so it stays the game font.)
            const gameFont = getComputedStyle(menu).fontFamily || "sans-serif";
            menu.style.setProperty("--chatplus-font-family", `${family}, ${gameFont}`);
        } else {
            menu.style.removeProperty("--chatplus-font-family"); // Default = game font
        }
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

    /** Whether the game is actually showing this message (vs hiding it per a setting). */
    private isMessageVisible(msg: HTMLElement): boolean {
        const cs = getComputedStyle(msg);
        return cs.display !== "none" && cs.visibility !== "hidden";
    }

    /**
     * A bare "<name> Logged In/Out" notification rather than a real whisper. Real
     * whispers start with a "From <name>:" prefix, so we require the line to NOT
     * start with "From" to avoid suppressing a whisper that mentions logging in.
     */
    private isLoginLogoutMessage(msg: HTMLElement): boolean {
        const text = (msg.textContent ?? "").trim();
        return !/^from\b/i.test(text) && /\blogged (in|out)\b/i.test(text);
    }

    /** Whether a (visible) private-list message should light up the Whispers tab. */
    private shouldNotify(msg: HTMLElement): boolean {
        return this.isLoginLogoutMessage(msg) ? this.flashLogin() : this.flashesForChannel("private");
    }

    /** Scroll whichever list the active tab is showing to the newest message. */
    private scrollToBottom(): void {
        const list =
            this.activeTab === "private"
                ? document.getElementById(PRIVATE_LIST_ID)
                : this.getList();
        if (list) list.scrollTo(0, list.scrollHeight);
    }

    /** Whether new messages on this channel should flash their tab (per settings). */
    private flashesForChannel(channel: Channel): boolean {
        switch (channel) {
            case "local": return this.settings.flashLocal?.value !== false;
            case "global": return this.settings.flashGlobal?.value !== false;
            case "system": return this.settings.flashSystem?.value !== false;
            case "private": return this.settings.flashWhispers?.value !== false;
        }
    }

    private flashLogin(): boolean {
        return this.settings.flashLogin?.value === true;
    }

    private showSystemInAll(): boolean {
        return this.settings.showSystemInAll?.value !== false;
    }

    private deathInAll(): boolean {
        return this.settings.deathInAll?.value !== false;
    }

    private tradeInAll(): boolean {
        return this.settings.tradeInAll?.value !== false;
    }

    /** True only when every system sub-type is shown in All. */
    private systemFullyInAll(): boolean {
        return this.showSystemInAll() && this.deathInAll() && this.tradeInAll();
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
        // Build a combined selector across every section-label row.
        const hdr = (suffix: string) =>
            HEADER_KEYS.map((k) => `#highlite-settings-content-row-${k}${suffix}`).join(",\n");
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
/* Grow the whole menu so the taller list doesn't squeeze the input; width is
   user-set (auto = the game's default). */
#${CHAT_MENU_ID} {
    height: var(--chatplus-menu-h, auto) !important;
    max-height: none !important;
    width: var(--chatplus-w, auto) !important;
}
/* Message font size. */
#${PUBLIC_LIST_ID} .hs-chat-message-container,
#${PUBLIC_LIST_ID} .hs-chat-message-container *,
#${CHAT_MENU_ID}.chatplus-private #${PRIVATE_LIST_ID} .hs-chat-message-container,
#${CHAT_MENU_ID}.chatplus-private #${PRIVATE_LIST_ID} .hs-chat-message-container * {
    font-size: var(--chatplus-font, 13px) !important;
    font-family: var(--chatplus-font-family) !important;
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
/* Collapse/expand button — pinned to the far right of the bar. */
#${TABBAR_ID} .chatplus-collapse-btn {
    margin-left: auto;
    flex: 0 0 auto;
    padding: 3px 9px;
    font: inherit;
    font-size: 11px;
    line-height: 1.2;
    color: #b8b8b8;
    background: rgba(0, 0, 0, 0.35);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-bottom: none;
    border-radius: 5px 5px 0 0;
    cursor: pointer;
    user-select: none;
}
#${TABBAR_ID} .chatplus-collapse-btn:hover {
    color: #e6e6e6;
    background: rgba(255, 255, 255, 0.08);
}
/* Collapsed: shrink the menu and hide everything but the collapse button. */
#${CHAT_MENU_ID}.chatplus-collapsed {
    height: auto !important;
}
#${CHAT_MENU_ID}.chatplus-collapsed #${PUBLIC_LIST_ID},
#${CHAT_MENU_ID}.chatplus-collapsed #${PRIVATE_LIST_ID},
#${CHAT_MENU_ID}.chatplus-collapsed #${INPUT_MENU_ID},
#${CHAT_MENU_ID}.chatplus-collapsed .chatplus-tab {
    display: none !important;
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
}
/* Plain-text settings section labels — restyle the framework's info banner into
   left-aligned subtitles (same trick as Quick Deposit). */
${hdr("")} {
    background: transparent !important;
    border: none !important;
    box-shadow: none !important;
    padding: 10px 4px 2px 4px !important;
    transition: none !important;
}
${hdr(" > div")} {
    padding: 0 !important;
    border: none !important;
    background: transparent !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    text-align: left !important;
    gap: 0 !important;
}
${hdr(" > div > div:first-child")} {
    font-weight: 700 !important;
    font-size: 16px !important;
    color: #d0d0d0 !important;
    margin: 0 !important;
    padding: 0 !important;
    text-align: left !important;
}
${hdr(" > div > div:last-child")} {
    display: none !important;
}`;
        document.head.appendChild(style);
    }
}
