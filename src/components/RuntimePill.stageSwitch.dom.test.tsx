import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import { resetEngineAccountsStoresForTests } from "@/hooks/useEngineAccounts";
import { applyPipelineSnapshot, resetFilesClientCacheForTests } from "@/hooks/useFiles";
import { resetPickedAccountsForTests } from "@/lib/accounts/intendedAccount";
import { setLocale } from "@/lib/i18n";
import type { Pipeline, PipelineRuntimeSwitch } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { RuntimePill } from "./RuntimePill";
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
(dom as unknown as { matchMedia(query: string): unknown }).matchMedia = (query: string) => ({
  matches: true,
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
        codex: { active: null, accounts: [], migration: null, autoBalance: null },
      });
    }
    if (url === "/api/pipelines/p-stage") return answerPatch();
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

async function openSheet(): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<><TaskToastHost /><RuntimePill file={file} surface="structured" /></>);
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
  await act(async () => {
    (host.querySelector("[data-runtime-pill]") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 5));
  });
  for (let attempt = 0; attempt < 40 && document.querySelectorAll("[data-runtime-sheet-account]").length < 2; attempt += 1) {
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

test("a model chosen on a running stage continues the attempt on it through the pipeline", async () => {
  await publish(pipeline());
  answerPatch = () => json({ ok: true, pipeline: pipeline({ record: {} }) });
  const { host, root } = await openSheet();
  await choose("Opus 5.5");

  expect(writes()).toEqual([{ url: "/api/pipelines/p-stage", method: "PATCH", body: { action: "override-stage", stageId: "build", applyNow: true, model: "opus", effort: "high" } }]);
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

  expect(writes().map((call) => call.body)).toEqual([{ action: "override-stage", stageId: "build", applyNow: true, model: "fable", effort: "high", account: "acct-b" }]);
  expect(calls.some((call) => call.url === "/api/tmux")).toBe(false);
  expect(accountLine()).toBe("runs on Account A · next on Account B");

  await publish(pipeline({ record: { ...toB, phase: "rolled-back", outcome: "target account is no longer allowed" } }));
  expect(accountLine()).toBe("Switch to Fable · Account B did not complete. The stage continues on Fable · Account A. The selected account is no longer allowed for this project.");
  expect(document.querySelector('[data-runtime-sheet-account="acct-b"]')?.getAttribute("data-runtime-account-next")).toBeNull();
  await act(async () => root.unmount());
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
  await choose("Opus 5.5");

  expect(writes()).toEqual([]);
  expect(calls.find((call) => call.url === "/api/tmux")?.body).toMatchObject({ action: "reconfigure", model: "opus" });
  await act(async () => root.unmount());
});
