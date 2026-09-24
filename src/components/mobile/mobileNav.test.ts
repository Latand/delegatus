import { describe, expect, test } from "bun:test";

import { BOARD, createMobileNav, MOBILE_NAV_STATE_KEY, readMobileNavEntry, screenFromFragment, screenSlot, topScreen, type MobileNav, type MobileNavConfig } from "./mobileNav";
import { fakeHistory } from "./mobileNavTestHistory";

/*
 * The phone's navigation contract (docs/design/mobile-v2/README.md §3.3,
 * #2105) over a model of the browser's same-document history: every screen
 * and every sheet is exactly one entry, each standing on its own URL; the
 * platform's Back and the bar's ‹ are the same pop; a sheet's Back closes it
 * and stays on the screen; a sibling switch replaces; and what a traversal
 * lands on is read back from the entry itself.
 */

const focus = (path: string, id = `c-${path.split("/").pop()}`) => ({ llvFocus: { v: 1, conversationId: id, path, project: "atlas" } });

/** The Viewer's side: the project, the board's URL and a conversation's link. */
function viewer(project = "atlas"): MobileNavConfig & { project: () => string; set: (next: string) => void } {
  let current = project;
  return {
    project: () => current,
    set: (next) => { current = next; },
    boardUrl: () => (current === "__overview__" ? "/" : `#p=${current}`),
    conversation: (id) => ({ url: `#c=c-${id.split("/").pop()}`, keys: focus(id) }),
  };
}

function phone(url = "http://phone/#p=atlas", options: { hold?: boolean } = {}) {
  const b = fakeHistory(url, options);
  const config = viewer();
  const nav = createMobileNav(b.host);
  nav.configure(config);
  const detach = nav.attach();
  return { nav, b, config, detach };
}

const kinds = (nav: MobileNav) => nav.getState().stack.map((screen) => screen.kind);
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("screens", () => {
  test("a push is one entry on the screen's own URL, carrying the whole stack; ‹ pops it", async () => {
    const { nav, b } = phone();
    nav.push({ kind: "accounts" });
    expect(kinds(nav)).toEqual(["board", "accounts"]);
    expect(nav.getState().motion).toBe("push");
    expect(b.length()).toBe(2);
    expect(b.hash()).toBe("#accounts");
    expect(readMobileNavEntry(b.state())).toEqual({ stack: [BOARD, { kind: "accounts" }], sheet: null, project: "atlas" });
    nav.back();
    expect(kinds(nav)).toEqual(["board"]);
    expect(nav.getState().motion).toBe("pop");
    await settle();
    expect(b.index()).toBe(0);
    expect(b.hash()).toBe("#p=atlas");
  });

  test("board → task → pipeline → conversation: each is one entry, and Back ×3 walks them in turn", async () => {
    const { nav, b } = phone();
    nav.push({ kind: "task", id: "t1" });
    expect(b.hash()).toBe("#task=t1");
    nav.push({ kind: "pipeline", id: "p1" });
    expect(b.hash()).toBe("#pipeline=p1");
    nav.push({ kind: "chat", id: "/repo/stage.jsonl" });
    expect(b.hash()).toBe("#c=c-stage.jsonl");
    expect(b.state()).toMatchObject(focus("/repo/stage.jsonl"));
    expect(b.length()).toBe(4);
    b.back();
    expect(kinds(nav)).toEqual(["board", "task", "pipeline"]);
    nav.back();
    await settle();
    expect(topScreen(nav.getState())).toEqual({ kind: "task", id: "t1" });
    expect(b.hash()).toBe("#task=t1");
    b.back();
    expect(kinds(nav)).toEqual(["board"]);
    /* Forward re-enters the task it left. */
    b.forward();
    expect(topScreen(nav.getState())).toEqual({ kind: "task", id: "t1" });
    expect(nav.getState().motion).toBe("push");
  });

  /* The operator's report (#2105): the board was left standing on the
     orchestrator's link by an earlier visit, and a task pushed from it copied
     that link. Back from the task's agent landed on it, and the Viewer's
     resolver took the link for a fresh deep link and opened the orchestrator.
     A screen now stands on its own URL, whatever the board was left on. */
  test("a screen pushed from a board left on a conversation's link stands on its own URL", async () => {
    const { nav, b } = phone("http://phone/#c=c-orchestrator.jsonl");
    nav.push({ kind: "task", id: "t1" });
    /* The entry the tab was loaded on became the board's own, at the board's URL. */
    expect(b.entries()[0]!.url).toBe("http://phone/#p=atlas");
    expect(b.hash()).toBe("#task=t1");
    nav.push({ kind: "chat", id: "/repo/agent.jsonl" });
    b.back();
    expect(topScreen(nav.getState())).toEqual({ kind: "task", id: "t1" });
    expect(b.hash()).toBe("#task=t1");
    expect(b.state()).not.toHaveProperty("llvFocus");
    b.back();
    expect(kinds(nav)).toEqual(["board"]);
    expect(b.hash()).toBe("#p=atlas");
  });

  test("a sibling switch replaces the top: no new entry, and the entry names the new conversation", () => {
    const { nav, b } = phone();
    nav.push({ kind: "chat", id: "/repo/c1.jsonl" });
    const before = b.length();
    nav.replace({ kind: "chat", id: "/repo/c2.jsonl" });
    expect(b.length()).toBe(before);
    expect(topScreen(nav.getState())).toEqual({ kind: "chat", id: "/repo/c2.jsonl" });
    expect(nav.getState().motion).toBe("switch");
    expect(b.hash()).toBe("#c=c-c2.jsonl");
    expect(b.state()).toMatchObject(focus("/repo/c2.jsonl"));
  });

  test("‹ at the bottom of the stack stays on the board and writes nothing", () => {
    const { nav, b } = phone();
    const state = b.state();
    nav.back();
    expect(kinds(nav)).toEqual(["board"]);
    expect(b.length()).toBe(1);
    expect(b.state()).toEqual(state);
  });

  test("a screen alone at the bottom: ‹ replaces it with the board", () => {
    const { nav, b } = phone();
    nav.replace({ kind: "pipeline", id: "p1" });
    expect(kinds(nav)).toEqual(["pipeline"]);
    nav.back();
    expect(kinds(nav)).toEqual(["board"]);
    expect(nav.getState().motion).toBe("pop");
    expect(b.length()).toBe(1);
  });
});

