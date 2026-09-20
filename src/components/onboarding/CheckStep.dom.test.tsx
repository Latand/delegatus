import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";

/*
 * #1876 slice 2: the Check step renders the server's run as it stands. A
 * failed row opens in place with its code's two sentences and its action, the
 * rows after it stay waiting, and the footer line names the row it stopped at.
 */

const dom = new Window({ url: "http://localhost/" });
const RUNTIME = { engine: "claude", model: "haiku", effort: "low" };
const row = (id: string, state: string, failure: unknown = null) => ({ id, state, startedAt: state === "waiting" ? null : "2026-09-20T10:00:00.000Z", finishedAt: state === "waiting" ? null : "2026-09-20T10:00:04.000Z", failure, note: null });
let answer: unknown = { runtime: RUNTIME, run: null };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/* What each request answers. The default serves `answer` at 200; a test that
   cares which URL was asked, or about a status, replaces it. */
const serveAnswer = () => json(answer);
let respond: (url: string) => Response = serveAnswer;
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  localStorage: dom.localStorage,
  fetch: (url: unknown) => Promise.resolve(respond(String(url))),
});

const { CheckStep, resetTime } = await import("./CheckStep");

type CapturedRun = { cleanup: { done: boolean; problems: string[] } } & Record<string, unknown>;
const runOf = (state: string, rows: unknown[]): { answer: { runtime: typeof RUNTIME; run: CapturedRun } } => ({
  answer: {
    runtime: RUNTIME,
    run: { id: "run00004", state, startedAt: "2026-09-20T10:00:00.000Z", finishedAt: "2026-09-20T10:01:30.000Z", runtime: RUNTIME, rows, cleanup: { done: true, problems: [] }, version: "0.0.0" },
  },
});
const fail = (code: string, extra: Record<string, unknown> = {}) => ({ code, params: { engine: "Claude", bin: "claude" }, detail: "d", agentPath: null, accountId: null, ...extra });

afterAll(async () => { await unmount(); void dom.happyDOM.close(); });
afterEach(() => { respond = serveAnswer; });

let ownsPrimary: boolean | null = null;
/* One step at a time: a step left mounted keeps its own 1-second poll running
   into the next test, and a test that counts requests would count those too. */
let mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement } | null = null;

async function unmount(): Promise<void> {
  const previous = mounted;
  if (!previous) return;
  mounted = null;
  await act(async () => { previous.root.unmount(); });
  previous.host.remove();
}

