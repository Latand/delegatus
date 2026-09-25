"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useState, useSyncExternalStore, type RefObject } from "react";

/*
 * The phone's navigation (docs/design/mobile-v2/README.md §3.3, #2105): ONE
 * model, over the browser's own history. Every place the operator can stand —
 * a screen (the board, a task, a pipeline, a conversation, …) and every sheet
 * that covers one — is exactly one history entry, and that entry says the
 * whole place: the stack of screens under it, the sheet, and the project the
 * Viewer showed. The store is a projection of the entry the tab stands on, so
 * the browser's Back, the bar's ‹ and iOS's edge swipe are all the same pop of
 * one entry, and what they land on is read back from the entry itself, never
 * reconstructed from a depth.
 *
 * Each entry stands on its own URL: the project's board (`#p=`, or the bare
 * route for the Overview), a conversation's link (`#c=`/`#f=`), or a phone
 * screen's fragment (`#task=`, `#pipeline=`, `#pipelines`, `#accounts`). A
 * sheet keeps the URL of the screen under it. A reload therefore lands on the
 * same place, and a traversal never hands the Viewer's resolver a URL that
 * belongs to some other screen — which is how Back from a task's agent used to
 * reopen the orchestrator: a screen push copied whatever conversation link the
 * board was last left on.
 *
 * Nothing else on the phone writes history. The Viewer's own records (a
 * conversation focus, #866; a project selection) are handed to this store
 * while the phone layout is up (`src/lib/navigation/focusHistory.ts`'s owner):
 * a focus types the conversation's own entry, and a project selection is an
 * entry of its own. A fragment navigation this store did not write — a link
 * it does not intercept, a notification, a pasted fragment — is taken over by
 * the screen it opens, so Back from there returns to where the operator was.
 */

export type MobileScreen =
  | { kind: "board" }
  | { kind: "chat"; id: string }
  /* One task: its pipelines, its agents and its status (#2072 slice 5). */
  | { kind: "task"; id: string }
  | { kind: "pipelines" }
  | { kind: "pipeline"; id: string }
  | { kind: "accounts" }
  /* The orchestrator's report log (#2146), one tap from its conversation. */
  | { kind: "reports" };
export type MobileScreenKind = MobileScreen["kind"];
const SHEET_NAMES = ["projects", "attention", "menu", "host", "search", "seat", "rotate", "tick", "switch", "model", "stage", "row", "links", "card", "status", "lane", "hidden", "tasks"] as const;
export type MobileSheetName = (typeof SHEET_NAMES)[number];
/** How the current state was reached; the shell picks its transition from it. */
export type MobileNavMotion = "load" | "push" | "pop" | "switch" | "sheet" | "act";

export interface MobileNavState {
  readonly stack: readonly MobileScreen[];
  readonly sheet: MobileSheetName | null;
  readonly motion: MobileNavMotion;
  /** The title cell's bump after an end-of-list swipe (§3.3); the bar clears it. */
  readonly bump: "left" | "right" | null;
}

export const BOARD: MobileScreen = { kind: "board" };
export const INITIAL_MOBILE_NAV: MobileNavState = { stack: [BOARD], sheet: null, motion: "load", bump: null };

/** The key a phone entry carries its place under. */
export const MOBILE_NAV_STATE_KEY = "mobile2";

/** The place one history entry the phone wrote stands for. */
export interface MobileNavEntry {
  /** The board first, the screen on top last. */
  stack: readonly MobileScreen[];
  sheet: MobileSheetName | null;
  /** The Viewer's project the entry was written on — the Overview's own key
      over the Overview — or null for an entry that did not know it. */
  project: string | null;
}

const SCREEN_KINDS: ReadonlySet<string> = new Set(["board", "chat", "task", "pipelines", "pipeline", "accounts", "reports"]);
const WITH_ID: ReadonlySet<string> = new Set(["chat", "task", "pipeline"]);
const SHEETS: ReadonlySet<string> = new Set(SHEET_NAMES);
/** Sheets that stay under a screen pushed from them, so Back from that screen
    finds the sheet again: the Tasks list is where the operator was choosing.
    A row in any other sheet is an action, and the screen it opens takes the
    sheet's place. */
const KEPT_SHEETS: ReadonlySet<MobileSheetName> = new Set(["tasks"]);
/** A stack longer than any path an operator can walk is not one this store wrote. */
const MAX_STACK = 64;
/** How many entries a ‹ from a foreign entry may pass through on its way. */
const MAX_PASSES = 8;

/** A fresh copy of a screen, or null for anything that is not one. */
function readScreen(value: unknown): MobileScreen | null {
  if (typeof value !== "object" || value === null) return null;
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !SCREEN_KINDS.has(kind)) return null;
  const id = (value as { id?: unknown }).id;
  if (WITH_ID.has(kind)) return typeof id === "string" && id.length > 0 ? ({ kind, id } as MobileScreen) : null;
  return id === undefined ? ({ kind } as MobileScreen) : null;
}