describe("sheets", () => {
  test("a sheet is one entry over the screen, on the screen's URL; Back closes it and stays", () => {
    const { nav, b } = phone();
    nav.push({ kind: "task", id: "t1" });
    nav.openSheet("status");
    expect(nav.getState().sheet).toBe("status");
    expect(nav.getState().motion).toBe("sheet");
    expect(b.length()).toBe(3);
    expect(b.hash()).toBe("#task=t1");
    b.back();
    expect(nav.getState().sheet).toBeNull();
    expect(topScreen(nav.getState())).toEqual({ kind: "task", id: "t1" });
    expect(nav.getState().motion).toBe("sheet");
    /* The next Back leaves the screen. */
    b.back();
    expect(kinds(nav)).toEqual(["board"]);
  });

  test("a sheet closed by its own × takes its entry with it", async () => {
    const { nav, b } = phone();
    nav.push({ kind: "task", id: "t1" });
    nav.openSheet("menu");
    nav.closeSheet();
    expect(nav.getState().sheet).toBeNull();
    await settle();
    expect(b.index()).toBe(1);
    expect(readMobileNavEntry(b.state())?.sheet).toBeNull();
    b.back();
    expect(kinds(nav)).toEqual(["board"]);
  });

  test("a sheet opened from a sheet takes its place", () => {
    const { nav, b } = phone();
    nav.openSheet("switch");
    nav.openSheet("projects");
    expect(b.length()).toBe(2);
    expect(nav.getState().sheet).toBe("projects");
    b.back();
    expect(nav.getState().sheet).toBeNull();
  });

  test("a row in a sheet that opens a screen gives it the sheet's entry: Back returns to the screen under the sheet", async () => {
    for (const closeFirst of [false, true]) {
      const { nav, b } = phone();
      nav.push({ kind: "task", id: "t1" });
      nav.openSheet("menu");
      if (closeFirst) nav.closeSheet();
      nav.push({ kind: "pipeline", id: "p1" });
      await settle();
      expect(b.length()).toBe(3);
      expect(kinds(nav)).toEqual(["board", "task", "pipeline"]);
      expect(nav.getState().sheet).toBeNull();
      b.back();
      expect(topScreen(nav.getState())).toEqual({ kind: "task", id: "t1" });
      expect(nav.getState().sheet).toBeNull();
    }
  });

  test("the Tasks list stays under a task opened from it, and Back finds the list again", () => {
    const { nav, b } = phone();
    nav.openSheet("tasks");
    nav.push({ kind: "task", id: "t1" });
    expect(b.length()).toBe(3);
    b.back();
    expect(kinds(nav)).toEqual(["board"]);
    expect(nav.getState().sheet).toBe("tasks");
  });

  test("‹ with a sheet open leaves the screen, sheet and all; on the board it closes the sheet", async () => {
    const { nav, b } = phone();
    nav.push({ kind: "pipelines" });
    nav.openSheet("menu");
    nav.back();
    expect(kinds(nav)).toEqual(["board"]);
    await settle();
    expect(b.index()).toBe(0);
    nav.openSheet("projects");
    nav.back();
    expect(nav.getState().sheet).toBeNull();
    await settle();
    expect(b.index()).toBe(0);
  });

  test("a close and a sibling switch in one gesture: the sheet's entry goes and the screen's entry names the sibling", async () => {
    const { nav, b } = phone();
    nav.push({ kind: "chat", id: "/repo/c1.jsonl" });
    nav.openSheet("switch");
    nav.closeSheet();
    nav.replace({ kind: "chat", id: "/repo/c2.jsonl" });
    await settle();
    expect(b.length()).toBe(3);
    expect(b.index()).toBe(1);
    expect(b.hash()).toBe("#c=c-c2.jsonl");
    expect(topScreen(nav.getState())).toEqual({ kind: "chat", id: "/repo/c2.jsonl" });
    b.back();
    expect(kinds(nav)).toEqual(["board"]);
  });

  test("a close waits for the gesture: a close and a push held together are one write", () => {
    const { nav, b } = phone("http://phone/#p=atlas", { hold: true });
    nav.openSheet("attention");
    nav.closeSheet();
    nav.push({ kind: "chat", id: "/repo/c1.jsonl" });
    b.flush();
    expect(b.length()).toBe(2);
    expect(b.index()).toBe(1);
    b.back();
    expect(kinds(nav)).toEqual(["board"]);
    expect(nav.getState().sheet).toBeNull();
  });

  test("subscribers hear every change once", () => {
    const { nav } = phone();
    let heard = 0;
    const off = nav.subscribe(() => { heard += 1; });
    nav.openSheet("menu");
    nav.openSheet("menu");
    nav.closeSheet();
    off();
    nav.openSheet("menu");
    expect(heard).toBe(2);
  });
});

