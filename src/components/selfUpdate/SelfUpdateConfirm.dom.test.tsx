import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { ProcessView, Revision, ResumeWork, Snapshot, WorkEvidence } from "@/lib/selfUpdate/types";
import { CHECKOUT_STEPS, idleCheck, idleUpdate, stoppedProcess } from "@/lib/selfUpdate/types";

/*
 * The update confirmation (docs/design/self-update-confirm.md, variant 1):
 * the running work named by card, role and project and grouped by project,
 * never by a project key or a conversation id; work not read yet said in
 * words; and Escape taking back the confirmation before the Update dialog.
 */

const dom = new Window({ url: "http://localhost/" });
const globals = globalThis as Record<string, unknown>;
const overrides: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  localStorage: dom.localStorage,
  requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 0),
  // No stream: the dialog's feed polls the mocked fetch.
  EventSource: undefined,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const saved = new Map<string, { present: boolean; value: unknown }>();
beforeAll(() => {
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, { present: key in globals, value: globals[key] });
    globals[key] = value;
  }
});
afterAll(() => {
  for (const [key, entry] of saved) {
    if (entry.present) globals[key] = entry.value;
    else delete globals[key];
  }
  void dom.happyDOM.close();
});

const { groupWorkRows, publishBlockerNames, workRows } = await import("./blockerNames");
const { SelfUpdateConfirm } = await import("./SelfUpdateConfirm");
const { SelfUpdateDialog } = await import("./SelfUpdateDialog");
const { setLocale, translate } = await import("@/lib/i18n");

/* Opaque keys of the scanner's shape, built here so no literal looks like one. */
const DELEGATUS = `repo-${"ab".repeat(10)}`;
const SITE = `repo-${"ef".repeat(10)}`;
const LOOSE = `dir-${"cd".repeat(10)}`;

const WORK: ResumeWork = {
  turns: 5, stages: 3, unreadable: null,
  stageList: [
    { pipelineId: "lane-one", stageId: "review", cursor: "running", task: "#12 retry deletion: fix the fail", conversationId: "conversation_one", project: DELEGATUS, roleId: "reviewer", taskId: "task-one" },
    { pipelineId: "lane-two", stageId: "polish-copy", cursor: "running", task: "Legacy lane title", conversationId: "conversation_two", project: SITE, roleId: null, taskId: null },
    { pipelineId: "flow:loose", stageId: "review", cursor: "reviewing", task: "Review the change", conversationId: null, project: null, roleId: null, taskId: null },
  ],
  turnList: [
    { conversationId: "conversation_one", engine: "codex", project: DELEGATUS, stage: { pipelineId: "lane-one", stageId: "review" }, seat: false },
    { conversationId: "conversation_seat", engine: "claude", project: DELEGATUS, stage: null, seat: true },
    { conversationId: "conversation_loose", engine: "claude", project: LOOSE, stage: null, seat: false },
    { conversationId: "conversation_card", engine: "codex", project: SITE, stage: null, seat: false },
    { conversationId: "conversation_bare", engine: "codex", project: null, stage: null, seat: false },
  ],
};

const NAMES = {
  projects: { [DELEGATUS]: "Delegatus", [SITE]: "landing-site" },
  conversations: { conversation_loose: "Find why the photo backup stopped", conversation_card: "the conversation's own title" },
  tasks: { "task-one": "Retry deletion: fix the failing tests" },
  cards: { conversation_card: "Pricing page theme" },
};

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate("en", key, params);