/** The phone entry inside a history state, or null for an entry the phone did
    not write (the desktop's, a fresh fragment navigation, a malformed one). An
    entry of the earlier shape (`{ d, screen }`) reads as that screen over the
    board. */
export function readMobileNavEntry(state: unknown): MobileNavEntry | null {
  if (typeof state !== "object" || state === null) return null;
  const raw = (state as Record<string, unknown>)[MOBILE_NAV_STATE_KEY];
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as { v?: unknown; stack?: unknown; sheet?: unknown; project?: unknown; d?: unknown; screen?: unknown };
  if (record.v === 2) {
    if (!Array.isArray(record.stack) || record.stack.length === 0 || record.stack.length > MAX_STACK) return null;
    const stack = record.stack.map(readScreen);
    if (stack.some((screen) => screen === null) || stack[0]!.kind !== "board") return null;
    const sheet = typeof record.sheet === "string" && SHEETS.has(record.sheet) ? (record.sheet as MobileSheetName) : null;
    const project = typeof record.project === "string" && record.project.length > 0 ? record.project : null;
    return { stack: stack as MobileScreen[], sheet, project };
  }
  if (typeof record.d !== "number" || !Number.isInteger(record.d) || record.d < 1) return null;
  const screen = readScreen(record.screen);
  if (!screen) return null;
  return { stack: screen.kind === "board" ? [BOARD] : [BOARD, screen], sheet: null, project: null };
}

function fragmentOf(href: string): string {
  const at = href.indexOf("#");
  return at < 0 ? "" : href.slice(at);
}

/**
 * Whether the tab stands on an entry the phone wrote for the URL it is at: a
 * traversal landed there. Each entry records the fragment it was written
 * for, so a fragment navigation's entry is never mistaken for one — even
 * where a history implementation copies the previous entry's state onto it
 * (a browser gives it none). An entry of the earlier shape recorded no URL.
 */
export function standsOnOwnUrl(state: unknown, href: string): boolean {
  if (!readMobileNavEntry(state)) return false;
  const raw = (state as Record<string, { v?: unknown; at?: unknown }>)[MOBILE_NAV_STATE_KEY]!;
  return raw.v !== 2 || raw.at === fragmentOf(href);
}

export function screenKey(screen: MobileScreen): string {
  return "id" in screen ? `${screen.kind}:${screen.id}` : screen.kind;
}

export function sameScreen(a: MobileScreen, b: MobileScreen): boolean {
  return screenKey(a) === screenKey(b);
}

export function topScreen(state: Pick<MobileNavState, "stack">): MobileScreen {
  return state.stack[state.stack.length - 1] ?? BOARD;
}

function sameStack(a: readonly MobileScreen[], b: readonly MobileScreen[]): boolean {
  return a.length === b.length && a.every((screen, index) => sameScreen(screen, b[index]!));
}

function startsWith(stack: readonly MobileScreen[], prefix: readonly MobileScreen[]): boolean {
  return prefix.length <= stack.length && prefix.every((screen, index) => sameScreen(screen, stack[index]!));
}

/** The fragment a phone screen stands on. The board and a conversation stand
    on the Viewer's own URLs (`MobileNavConfig`). */
export function screenFragment(screen: MobileScreen): string | null {
  switch (screen.kind) {
    case "task":
      return `#task=${encodeURIComponent(screen.id)}`;
    case "pipeline":
      return `#pipeline=${encodeURIComponent(screen.id)}`;
    case "pipelines":
      return "#pipelines";
    case "accounts":
      return "#accounts";
    case "reports":
      return "#reports";
    default:
      return null;
  }
}

