import { afterAll, expect, test } from "bun:test";
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
  fetch: () => Promise.resolve(new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } })),
});

const { CheckStep, resetTime } = await import("./CheckStep");

const runOf = (state: string, rows: unknown[]) => ({
  answer: {
    runtime: RUNTIME,
    run: { id: "run00004", state, startedAt: "2026-09-20T10:00:00.000Z", finishedAt: "2026-09-20T10:01:30.000Z", runtime: RUNTIME, rows, cleanup: { done: true, problems: [] }, version: "0.0.0" },
  },
});
const fail = (code: string, extra: Record<string, unknown> = {}) => ({ code, params: { engine: "Claude", bin: "claude" }, detail: "d", agentPath: null, accountId: null, ...extra });

afterAll(() => { void dom.happyDOM.close(); });

async function render(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<CheckStep noEngine={false} onGoEngines={() => {}} onLeave={() => {}} onSkip={() => {}} />);
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
  expect(host.querySelector("[data-health-skip]")).toBeNull();
});

test("a spawn timeout with no agent to open ends at the terminal check and the bug report, as code without backticks", async () => {
  answer = runOf("failed", [row("spawn", "failed", fail("SPAWN_TIMEOUT")), row("delivery", "waiting"), row("report", "waiting"), row("wake", "waiting"), row("filing", "waiting")]).answer;
  const host = await render();
  const failure = host.querySelector<HTMLElement>("[data-health-failure]")!;
  expect(failure.textContent).toContain("copy the details into a bug report");
  expect(failure.textContent).not.toContain("open the agent");
  expect(failure.textContent).not.toContain("`");
  expect(failure.querySelector("code")?.textContent).toBe("claude --version");
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
});

test("the reset time follows the interface language, date and hour:minute", () => {
  const iso = "2100-01-02T17:00:00.000Z";
  expect(resetTime(iso, "en")).not.toMatch(/:\d\d:\d\d/);
  expect(resetTime(iso, "uk")).not.toBe(resetTime(iso, "en"));
  expect(resetTime(iso, "uk")).toContain("2100");
  expect(resetTime(undefined, "en")).toBe("—");
});
