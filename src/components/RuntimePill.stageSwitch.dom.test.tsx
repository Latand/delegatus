import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import { resetEngineAccountsStoresForTests } from "@/hooks/useEngineAccounts";
import { applyPipelineSnapshot, resetFilesClientCacheForTests } from "@/hooks/useFiles";
import { resetPickedAccountsForTests } from "@/lib/accounts/intendedAccount";
import { setLocale, translate } from "@/lib/i18n";
import type { Pipeline, PipelineRuntimeSwitch } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { RuntimePill } from "./RuntimePill";
import type { RuntimeSession } from "./runtime/runtimeModel";
import { stageRunOf, switchFailureText } from "./stageRuntimeSwitch";
import { TaskToastHost } from "./tasks/taskToast";

/*
 * The conversation of a pipeline stage's running attempt. A choice in the
 * composer's runtime pill goes to the pipeline as `override-stage` with
 * `applyNow`, so the same attempt continues on it; the conversation's own
 * reconfigure is never sent. The switch record the pipeline keeps is what the
 * pill shows: under way, taken, or not taken with the reason in words.
 *
 * Account ids and labels are invented.
 */

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
  PointerEvent: dom.MouseEvent,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
});
let phone = true;
(dom as unknown as { matchMedia(query: string): unknown }).matchMedia = (query: string) => ({
  matches: phone,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

const ACCOUNTS = [
  { id: "acct-a", label: "Account A", kind: "managed", authPresent: true, authHealth: "authenticated", loginPending: false, loginState: "authenticated", deviceAuth: null },
  { id: "acct-b", label: "Account B", kind: "managed", authPresent: true, authHealth: "authenticated", loginPending: false, loginState: "authenticated", deviceAuth: null },
];

const file = {
  path: "/state/accounts/claude/acct-a/projects/viewer/stage.jsonl",
  root: "claude-projects", name: "stage.jsonl", project: "viewer",
  title: "Build the upload form", engine: "claude", kind: "session", fmt: "claude",
  parent: null, mtime: 1, size: 1, activity: "live", proc: "running", pid: 11,
  conversationId: "conversation_stage", model: "fable", effort: "high", fast: false,
  pendingQuestion: null, waitingInput: null,
  durableLineage: {
    kind: "spawn", role: "builder", parentConversationId: null, reviewsConversationId: null,
    memberships: [{ kind: "pipeline", containerId: "p-stage", role: "builder", slot: "build", stageId: "build", stageOrder: 0, round: null, parentConversationId: null }],
  },
} as unknown as FileEntry;

function pipeline(change: { state?: string; attemptState?: string; conversationId?: string; record?: Partial<PipelineRuntimeSwitch> } = {}): Pipeline {
  const seat = { engine: "claude", model: "fable", effort: "high", serviceTier: null, accountId: "acct-a" };
  const record = change.record ? {
    id: "p-stage:build:1:1", seq: 1, requestedAt: "2026-10-05T10:00:00.000Z", actor: { kind: "operator" }, mode: "fork",
    from: { ...seat, conversationId: "conversation_stage", launchId: null, sessionId: "session-stage", agentPath: file.path },
    to: { ...seat, model: "opus", accountPinned: false },
    phase: "requested",
    ...change.record,
  } : null;
  return {
    id: "p-stage", project: "viewer", state: change.state ?? "running",
    stages: [{ id: "build", kind: "run", effectiveRole: { engine: "claude", model: "fable", effort: "high" } }],
    runs: [{ stageId: "build", attempts: [{
      n: 1, state: change.attemptState ?? "running", conversationId: change.conversationId ?? "conversation_stage",
      agentPath: file.path, sessionId: "session-stage", effectiveRole: { engine: "claude", model: "fable", effort: "high" },
      ...(record ? { runtimeSwitches: [record] } : {}),
    }] }],
  } as unknown as Pipeline;
}

const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
const realFetch = globalThis.fetch;
/** What the pipeline answers a write with. */
let answerPatch: () => Response = () => new Response("{}", { status: 500 });

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  phone = true;
  setLocale("en");
  calls.length = 0;
  resetEngineAccountsStoresForTests();
  resetPickedAccountsForTests();
  resetFilesClientCacheForTests();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : (input as URL).toString());
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ url, method: init?.method ?? "GET", body });
    if (url === "/api/accounts") {
      return json({
        claude: { active: "acct-a", accounts: ACCOUNTS, migration: null, autoBalance: null },
        codex: { active: "acct-a", accounts: ACCOUNTS, migration: null, autoBalance: null },
      });
    }
    if (url === "/api/pipelines/p-stage") return answerPatch();
    if (url === "/api/tmux") return json({ ok: true, operationId: "op-parked" });
    return json({ ok: true });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  resetFilesClientCacheForTests();
});

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
}