/** The phone screen a fragment names — a reload of one, or a link to one. */
export function screenFromFragment(hash: string): MobileScreen | null {
  if (hash === "#pipelines") return { kind: "pipelines" };
  if (hash === "#accounts") return { kind: "accounts" };
  if (hash === "#reports") return { kind: "reports" };
  const match = hash.match(/^#(task|pipeline)=(.+)$/);
  if (!match) return null;
  let id = match[2]!;
  try {
    id = decodeURIComponent(id);
  } catch {
    /* a malformed escape is kept as written */
  }
  return { kind: match[1] as "task" | "pipeline", id };
}

/** Whether a fragment names a conversation (or an artifact over one): a
    navigation to it opens something over the place the operator is. */
function namesConversation(hash: string): boolean {
  return /^#(?:c|f|a)=./.test(hash);
}

/** What the Viewer tells the store about URLs and identity; the store asks at
    the moment it writes. */
export interface MobileNavConfig {
  /** The URL the board stands on: the project's `#p=`, or the bare route (with
      its query) for the Overview. */
  boardUrl(): string;
  /** A conversation screen's link and the Viewer's own keys for it (its typed
      focus entry), or null when the Viewer cannot name it. */
  conversation(id: string): { url: string; keys: Record<string, unknown> } | null;
  /** The Viewer's project, recorded on every entry written. */
  project(): string | null;
}

/** A focus the Viewer recorded for a conversation: the keys its entry carries
    and the link it stands on. */
export interface MobileNavMark {
  path: string;
  keys: Record<string, unknown>;
  url: string;
}

/** What a traversal landed on, as the Viewer needs to know it. `passing`
    is an entry a ‹ goes through on its way to the screen under the one it
    left: nothing is drawn from it, and nothing replays. */
export type MobileNavLanding =
  | { kind: "phone"; entry: MobileNavEntry; topChanged: boolean }
  | { kind: "foreign" }
  | { kind: "passing" };

/** What the store needs from the browser: the same-document history and its
    traversal events. Injected so the contract is testable without a window. */
export interface MobileNavHistory {
  readonly state: unknown;
  /** How many entries the tab's history holds; one means nothing to pop to. */
  readonly length?: number;
  pushState(state: unknown, unused: string, url?: string): void;
  replaceState(state: unknown, unused: string, url?: string): void;
  go(delta: number): void;
}

export interface MobileNavHost {
  history: MobileNavHistory;
  /** The document's current URL. */
  href(): string;
  /** Subscribe to history traversals: the landed entry's state, and the event
      itself so a second reader of the same traversal reads the same answer. */
  onPopstate(listener: (state: unknown, event?: object) => void): () => void;
  /** Runs `task` once the current gesture's synchronous work is done, so a
      sheet's close and the screen its row opens become one write. */
  defer?(task: () => void): void;
  /** How long a pop this store asked for may take before the store stops
      waiting for it. */
  settleMs?: number;
  /** Load another page of the app in this tab. */
  assign?(url: string): void;
}

export interface MobileNav {
  getState(): MobileNavState;
  subscribe(listener: () => void): () => void;
  /** Push a screen (200 ms slide from the right). A sheet open under the tap
      gives its entry to the screen, except a kept one (the Tasks list), which
      stays under it. */
  push(screen: MobileScreen): void;
  /** Replace the top of the stack: a sibling switch (120 ms crossfade). */
  replace(screen: MobileScreen, motion?: "switch" | "pop"): void;
  /** Leave the screen on top: its entry (and the sheet over it) is popped. At
      the bottom of the stack it closes the sheet. */
  back(): void;
  /** Open a sheet over the current screen: one history entry of its own, or
      the entry of the sheet it replaces. */
  openSheet(name: MobileSheetName): void;
  /** Close the sheet: its entry is popped, so Back afterwards leaves the screen. */
  closeSheet(): void;
  /** Leave the phone for another page of the app (Activity). The sheet under
      the tap closes first and the page loads once its pop has landed: a
      traversal asked for after a document navigation cancels it, so a close
      and a load in the same tap otherwise land back on the board. */
  leave(url: string): void;
  /** The Viewer moved somewhere else (a project, a conversation in another
      project): the shell draws that project's board with no sheet. Writes no
      history; the navigation that follows writes the entry. */
  home(): void;
  /** A deliberate project selection: the board of `project`, one entry. */
  enterProject(project: string, url: string): void;
  /** A project renamed under the same place: the current entry is relabeled. */
  retargetProject(project: string, keys: Record<string, unknown> | null, url: string): void;
  /** A focus the Viewer recorded: the conversation's entry carries it now if the
      conversation is on screen, or when it is next opened. */
  mark(mark: MobileNavMark): void;
  bump(side: "left" | "right"): void;
  clearBump(): void;
  /** A traversal landed: update the place from the entry. Idempotent for the
      same event, so the Viewer can ask what the store already read. */
  land(state: unknown, event?: object): MobileNavLanding;
  /** What a screen was left showing — its scroll, a section it had open —
      keyed by its place in the stack (`screenSlot`), for as long as that place
      stands. */
  remember(slot: string, value: unknown): void;
  recall(slot: string): unknown;
  /** Tell the store how to name URLs and identities. */
  configure(config: MobileNavConfig | null): void;
  /** Start following history traversals; returns the detach. Ref-counted, so
      several mounted screens share one listener. The first attach also writes
      the entry the tab was loaded on, when no phone wrote it. */
  attach(): () => void;
}

function carried(state: unknown): Record<string, unknown> {
  if (typeof state !== "object" || state === null) return {};
  const { [MOBILE_NAV_STATE_KEY]: _phone, ...rest } = state as Record<string, unknown>;
  return rest;
}

const microtask = (task: () => void) => queueMicrotask(task);

export function createMobileNav(host: MobileNavHost): MobileNav {
  const defer = host.defer ?? microtask;
  const settleMs = host.settleMs ?? 800;
  let config: MobileNavConfig | null = null;
  const listeners = new Set<() => void>();

  /* The place the tab was loaded on: a reload keeps its entry, and a fresh
     tab on a phone screen's fragment opens that screen over the board. */
  const loaded = standsOnOwnUrl(host.history.state, host.href()) ? readMobileNavEntry(host.history.state) : null;
  const fragmentScreen = loaded ? null : screenFromFragment(fragmentOf(host.href()));
  let state: MobileNavState = loaded
    ? { stack: loaded.stack, sheet: loaded.sheet, motion: "load", bump: null }
    : { ...INITIAL_MOBILE_NAV, stack: fragmentScreen ? [BOARD, fragmentScreen] : [BOARD] };
  /* The entry the tab was loaded on, when no phone wrote it: the first write
     makes it the board's own, so ‹ from the first screen lands on the board. */
  let unstampedBase = !loaded;
  /* The tab stands on an entry a fresh fragment navigation wrote (a link, a
     notification): the screen it opens takes that entry over. */
  let adopt = false;
  /* Pops a close or a ‹ owes the history, not asked of it yet. */
  let pendingPops = 0;
  let flushQueued = false;
  /* A pop this store asked for is on its way; writes wait for it to land. */
  let traversing = false;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let waiting: Array<() => void> = [];
  let pendingMark: MobileNavMark | null = null;
  /* The screen a ‹ taken on a foreign entry is going to, and how many entries
     it has passed through on the way (see `back`). */
  let backTo: readonly MobileScreen[] | null = null;
  let passes = 0;
  /* What each traversal event landed on, so every reader of one event reads
     the same answer, even when a pass-through lands the next inside it. */
  const landings = new WeakMap<object, MobileNavLanding>();
  const memory = new Map<string, unknown>();
  /* Screens following the history (`attach`), and the listener they share. */
  let attached = 0;
  let detach: (() => void) | null = null;

  const set = (next: Partial<MobileNavState>): void => {
    const merged = { ...state, ...next };
    if (merged.stack === state.stack && merged.sheet === state.sheet && merged.motion === state.motion && merged.bump === state.bump) return;
    state = merged;
    for (const listener of listeners) listener();
  };

  const projectNow = (): string | null => config?.project() ?? null;
  /* Unconfigured (a test's own store), the board keeps the URL it stands on
     unless that URL names something else. */
  const boardUrl = (): string => {
    if (config) return config.boardUrl();
    const href = host.href();
    const hash = fragmentOf(href);
    return namesConversation(hash) || screenFromFragment(hash) ? href.slice(0, href.length - hash.length) : href;
  };

  /** The keys and URL an entry with `stack` on top stands on. A conversation
      keeps the keys its current entry carries when it stays on top (a sheet
      over it, a sheet closed), takes a focus the Viewer recorded for it, or
      asks the Viewer; a phone screen has its fragment; the board is the
      project's. */
  const address = (stack: readonly MobileScreen[]): { url: string; keys: Record<string, unknown> } => {
    const top = stack[stack.length - 1] ?? BOARD;
    if (top.kind === "chat") {
      const current = own();
      if (current && sameScreen(topScreen(current), top)) return { url: host.href(), keys: carried(host.history.state) };
      if (pendingMark?.path === top.id) {
        const mark = pendingMark;
        pendingMark = null;
        return { url: mark.url, keys: mark.keys };
      }
      const named = config?.conversation(top.id) ?? null;
      if (named) return named;
      return { url: boardUrl(), keys: {} };
    }
    return { url: screenFragment(top) ?? boardUrl(), keys: {} };
  };

  /** The one writer: an entry's place, the Viewer's keys beside it, and the
      fragment it was written for. */
  const put = (action: "push" | "replace", keys: Record<string, unknown>, entry: MobileNavEntry, url: string): void => {
    const at = fragmentOf(new URL(url, host.href()).href);
    const next = { ...keys, [MOBILE_NAV_STATE_KEY]: { v: 2, stack: entry.stack, sheet: entry.sheet, project: entry.project, at } };
    if (action === "push") host.history.pushState(next, "", url);
    else host.history.replaceState(next, "", url);
  };

  const writeEntry = (action: "push" | "replace", entry: MobileNavEntry, place = address(entry.stack)): void => {
    put(action, place.keys, entry, place.url);
  };

  /** The phone's entry the tab stands on, or null for one a navigation the
      store did not write put it on. */
  const own = (): MobileNavEntry | null => (standsOnOwnUrl(host.history.state, host.href()) ? readMobileNavEntry(host.history.state) : null);

  /** The entry the tab stands on, when no phone wrote it for its URL, before
      anything is written above it. A fresh navigation to a conversation (a
      link, a notification) is taken over by the screen it opens, so Back from
      there returns to where the operator was. Anything else — the entry the
      tab was loaded on, a project link — is a board, and becomes the board's
      own: at the board's URL when it stood on a conversation's or a screen's
      link (a deep link's conversation then sits over a board ‹ can reach). */
  const takeOver = (): "replace" | "push" => {
    if (own()) return "push";
    const hash = fragmentOf(host.href());
    const base = unstampedBase;
    unstampedBase = false;
    if (!base && (adopt || namesConversation(hash))) {
      adopt = false;
      return "replace";
    }
    adopt = false;
    const url = namesConversation(hash) || screenFromFragment(hash) ? boardUrl() : host.href();
    put("replace", carried(host.history.state), { stack: [BOARD], sheet: null, project: projectNow() }, url);
    return "push";
  };

  /* A pop this store asks for is heard even while no screen follows the
     history (a shell not mounted yet): the landing is what frees the writes
     waiting for it. */
  let hearing: (() => void) | null = null;

  const settle = (): void => {
    traversing = false;
    backTo = null;
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = null;
    if (hearing) {
      hearing();
      hearing = null;
    }
    const run = waiting;
    waiting = [];
    for (const task of run) task();
  };

  /** How long a pop this store asked for may take to land. */
  const armSettle = (): void => {
    if (settleTimer !== null) clearTimeout(settleTimer);
    let grace = false;
    const wait = (): void => {
      if (!traversing) return;
      /* Nothing under the entry to pop to: the entry itself says what the
         screen shows instead. */
      if ((host.history.length ?? Number.POSITIVE_INFINITY) <= 1) {
        writeEntry("replace", { stack: state.stack, sheet: state.sheet, project: projectNow() });
        settle();
        return;
      }
      /* The landing can still come (a busy main thread): wait longer, then
         stop holding the writes that wait for it. The entry being left is
         never rewritten, so a landing later still only takes the tab where it
         was going, and Forward finds what was left. */
      if (!grace) {
        grace = true;
        settleTimer = setTimeout(wait, settleMs * 4);
        return;
      }
      settle();
    };
    settleTimer = setTimeout(wait, settleMs);
  };

  /** Ask the history for the pops owed. The browser lands asynchronously (a
      test's history may land inside the call), so `traversing` is set first. */
  const flush = (): void => {
    flushQueued = false;
    if (pendingPops === 0 || traversing) return;
    /* A fragment navigation in the same gesture (a link inside the sheet) put
       the tab on an entry this store did not write: the entries under it stay
       where they are, and the landing is that navigation's own. A ‹ taken on
       such an entry is the one pop that goes through anyway. */
    if (!own() && !backTo) {
      pendingPops = 0;
      return;
    }
    const steps = pendingPops;
    pendingPops = 0;
    traversing = true;
    if (!detach && !hearing) hearing = host.onPopstate((landed, event) => nav.land(landed, event));
    armSettle();
    host.history.go(-steps);
  };

  const queueFlush = (): void => {
    if (flushQueued) return;
    flushQueued = true;
    defer(flush);
  };

  /** A write while a pop is on its way waits for it to land. */
  const later = (task: () => void): boolean => {
    if (!traversing) return false;
    waiting.push(task);
    return true;
  };

  /** Pop what is owed, then run `task` on the entry the pop lands on; with
      nothing to pop, run it now. */
  const popThen = (task: () => void): void => {
    waiting.push(task);
    flush();
    if (!traversing) settle();
  };

  /** Commit an entry that goes ABOVE the current place: a push, unless a pop
      owed by this same gesture frees the entry on top for it, the entry on top
      is a sheet the tap in it replaces (`replaceTop`), or it is a fresh
      navigation's own entry, which the screen it opens takes over. */
  const commitAbove = (entry: MobileNavEntry, replaceTop: boolean, place = address(entry.stack)): void => {
    if (pendingPops === 1) {
      pendingPops = 0;
      writeEntry("replace", entry, place);
      return;
    }
    if (pendingPops > 1) {
      pendingPops -= 1;
      popThen(() => writeEntry("replace", entry, place));
      return;
    }
    writeEntry(replaceTop ? "replace" : takeOver(), entry, place);
  };

  /** Commit an entry that REPLACES the current screen's own: with a sheet over
      it, the sheet's entry is popped first. */
  const commitInPlace = (entry: MobileNavEntry): void => {
    if (state.sheet && pendingPops === 0 && own()?.sheet) pendingPops = 1;
    const place = address(entry.stack);
    if (pendingPops > 0) {
      popThen(() => writeEntry("replace", entry, place));
      return;
    }
    writeEntry("replace", entry, place);
  };

  /** Whether the entry the tab stands on is a sheet that a navigation from
      it replaces. Read from the entry, not the drawn state: `home()` closes a
      sheet on screen before the navigation that follows writes anything. */
  const actionSheetOnTop = (): boolean => {
    if (pendingPops > 0) return false;
    const sheet = own()?.sheet ?? null;
    return sheet !== null && !KEPT_SHEETS.has(sheet);
  };

  /** A place in the stack taken by a new screen starts from nothing. */
  const forgetFrom = (depth: number): void => {
    for (const slot of memory.keys()) {
      if (Number(slot.slice(0, slot.indexOf(":"))) >= depth) memory.delete(slot);
    }
  };

  const nav: MobileNav = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    push(screen) {
      if (later(() => nav.push(screen))) return;
      const stack = [...state.stack, screen];
      if (pendingMark && !(screen.kind === "chat" && pendingMark.path === screen.id)) pendingMark = null;
      forgetFrom(stack.length - 1);
      commitAbove({ stack, sheet: null, project: projectNow() }, actionSheetOnTop());
      set({ stack, sheet: null, motion: "push", bump: null });
    },
    replace(screen, motion = "switch") {
      if (later(() => nav.replace(screen, motion))) return;
      const stack = [...state.stack.slice(0, -1), screen];
      forgetFrom(stack.length - 1);
      commitInPlace({ stack, sheet: null, project: projectNow() });
      set({ stack, sheet: null, motion, bump: null });
    },
    back() {
      if (later(() => nav.back())) return;
      if (state.stack.length > 1) {
        const current = own();
        /* The tab stands on an entry no phone wrote: a link that never
           opened, a notification the worker navigated itself. Whether that
           navigation went above the screen on show or took its entry is not
           known, so the pop goes one entry at a time until it lands on the
           screen under this one — never short of it, never past it. */
        if (!current && pendingPops === 0) {
          backTo = state.stack.slice(0, -1);
          passes = 0;
          adopt = false;
        }
        pendingPops += state.sheet && current?.sheet ? 2 : 1;
        set({ stack: state.stack.slice(0, -1), sheet: null, motion: "pop", bump: null });
        queueFlush();
        return;
      }
      if (state.sheet) {
        nav.closeSheet();
        return;
      }
      if (topScreen(state).kind !== "board") nav.replace(BOARD, "pop");
    },
    openSheet(name) {
      if (later(() => nav.openSheet(name))) return;
      if (state.sheet === name) return;
      const entry = { stack: state.stack, sheet: name, project: projectNow() };
      /* A sheet opened from a sheet takes its place. */
      commitAbove(entry, pendingPops === 0 && Boolean(own()?.sheet));
      set({ sheet: name, motion: "sheet" });
    },
    closeSheet() {
      if (later(() => nav.closeSheet())) return;
      if (!state.sheet) return;
      if (own()?.sheet && pendingPops === 0) {
        pendingPops = 1;
        queueFlush();
      } else {
        writeEntry("replace", { stack: state.stack, sheet: null, project: projectNow() });
      }
      set({ sheet: null, motion: "sheet" });
    },
    leave(url) {
      if (later(() => nav.leave(url))) return;
      nav.closeSheet();
      popThen(() => host.assign?.(url));
    },
    home() {
      if (state.stack.length === 1 && topScreen(state).kind === "board" && !state.sheet && !state.bump) return;
      set({ stack: [BOARD], sheet: null, motion: "act", bump: null });
    },
    enterProject(project, url) {
      if (later(() => nav.enterProject(project, url))) return;
      const current = own();
      const entry: MobileNavEntry = { stack: [BOARD], sheet: null, project };
      const place = { url, keys: {} };
      pendingMark = null;
      const settled = pendingPops === 0 && !current?.sheet;
      if (settled && current && current.stack.length === 1 && current.project === project) {
        /* Already this project's board: the same place, relabeled. */
        writeEntry("replace", entry, place);
      } else if (settled && !current && unstampedBase) {
        /* The tab's first entry, which no phone wrote: this board is it. */
        unstampedBase = false;
        writeEntry("replace", entry, place);
      } else {
        commitAbove(entry, actionSheetOnTop(), place);
      }
      adopt = false;
      set({ stack: [BOARD], sheet: null, motion: "act", bump: null });
    },
    retargetProject(project, keys, url) {
      const current = own();
      if (!current) return;
      const onBoard = current.stack.length === 1;
      put("replace", keys ?? carried(host.history.state), { ...current, project }, onBoard ? url : host.href());
    },
    mark(mark) {
      const top = topScreen(state);
      const current = own();
      if (!traversing && pendingPops === 0 && top.kind === "chat" && top.id === mark.path && current && sameScreen(topScreen(current), top)) {
        pendingMark = null;
        put("replace", mark.keys, current, mark.url);
        return;
      }
      pendingMark = mark;
    },
    bump(side) {
      set({ bump: side });
    },
    clearBump() {
      if (state.bump) set({ bump: null });
    },
    land(landed, event) {
      const known = event ? landings.get(event) : undefined;
      if (known) return known;
      const before = topScreen(state);
      const ours = traversing;
      /* A fragment navigation's event can arrive after the screen it opened
         has already taken its entry over: the entry the tab stands on is the
         place then. */
      const entry = standsOnOwnUrl(landed, host.href()) ? readMobileNavEntry(landed) : own();
      let result: MobileNavLanding;
      if (ours && backTo && entry && entry.stack.length > backTo.length && startsWith(entry.stack, backTo) && passes < MAX_PASSES) {
        /* Still above the screen the ‹ is going to: one entry more. */
        passes += 1;
        result = { kind: "passing" };
        if (event) landings.set(event, result);
        armSettle();
        host.history.go(-1);
        return result;
      }
      if (ours) {
        /* The pop this store asked for: the place it already shows is the
           one the entry says, and the writes that waited for it go now. */
        const followed = waiting.length > 0;
        settle();
        if (entry && !followed && (!sameStack(entry.stack, state.stack) || entry.sheet !== state.sheet)) {
          set({ stack: entry.stack, sheet: entry.sheet, motion: "pop", bump: null });
        }
        result = entry ? { kind: "phone", entry, topChanged: !sameScreen(before, topScreen(entry)) } : { kind: "foreign" };
      } else if (entry) {
        adopt = false;
        pendingPops = 0;
        const motion: MobileNavMotion = sameStack(entry.stack, state.stack)
          ? "sheet"
          : startsWith(state.stack, entry.stack) ? "pop"
          : startsWith(entry.stack, state.stack) ? "push"
          : entry.stack.length === state.stack.length ? "switch" : "act";
        set({ stack: sameStack(entry.stack, state.stack) ? state.stack : entry.stack, sheet: entry.sheet, motion, bump: null });
        result = { kind: "phone", entry, topChanged: !sameScreen(before, topScreen(entry)) };
      } else {
        /* An entry no phone wrote. A fresh navigation to a conversation (a link,
           a notification) opens it over where the operator is, and the screen
           it opens takes this entry over; a phone screen's fragment is that
           screen over the place; anything else is a board. */
        pendingPops = 0;
        const hash = fragmentOf(host.href());
        const screen = screenFromFragment(hash);
        if (namesConversation(hash)) {
          adopt = true;
          set({ sheet: null, motion: "act", bump: null });
        } else if (screen) {
          const stack = sameScreen(topScreen(state), screen) ? state.stack : [...state.stack, screen];
          put("replace", carried(landed), { stack, sheet: null, project: projectNow() }, host.href());
          set({ stack, sheet: null, motion: "push", bump: null });
        } else {
          adopt = false;
          set({ stack: [BOARD], sheet: null, motion: "pop", bump: null });
        }
        result = { kind: "foreign" };
      }
      if (event) landings.set(event, result);
      return result;
    },
    remember(slot, value) {
      memory.set(slot, value);
    },
    recall(slot) {
      return memory.get(slot);
    },
    configure(next) {
      config = next;
    },
    attach() {
      attached += 1;
      if (!detach) detach = host.onPopstate((landed, event) => nav.land(landed, event));
      if (unstampedBase && config) {
        /* A fresh tab on a phone screen's fragment: the board goes under it. */
        if (fragmentScreen && state.stack.length > 1 && !own()) {
          const url = host.href();
          unstampedBase = false;
          put("replace", carried(host.history.state), { stack: [BOARD], sheet: null, project: projectNow() }, boardUrl());
          put("push", {}, { stack: state.stack, sheet: null, project: projectNow() }, url);
        } else if (!namesConversation(fragmentOf(host.href()))) {
          /* A board URL: it is the board's entry as it stands. A conversation's
             link stays as it is until the conversation opens over it. */
          unstampedBase = false;
          put("replace", carried(host.history.state), { stack: [BOARD], sheet: null, project: projectNow() }, host.href());
        }
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        attached -= 1;
        if (attached === 0 && detach) {
          detach();
          detach = null;
        }
      };
    },
  };
  return nav;
}