describe("workRows", () => {
  test("each item is named by its card, its role and its project's name", () => {
    expect(workRows(WORK, NAMES, t as never)).toEqual([
      { key: "stage:lane-one:review", kind: "stage", title: "Retry deletion: fix the failing tests", who: "Reviewer", project: "Delegatus" },
      { key: "stage:lane-two:polish-copy", kind: "stage", title: "Legacy lane title", who: "Polish copy", project: "landing-site" },
      { key: "stage:flow:loose:review", kind: "stage", title: "Review the change", who: "review loop", project: null },
      { key: "turn:conversation_seat", kind: "seat", title: "Orchestrator", who: "Claude agent", project: "Delegatus" },
      { key: "turn:conversation_loose", kind: "agent", title: "Find why the photo backup stopped", who: "Claude agent", project: null },
      { key: "turn:conversation_card", kind: "agent", title: "Pricing page theme", who: "Codex agent", project: "landing-site" },
      { key: "turn:conversation_bare", kind: "agent", title: "Codex agent", who: "", project: null },
    ]);
  });

  test("with no names published, a stage falls back to its lane's text and a turn to its agent", () => {
    const rows = workRows(WORK, { projects: {}, conversations: {} }, t as never);
    expect(rows.map((row) => row.title)).toEqual(["#12 retry deletion: fix the fail", "Legacy lane title", "Review the change", "Orchestrator", "Claude agent", "Codex agent", "Codex agent"]);
    /* Every key here is opaque, so no project has a name to show. */
    expect(rows.every((row) => row.project === null)).toBe(true);
  });

  test("an opaque stage id is no name", () => {
    const stage = { ...WORK.stageList![1]!, stageId: "ab".repeat(6) };
    expect(workRows({ ...WORK, stageList: [stage], turnList: [] }, NAMES, t as never)[0]!.who).toBe("");
  });

  test("rows group under each project in order, the unnamed group last", () => {
    const groups = groupWorkRows(workRows(WORK, NAMES, t as never));
    expect(groups.map((group) => [group.project, group.rows.map((row) => row.key)])).toEqual([
      ["Delegatus", ["stage:lane-one:review", "turn:conversation_seat"]],
      ["landing-site", ["stage:lane-two:polish-copy", "turn:conversation_card"]],
      [null, ["stage:flow:loose:review", "turn:conversation_loose", "turn:conversation_bare"]],
    ]);
  });
});

/* ── Rendering ───────────────────────────────────────────────────────────── */

const OLD = "7fb7345".padEnd(40, "1");
const NEW = "e7893bc".padEnd(40, "2");
const NOW = Date.parse("2026-10-11T12:35:00Z");
const AT = new Date(NOW - 40_000).toISOString();
const rev = (sha: string, version: string): Revision => ({ version, sha, short: sha.slice(0, 7), date: "2026-10-11T09:00:00Z" });
const proc = (pid: number): ProcessView => ({ ...stoppedProcess(), state: "healthy", pid, startedAt: AT, lastHealthAt: AT, lastHealthOk: true, revision: OLD.slice(0, 7), tail: [] });

function snapshot(work: WorkEvidence["state"], resumeWork: ResumeWork | null = WORK): Snapshot {
  return {
    mode: "checkout",
    unsupportedReason: null,
    installed: rev(OLD, "1.10.4"),
    serving: { web: rev(OLD, "1.10.4"), runtimeHost: rev(OLD, "1.10.4") },
    available: rev(NEW, "1.11.0"),
    check: { ...idleCheck(), state: "update-available", at: AT, nextPollAt: AT, relation: "behind", behind: 5 },
    update: idleUpdate(CHECKOUT_STEPS),
    processes: { web: { ...proc(48213), port: 45123 }, runtimeHost: proc(48190) },
    busy: null,
    meta: { branch: "main", remote: "/var/tmp/remote.git", checkout: "/var/tmp/checkout", pollMinutes: 60, serverTime: new Date(NOW).toISOString() },
    workEvidence: { state: work, since: AT, at: work === "ready" ? AT : null, error: work === "unavailable" ? "journal read timed out" : null, phases: null },
    ...(work === "ready" && resumeWork ? { resumeWork } : {}),
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  publishBlockerNames({ projects: {}, conversations: {} });
  setLocale("en");
});

async function mount(element: React.ReactElement) {
  host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  root = createRoot(host);
  await act(async () => { root!.render(element); });
}

const confirmDialog = () => dom.document.querySelector("[data-team-dialog='self-update-confirm']");
const text = () => confirmDialog()?.textContent ?? "";
/** A button under `scope`, typed as the DOM's (happy-dom's types are its own). */
const button = (scope: { querySelector(selector: string): unknown } | null, selector: string) => scope?.querySelector(selector) as HTMLButtonElement;

