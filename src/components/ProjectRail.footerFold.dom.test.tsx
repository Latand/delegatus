import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale, translate } from "@/lib/i18n";
import type { FileEntry, LimitsPayload } from "@/lib/types";

/*
 * Putting the rail's footer away before a stream (issue #1802).
 *
 * The operator's ask was literal: nothing with a number, a plan name or an
 * account name in it may stay on screen once the footer is folded. So this
 * mounts the rail with the footers ANSWERING — real memory figures, a real
 * limit window — and then folds it, because a footer asserted while its polls
 * failed would pass with nothing rendered in the first place.
 */

const dom = new Window({ url: "http://localhost/", width: 1440, height: 900 });
installActEnv();
const matchMediaStub = (query: string) => ({
  matches: false, media: String(query), onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  dispatchEvent() { return false; },
});
(dom as unknown as { matchMedia: typeof matchMediaStub }).matchMedia = matchMediaStub;
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  matchMedia: matchMediaStub,
});

const NOW = Math.round(Date.now() / 1000);
const limits: LimitsPayload = {
  claude: null,
  codex: {
    session: { usedPercent: 40, resetsAt: NOW + 3_600, windowMinutes: 300 },
    weekly: { usedPercent: 10, resetsAt: NOW + 172_800, windowMinutes: 10_080 },
    plan: "pro",
    capturedAt: NOW,
  },
  claudeAccountId: "claude-a",
  codexAccountId: "account-a",
  provenance: {
    claude: { source: "unavailable", reason: null, staleSince: null },
    codex: { source: "live", reason: null, staleSince: null },
  },
  staleSince: null,
} as LimitsPayload;

const resources = {
  system: {
    ramTotal: 32 * 1024 ** 3,
    ramAvailable: 9 * 1024 ** 3,
    swapTotal: 8 * 1024 ** 3,
    swapUsed: 1 * 1024 ** 3,
    capturedAt: new Date(NOW * 1000).toISOString(),
  },
  sessions: [],
};

const accounts = {
  codex: { active: "account-a", accounts: [] },
  claude: { active: "claude-a", accounts: [] },
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.startsWith("/api/resources")) return { ok: true, status: 200, json: async () => resources } as Response;
  if (url === "/api/limits") return { ok: true, status: 200, json: async () => limits } as Response;
  if (url === "/api/accounts") return { ok: true, status: 200, json: async () => accounts } as Response;
  return { ok: false, status: 404, json: async () => ({}) } as Response;
}) as unknown as typeof fetch;

const { ProjectRail, RAIL_FOOTER_STORAGE_KEY } = await import("./ProjectRail");

const files = [{
  path: "/sessions/a.jsonl",
  root: "claude-projects",
  name: "a.jsonl",
  project: "atlas",
  title: "Session",
  engine: "claude",
  kind: "session",
  fmt: "claude",
  parent: null,
  mtime: 1_000,
  size: 1,
  activity: "idle",
  proc: null,
  pid: null,
  model: null,
  pendingQuestion: null,
  waitingInput: null,
} as FileEntry];

let root: Root | null = null;
beforeEach(() => {
  dom.localStorage.clear();
});
afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  dom.document.body.replaceChildren();
  setLocale("en");
});

/* The resources probe starts 1.5s after mount on purpose (it keeps its first
   request out of the board's own burst), so a test that wants its numbers on
   screen waits for them rather than for a fixed number of turns. */
async function waitForText(host: HTMLElement, needle: string): Promise<void> {
  for (let round = 0; round < 60; round += 1) {
    if ((host.textContent ?? "").includes(needle)) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  }
}

async function renderRail(): Promise<HTMLElement> {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host as unknown as Element);
    root.render(
      <ProjectRail
        files={files}
        projectCatalog={[]}
        pipelines={[]}
        workflows={[]}
        archivedProjects={new Set()}
        selected="atlas"
        loaded
        now={2_000}
        onSelect={() => {}}
      />,
    );
  });
  /* A few turns for the resources and limits responses to land. */
  for (let round = 0; round < 4; round += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  return host as unknown as HTMLElement;
}

const toggleIn = (host: HTMLElement) => host.querySelector("[data-rail-footer-toggle]") as HTMLButtonElement;
const footerIn = (host: HTMLElement) => host.querySelector("[data-rail-footer]") as HTMLElement;
const click = async (element: HTMLElement) => {
  await act(async () => { element.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
};

test("the folded rail footer shows no resource or limit reading, and unfolding brings it back", async () => {
  const host = await renderRail();
  await waitForText(host, translate("en", "resources.ram"));

  /* Open: the readings the operator wants off the screen are genuinely on it. */
  const open = host.textContent ?? "";
  expect(open).toContain(translate("en", "resources.ram"));
  expect(open).toContain(translate("en", "resources.swap"));
  expect(open).toMatch(/\d+%/);
  expect(footerIn(host).getAttribute("data-rail-footer")).toBe("open");
  expect(toggleIn(host).getAttribute("aria-expanded")).toBe("true");

  await click(toggleIn(host));

  const folded = host.textContent ?? "";
  expect(footerIn(host).getAttribute("data-rail-footer")).toBe("folded");
  /* A label and the control, and nothing that reads as a number or a plan. */
  expect(folded).toContain(translate("en", "rail.footerLabel"));
  expect(folded).not.toContain(translate("en", "resources.ram"));
  expect(folded).not.toContain(translate("en", "resources.swap"));
  expect(folded).not.toMatch(/\d+%/);
  expect(folded.toLowerCase()).not.toContain("pro");
  /* Unmounted, not hidden: no footer subtree is left in the document to tick. */
  expect(host.querySelector("[data-rail-footer] > div")).toBeNull();

  await click(toggleIn(host));
  await waitForText(host, translate("en", "resources.ram"));
  const reopened = host.textContent ?? "";
  expect(reopened).toContain(translate("en", "resources.ram"));
  expect(reopened).toMatch(/\d+%/);
});

test("the fold is remembered for this browser", async () => {
  const host = await renderRail();
  await waitForText(host, translate("en", "resources.ram"));
  await click(toggleIn(host));
  expect(dom.localStorage.getItem(RAIL_FOOTER_STORAGE_KEY)).toBe("folded");

  await act(async () => { root?.unmount(); });
  root = null;
  dom.document.body.replaceChildren();

  const again = await renderRail();
  expect(footerIn(again).getAttribute("data-rail-footer")).toBe("folded");
  expect(again.textContent ?? "").not.toContain(translate("en", "resources.ram"));
});

test("the control is there before any poll answers, in either language", async () => {
  /* The footer's own readings arrive a second and a half after mount. The
     control must not wait for them: a rail whose polls have not landed yet (or
     never will) still has to be foldable, because the moment they do land an
     account name appears on screen. */
  const host = await renderRail();
  setLocale("uk");
  await click(toggleIn(host));
  expect(footerIn(host).getAttribute("data-rail-footer")).toBe("folded");
  expect(toggleIn(host).getAttribute("aria-expanded")).toBe("false");
  expect(host.textContent ?? "").toContain(translate("uk", "rail.footerLabel"));
});