async function publish(record: Pipeline): Promise<void> {
  await act(async () => { applyPipelineSnapshot(record, true); });
  await settle();
}

async function openSheet(shownFile: FileEntry = file, mobile = true): Promise<{ host: HTMLElement; root: Root }> {
  phone = mobile;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<><TaskToastHost /><RuntimePill file={shownFile} surface="structured" /></>);
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
  await act(async () => {
    (host.querySelector("[data-runtime-pill]") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 5));
  });
  for (let attempt = 0; mobile && attempt < 40 && document.querySelectorAll("[data-runtime-sheet-account]").length < 2; attempt += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
  return { host, root };
}

async function choose(label: string): Promise<void> {
  const row = [...document.querySelectorAll("[data-runtime-sheet-row]")].find((item) => item.textContent === label) as HTMLButtonElement;
  await act(async () => { row.click(); });
  await settle();
}

const writes = () => calls.filter((call) => call.method === "PATCH");
const pill = (host: HTMLElement) => host.querySelector("[data-runtime-pill]") as HTMLButtonElement;
const accountLine = () => document.querySelector("[data-runtime-sheet-account-current]")!.textContent;

for (const locale of ["en", "uk"] as const) {
  for (const mobile of [false, true]) {
    test(`selector accessible names explain when the change takes effect: ${locale}, ${mobile ? "phone" : "desktop"}`, async () => {
      setLocale(locale);
      let ordinaryControls = 0;
      for (const running of [false, true]) {
        if (running) await publish(pipeline());
        const { host, root } = await openSheet(running ? file : { ...file, durableLineage: undefined }, mobile);
        try {
          const panel = document.querySelector(mobile ? '[role="dialog"]' : '[role="menu"]')!;
          const controls = panel.querySelectorAll("button").length + host.querySelectorAll("button").length;
          if (!running) ordinaryControls = controls;
          else expect(controls).toBe(ordinaryControls);
          const wording = translate(locale, running ? "mobile2.composer.stageNow" : "composer.runtimePill");
          expect(pill(host).getAttribute("aria-label")).toContain(wording);
          expect(panel.getAttribute("aria-label")).toContain(wording);
          if (running) {
            expect(pill(host).getAttribute("aria-label")).not.toContain(translate(locale, "composer.runtimePill"));
            expect(panel.getAttribute("aria-label")).not.toContain(translate(locale, "composer.runtimePill"));
          }
        } finally {
          await act(async () => root.unmount());
        }
      }
    });
  }
}

for (const edit of ["model", "effort", "account", "speed"] as const) {
  test(`the running-stage selector preserves displayed Ultrafast on a ${edit} edit`, async () => {
    const codexFile = { ...file, engine: "codex", fmt: "codex", root: "codex-sessions", path: "/state/accounts/codex/acct-a/sessions/stage.jsonl", model: "gpt-6-astra", effort: "high", fast: true, serviceTier: "ultrafast" } as FileEntry;
    const lane = pipeline();
    lane.stages[0]!.effectiveRole = { ...lane.stages[0]!.effectiveRole, engine: "codex", model: "gpt-6-astra" };
    lane.runs[0]!.attempts[0]!.effectiveRole = lane.stages[0]!.effectiveRole;
    await publish(lane);
    answerPatch = () => json({ ok: true, pipeline: lane });
    const { host, root } = await openSheet(codexFile);
    try {
      expect(pill(host).getAttribute("aria-label")).toContain("Ultrafast");
      if (edit === "account") {
        await act(async () => { (document.querySelector('[data-runtime-sheet-account="acct-b"]') as HTMLButtonElement).click(); });
        await settle();
      } else {
        await choose(edit === "model" ? "GPT-6.1-Sol" : edit === "effort" ? "xhigh" : "Standard");
      }
      expect(writes()).toHaveLength(1);
      expect(writes()[0]!.body).toMatchObject({ applyNow: true, serviceTier: edit === "speed" ? "standard" : "ultrafast" });
      if (edit === "account") expect(writes()[0]!.body?.account).toBe("acct-b");
    } finally {
      await act(async () => root.unmount());
    }
  });
}