describe("SelfUpdateConfirm", () => {
  for (const locale of ["en", "uk"] as const) {
    test(`${locale}: the work is listed under each project's name and said once to resume`, async () => {
      setLocale(locale);
      publishBlockerNames(NAMES);
      await mount(<SelfUpdateConfirm snapshot={snapshot("ready")} title="Update to e7893bc (1.11.0)?" onConfirm={() => {}} onCancel={() => {}} />);
      const dialog = confirmDialog()!;
      expect(dialog.getAttribute("aria-label")).toBe("Update to e7893bc (1.11.0)?");
      expect([...dialog.querySelectorAll("[data-confirm-project]")].map((node) => node.textContent))
        .toEqual(["Delegatus", "landing-site", translate(locale, "dash.projectUnnamed")]);
      expect(dialog.querySelectorAll("[data-confirm-row]").length).toBe(7);
      expect(dialog.querySelector("[data-confirm-count]")?.textContent).toBe("7");
      expect(text().split(translate(locale, "selfUpdate.confirmApply.resumes")).length).toBe(2);
      expect(text()).toContain(translate(locale, "roleCopy.reviewer.name"));
      expect(text()).not.toMatch(/repo-|dir-|conversation_/);
      expect(button(dialog, "[data-action='confirm-apply']").textContent).toBe(translate(locale, "selfUpdate.confirmApply.go"));
    });
  }

  test("what the server counted beyond its list is said as «and N more»", async () => {
    await mount(<SelfUpdateConfirm snapshot={snapshot("ready", { ...WORK, stages: 25, turns: 5 })} title="t" onConfirm={() => {}} onCancel={() => {}} />);
    expect(confirmDialog()!.querySelector("[data-confirm-more]")?.textContent).toBe("and 22 more");
    expect(confirmDialog()!.querySelector("[data-confirm-count]")?.textContent).toBe("29");
  });

  test("pending work says it is still being read, lists nothing and leaves «Update now» enabled", async () => {
    await mount(<SelfUpdateConfirm snapshot={snapshot("pending")} title="t" onConfirm={() => {}} onCancel={() => {}} />);
    expect(confirmDialog()!.querySelector("[data-confirm-work]")?.getAttribute("data-confirm-work")).toBe("pending");
    expect(text()).toContain(translate("en", "selfUpdate.confirmApply.pending"));
    expect(confirmDialog()!.querySelector("[data-confirm-list]")).toBeNull();
    expect(text()).not.toContain(translate("en", "selfUpdate.confirmApply.idle"));
    expect(button(confirmDialog(), "[data-action='confirm-apply']").disabled).toBe(false);
  });

  test("unreadable work is said with its reason and never as no work", async () => {
    await mount(<SelfUpdateConfirm snapshot={snapshot("unavailable")} title="t" onConfirm={() => {}} onCancel={() => {}} />);
    const line = confirmDialog()!.querySelector("[data-confirm-work='unavailable']");
    expect(line?.getAttribute("role")).toBe("alert");
    expect(line?.textContent).toBe(translate("en", "selfUpdate.confirmApply.unavailable", { detail: "journal read timed out" }));
    await act(async () => { root!.render(<SelfUpdateConfirm snapshot={snapshot("ready", { ...WORK, unreadable: "registry unreadable" })} title="t" onConfirm={() => {}} onCancel={() => {}} />); });
    expect(confirmDialog()!.querySelector("[data-confirm-work='unavailable']")?.textContent).toContain("registry unreadable");
    expect(text()).not.toContain(translate("en", "selfUpdate.confirmApply.idle"));
  });

  test("work read as empty says nothing is running", async () => {
    await mount(<SelfUpdateConfirm snapshot={snapshot("ready", { turns: 0, stages: 0, turnList: [], stageList: [], unreadable: null })} title="t" onConfirm={() => {}} onCancel={() => {}} />);
    expect(confirmDialog()!.querySelector("[data-confirm-work]")?.getAttribute("data-confirm-work")).toBe("idle");
  });
});

/* ── Inside the Update dialog ────────────────────────────────────────────── */

