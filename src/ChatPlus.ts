import { Plugin, SettingsTypes } from "@ryelite/core";
import { ALERT_SOUNDS, playAlertSound, disposeAlertSounds } from "./alertSounds";

/*
 * Chat+ — a Highspell+ plugin that reorganises the game's chat into WoW-style tabs.
 *
 * The game keeps a single combined "public" message list and tells channels apart
 * only by a colour class on each line (orange = global, yellow = local, white =
 * system); private messages live in a *separate* list outside the chat menu. Chat+ adds a
 * tab bar and filters/relocates those real nodes — it never clones or rebuilds
 * them, so every game-attached behaviour (right-click menus, player-name actions)
 * keeps working, and the chat input is never touched, so sending is unchanged.
 *
 * Everything below is layered onto that idea: per-tab show/hide, drag-reorderable
 * tabs, unread counts, a right-click "clear", a collapse toggle (a draggable arrow
 * in the bar and/or a "Hide chat" setting), and adjustable height / width / font /
 * per-channel colours.
 */

// ---------------------------------------------------------------------------
// Game DOM the plugin hooks into
// ---------------------------------------------------------------------------
const CHAT_MENU_ID = "hs-chat-menu"; // outer chat wrapper (tabs are inserted here)
const INPUT_MENU_ID = "hs-chat-input-menu"; // the free-type input area
const PUBLIC_LIST_ID = "hs-public-message-list__container"; // scrollable public list
const PRIVATE_LIST_ID = "hs-private-message-list"; // separate private-message list (sibling of the menu)
const MESSAGE_SELECTOR = ".hs-chat-message-container"; // one chat line

// Per-line colour classes the game uses to mark each channel. SYSTEM isn't matched
// directly (it's the classify() fallback) but is listed here for completeness.
const CLASS_GLOBAL = "hs-text--orange";
const CLASS_LOCAL = "hs-text--yellow";
const CLASS_SYSTEM = "hs-text--white";
const CLASS_PRIVATE = "hs-text--cyan"; // private messages: From / name / text all use this
// System sub-types (all classify as "system"; split for per-type "show in All").
const CLASS_DEATH = "hs-text--red"; // death messages ("X died")
const CLASS_TRADE = "hs-text--magenta"; // incoming trade requests (purple)

// The game's own message colours, hardcoded so the plugin doesn't have to detect
// them. Verified against highspell.com/css/game.12.css (--hs-color-* on
// #hs-screen-mask). These are the picker defaults.
const DEFAULT_GLOBAL_COLOR = "#ffb400"; // orange
const DEFAULT_LOCAL_COLOR = "#ffff00"; // yellow
const DEFAULT_PRIVATE_COLOR = "#00ffff"; // cyan
const DEFAULT_SYSTEM_COLOR = "#ffffff"; // white (status messages)
const DEFAULT_DEATH_COLOR = "#ff0000"; // red
const DEFAULT_TRADE_COLOR = "#ff00ff"; // magenta

// Custom chat background (opt-in). Colour + opacity are combined into one rgba.
// (The game's own #hs-chat-menu has no background; it only tints the message
// list rgba(0,0,0,0.25) on hover, so this override paints the panel itself.)
const DEFAULT_BG_COLOR = "#000000";
const DEFAULT_BG_OPACITY = 60; // percent

// Each public line gets tagged with its channel so colour rules can be scoped
// (e.g. recolour white text only on system lines, not the white bits of others).
const CHANNEL_ATTR = "data-chatplus-channel";

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
// Marks a message hidden by the ignore-list / blocked-words filters.
const FILTERED_CLASS = "chatplus-filtered";
// Marks a message that matched an alert word (highlighted, and dinged on arrival).
const ALERT_CLASS = "chatplus-alert";
// Minimum gap between two dings so a spammy line can't machine-gun the sound.
const ALERT_COOLDOWN_MS = 1000;
// Alert sound choices come from the bundled list in src/alertSounds.ts.
const LIST_EDITOR_ID = "chatplus-list-editor";

// Setting keys for the plain-text section labels (SettingsTypes.info rows restyled
// into subtitles by injectStyle).
const HEADER_KEYS = [
    "flashHeader",
    "showTabsHeader",
    "allInHeader",
    "filtersHeader",
    "windowHeader",
    "customizeHeader",
];

// Pixels the pointer must travel before a press counts as a drag (vs a click).
const DRAG_THRESHOLD = 5;

// The collapse arrow lives in the tab bar alongside the tabs and is reordered with
// them; this is its id in the saved order (data.tabOrder).
const COLLAPSE_ID = "collapse";
// Everything in the bar that can be dragged to reorder (tabs + the collapse arrow).
const DRAGGABLE_SELECTOR = ".chatplus-tab, .chatplus-collapse-btn";

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
// on. The Private tab also pulls private messages out of their normal spot and
// is handled specially (see the Private section).
const TABS: TabDef[] = [
    { id: "all", label: "All", channel: null, showSetting: "showAllTab" },
    { id: "local", label: "Local", channel: "local", showSetting: "showLocalTab" },
    { id: "global", label: "Global", channel: "global", showSetting: "showGlobalTab" },
    { id: "system", label: "System", channel: "system", showSetting: "showSystemTab" },
    { id: "private", label: "Private", channel: "private", showSetting: "showPrivateTab" },
];