test("a model chosen on a running stage continues the attempt on it through the pipeline", async () => {
  await publish(pipeline());
  answerPatch = () => json({ ok: true, pipeline: pipeline({ record: {} }) });
  const { host, root } = await openSheet();
  await choose("Opus 5.5");

  expect(writes()).toEqual([{ url: "/api/pipelines/p-stage", method: "PATCH", body: { action: "override-stage", stageId: "build", applyNow: true, expectedAttempt: 1, expectedConversationId: "conversation_stage", engine: "claude", model: "opus", effort: "high", serviceTier: null } }]);
  expect(calls.some((call) => call.url === "/api/tmux")).toBe(false);
  expect(pill(host).textContent).toContain("Opus 5.5");
  expect(pill(host).getAttribute("aria-busy")).toBe("true");
  expect(host.querySelector("[data-runtime-switch-pending]")).not.toBeNull();

  await publish(pipeline({ record: { phase: "committed" } }));
  expect(pill(host).getAttribute("aria-busy")).toBeNull();
  expect(host.querySelector("[data-runtime-pill-error]")).toBeNull();
  expect(host.textContent).toContain("Conversation settings applied");
  await act(async () => root.unmount());
});

test("a switch that rolled back says so by display names and returns the face to what runs", async () => {
  await publish(pipeline());
  answerPatch = () => json({ ok: true, pipeline: pipeline({ record: {} }) });
  const { host, root } = await openSheet();
  await choose("Opus 5.5");
  await publish(pipeline({ record: { phase: "rolled-back", outcome: "runtime switch failed; continued on previous runtime" } }));

  const words = "Switch to Opus 5.5 did not complete. The stage continues on Fable. The new runtime could not continue the attempt.";
  expect(host.querySelector("[data-runtime-pill-error]")?.textContent).toBe(words);
  expect(pill(host).getAttribute("title")).toBe(words);
  expect(accountLine()).toBe(words);
  expect(host.textContent).not.toContain("claude ·");
  expect(pill(host).textContent).toContain("Fable");
  expect(pill(host).getAttribute("aria-busy")).toBeNull();

  setLocale("uk");
  await publish(pipeline({ record: { phase: "failed", outcome: "stage stopped by kill during runtime switch" } }));
  expect(host.querySelector("[data-runtime-pill-error]")?.textContent)
    .toBe("Перехід на Opus 5.5 не вдався. Агент зупинився на Fable. Етап зупинили під час переходу.");
  await act(async () => root.unmount());
});

test("an account picked on a running stage moves the attempt now, and a rollback names both accounts", async () => {
  await publish(pipeline());
  const toB = { to: { engine: "claude", model: "fable", effort: "high", serviceTier: null, accountId: "acct-b", accountPinned: true } } as Partial<PipelineRuntimeSwitch>;
  answerPatch = () => json({ ok: true, pipeline: pipeline({ record: toB }) });
  const { root } = await openSheet();
  await act(async () => { (document.querySelector('[data-runtime-sheet-account="acct-b"]') as HTMLButtonElement).click(); });
  await settle();

  expect(writes().map((call) => call.body)).toEqual([{ action: "override-stage", stageId: "build", applyNow: true, expectedAttempt: 1, expectedConversationId: "conversation_stage", engine: "claude", model: "fable", effort: "high", serviceTier: null, account: "acct-b" }]);
  expect(calls.some((call) => call.url === "/api/tmux")).toBe(false);
  expect(accountLine()).toBe("runs on Account A · moving to Account B");

  await publish(pipeline({ record: { ...toB, phase: "rolled-back", outcome: "target account is no longer allowed" } }));
  expect(accountLine()).toBe("Switch to Fable · Account B did not complete. The stage continues on Fable · Account A. The selected account is no longer allowed for this project.");
  expect(document.querySelector('[data-runtime-sheet-account="acct-b"]')?.getAttribute("data-runtime-account-next")).toBeNull();
  await act(async () => root.unmount());
});