async function render(): Promise<HTMLElement> {
  await unmount();
  ownsPrimary = null;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => {
    root.render(<CheckStep noEngine={false} onGoEngines={() => {}} onLeave={() => {}} onSkip={() => {}} onOwnsPrimary={(owns) => { ownsPrimary = owns; }} />);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  return host;
}

test("before a run the lead names the model and every row waits", async () => {
  answer = { runtime: RUNTIME, run: null };
  const host = await render();
  expect(host.querySelector("[data-health-lead]")?.textContent).toContain("Haiku at low effort");
  expect(Array.from(host.querySelectorAll<HTMLElement>("[data-health-row]")).map((el) => el.dataset.healthState)).toEqual(["waiting", "waiting", "waiting", "waiting", "waiting"]);
  expect(host.querySelector("[data-health-start]")).not.toBeNull();
  expect(host.querySelector("[data-health-skip]")).not.toBeNull();
});

test("a failed wake opens in place and the footer names the row it stopped at", async () => {
  answer = {
    runtime: RUNTIME,
    run: {
      id: "run00003",
      state: "failed",
      startedAt: "2026-09-20T10:00:00.000Z",
      finishedAt: "2026-09-20T10:01:30.000Z",
      runtime: RUNTIME,
      rows: [
        row("spawn", "passed"),
        row("delivery", "passed"),
        row("report", "passed"),
        row("wake", "failed", { code: "WAKE_NOT_OWED", params: {}, detail: "verdict quiet: nothing owed", agentPath: null, accountId: null }),
        row("filing", "waiting"),
      ],
      cleanup: { done: true, problems: [] },
      version: "0.0.0",
    },
  };
  const host = await render();
  const failure = host.querySelector<HTMLElement>("[data-health-failure]");
  expect(failure?.dataset.healthFailure).toBe("WAKE_NOT_OWED");
  expect(failure?.textContent).toContain("filed under different projects");
  expect(host.querySelector<HTMLElement>("[data-health-action]")?.dataset.healthAction).toBe("copy");
  expect(host.querySelector<HTMLElement>('[data-health-row="filing"]')?.dataset.healthState).toBe("waiting");
  expect(host.querySelector("[data-health-summary=failed]")?.textContent).toContain("“The orchestrator is woken”");
  /* Its remedy is a bug report, so the footer does not tell the user to fix it. */
  expect(host.querySelector("[data-health-summary=failed]")?.textContent).toBe("The check stopped at “The orchestrator is woken”. The rows before it passed.");
  expect(host.querySelector("[data-health-skip]")).toBeNull();
  /* The state word carries the danger colour with the glyph, not muted grey. */
  expect(host.querySelector<HTMLElement>('[data-health-row="wake"] span.font-semibold')?.className).toContain("text-danger");
});

test("a failure the user can fix keeps the footer that asks for the fix", async () => {
  answer = runOf("failed", [row("spawn", "passed"), row("delivery", "passed"), row("report", "failed", fail("MCP_UNREACHABLE")), row("wake", "waiting"), row("filing", "waiting")]).answer;
  const host = await render();
  expect(host.querySelector("[data-health-summary=failed]")?.textContent).toContain("Fix that, then run it again");
});

test("no orchestrator yet: the note sits under the label on a phone and the run still passes", async () => {
  const rows = ["spawn", "delivery", "report", "wake"].map((id) => row(id, "passed"));
  answer = runOf("passed", [...rows, { ...row("filing", "skipped"), note: "no-seat" }]).answer;
  const host = await render();
  const note = host.querySelector<HTMLElement>("[data-health-note]");
  expect(note?.textContent).toBe("No orchestrator yet.");
  expect(note?.className).toContain("max-sm:w-full");
  expect(host.querySelector("[data-health-summary=passed]")?.textContent).toBe("Everything works on this machine.");
});

test("while the check runs nothing is filled: Stop is bordered and the footer steps back", async () => {
  answer = runOf("running", [row("spawn", "passed"), row("delivery", "running"), row("report", "waiting"), row("wake", "waiting"), row("filing", "waiting")]).answer;
  const host = await render();
  expect(host.querySelector("[data-health-start]")).toBeNull();
  expect(host.querySelector<HTMLElement>("[data-health-stop]")?.className).not.toContain("bg-accent");
  expect(ownsPrimary).toBe(true);
});

test("a cleanup that could not finish says what the Viewer does next", async () => {
  const passed = runOf("passed", ["spawn", "delivery", "report", "wake", "filing"].map((id) => row(id, "passed"))).answer;
  passed.run.cleanup = { done: true, problems: ["worktree: device or resource busy"] };
  answer = passed;
  const host = await render();
  const line = host.querySelector("[data-health-cleanup-problem]")?.textContent ?? "";
  expect(line).toContain("worktree: device or resource busy");
  expect(line).toContain("the next time this check opens or runs");
});

test("a spawn timeout with no agent to open ends at the terminal check and the bug report, as code without backticks", async () => {
  answer = runOf("failed", [row("spawn", "failed", fail("SPAWN_TIMEOUT")), row("delivery", "waiting"), row("report", "waiting"), row("wake", "waiting"), row("filing", "waiting")]).answer;
  const host = await render();
  const failure = host.querySelector<HTMLElement>("[data-health-failure]")!;
  expect(failure.textContent).toContain("copy the details into a bug report");
  expect(failure.textContent).not.toContain("open the agent");
  expect(failure.textContent).not.toContain("`");
  expect(failure.querySelector("code")?.textContent).toBe("claude --version");
  /* Both branches of the terminal check are closed. */
  expect(failure.textContent).toContain("If it does not, reinstall it");
  expect(host.querySelector<HTMLElement>("[data-health-action]")?.dataset.healthAction).toBe("agent");
  expect(host.querySelector<HTMLElement>("[data-health-action]")?.textContent).toBe("Copy details");
  /* The first row has no rows before it. */
  expect(host.querySelector("[data-health-summary=failed]")?.textContent).not.toContain("rows before it");
});

test("a spawn timeout with a transcript names the agent beside the button that opens it", async () => {
  answer = runOf("failed", [row("spawn", "failed", fail("SPAWN_TIMEOUT", { agentPath: "/scratch/agent.jsonl" })), row("delivery", "waiting"), row("report", "waiting"), row("wake", "waiting"), row("filing", "waiting")]).answer;
  const host = await render();
  expect(host.querySelector("[data-health-failure]")?.textContent).toContain("open the agent's card");
  expect(host.querySelector<HTMLElement>("[data-health-action]")?.textContent).toBe("Open the agent");
});

test("a turned-off tick offers only the details, since the fix is a local setting", async () => {
  answer = runOf("failed", [row("spawn", "passed"), row("delivery", "passed"), row("report", "passed"), row("wake", "failed", fail("TICK_OFF")), row("filing", "waiting")]).answer;
  const host = await render();
  expect(host.querySelector("[data-health-action]")).toBeNull();
  expect(host.querySelector("[data-health-failure]")?.textContent).toContain("Show details");
});

test("after Stop the rows that never ran read as not run", async () => {
  answer = runOf("stopped", [row("spawn", "passed"), row("delivery", "waiting"), row("report", "waiting"), row("wake", "waiting"), row("filing", "waiting")]).answer;
  const host = await render();
  expect(Array.from(host.querySelectorAll<HTMLElement>("[data-health-row]")).map((el) => el.dataset.healthState)).toEqual(["passed", "notRun", "notRun", "notRun", "notRun"]);
  expect(host.textContent).toContain("not run");
  expect(host.textContent).not.toContain("waiting");
});

test("after a pass, running it again is the secondary action", async () => {
  answer = runOf("passed", ["spawn", "delivery", "report", "wake", "filing"].map((id) => row(id, "passed"))).answer;
  const host = await render();
  expect(host.querySelector<HTMLElement>("[data-health-start]")?.className).not.toContain("bg-accent");
  expect(ownsPrimary).toBe(false);
});

test("after a failure, running it again is the one accent action and the footer steps back", async () => {
  answer = runOf("failed", [row("spawn", "passed"), row("delivery", "passed"), row("report", "passed"), row("wake", "failed", fail("TICK_OFF")), row("filing", "waiting")]).answer;
  const host = await render();
  expect(host.querySelector<HTMLElement>("[data-health-start]")?.className).toContain("bg-accent");
  expect(ownsPrimary).toBe(true);
});

test("a Viewer that forgot the run stops polling and offers the check again", async () => {
  /* The restart this slice exists to survive: the process forgets the run, so
     `?run=<id>` answers 404 for ever. The step used to keep the stale running
     answer, spin its loader and poll that 404 once a second until a reload. */
  const running = runOf("running", [row("spawn", "passed"), row("delivery", "running"), row("report", "waiting"), row("wake", "waiting"), row("filing", "waiting")]).answer;
  running.run.cleanup = { done: false, problems: [] };
  let namedReads = 0;
  let restarted = false;
  respond = (url) => {
    if (!url.includes("run=")) return json(restarted ? { runtime: RUNTIME, run: null } : running);
    namedReads += 1;
    restarted = true;
    return json({ error: "no such health check run" }, 404);
  };
  const host = await render();
  expect(host.querySelector<HTMLElement>("[data-health-check]")?.dataset.healthCheck).toBe("running");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_200)); });
  expect(namedReads).toBe(1);
  expect(host.querySelector<HTMLElement>("[data-health-check]")?.dataset.healthCheck).toBe("idle");
  expect(host.querySelector("[data-health-stop]")).toBeNull();
  expect(host.querySelector("[data-health-start]")?.textContent).toBe("Run the check");
  /* And the poll is gone, not merely quiet for one tick. */
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_200)); });
  expect(namedReads).toBe(1);
});

