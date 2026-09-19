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

const { CheckStep } = await import("./CheckStep");

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