test("a switch refused before the turn was cut says the stage stays, and only a kill says the agent stopped", async () => {
  await publish(pipeline());
  answerPatch = () => json({ ok: true, pipeline: pipeline({ record: {} }) });
  const { host, root } = await openSheet();
  await choose("Opus 5.5");
  const shown = () => host.querySelector("[data-runtime-pill-error]")?.textContent;

  await publish(pipeline({ record: { phase: "failed", outcome: "target engine is unavailable; stage stays on its runtime" } }));
  expect(shown()).toBe("Did not switch to Opus 5.5. The stage stays on Fable. The selected engine is unavailable.");
  expect(shown()).not.toContain("stopped");
  await act(async () => root.unmount());

  /* The same words for every outcome, read off the record alone. */
  const words = (locale: "en" | "uk", change: Parameters<typeof pipeline>[0]) => {
    const record = pipeline(change);
    return switchFailureText((key, params) => translate(locale, key, params), stageRunOf(file, record)!, { account: (id) => id, effort: (tier) => tier });
  };
  expect(words("uk", { record: { phase: "failed", outcome: "runtime switch was not started: another delivery is pending" } }))
    .toBe("Перехід на Opus 5.5 не відбувся. Етап лишається на Fable. Попередній хід ще завершується.");
  expect(words("uk", { record: { phase: "failed", outcome: "target account is no longer allowed; stage stays on its runtime" } }))
    .toBe("Перехід на Opus 5.5 не відбувся. Етап лишається на Fable. Цей акаунт більше не дозволений для проєкту.");
  expect(words("en", { record: { phase: "failed", outcome: "could not stop the running agent: host busy" } }))
    .toBe("Did not switch to Opus 5.5. The stage stays on Fable. The running agent could not be stopped.");
  expect(words("en", { state: "needs_decision", attemptState: "needs_decision", record: { phase: "cutting", outcome: "runtime switch stop remains unconfirmed: host busy" } }))
    .toBe("Switch to Opus 5.5 is waiting for your decision. The agent has not been confirmed stopped yet.");
  expect(words("uk", { state: "needs_decision", attemptState: "needs_decision", record: { phase: "cutting", outcome: "runtime switch stop remains unconfirmed: host busy" } }))
    .toBe("Перехід на Opus 5.5 чекає на ваше рішення. Ще немає підтвердження, що агента зупинено.");
  expect(words("en", { state: "needs_decision", attemptState: "needs_decision", record: { phase: "switching", outcome: "runtime switch rollback refused: source account is no longer allowed" } }))
    .toBe("Switch to Opus 5.5 is waiting for your decision. The previous account is no longer allowed for this project.");
  expect(words("en", { state: "needs_decision", attemptState: "needs_decision", record: { phase: "failed", outcome: "stage stopped by kill during runtime switch" } }))
    .toBe("Switch to Opus 5.5 failed. The agent stopped on Fable. The stage was stopped during the switch.");
  expect(words("en", { record: { phase: "rolled-back", outcome: "provider said something of its own" } }))
    .toBe("Switch to Opus 5.5 did not complete. The stage continues on Fable.");
  expect(words("uk", { record: { phase: "rolled-back", outcome: "target account is no longer allowed on this project; the stage stays on its runtime" } }))
    .toBe("Перехід на Opus 5.5 не завершився. Етап продовжує на Fable. Цей акаунт більше не дозволений для проєкту.");
});

test("the sheet of a running stage says the change applies now, in both languages", async () => {
  await publish(pipeline());
  const { root } = await openSheet();
  const header = () => document.querySelector("[data-runtime-sheet-header]")!.textContent;
  expect(header()).toContain("Running stage");
  expect(header()).toContain("Applies now: the turn stops, the attempt goes on.");
  expect(header()).not.toContain("ext message");
  expect(document.querySelector('[data-runtime-sheet-account="acct-a"]')?.textContent).toContain("this attempt");
  expect(document.querySelector('[data-runtime-sheet-account="acct-b"]')?.getAttribute("aria-label")).toBe("Continue this attempt on Account B now");
  expect(document.querySelector("[data-runtime-sheet]")!.textContent).not.toContain("next message");
  await act(async () => root.unmount());

  setLocale("uk");
  const second = await openSheet();
  expect(header()).toContain("Етап у роботі");
  expect(header()).toContain("Діє одразу: хід зупиняється, спроба триває.");
  expect(document.querySelector("[data-runtime-sheet]")!.textContent).not.toContain("аступне повідомлення");
  expect(document.querySelector('[data-runtime-sheet-account="acct-a"]')?.textContent).toContain("ця спроба");
  await act(async () => second.root.unmount());
});