// Maps each colour-picker setting to the CSS variable that drives its override,
// plus the game's own colour the Reset button restores.
const COLOR_BINDINGS = [
    { setting: "globalColor", var: "--chatplus-color-global", def: DEFAULT_GLOBAL_COLOR },
    { setting: "localColor", var: "--chatplus-color-local", def: DEFAULT_LOCAL_COLOR },
    { setting: "privateColor", var: "--chatplus-color-private", def: DEFAULT_PRIVATE_COLOR },
    { setting: "systemColor", var: "--chatplus-color-system", def: DEFAULT_SYSTEM_COLOR },
    { setting: "deathColor", var: "--chatplus-color-death", def: DEFAULT_DEATH_COLOR },
    { setting: "tradeColor", var: "--chatplus-color-trade", def: DEFAULT_TRADE_COLOR },
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

    // The open chip editor (ignored players / blocked words), if any.
    private listEditor: HTMLElement | null = null;
    // Compiled blocked-words matcher, rebuilt whenever the list changes.
    private blockedWordsRe: RegExp | null = null;
    private alertWordsRe: RegExp | null = null;
    private ignoredSet = new Set<string>();

    // Alert sound: the time of the last ding (the AudioContext lives in alertSounds.ts).
    private lastDingAt = 0;

    // The game's own block-list check, wrapped so our ignore list is honoured
    // everywhere the game consults it (see installBlockHook).
    private hookedChatManagerProto: any = null;
    private origIsUserBlocked: ((name: string) => boolean) | null = null;
    // ChatMenuController.addChatMessage — the one call that adds a chat line AND
    // sets the overhead text; wrapped so filtered messages never reach either.
    private hookedChatMenuProto: any = null;
    private origAddChatMessage: ((...args: any[]) => any) | null = null;
    // The game classes may not be exposed yet when we start; poll until they are.
    private hookRetryTimer: number | null = null;
    private hookRetriesLeft = 0;

    // Where the private list normally lives, so we can put it back. It sits OUTSIDE
    // the chat menu (as a sibling), so we relocate it into the menu's message slot
    // while the Private tab feature is on.
    private privateOrigParent: HTMLElement | null = null;
    private privateOrigNext: Element | null = null;

    // Wheel handler on the private list. The game zooms the camera from a wheel
    // listener on #hs-screen-mask; its own public list opts out by calling
    // stopPropagation() on wheel, but the private list never needed to (it isn't
    // scrollable in the stock game), so we add the same guard while we own it.
    private privateWheelTarget: HTMLElement | null = null;
    private readonly onPrivateWheel = (e: WheelEvent): void => {
        e.stopPropagation();
    };

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
            text: "Private",
            type: SettingsTypes.checkbox,
            value: true,
            callback: () => {},
        };

        this.settings.flashLogin = {
            text: "Login",
            description: "Flash the Private tab for 'X Logged In/Out' notifications.",
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
                "Show a Private tab for private messages (moves them out of their normal spot while on).",
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

        // "Filters:" — hide messages from ignored players / containing blocked words.
        this.settings.filtersHeader = {
            text: "Filters:",
            type: SettingsTypes.info,
            value: "Filters:",
            callback: () => {},
        };

        this.settings.ignoredPlayers = {
            text: "Ignored players",
            description:
                "Hide every message from these players (public and private). An extra ignore list with no cap, on top of the game's own.",
            type: SettingsTypes.button,
            value: "Manage",
            callback: () => this.openIgnoredPlayersEditor(),
        };

        this.settings.blockedWords = {
            text: "Blocked words",
            description:
                "Hide any message containing one of these words or phrases (whole-word, case-insensitive).",
            type: SettingsTypes.button,
            value: "Manage",
            callback: () => this.openBlockedWordsEditor(),
        };

        this.settings.alertWords = {
            text: "Alert words",
            description:
                "Play a ding (and highlight the line) when a message contains one of these words — e.g. your name.",
            type: SettingsTypes.button,
            value: "Manage",
            callback: () => this.openAlertWordsEditor(),
        };

        this.settings.alertSound = {
            text: "Alert sound",
            description: "Which sound plays for an alert word. Changing it plays a preview.",
            type: SettingsTypes.combobox,
            value: "Ding",
            options: [...ALERT_SOUNDS],
            callback: () => this.playAlertSound(true),
        };

        this.settings.alertVolume = {
            text: "Alert volume (%)",
            description: "Loudness of the alert ding. 0 turns the sound off (the line is still highlighted).",
            type: SettingsTypes.range,
            value: 60,
            min: 0,
            max: 100,
            callback: () => {},
        };

        this.settings.alertTest = {
            text: "Test alert sound",
            type: SettingsTypes.button,
            value: "Ding",
            callback: () => this.playAlertSound(true),
        };

        // "Chat window:" — hide/show the chat and the collapse arrow.
        this.settings.windowHeader = {
            text: "Chat window:",
            type: SettingsTypes.info,
            value: "Chat window:",
            callback: () => {},
        };

        this.settings.chatHidden = {
            text: "Hide chat",
            description:
                "Collapse the chat down to just the tab bar. Same as clicking the collapse arrow; the two stay in sync.",
            type: SettingsTypes.checkbox,
            value: false,
            callback: () => this.onHiddenSettingChanged(),
        };

        this.settings.showCollapseBtn = {
            text: "Show collapse arrow",
            description:
                "Show the ▼/▲ arrow in the tab bar. Drag it to move it among the tabs. With it off, use 'Hide chat' to collapse/expand.",
            type: SettingsTypes.checkbox,
            value: true,
            callback: () => this.applyCollapseBtnVisibility(),
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

        // Background (opt-in so the game's own panel look is untouched by default).
        this.settings.customBackground = {
            text: "Custom background",
            description: "Override the chat panel's background with the colour and opacity below.",
            type: SettingsTypes.checkbox,
            value: false,
            callback: () => this.applyBackground(),
        };

        this.settings.bgColor = {
            text: "Background colour",
            description: "Colour of the chat panel background (when 'Custom background' is on).",
            type: SettingsTypes.color,
            value: DEFAULT_BG_COLOR,
            callback: () => this.applyBackground(),
        };

        this.settings.bgOpacity = {
            text: "Background opacity (%)",
            description: "0 = fully transparent, 100 = solid (when 'Custom background' is on).",
            type: SettingsTypes.range,
            value: DEFAULT_BG_OPACITY,
            min: 0,
            max: 100,
            callback: () => this.applyBackground(),
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
            text: "Private text colour",
            description: "Colour of private messages.",
            type: SettingsTypes.color,
            value: DEFAULT_PRIVATE_COLOR,
            callback: () => this.applyColors(),
        };

        this.settings.systemColor = {
            text: "System text colour",
            description: "Colour of white system/status messages.",
            type: SettingsTypes.color,
            value: DEFAULT_SYSTEM_COLOR,
            callback: () => this.applyColors(),
        };

        this.settings.deathColor = {
            text: "Death text colour",
            description: "Colour of red death messages ('X died').",
            type: SettingsTypes.color,
            value: DEFAULT_DEATH_COLOR,
            callback: () => this.applyColors(),
        };

        this.settings.tradeColor = {
            text: "Trade text colour",
            description: "Colour of purple trade-request messages.",
            type: SettingsTypes.color,
            value: DEFAULT_TRADE_COLOR,
            callback: () => this.applyColors(),
        };

        this.settings.resetColors = {
            text: "Reset colours to default",
            description: "Restore all text colours to the game's defaults.",
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
        this.compileFilters();
        this.installGameHooks();
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

        this.collapsed = this.settings.chatHidden?.value === true;
        this.compileFilters();
        this.installGameHooks(); // in case the game classes weren't exposed yet at start()
        this.buildTabBar(menu);
        this.observeList(list);
        this.observePrivate();

        this.applyFilter();
        this.updateListVisibility();
        this.applyHeight();
        this.applyWidth();
        this.applyFont();
        this.applyColors();
        this.applyBackground();
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
        this.closeListEditor();
        this.removeGameHooks();

        // Restore every message to visible and hand the lists back to the game.
        this.unclearAll();
        this.unfilterAll();
        this.unmarkAlerts();
        disposeAlertSounds();
        for (const msg of this.messages()) {
            msg.style.display = "";
            msg.removeAttribute(CHANNEL_ATTR);
        }
        this.getList()?.style.removeProperty("display");
        this.restorePrivateList();
        this.unguardPrivateWheel();
        this.privateOrigParent = null;
        this.privateOrigNext = null;

        // Drop our layout overrides from the menu.
        const menu = document.getElementById(CHAT_MENU_ID);
        menu?.classList.remove("chatplus-private");
        menu?.classList.remove("chatplus-collapsed");
        menu?.classList.remove("chatplus-custom-bg");
        menu?.style.removeProperty("--chatplus-bg");
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

        for (const item of this.orderedItems()) {
            if (item === COLLAPSE_ID) {
                bar.appendChild(this.buildCollapseButton(bar));
                continue;
            }
            const tab = item;
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
        this.applyCollapsed(); // set the rebuilt collapse button's arrow + state
        this.applyCollapseBtnVisibility();
    }

    /**
     * The collapse/expand arrow. It sits in the bar like a tab (right after the
     * tabs by default), can be dragged to any slot, and its position is saved in
     * the same order list as the tabs.
     */
    private buildCollapseButton(bar: HTMLElement): HTMLElement {
        const collapseBtn = document.createElement("button");
        collapseBtn.className = "chatplus-collapse-btn";
        collapseBtn.dataset.tab = COLLAPSE_ID;
        this.bindClick(collapseBtn, () => {
            if (this.justDragged) return;
            this.toggleCollapse();
        });
        this.makeDraggable(collapseBtn, bar);
        this.collapseBtn = collapseBtn;
        return collapseBtn;
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

    /**
     * Tabs plus the collapse arrow, in the user's saved order. Tabs that aren't in
     * the saved order (new or newly re-shown) slot in just before the arrow, so
     * the arrow keeps sitting to the right of the tabs unless the user moved it.
     * If the arrow was never placed it goes last.
     */
    private orderedItems(): (TabDef | typeof COLLAPSE_ID)[] {
        const source = this.allTabDefs();
        const saved: string[] = Array.isArray(this.data?.tabOrder) ? this.data.tabOrder : [];
        const byId = new Map(source.map((t) => [t.id as string, t]));
        const result: (TabDef | typeof COLLAPSE_ID)[] = [];
        for (const id of saved) {
            if (id === COLLAPSE_ID) {
                if (!result.includes(COLLAPSE_ID)) result.push(COLLAPSE_ID);
                continue;
            }
            const tab = byId.get(id);
            if (tab && !result.includes(tab)) result.push(tab);
        }
        const missing = source.filter((t) => !result.includes(t));
        const arrowAt = result.indexOf(COLLAPSE_ID);
        if (arrowAt >= 0) result.splice(arrowAt, 0, ...missing);
        else result.push(...missing, COLLAPSE_ID);
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
        this.setCollapsed(!this.collapsed);
    }

    /** Collapse/expand and keep the "Hide chat" checkbox showing the same state. */
    private setCollapsed(collapsed: boolean): void {
        this.collapsed = collapsed;
        if (this.settings.chatHidden && this.settings.chatHidden.value !== collapsed) {
            this.settings.chatHidden.value = collapsed;
            (document as any).highlite?.managers?.SettingsManager?.updatePluginSettingsUI?.(this);
        }
        this.applyCollapsed();
        if (!collapsed) this.scrollToBottom();
    }

    /** The "Hide chat" checkbox was toggled in the settings panel. */
    private onHiddenSettingChanged(): void {
        const hidden = this.settings.chatHidden?.value === true;
        if (hidden === this.collapsed) return;
        if (!this.tabbar) {
            this.collapsed = hidden; // not attached yet; attach() picks it up
            return;
        }
        this.setCollapsed(hidden);
    }

    /** Show or hide the collapse arrow per its setting (it keeps its slot either way). */
    private applyCollapseBtnVisibility(): void {
        const show = this.settings.showCollapseBtn?.value !== false;
        this.collapseBtn?.classList.toggle("chatplus-hidden", !show);
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
                bar.querySelectorAll<HTMLElement>(DRAGGABLE_SELECTOR)
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

    /** Persist the current order (tabs + collapse arrow) from the DOM into plugin data. */
    private saveOrderFromDom(bar: HTMLElement): void {
        const ids = Array.from(bar.querySelectorAll<HTMLElement>(DRAGGABLE_SELECTOR))
            .map((el) => el.dataset.tab ?? "")
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
     * Hide the messages belonging to a tab (all of them for All / Private) and
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
    // Private messages / private list
    //
    // Private messages are a separate list (#hs-private-message-list) that lives OUTSIDE
    // the chat menu. When the feature is on we move it into the menu so it shares
    // the message area, show it only on the Private tab, and move it back when off.
    // ------------------------------------------------------------------------

    /** Whether the Private tab is shown — also gates the private-list relocation. */
    private privateInTab(): boolean {
        return this.settings.showPrivateTab?.value === true;
    }

    /**
     * Show the right list for the active tab: the Private tab shows the private
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
            this.unguardPrivateWheel();
            return;
        }
        this.guardPrivateWheel(pm);
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

    /** Keep wheel events over the private list from reaching the game's zoom handler. */
    private guardPrivateWheel(pm: HTMLElement): void {
        if (this.privateWheelTarget === pm) return;
        this.unguardPrivateWheel();
        pm.addEventListener("wheel", this.onPrivateWheel);
        this.privateWheelTarget = pm;
    }

    private unguardPrivateWheel(): void {
        this.privateWheelTarget?.removeEventListener("wheel", this.onPrivateWheel);
        this.privateWheelTarget = null;
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
     * Watch the separate private list so the Private tab can flash on a new
     * private message (and auto-scroll while it's the active tab). Only acts when the
     * Private tab is enabled.
     */
    private observePrivate(): void {
        const pm = document.getElementById(PRIVATE_LIST_ID);
        if (!pm) return;
        this.privateObserver?.disconnect();
        this.privateObserver = new MutationObserver((records) => {
            // Track whether any visible message was added (so the view follows when
            // you're on the Private tab) and whether any of them should flash the
            // tab (gated per the Private/Login flash settings). Login/logout lines
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
                        const hidden = this.applyMessageFilters(m);
                        if (!hidden) this.checkAlert(m);
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
        msg.setAttribute(CHANNEL_ATTR, channel);
        // Ignored player / blocked word: hidden everywhere, and never flashes.
        if (this.applyMessageFilters(msg)) return;
        this.checkAlert(msg);
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
            msg.setAttribute(CHANNEL_ATTR, channel);
            this.applyMessageFilters(msg);
            msg.style.display = this.shouldShow(channel, this.activeTab, msg) ? "" : "none";
        }
        // Whispers live in their own list; keep their filter state current too.
        document
            .getElementById(PRIVATE_LIST_ID)
            ?.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR)
            .forEach((m) => this.applyMessageFilters(m));
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
    // Filters: ignored players & blocked words
    //
    // Both lists live in plugin data (persisted like the tab order). A matching
    // message gets FILTERED_CLASS, hidden by an !important rule, so it stays
    // hidden through every re-filter; it also never counts as unread.
    //
    // Sender detection is text-based because the game gives the name span no
    // class of its own: a line reads "Name: text", or "From Name: text" /
    // "To Name: text" for whispers, so the sender is whatever precedes the first
    // colon (minus a From/To prefix).
    // ------------------------------------------------------------------------

    private getIgnoredPlayers(): string[] {
        return Array.isArray(this.data?.ignoredPlayers) ? [...this.data.ignoredPlayers] : [];
    }

    private setIgnoredPlayers(list: string[]): void {
        if (this.data) this.data.ignoredPlayers = list;
        this.compileFilters();
        this.refilterIfActive();
    }

    private getBlockedWords(): string[] {
        return Array.isArray(this.data?.blockedWords) ? [...this.data.blockedWords] : [];
    }

    private setBlockedWords(list: string[]): void {
        if (this.data) this.data.blockedWords = list;
        this.compileFilters();
        this.refilterIfActive();
    }

    /** Rebuild the fast matchers from the saved lists. */
    private compileFilters(): void {
        this.ignoredSet = new Set(this.getIgnoredPlayers().map((n) => this.normalizeName(n)));
        this.blockedWordsRe = this.buildWordMatcher(this.getBlockedWords());
        this.alertWordsRe = this.buildWordMatcher(this.getAlertWords());
    }

    /**
     * Whole-word/phrase, case-insensitive matcher for a list of entries (null for
     * an empty list). Lookarounds rather than \b so that entries starting/ending
     * in punctuation (e.g. ":)" or "l33t!") still work.
     */
    private buildWordMatcher(entries: string[]): RegExp | null {
        const words = entries.map((w) => w.trim()).filter(Boolean);
        if (!words.length) return null;
        const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        return new RegExp(
            `(?<![\\p{L}\\p{N}_])(?:${escaped.join("|")})(?![\\p{L}\\p{N}_])`,
            "iu"
        );
    }

    // ------------------------------------------------------------------------
    // Alert words: ding + highlight when a new line contains one
    // ------------------------------------------------------------------------

    private getAlertWords(): string[] {
        return Array.isArray(this.data?.alertWords) ? [...this.data.alertWords] : [];
    }

    private setAlertWords(list: string[]): void {
        if (this.data) this.data.alertWords = list;
        this.compileFilters();
    }

    /** Called once per newly arrived (unfiltered) line: highlight and ding on a match. */
    private checkAlert(msg: HTMLElement): void {
        if (!this.alertWordsRe) return;
        const text = msg.textContent ?? "";
        if (!this.alertWordsRe.test(text)) return;
        if (this.isOwnMessage(msg)) return; // saying your own name shouldn't ding you
        msg.classList.add(ALERT_CLASS);
        this.playAlertSound(false);
    }

    /** Whether a line was sent by the local player (per the text-prefix sender). */
    private isOwnMessage(msg: HTMLElement): boolean {
        const text = (msg.textContent ?? "").trim();
        const colon = text.indexOf(":");
        // Outgoing whispers read "To <name>: …" — always ours.
        if (colon > 0 && /^to\b/i.test(text.slice(0, colon))) return true;
        let me: unknown;
        try {
            me = this.gameHooks?.EntityManager?.Instance?.MainPlayer?.Name;
        } catch {
            return false;
        }
        if (typeof me !== "string" || !me) return false;
        return this.senderCandidates(msg).includes(this.normalizeName(me));
    }

    /**
     * Play the selected alert sound from the client's shared master list. `force` skips the
     * cooldown (Test button / preview).
     */
    private playAlertSound(force: boolean): void {
        const pct = Number(this.settings.alertVolume?.value);
        const vol = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 60;
        if (vol <= 0) return;
        const now = Date.now();
        if (!force && now - this.lastDingAt < ALERT_COOLDOWN_MS) return;
        this.lastDingAt = now;
        try {
            playAlertSound(String(this.settings.alertSound?.value ?? "Ding"), vol);
        } catch (e) {
            this.warn("Alert sound failed", e);
        }
    }

    /** Drop the alert highlight from every line (used on teardown). */
    private unmarkAlerts(): void {
        for (const list of [this.getList(), document.getElementById(PRIVATE_LIST_ID)]) {
            list?.querySelectorAll<HTMLElement>(`.${ALERT_CLASS}`).forEach((m) =>
                m.classList.remove(ALERT_CLASS)
            );
        }
    }

    private openAlertWordsEditor(): void {
        this.openListEditor({
            title: "Alert words",
            blurb:
                "When a new message contains one of these words or phrases (whole-word, case-insensitive) " +
                "you'll hear a ding and the line is highlighted. Add your own name to be pinged when someone says it. " +
                "Type a word and press Enter to add it; click a word to remove it.",
            placeholder: "Word or phrase…",
            empty: "No alert words yet.",
            get: () => this.getAlertWords(),
            set: (list) => this.setAlertWords(list),
            same: (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase(),
        });
    }

    /** Names are compared case-insensitively with spaces/underscores collapsed. */
    private normalizeName(name: string): string {
        return name.trim().toLowerCase().replace(/[\s_]+/g, " ");
    }

    /**
     * Candidate senders of a chat line per the text-prefix convention above. The
     * spans may run together in textContent ("FromMatter:"), so both the spaced
     * and unspaced From/To prefixes are tried alongside the raw head.
     */
    private senderCandidates(msg: HTMLElement): string[] {
        const text = (msg.textContent ?? "").trim();
        const colon = text.indexOf(":");
        if (colon <= 0 || colon > 40) return []; // player names are short
        const head = text.slice(0, colon);
        const out = new Set<string>([this.normalizeName(head)]);
        const m = /^(from|to)\s*(.+)$/i.exec(head);
        if (m && m[2].trim()) out.add(this.normalizeName(m[2]));
        return [...out].filter(Boolean);
    }

    /** Whether a line is from an ignored player or contains a blocked word. */
    private isFiltered(msg: HTMLElement): boolean {
        if (this.ignoredSet.size) {
            for (const name of this.senderCandidates(msg)) {
                if (this.ignoredSet.has(name)) return true;
            }
        }
        if (this.blockedWordsRe) {
            const text = msg.textContent ?? "";
            if (this.blockedWordsRe.test(text)) return true;
        }
        return false;
    }

    /** Toggle FILTERED_CLASS on a line to match the current lists; returns hidden?. */
    private applyMessageFilters(msg: HTMLElement): boolean {
        const hide = this.isFiltered(msg);
        msg.classList.toggle(FILTERED_CLASS, hide);
        return hide;
    }

    /** Un-hide everything the filters hid (used on teardown). */
    private unfilterAll(): void {
        for (const list of [this.getList(), document.getElementById(PRIVATE_LIST_ID)]) {
            list?.querySelectorAll<HTMLElement>(`.${FILTERED_CLASS}`).forEach((m) =>
                m.classList.remove(FILTERED_CLASS)
            );
        }
    }

    // ------------------------------------------------------------------------
    // Game hooks
    //
    // Two wrappers, both restored on stop():
    //  1. ChatManager.isUserBlocked(name) — the client's own block-list check,
    //     consulted before adding a public/global line, a whisper, and the text
    //     above a player's head. Honouring our ignore list here makes it behave
    //     exactly like the in-game block list, with no cap.
    //  2. ChatMenuController.addChatMessage(...) — the single call that both adds
    //     the chat line and sets the overhead text. Dropping filtered messages
    //     here also keeps *blocked words* off players' heads, and is a safety net
    //     should (1) ever stop matching.
    // The classes may not be exposed yet when the plugin starts, so installation
    // is retried on a timer until both hooks are in place.
    // ------------------------------------------------------------------------

    private installGameHooks(): void {
        this.installBlockHook();
        this.installAddChatMessageHook();
        if (this.hookedChatManagerProto && this.hookedChatMenuProto) {
            this.stopHookRetry();
            return;
        }
        if (this.hookRetryTimer === null) {
            this.hookRetriesLeft = 60; // ~2 minutes at 2s
            this.hookRetryTimer = window.setInterval(() => {
                this.installBlockHook();
                this.installAddChatMessageHook();
                if (this.hookedChatManagerProto && this.hookedChatMenuProto) {
                    this.stopHookRetry();
                } else if (--this.hookRetriesLeft <= 0) {
                    this.stopHookRetry();
                    this.warn(
                        "Could not hook the game's chat classes " +
                            `(ChatManager: ${!!this.hookedChatManagerProto}, ChatMenuController: ${!!this.hookedChatMenuProto}); ` +
                            "ignore list will only hide chat lines, not overhead text."
                    );
                }
            }, 2000);
        }
    }

    private stopHookRetry(): void {
        if (this.hookRetryTimer !== null) {
            window.clearInterval(this.hookRetryTimer);
            this.hookRetryTimer = null;
        }
    }

    private removeGameHooks(): void {
        this.stopHookRetry();
        if (this.hookedChatManagerProto && this.origIsUserBlocked) {
            this.hookedChatManagerProto.isUserBlocked = this.origIsUserBlocked;
        }
        this.hookedChatManagerProto = null;
        this.origIsUserBlocked = null;
        if (this.hookedChatMenuProto && this.origAddChatMessage) {
            this.hookedChatMenuProto.addChatMessage = this.origAddChatMessage;
        }
        this.hookedChatMenuProto = null;
        this.origAddChatMessage = null;
    }

    private installBlockHook(): void {
        if (this.hookedChatManagerProto) return;
        let proto: any;
        try {
            proto = this.gameHooks?.ChatManager?.prototype;
        } catch {
            return;
        }
        if (!proto || typeof proto.isUserBlocked !== "function") return;

        const orig: (name: string) => boolean = proto.isUserBlocked;
        const plugin = this;
        proto.isUserBlocked = function (this: unknown, name: string): boolean {
            let blocked = false;
            try {
                blocked = orig.call(this, name) === true;
            } catch {
                /* fall through to our list */
            }
            if (!blocked && typeof name === "string" && plugin.ignoredSet.size) {
                blocked = plugin.ignoredSet.has(plugin.normalizeName(name));
            }
            return blocked;
        };
        this.hookedChatManagerProto = proto;
        this.origIsUserBlocked = orig;
        this.log("Hooked ChatManager.isUserBlocked for the ignore list");
    }

    /** The live ChatMenuController instance, via the UI manager the game exposes. */
    private getChatMenuController(): any {
        try {
            const mgr = this.gameHooks?.UIManager?.Manager;
            return mgr?.getController?.()?.ChatMenuController ?? null;
        } catch {
            return null;
        }
    }

    private installAddChatMessageHook(): void {
        if (this.hookedChatMenuProto) return;
        const ctrl = this.getChatMenuController();
        if (!ctrl) return;
        const proto = Object.getPrototypeOf(ctrl);
        if (!proto || typeof proto.addChatMessage !== "function") return;

        const orig: (...args: any[]) => any = proto.addChatMessage;
        const plugin = this;
        // Signature (from the client): (isIncoming, entityId, type, playerName,
        // message, originalMessage, style, chatType).
        proto.addChatMessage = function (this: unknown, ...args: any[]): any {
            try {
                if (plugin.shouldDropGameMessage(args)) return;
            } catch {
                /* never break the game's chat on our account */
            }
            return orig.apply(this, args);
        };
        this.hookedChatMenuProto = proto;
        this.origAddChatMessage = orig;
        this.log("Hooked ChatMenuController.addChatMessage for filters");
    }

    /** Decide whether a game chat message should be dropped before it renders anywhere. */
    private shouldDropGameMessage(args: any[]): boolean {
        if (!this.ignoredSet.size && !this.blockedWordsRe) return false;
        const [, entityId, , playerName, message, originalMessage] = args;

        if (this.ignoredSet.size) {
            let name: unknown = playerName;
            if (!name && entityId !== null && entityId !== undefined) {
                // Public lines carry only an entity id; resolve it the way the game does.
                try {
                    name = this.gameHooks?.EntityManager?.Instance?.getPlayerByEntityId?.(entityId)?.Name;
                } catch {
                    name = undefined;
                }
            }
            if (typeof name === "string" && this.ignoredSet.has(this.normalizeName(name))) return true;
        }
        if (this.blockedWordsRe) {
            for (const text of [message, originalMessage]) {
                if (typeof text === "string" && this.blockedWordsRe.test(text)) return true;
            }
        }
        return false;
    }

    private openIgnoredPlayersEditor(): void {
        this.openListEditor({
            title: "Ignored players",
            blurb:
                "These players are treated like the game's own block list on your client: no public chat, " +
                "no whispers, and no text over their head. Type a name and press Enter to add it; click a name to remove it.",
            placeholder: "Player name…",
            empty: "No one ignored yet.",
            get: () => this.getIgnoredPlayers(),
            set: (list) => this.setIgnoredPlayers(list),
            same: (a, b) => this.normalizeName(a) === this.normalizeName(b),
        });
    }

    private openBlockedWordsEditor(): void {
        this.openListEditor({
            title: "Blocked words",
            blurb:
                "Any message containing one of these words or phrases is hidden (whole-word, case-insensitive). " +
                "Type a word and press Enter to add it; click a word to remove it.",
            placeholder: "Word or phrase…",
            empty: "No blocked words yet.",
            get: () => this.getBlockedWords(),
            set: (list) => this.setBlockedWords(list),
            same: (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase(),
        });
    }

    /**
     * Generic chip editor: a fixed backdrop with the current entries as chips, a
     * free-type input (Enter / comma adds; Backspace on an empty box removes the
     * last chip), and a Close button. Mirrors the TCG plugin's exclusions picker.
     */
    private openListEditor(opts: {
        title: string;
        blurb: string;
        placeholder: string;
        empty: string;
        get: () => string[];
        set: (list: string[]) => void;
        same: (a: string, b: string) => boolean;
    }): void {
        this.closeListEditor();
        this.closeTabMenu();

        const backdrop = document.createElement("div");
        backdrop.id = LIST_EDITOR_ID;

        const box = document.createElement("div");
        box.className = "chatplus-editor-box";

        const h = document.createElement("h3");
        h.textContent = opts.title;
        const blurb = document.createElement("div");
        blurb.className = "chatplus-editor-blurb";
        blurb.textContent = opts.blurb;
        const chips = document.createElement("div");
        chips.className = "chatplus-editor-chips";
        const input = document.createElement("input");
        input.type = "text";
        input.className = "chatplus-editor-input";
        input.placeholder = opts.placeholder;
        input.autocomplete = "off";
        input.spellcheck = false;
        const btns = document.createElement("div");
        btns.className = "chatplus-editor-btns";
        const addBtn = document.createElement("button");
        addBtn.className = "chatplus-editor-btn";
        addBtn.textContent = "Add";
        const closeBtn = document.createElement("button");
        closeBtn.className = "chatplus-editor-btn primary";
        closeBtn.textContent = "Close";
        btns.append(addBtn, closeBtn);
        box.append(h, blurb, chips, input, btns);
        backdrop.appendChild(box);

        const render = () => {
            chips.textContent = "";
            const list = opts.get();
            if (!list.length) {
                const none = document.createElement("span");
                none.className = "chatplus-editor-empty";
                none.textContent = opts.empty;
                chips.appendChild(none);
                return;
            }
            for (const entry of list) {
                const chip = document.createElement("span");
                chip.className = "chatplus-chip";
                chip.title = "Remove";
                chip.textContent = entry;
                const x = document.createElement("b");
                x.textContent = "✕";
                chip.appendChild(x);
                chip.onclick = () => {
                    opts.set(opts.get().filter((e) => e !== entry));
                    render();
                };
                chips.appendChild(chip);
            }
        };

        const addFromInput = () => {
            // Allow pasting several at once, comma-separated.
            const parts = input.value
                .split(",")
                .map((p) => p.trim())
                .filter(Boolean);
            if (!parts.length) return;
            let list = opts.get();
            for (const part of parts) {
                if (!list.some((e) => opts.same(e, part))) list = [...list, part];
            }
            opts.set(list);
            input.value = "";
            render();
        };

        // Keep every keystroke inside the editor: the game's global type-to-chat
        // handler would otherwise swallow the input (same trick as the TCG plugin).
        for (const type of ["keydown", "keyup", "keypress"] as const) {
            backdrop.addEventListener(type, (e) => {
                if (type === "keydown") {
                    const k = (e as KeyboardEvent).key;
                    if (k === "Escape") {
                        this.closeListEditor();
                    } else if (e.target === input && (k === "Enter" || k === ",")) {
                        e.preventDefault();
                        addFromInput();
                    } else if (e.target === input && k === "Backspace" && input.value === "") {
                        const list = opts.get();
                        if (list.length) {
                            opts.set(list.slice(0, -1));
                            render();
                        }
                    }
                }
                e.stopPropagation();
            });
        }
        addBtn.onclick = addFromInput;
        closeBtn.onclick = () => this.closeListEditor();
        backdrop.onclick = (e) => {
            if (e.target === backdrop) this.closeListEditor();
        };
        // Don't let presses inside the editor reach the game underneath.
        backdrop.addEventListener("pointerdown", (e) => e.stopPropagation());

        document.body.appendChild(backdrop);
        this.listEditor = backdrop;
        render();
        input.focus();
    }

    private closeListEditor(): void {
        this.listEditor?.remove();
        this.listEditor = null;
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
     * shown in All). Private messages are never in All, so they keep their count.
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
        for (const c of COLOR_BINDINGS) {
            const setting = this.settings[c.setting];
            if (setting) setting.value = c.def;
        }
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
    // Background
    //
    // Opt-in: when "Custom background" is on, the menu gets a class whose rule
    // paints --chatplus-bg (colour + opacity as one rgba) over the panel and makes
    // the message lists see-through so the one colour shows uniformly.
    // ------------------------------------------------------------------------

    private applyBackground(): void {
        const menu = document.getElementById(CHAT_MENU_ID);
        if (!menu) return;
        const on = this.settings.customBackground?.value === true;
        menu.classList.toggle("chatplus-custom-bg", on);
        if (!on) {
            menu.style.removeProperty("--chatplus-bg");
            return;
        }
        const hex = String(this.settings.bgColor?.value || DEFAULT_BG_COLOR);
        const pct = Number(this.settings.bgOpacity?.value);
        const alpha = (Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : DEFAULT_BG_OPACITY) / 100;
        menu.style.setProperty("--chatplus-bg", this.hexToRgba(hex, alpha));
    }

    /** "#rgb" / "#rrggbb" -> "rgba(r, g, b, a)"; anything unparseable falls back to black. */
    private hexToRgba(hex: string, alpha: number): string {
        let h = hex.trim().replace(/^#/, "");
        if (h.length === 3) h = h.split("").map((ch) => ch + ch).join("");
        const n = /^[0-9a-f]{6}$/i.test(h) ? parseInt(h, 16) : 0;
        const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
     * A bare "<name> Logged In/Out" notification rather than a real private message. Real
     * private messages start with a "From <name>:" prefix, so we require the line to NOT
     * start with "From" to avoid suppressing a private message that mentions logging in.
     */
    private isLoginLogoutMessage(msg: HTMLElement): boolean {
        const text = (msg.textContent ?? "").trim();
        return !/^from\b/i.test(text) && /\blogged (in|out)\b/i.test(text);
    }

    /** Whether a (visible) private-list message should light up the Private tab. */
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
    /* The game pins this list to a fixed 35rem with its own left margin; while
       it lives in our panel it must follow the panel's width instead. */
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    margin-left: 0 !important;
    box-sizing: border-box !important;
    overflow-x: hidden !important;
}
/* Message rows are left exactly as the game lays them out (a flex row of
   spans): once the list itself has a bounded width, flex shrinks the long text
   span to wrap by words while the short "From"/name spans keep their natural
   width — the same behaviour as the public list. */
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
/* System sub-types: white only on lines tagged as system (so the white parts of
   other channels' lines are left alone); red/magenta are unique to death/trade. */
#${PUBLIC_LIST_ID} .hs-chat-message-container[${CHANNEL_ATTR}="system"] .${CLASS_SYSTEM} {
    color: var(--chatplus-color-system) !important;
}
#${PUBLIC_LIST_ID} .${CLASS_DEATH} {
    color: var(--chatplus-color-death) !important;
}
#${PUBLIC_LIST_ID} .${CLASS_TRADE} {
    color: var(--chatplus-color-trade) !important;
}
/* Custom background (opt-in): paint the panel, let the lists show it through. */
#${CHAT_MENU_ID}.chatplus-custom-bg {
    background: var(--chatplus-bg, rgba(0, 0, 0, 0.6)) !important;
    background-image: none !important;
}
#${CHAT_MENU_ID}.chatplus-custom-bg #${PUBLIC_LIST_ID},
#${CHAT_MENU_ID}.chatplus-custom-bg #${PRIVATE_LIST_ID} {
    background: transparent !important;
    background-image: none !important;
}
/* Messages the user cleared from a tab (client-side only), and messages hidden
   by the ignored-players / blocked-words filters. */
.${CLEARED_CLASS},
.${FILTERED_CLASS} {
    display: none !important;
}
/* A line that matched an alert word. */
#${PUBLIC_LIST_ID} .${ALERT_CLASS},
#${CHAT_MENU_ID}.chatplus-private #${PRIVATE_LIST_ID} .${ALERT_CLASS} {
    background: rgba(255, 211, 77, 0.16) !important;
    box-shadow: inset 3px 0 0 rgba(255, 211, 77, 0.85);
    border-radius: 3px;
}
/* Chip editor (ignored players / blocked words / alert words) — fixed backdrop over the game. */
#${LIST_EDITOR_ID} {
    position: fixed;
    inset: 0;
    z-index: 99999;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.55);
}
#${LIST_EDITOR_ID} .chatplus-editor-box {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: 440px;
    max-width: calc(100vw - 32px);
    max-height: 82vh;
    background: #1c1c1f;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 12px;
    padding: 20px 22px;
    box-shadow: 0 16px 60px rgba(0, 0, 0, 0.7);
    font: 500 13px/1.5 system-ui, sans-serif;
    color: #e6e6e6;
}
#${LIST_EDITOR_ID} h3 {
    margin: 0;
    font: 700 16px/1.2 Georgia, serif;
}
#${LIST_EDITOR_ID} .chatplus-editor-blurb,
#${LIST_EDITOR_ID} .chatplus-editor-empty {
    color: #9a9a9a;
    font-size: 12.5px;
}
#${LIST_EDITOR_ID} .chatplus-editor-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    max-height: 180px;
    overflow: auto;
}
#${LIST_EDITOR_ID} .chatplus-chip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    background: rgba(255, 255, 255, 0.07);
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 999px;
    padding: 5px 11px;
    cursor: pointer;
    font: 600 12px/1 system-ui, sans-serif;
    color: #e6e6e6;
    user-select: none;
}
#${LIST_EDITOR_ID} .chatplus-chip b {
    color: #9a9a9a;
    font-weight: 700;
}
#${LIST_EDITOR_ID} .chatplus-chip:hover {
    border-color: #a05656;
}
#${LIST_EDITOR_ID} .chatplus-chip:hover b {
    color: #e07a7a;
}
#${LIST_EDITOR_ID} .chatplus-editor-input {
    background: rgba(255, 255, 255, 0.07);
    color: #e6e6e6;
    font: 500 13px/1.2 system-ui, sans-serif;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 6px;
    padding: 7px 10px;
    outline: none;
}
#${LIST_EDITOR_ID} .chatplus-editor-input:focus {
    border-color: #7a86b8;
}
#${LIST_EDITOR_ID} .chatplus-editor-btns {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
}
#${LIST_EDITOR_ID} .chatplus-editor-btn {
    background: rgba(255, 255, 255, 0.07);
    color: #e6e6e6;
    font: 600 13px/1 system-ui, sans-serif;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 6px;
    padding: 8px 14px;
    cursor: pointer;
}
#${LIST_EDITOR_ID} .chatplus-editor-btn:hover {
    filter: brightness(1.2);
}
#${LIST_EDITOR_ID} .chatplus-editor-btn.primary {
    background: #2c4a2e;
    border-color: #3f6b42;
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
/* Collapse/expand button — sits in the bar like a tab (draggable), right after
   the tabs by default. */
#${TABBAR_ID} .chatplus-collapse-btn {
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
    cursor: grab;
    user-select: none;
}
#${TABBAR_ID} .chatplus-collapse-btn.dragging {
    opacity: 0.6;
    cursor: grabbing;
}
/* "Show collapse arrow" off: hidden but still in the DOM so it keeps its slot. */
#${TABBAR_ID} .chatplus-collapse-btn.chatplus-hidden {
    display: none !important;
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