const noop = (): void => {};
/** The server render and any non-browser reader see the board with no sheet. */
const INERT: MobileNav = {
  getState: () => INITIAL_MOBILE_NAV,
  subscribe: () => noop,
  push: noop,
  replace: noop,
  back: noop,
  openSheet: noop,
  closeSheet: noop,
  leave: noop,
  home: noop,
  enterProject: noop,
  retargetProject: noop,
  mark: noop,
  bump: noop,
  clearBump: noop,
  land: () => ({ kind: "foreign" }),
  remember: noop,
  recall: () => undefined,
  configure: noop,
  attach: () => noop,
};

let browserNav: MobileNav | null = null;
let browserNavWindow: Window | null = null;

/** The tab's one navigation store, over the real history. A test process
    that swaps its window gets a store over the new one. */
export function getMobileNav(): MobileNav {
  if (typeof window === "undefined") return INERT;
  if (!browserNav || browserNavWindow !== window) {
    browserNavWindow = window;
    browserNav = createMobileNav({
      history: window.history,
      href: () => window.location.href,
      onPopstate(listener) {
        const handler = (event: PopStateEvent) => listener(event.state, event);
        window.addEventListener("popstate", handler);
        return () => window.removeEventListener("popstate", handler);
      },
      assign: (url) => window.location.assign(url),
    });
  }
  return browserNav;
}