describe("the Viewer's own records", () => {
  test("a focus recorded before the open types the conversation's one entry", () => {
    const { nav, b } = phone();
    nav.push({ kind: "task", id: "t1" });
    nav.mark({ path: "/repo/agent.jsonl", keys: focus("/repo/agent.jsonl", "c-real"), url: "#c=c-real" });
    nav.push({ kind: "chat", id: "/repo/agent.jsonl" });
    expect(b.length()).toBe(3);
    expect(b.hash()).toBe("#c=c-real");
    expect(b.state()).toMatchObject(focus("/repo/agent.jsonl", "c-real"));
    expect(readMobileNavEntry(b.state())?.stack).toEqual([BOARD, { kind: "task", id: "t1" }, { kind: "chat", id: "/repo/agent.jsonl" }]);
  });

  test("a focus of the conversation on screen types its entry in place", () => {
    const { nav, b } = phone();
    nav.push({ kind: "chat", id: "/repo/agent.jsonl" });
    nav.mark({ path: "/repo/agent.jsonl", keys: focus("/repo/agent.jsonl", "c-adopted"), url: "#c=c-adopted" });
    expect(b.length()).toBe(2);
    expect(b.hash()).toBe("#c=c-adopted");
    expect(readMobileNavEntry(b.state())?.stack).toEqual([BOARD, { kind: "chat", id: "/repo/agent.jsonl" }]);
  });

  test("a project selection is one board entry; Back returns to the place in the project left", () => {
    const { nav, b, config } = phone();
    nav.push({ kind: "task", id: "t1" });
    nav.openSheet("projects");
    nav.home();
    config.set("forge");
    nav.enterProject("forge", "#p=forge");
    /* The row replaced the sheet it was tapped in. */
    expect(b.length()).toBe(3);
    expect(b.hash()).toBe("#p=forge");
    expect(readMobileNavEntry(b.state())).toEqual({ stack: [BOARD], sheet: null, project: "forge" });
    const landing = nav.land(b.state());
    expect(landing.kind).toBe("phone");
    b.back();
    expect(topScreen(nav.getState())).toEqual({ kind: "task", id: "t1" });
    expect(readMobileNavEntry(b.state())?.project).toBe("atlas");
    /* The same project's board again is the same place, not a second entry. */
    b.forward();
    nav.enterProject("forge", "#p=forge");
    expect(b.length()).toBe(3);
  });
});