describe("the Update dialog asks before it applies", () => {
  async function open(work: WorkEvidence["state"] = "ready", served: (work: WorkEvidence["state"]) => Snapshot = snapshot, openAction = "update") {
    const posts: { path: string; body: unknown }[] = [];
    globals.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "POST") {
        posts.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(JSON.stringify(served(work)), { status: 202, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(served(work)), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    let closed = 0;
    await mount(<SelfUpdateDialog onClose={() => { closed += 1; }} />);
    for (let wait = 0; wait < 40 && !dom.document.querySelector(`[data-action='${openAction}']`); wait++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    const update = button(dom.document, `[data-action='${openAction}']`);
    expect(update).not.toBeNull();
    await act(async () => { update.click(); });
    expect(confirmDialog()).not.toBeNull();
    return { posts, closed: () => closed };
  }
  const press = (key: string) => act(async () => { dom.document.body.dispatchEvent(new dom.KeyboardEvent("keydown", { key, bubbles: true }) as never); });

  test("Escape takes back the confirmation first and the Update dialog stays", async () => {
    const { posts, closed } = await open();
    expect(confirmDialog()!.getAttribute("aria-label")).toBe("Update to e7893bc (1.11.0)?");
    await press("Escape");
    expect(confirmDialog()).toBeNull();
    expect(dom.document.querySelector("[data-self-update-dialog]")).not.toBeNull();
    expect(closed()).toBe(0);
    await press("Escape");
    expect(closed()).toBe(1);
    expect(posts).toEqual([]);
  });

  test("Cancel applies nothing; «Update now» closes the question and runs the update once", async () => {
    const first = await open("pending");
    await act(async () => { button(confirmDialog(), "[data-action='cancel-apply']").click(); });
    expect(confirmDialog()).toBeNull();
    expect(first.posts).toEqual([]);
    await act(async () => { button(dom.document, "[data-action='update']").click(); });
    await act(async () => { button(confirmDialog(), "[data-action='confirm-apply']").click(); });
    expect(confirmDialog()).toBeNull();
    expect(first.posts.map((post) => post.path)).toEqual(["/api/self-update/update"]);
    expect(Object.keys(first.posts[0]!.body as object)).toEqual(["key"]);
  });

  test("the install action's primary button repeats the action's own words and posts the action", async () => {
    const needsRestart = (work: WorkEvidence["state"]): Snapshot => ({
      ...snapshot(work),
      action: { id: "restart-service", button: true },
    } as unknown as Snapshot);
    const { posts } = await open("ready", needsRestart, "install-action");
    expect(confirmDialog()!.getAttribute("aria-label")).toBe("Restart launcher?");
    const go = button(confirmDialog(), "[data-action='confirm-apply']");
    expect(go.textContent).toBe("Restart launcher");
    expect(text()).not.toContain(translate("en", "selfUpdate.confirmApply.go"));
    await act(async () => { go.click(); });
    expect(posts.map((post) => post.path)).toEqual(["/api/self-update/action"]);
  });

  test("Retry asks with a short title, names the target in the body and posts the retry", async () => {
    const failed = (work: WorkEvidence["state"]): Snapshot => {
      const base = snapshot(work);
      const steps = idleUpdate(CHECKOUT_STEPS).steps.map((step, index) => ({ ...step, state: index === 0 ? "failed" as const : "pending" as const }));
      return { ...base, update: { ...idleUpdate(CHECKOUT_STEPS), state: "failed", trigger: "operator", target: NEW, targetShort: NEW.slice(0, 7), targetVersion: "1.11.0", steps } };
    };
    const { posts } = await open("ready", failed, "retry");
    expect(confirmDialog()!.getAttribute("aria-label")).toBe("Retry the update?");
    expect(text()).toContain("Trying the update to e7893bc (1.11.0) again.");
    await act(async () => { button(confirmDialog(), "[data-action='confirm-apply']").click(); });
    expect(posts.map((post) => post.path)).toEqual(["/api/self-update/update"]);
    expect(Object.keys(posts[0]!.body as object).sort()).toEqual(["key", "retry"]);
    expect((posts[0]!.body as { retry: boolean }).retry).toBe(true);
  });
});