/** Tests start a case from a fresh store over a clean entry: the store lives
    for the page, and an entry a previous case left would read as a reload. */
export function resetMobileNavForTests(url?: string): void {
  browserNav = null;
  browserNavWindow = null;
  if (typeof window !== "undefined") window.history.replaceState(null, "", url ?? window.location.href);
}

/** Tests mount a shell over their own store (a fake history); the app reads
    the browser singleton. */
export const MobileNavContext = createContext<MobileNav | null>(null);

export function useMobileNavStore(): MobileNav {
  return useContext(MobileNavContext) ?? getMobileNav();
}

export function useMobileNav(): MobileNavState {
  const nav = useMobileNavStore();
  return useSyncExternalStore(nav.subscribe, nav.getState, () => INITIAL_MOBILE_NAV);
}

/**
 * A sheet that shows a selection its owner holds in its own state — a card's
 * actions, a stage's settings, a lane's menu. Its entry outlives that state: a
 * reload restores the entry (#2105), and Forward reaches it after the screen
 * remounted. With the selection gone the sheet would draw nothing while the
 * shell still counted it open, and the operator's next Back would be spent on
 * it; so the sheet closes, taking its entry with it.
 */
export function useSheetSelection(name: MobileSheetName, present: boolean): void {
  const nav = useMobileNavStore();
  const { sheet } = useMobileNav();
  useEffect(() => {
    if (sheet === name && !present) nav.closeSheet();
  }, [nav, sheet, name, present]);
}