describe("traversals", () => {
  test("the landing is read once per event and says whether the screen on top changed", () => {
    const { nav, b } = phone();
    nav.push({ kind: "chat", id: "/repo/c1.jsonl" });
    nav.openSheet("menu");
    const event = {};
    b.host.history.go(-1);
    const landing = nav.land(b.state(), event);
    expect(landing).toMatchObject({ kind: "phone", topChanged: false });
    expect(nav.land(b.state(), event)).toBe(landing);
  });

  test("a link the store did not write, from a task: the conversation it opens takes its entry, and Back returns to the task", () => {
    const { nav, b } = phone();
    nav.push({ kind: "task", id: "t1" });
    b.navigate("#c=c-agent.jsonl");
    expect(topScreen(nav.getState())).toEqual({ kind: "task", id: "t1" });
    nav.push({ kind: "chat", id: "/repo/agent.jsonl" });
    expect(b.length()).toBe(3);
    expect(readMobileNavEntry(b.state())?.stack).toEqual([BOARD, { kind: "task", id: "t1" }, { kind: "chat", id: "/repo/agent.jsonl" }]);
    b.back();
    expect(topScreen(nav.getState())).toEqual({ kind: "task", id: "t1" });
    expect(b.hash()).toBe("#task=t1");
  });

  test("a link's own event arriving after its conversation took the entry over changes nothing", () => {
    const { nav, b } = phone();
    nav.push({ kind: "task", id: "t1" });
    /* The link navigates, and the conversation opens in the same gesture,
       before the browser delivers the navigation's event. */
    b.navigate("#c=c-agent.jsonl", { quiet: true });
    nav.push({ kind: "chat", id: "/repo/agent.jsonl" });
    expect(b.length()).toBe(3);
    b.deliver(null);
    expect(topScreen(nav.getState())).toEqual({ kind: "chat", id: "/repo/agent.jsonl" });
    b.back();
    expect(topScreen(nav.getState())).toEqual({ kind: "task", id: "t1" });
  });

  test("a project link the store did not write is that project's board", () => {
    const { nav, b } = phone();
    nav.push({ kind: "task", id: "t1" });
    b.navigate("#p=forge");
    expect(kinds(nav)).toEqual(["board"]);
  });

  test("a phone screen's link opens that screen over the place", () => {
    const { nav, b } = phone();
    b.navigate("#pipeline=p9");
    expect(kinds(nav)).toEqual(["board", "pipeline"]);
    expect(readMobileNavEntry(b.state())?.stack).toEqual([BOARD, { kind: "pipeline", id: "p9" }]);
    b.back();
    expect(kinds(nav)).toEqual(["board"]);
  });

  test("attach is ref-counted: the listener stays until the last screen detaches", () => {
    const b = fakeHistory("http://phone/#p=atlas");
    const nav = createMobileNav(b.host);
    const first = nav.attach();
    const second = nav.attach();
    expect(b.listening()).toBe(true);
    first();
    expect(b.listening()).toBe(true);
    second();
    expect(b.listening()).toBe(false);
  });
});