test("a poll that simply fails keeps the run and keeps polling", async () => {
  const running = runOf("running", [row("spawn", "passed"), row("delivery", "running"), row("report", "waiting"), row("wake", "waiting"), row("filing", "waiting")]).answer;
  running.run.cleanup = { done: false, problems: [] };
  let namedReads = 0;
  respond = (url) => {
    if (!url.includes("run=")) return json(running);
    namedReads += 1;
    /* A transient failure, not a run the server has forgotten. */
    return json({ error: "upstream unavailable" }, 503);
  };
  const host = await render();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_200)); });
  expect(namedReads).toBeGreaterThan(1);
  expect(host.querySelector<HTMLElement>("[data-health-check]")?.dataset.healthCheck).toBe("running");
});

test("a refused start is written in the interface language when the step has a sentence for it", async () => {
  answer = { runtime: RUNTIME, run: null };
  const host = await render();
  /* The server refuses because no engine is connected any more. */
  respond = () => json({ error: "Connect an engine first: no engine can start an agent on this machine.", code: "NO_ENGINE" }, 409);
  await act(async () => { host.querySelector<HTMLElement>("[data-health-start]")!.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(host.querySelector("[data-health-start-failed]")?.textContent).toBe("Connect an engine first (step 1).");

  /* A refusal it has no sentence for quotes the server instead of swallowing it. */
  respond = () => json({ error: "the check is already running elsewhere" }, 409);
  await act(async () => { host.querySelector<HTMLElement>("[data-health-start]")!.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(host.querySelector("[data-health-start-failed]")?.textContent).toBe("Could not start the check: the check is already running elsewhere");
});

test("the reset time follows the interface language, date and hour:minute", () => {
  const iso = "2100-01-02T17:00:00.000Z";
  expect(resetTime(iso, "en")).not.toMatch(/:\d\d:\d\d/);
  expect(resetTime(iso, "uk")).not.toBe(resetTime(iso, "en"));
  expect(resetTime(iso, "uk")).toContain("2100");
  expect(resetTime(undefined, "en")).toBe("—");
});