/** Where `screen` stands in `stack` (its topmost place), as the key its
    memory is kept under; null when the stack does not hold it. */
export function screenSlot(stack: readonly MobileScreen[], screen: MobileScreen): string | null {
  const key = screenKey(screen);
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (screenKey(stack[index]!) === key) return `${index}:${key}`;
  }
  return null;
}

/**
 * A screen's own scroller keeps its offset for as long as the screen stays in
 * the stack: Back to it lands where the operator left it, and a new visit of
 * the same screen from somewhere else starts at the top. `ready` holds the
 * restore until the screen has drawn what it scrolls.
 */
export function useMobileScrollMemory(ref: RefObject<HTMLElement | null>, screen: MobileScreen, ready = true): void {
  const nav = useMobileNavStore();
  const key = screenKey(screen);
  useLayoutEffect(() => {
    const element = ref.current;
    const slot = screenSlot(nav.getState().stack, screen);
    if (!element || !ready || !slot) return;
    const saved = nav.recall(`${slot}:scroll`);
    const target = typeof saved === "number" ? saved : 0;
    let restoring = target > 0;
    let frame = 0;
    let tries = 0;
    const restore = () => {
      element.scrollTop = target;
      /* The content may still be growing into the height it had. */
      if (Math.abs(element.scrollTop - target) > 1 && tries < 20) {
        tries += 1;
        frame = requestAnimationFrame(restore);
      } else {
        restoring = false;
      }
    };
    if (restoring) restore();
    const onScroll = () => {
      /* A scroller on its way out of the page reports a last scroll to 0. */
      if (!restoring && element.isConnected) nav.remember(`${slot}:scroll`, element.scrollTop);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("scroll", onScroll);
    };
    /* eslint-disable-next-line react-hooks/exhaustive-deps -- `screen` is read through its key */
  }, [nav, key, ref, ready]);
}

/** A screen's own view state — a section it has open — kept like its scroll:
    Back to the screen finds it as it was left. */
export function useMobileScreenState<T>(screen: MobileScreen, name: string, initial: T): [T, (next: T | ((current: T) => T)) => void] {
  const nav = useMobileNavStore();
  const [slot] = useState(() => screenSlot(nav.getState().stack, screen));
  const [value, setValue] = useState<T>(() => {
    const kept = slot ? nav.recall(`${slot}:${name}`) : undefined;
    return kept === undefined ? initial : (kept as T);
  });
  const set = useCallback((next: T | ((current: T) => T)) => {
    setValue((current) => {
      const value = typeof next === "function" ? (next as (current: T) => T)(current) : next;
      if (slot) nav.remember(`${slot}:${name}`, value);
      return value;
    });
  }, [nav, slot, name]);
  return [value, set];
}