describe("a pop that lands late", () => {
  const after = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  function slow(lateMs: number) {
    const b = fakeHistory("http://phone/#p=atlas", { lateMs, settleMs: 20 });
    const nav = createMobileNav(b.host);
    nav.configure(viewer());
    nav.attach();
    return { nav, b };
  }

  test("a landing after the first wait but inside the grace settles it, and the entry left is not rewritten", async () => {
    const { nav, b } = slow(50);
    nav.push({ kind: "task", id: "t1" });
    nav.openSheet("menu");
    nav.closeSheet();
    await after(150);
    expect(b.index()).toBe(1);
    expect(readMobileNavEntry(b.entries()[2]!.state)?.sheet).toBe("menu");
    expect(nav.getState().sheet).toBeNull();
    /* A write after it goes where it should: above the task. */
    nav.push({ kind: "pipeline", id: "p1" });
    expect(b.index()).toBe(2);
    expect(readMobileNavEntry(b.state())?.stack).toEqual([BOARD, { kind: "task", id: "t1" }, { kind: "pipeline", id: "p1" }]);
  });

  test("a landing later than the grace still only takes the tab where it was going", async () => {
    const { nav, b } = slow(200);
    nav.push({ kind: "task", id: "t1" });
    nav.openSheet("menu");
    nav.closeSheet();
    await after(300);
    expect(b.index()).toBe(1);
    expect(readMobileNavEntry(b.entries()[2]!.state)?.sheet).toBe("menu");
    expect(topScreen(nav.getState())).toEqual({ kind: "task", id: "t1" });
    expect(nav.getState().sheet).toBeNull();
    /* Forward finds what was left (this history lands it late too). */
    b.forward();
    await after(250);
    expect(nav.getState().sheet).toBe("menu");
  });

  test("with nothing under the entry to pop to, the entry is made to say what the screen shows", async () => {
    const b = fakeHistory("http://phone/#p=atlas", { settleMs: 20 });
    b.host.history.replaceState({ [MOBILE_NAV_STATE_KEY]: { v: 2, stack: [BOARD], sheet: "menu", project: "atlas", at: "#p=atlas" } }, "", "http://phone/#p=atlas");
    const nav = createMobileNav(b.host);
    nav.configure(viewer());
    nav.attach();
    expect(nav.getState().sheet).toBe("menu");
    nav.closeSheet();
    await after(60);
    expect(b.length()).toBe(1);
    expect(readMobileNavEntry(b.state())?.sheet).toBeNull();
  });
});

describe("a reload and a fresh tab", () => {
  test("a reload lands on the entry's own place, with the stack under it", () => {
    const { nav, b } = phone();
    nav.push({ kind: "task", id: "t1" });
    nav.push({ kind: "pipeline", id: "p1" });
    /* The page reloads: the entries stay, the store starts over. */
    const reloaded = createMobileNav(b.host);
    reloaded.configure(viewer());
    reloaded.attach();
    expect(reloaded.getState().stack).toEqual([BOARD, { kind: "task", id: "t1" }, { kind: "pipeline", id: "p1" }]);
    expect(reloaded.getState().motion).toBe("load");
    b.back();
    expect(topScreen(reloaded.getState())).toEqual({ kind: "task", id: "t1" });
  });

  test("a fresh tab on a phone screen's link opens it over the board, which ‹ reaches", async () => {
    const b = fakeHistory("http://phone/#task=t%201");
    const nav = createMobileNav(b.host);
    nav.configure(viewer());
    nav.attach();
    expect(nav.getState().stack).toEqual([BOARD, { kind: "task", id: "t 1" }]);
    expect(b.length()).toBe(2);
    expect(b.entries()[0]!.url).toBe("http://phone/#p=atlas");
    expect(b.hash()).toBe("#task=t%201");
    nav.back();
    await settle();
    expect(kinds(nav)).toEqual(["board"]);
    expect(b.hash()).toBe("#p=atlas");
  });

  test("a fresh tab on a board's URL is the board's entry as it stands", () => {
    const { b } = phone("http://phone/#p=atlas");
    expect(readMobileNavEntry(b.state())).toEqual({ stack: [BOARD], sheet: null, project: "atlas" });
    expect(b.hash()).toBe("#p=atlas");
  });
});