test("a refusal from the pipeline is the pill's error in words, and the face stays on what runs", async () => {
  await publish(pipeline());
  answerPatch = () => json({ error: "another runtime switch is in progress", code: "RUNTIME_SWITCH_IN_PROGRESS" }, 409);
  const { host, root } = await openSheet();
  await choose("Opus 5.5");

  expect(host.querySelector("[data-runtime-pill-error]")?.textContent).toBe("A model or account change is already under way.");
  expect(pill(host).textContent).toContain("Fable");
  expect(host.querySelector(".border-l-danger")?.textContent).toContain("A model or account change is already under way.");
  await act(async () => root.unmount());
});

test("a switch that was over before the page opened is shown without being announced again", async () => {
  await publish(pipeline({ record: { phase: "rolled-back", outcome: "runtime switch failed; continued on previous runtime" } }));
  const { host, root } = await openSheet();
  expect(host.querySelector("[data-runtime-pill-error]")?.textContent).toContain("Switch to Opus 5.5 did not complete.");
  expect(host.querySelector(".border-l-danger")).toBeNull();
  await act(async () => root.unmount());
});

test("a conversation that is no longer the stage's agent keeps its own reconfigure", async () => {
  await publish(pipeline({ conversationId: "conversation_successor" }));
  const { root } = await openSheet();
  expect(document.querySelector("[data-runtime-sheet-header]")!.textContent).toContain("Applies to your next message");
  expect(document.querySelector('[data-runtime-sheet-account="acct-a"]')?.textContent).toContain("next message");
  await choose("Opus 5.5");

  expect(writes()).toEqual([]);
  expect(calls.find((call) => call.url === "/api/tmux")?.body).toMatchObject({ action: "reconfigure", model: "opus" });
  await act(async () => root.unmount());
});

/** The conversation's own session, carrying how its reconfigure `op-parked` ended. */
function settled(status: "applied" | "failed", reason?: string): RuntimeSession {
  return {
    conversationId: "conversation_stage",
    sessionKey: { engine: "claude", sessionId: "session-stage" },
    hostKind: "claude-broker", host: "hosted", turn: "idle", provenance: "structured",
    revision: 5, attentionIds: [],
    recentReceipts: [{
      operationId: "op-parked", idempotencyKey: "op-parked", conversationId: "conversation_stage",
      kind: "reconfigure", status, ...(reason ? { reason } : {}), at: "2026-10-05T10:00:00.000Z", revision: 5,
    }],
    accountId: "acct-a", parentConversationId: null, flowId: null, workflowId: null,
    cwd: "/repo", artifactPath: file.path,
    capabilities: { steer: true, structuredAttention: true },
    activeTurnId: null, pendingReconfigure: null, drift: null,
  };
}

test("a parked stage keeps the conversation's own reconfigure, and its failure is the pill's error", async () => {
  await publish(pipeline({ state: "needs_decision", attemptState: "needs_decision" }));
  const { host, root } = await openSheet();
  await choose("Opus 5.5");
  expect(writes()).toEqual([]);
  expect(calls.find((call) => call.url === "/api/tmux")?.body).toMatchObject({ action: "reconfigure", model: "opus" });
  expect(pill(host).textContent).toContain("Opus 5.5");

  await act(async () => {
    root.render(<><TaskToastHost /><RuntimePill file={file} surface="structured" runtimeSession={settled("failed", "The provider refused the model")} /></>);
    await new Promise((r) => setTimeout(r, 5));
  });
  await settle();
  expect(host.querySelector("[data-runtime-pill-error]")?.textContent).toBe("The provider refused the model");
  expect(host.querySelector(".border-l-danger")?.textContent).toContain("The provider refused the model");
  expect(pill(host).textContent).toContain("Fable");
  expect(pill(host).getAttribute("aria-busy")).toBeNull();
  await act(async () => root.unmount());
});

test("a parked stage's reconfigure that applied is announced like any conversation's", async () => {
  await publish(pipeline({ state: "needs_decision", attemptState: "needs_decision" }));
  const { host, root } = await openSheet();
  await choose("Opus 5.5");
  await act(async () => {
    root.render(<><TaskToastHost /><RuntimePill file={file} surface="structured" runtimeSession={settled("applied")} /></>);
    await new Promise((r) => setTimeout(r, 5));
  });
  await settle();
  expect(host.textContent).toContain("Conversation settings applied");
  expect(host.querySelector("[data-runtime-pill-error]")).toBeNull();
  expect(pill(host).textContent).toContain("Opus 5.5");
  expect(pill(host).getAttribute("aria-busy")).toBeNull();
  await act(async () => root.unmount());
});