describe("history entries", () => {
  test("readMobileNavEntry refuses what the phone did not write", () => {
    const entry = (value: unknown) => readMobileNavEntry({ [MOBILE_NAV_STATE_KEY]: value });
    expect(readMobileNavEntry(null)).toBeNull();
    expect(readMobileNavEntry({ llvFocus: { v: 1 } })).toBeNull();
    expect(entry({ v: 2, stack: [], sheet: null })).toBeNull();
    expect(entry({ v: 2, stack: [{ kind: "task", id: "t1" }], sheet: null })).toBeNull();
    expect(entry({ v: 2, stack: [BOARD, { kind: "chat" }], sheet: null })).toBeNull();
    expect(entry({ v: 2, stack: [BOARD, { kind: "bench" }], sheet: null })).toBeNull();
    expect(entry({ v: 2, stack: [BOARD, { kind: "board", id: "x" }], sheet: null })).toBeNull();
    expect(entry({ v: 2, stack: [BOARD, { kind: "task", id: "t1", extra: 1 }], sheet: "status", project: "atlas" }))
      .toEqual({ stack: [BOARD, { kind: "task", id: "t1" }], sheet: "status", project: "atlas" });
    expect(entry({ v: 2, stack: [BOARD], sheet: "no-such-sheet" })).toEqual({ stack: [BOARD], sheet: null, project: null });
    /* The earlier shape reads as its screen over the board. */
    expect(entry({ d: 3, screen: { kind: "chat", id: "c1" } })).toEqual({ stack: [BOARD, { kind: "chat", id: "c1" }], sheet: null, project: null });
    expect(entry({ d: 0, screen: BOARD })).toBeNull();
  });

  test("a phone screen's fragment names it, and nothing else does", () => {
    expect(screenFromFragment("#task=t%2F1")).toEqual({ kind: "task", id: "t/1" });
    expect(screenFromFragment("#pipeline=p1")).toEqual({ kind: "pipeline", id: "p1" });
    expect(screenFromFragment("#pipelines")).toEqual({ kind: "pipelines" });
    expect(screenFromFragment("#accounts")).toEqual({ kind: "accounts" });
    expect(screenFromFragment("#c=c1")).toBeNull();
    expect(screenFromFragment("#task=")).toBeNull();
  });

  test("a screen's scroll is kept while it stays in the stack, and a new visit starts at the top", () => {
    const { nav } = phone();
    nav.push({ kind: "task", id: "t1" });
    const slot = screenSlot(nav.getState().stack, { kind: "task", id: "t1" })!;
    expect(slot).toBe("1:task:t1");
    nav.remember(`${slot}:scroll`, 420);
    nav.push({ kind: "chat", id: "/repo/c1.jsonl" });
    nav.back();
    expect(nav.recall(`${slot}:scroll`)).toBe(420);
    nav.home();
    nav.push({ kind: "task", id: "t1" });
    expect(nav.recall(`${slot}:scroll`)).toBeUndefined();
  });

  test("home lands on the board with no sheet and no bump, and writes nothing", () => {
    const { nav, b } = phone();
    nav.push({ kind: "pipelines" });
    nav.openSheet("menu");
    nav.bump("right");
    const length = b.length();
    nav.home();
    expect(nav.getState()).toMatchObject({ stack: [BOARD], sheet: null, bump: null, motion: "act" });
    expect(b.length()).toBe(length);
  });

  test("a bump is cleared by the bar", () => {
    const { nav } = phone();
    nav.bump("left");
    expect(nav.getState().bump).toBe("left");
    nav.clearBump();
    expect(nav.getState().bump).toBeNull();
  });
});
