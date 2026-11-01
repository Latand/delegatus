import { afterEach, expect, test } from "bun:test";
import { act, StrictMode } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import type { RuntimeSettingsCapability } from "@/lib/runtime/contracts";
import type { FileEntry } from "@/lib/types";

import { RuntimePill } from "./RuntimePill";
import { TaskToastHost } from "./tasks/taskToast";
import type { RuntimeSession } from "./runtime/runtimeModel";
import { resumeKey, sendRuntimeFrom } from "./runtimeProfile";
import { serviceTierRefusal } from "@/lib/accounts/codexServiceTiers";

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
  PointerEvent: dom.MouseEvent,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
});
let mobile = false;
const requests: Array<Record<string, unknown>> = [];
let copilotModelCatalogResponse: unknown = null;
/* The Codex tier catalog answer and the speed action's answer; null answers 404 and ok. */
type Answer = { status: number; body: unknown };
let codexCatalogAnswer: Answer | null = null;
let codexCatalogGate: Promise<void> | null = null;
const catalogReads: string[] = [];
const speedAnswers: Array<{ answer: Answer; gate?: Promise<void> }> = [];
/* Holds the reconfigure answer open while set. */
let reconfigureGate: Promise<void> | null = null;
const json = (answer: Answer) => new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  if (String(_input).includes("/api/accounts/copilot/models")) {
    return new Response(JSON.stringify(copilotModelCatalogResponse ?? { models: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (String(_input).includes("/api/accounts/codex/models")) {
    catalogReads.push(String(_input));
    if (codexCatalogGate) await codexCatalogGate;
    return json(codexCatalogAnswer ?? { status: 404, body: { error: "Codex account was not found in the requested pool" } });
  }
  const sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  requests.push(sent);
  if (sent.action === "speed") {
    const next = speedAnswers.shift();
    if (next?.gate) await next.gate;
    return json(next?.answer ?? { status: 200, body: { ok: true, operationId: "speed-ui", requestedTier: sent.serviceTier, appliedTier: sent.serviceTier, echoed: true } });
  }
  if (sent.action === "reconfigure" && reconfigureGate) await reconfigureGate;
  return new Response(JSON.stringify({
    ok: true,
    structured: true,
    operationId: "reconfigure-ui",
    receipt: { operationId: "reconfigure-ui", status: "queued" },
  }), { status: 202, headers: { "content-type": "application/json" } });
}) as typeof fetch;
(dom as unknown as { matchMedia(query: string): unknown }).matchMedia = (query: string) => ({
  matches: mobile,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

const codexFile: FileEntry = {
  path: "/codex.jsonl", root: "codex-sessions", name: "codex.jsonl", project: "viewer", title: "codex",
  engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1, size: 1, activity: "idle",
  proc: "running", pid: 10, conversationId: "conversation_runtime", model: "gpt-5.6-sol", effort: "high", fast: false,
  pendingQuestion: null, waitingInput: null,
};
const claudeFile: FileEntry = {
  ...codexFile,
  path: "/claude.jsonl", root: "claude-projects", name: "claude.jsonl", fmt: "claude",
  engine: "claude", conversationId: "conversation_claude", model: "sonnet", effort: "high",
};
function copilotFile(model: string, effort: string): FileEntry {
  return {
    ...codexFile,
    path: "/fixture/config/agent-log-viewer/accounts/copilot/copilot-fixture/session-state/session/events.jsonl",
    root: "copilot-sessions", name: "events.jsonl", fmt: "copilot", engine: "copilot",
    conversationId: "conversation_copilot", model, effort,
  };
}
const key = "llvAgentRuntime:conversation_runtime";
const copilotResumeKey = resumeKey(copilotFile("auto", "medium"));

const CODEX_STRUCTURED: RuntimeSettingsCapability = { perTurnEffort: true, perTurnModel: false };
const CLAUDE_STRUCTURED: RuntimeSettingsCapability = { perTurnEffort: false, perTurnModel: false };

function structuredSession(
  status: "applied" | "failed",
  reason: string | null = null,
): RuntimeSession {
  return {
    conversationId: "conversation_runtime",
    sessionKey: { engine: "codex", sessionId: "thread-runtime" },
    hostKind: "codex-app-server",
    host: "hosted",
    turn: "idle",
    provenance: "structured",
    revision: 2,
    attentionIds: [],
    recentReceipts: [{
      operationId: "reconfigure-ui",
      idempotencyKey: "reconfigure-ui",
      conversationId: "conversation_runtime",
      kind: "reconfigure",
      status,
      reason,
      at: "2026-07-19T12:00:00.000Z",
      revision: 2,
    }],
    accountId: "source",
    parentConversationId: null,
    flowId: null,
    workflowId: null,
    cwd: "/repo",
    artifactPath: codexFile.path,
    capabilities: { steer: true, structuredAttention: true, runtimeSettings: CODEX_STRUCTURED },
    activeTurnId: null,
    pendingReconfigure: null,
    drift: null,
  };
}

async function renderPill(node: React.ReactElement): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
    await new Promise((r) => setTimeout(r, 0));
  });
  return { host, root };
}

const click = async (el: Element) => {
  await act(async () => {
    el.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
    await new Promise((r) => setTimeout(r, 0));
  });
};

/* The runtime popover renders through a portal into the document the pill is in
   — the composer's box is bounded and scrolls its own content, and an in-flow
   popover was clipped by exactly that (#1629) — so its rows and its own root are
   looked for in the document rather than under the mount. */
const keydown = async (el: Element, key: string) => {
  await act(async () => {
    el.dispatchEvent(new dom.KeyboardEvent("keydown", { key, bubbles: true }) as unknown as Event);
    await new Promise((r) => setTimeout(r, 0));
  });
};

afterEach(() => {
  mobile = false;
  document.body.replaceChildren();
  localStorage.clear();
  requests.length = 0;
  copilotModelCatalogResponse = null;
  codexCatalogAnswer = null;
  codexCatalogGate = null;
  catalogReads.length = 0;
  speedAnswers.length = 0;
  reconfigureGate = null;
});

test("the pill face reads shortLabel · tier and opens a menu with the active tier checked", async () => {
  const { host, root } = await renderPill(
    <RuntimePill file={codexFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />,
  );
  const pill = host.querySelector("[data-runtime-pill]") as HTMLButtonElement;
  expect(pill.textContent).toContain("5.6-Sol · High");
  expect(pill.getAttribute("aria-haspopup")).toBe("menu");
  expect(pill.getAttribute("aria-expanded")).toBe("false");
  expect(pill.getAttribute("aria-label")).toContain("Model and reasoning — applies to your next message");
  expect(pill.getAttribute("aria-label")).toContain("GPT-5.6-Sol");

  await click(pill);
  expect(pill.getAttribute("aria-expanded")).toBe("true");
  const menu = host.ownerDocument.querySelector('[role="menu"][data-runtime-popover]')!;
  const tiers = [...menu.querySelectorAll('[data-runtime-row="tier"]')];
  // The sol scale: all six tiers, lowest first, standalone display names.
  expect(tiers.map((row) => row.textContent)).toEqual(["Light", "Medium", "High", "Extra High", "Max", "Ultra"]);
  const checked = tiers.filter((row) => row.getAttribute("aria-checked") === "true");
  expect(checked).toHaveLength(1);
  expect(checked[0]!.textContent).toBe("High");
  // No Apply button and no Full-access-shaped row anywhere (§13 anti-goals).
  expect(menu.textContent).not.toContain("Apply");
  expect(menu.textContent!.toLowerCase()).not.toContain("access");
  await act(async () => root.unmount());
});

test("selecting a tier persists the sparse profile, announces, and closes (auto-apply — no Apply step)", async () => {
  const { host, root } = await renderPill(
    <RuntimePill file={codexFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />,
  );
  const pill = host.querySelector("[data-runtime-pill]") as HTMLButtonElement;
  await click(pill);
  const ultra = [...host.ownerDocument.querySelectorAll('[data-runtime-row="tier"]')].find((row) => row.textContent === "Ultra")!;
  await click(ultra);
  // Only the explicitly selected field persists (finding 4).
  expect(JSON.parse(localStorage.getItem(key + ":profile")!)).toEqual({ effort: "ultra" });
  // Desktop popover closes on selection; the face re-reads the profile.
  expect(host.querySelector("[data-runtime-popover]")).toBeNull();
  expect(pill.textContent).toContain("5.6-Sol · Ultra");
  const status = host.querySelector("[data-runtime-pill-status]")!;
  expect(status.textContent).toBe("Next message: GPT-5.6-Sol · Ultra");
  expect(host.querySelector("[data-runtime-switch-pending]")?.textContent).toBe("switch pending");
  expect(requests.at(-1)).toMatchObject({ action: "reconfigure", model: "gpt-5.6-sol", effort: "ultra", fast: false });
  await act(async () => root.unmount());
});

test("Strict Mode emits one structured reconfigure request for one selection", async () => {
  const { host, root } = await renderPill(
    <StrictMode>
      <RuntimePill file={codexFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />
    </StrictMode>,
  );
  await click(host.querySelector("[data-runtime-pill]")!);
  const ultra = [...host.ownerDocument.querySelectorAll('[data-runtime-row="tier"]')]
    .find((row) => row.textContent === "Ultra")!;
  await click(ultra);

  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ action: "reconfigure", effort: "ultra" });
  await act(async () => root.unmount());
});

test("a failed structured reconfigure restores the browser profile before future sends and remount", async () => {
  const mounted = await renderPill(
    <RuntimePill file={codexFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />,
  );
  await click(mounted.host.querySelector("[data-runtime-pill]")!);
  const ultra = [...mounted.host.ownerDocument.querySelectorAll('[data-runtime-row="tier"]')]
    .find((row) => row.textContent === "Ultra")!;
  await click(ultra);
  expect(sendRuntimeFrom(codexFile)).toEqual({ effort: "ultra" });

  await act(async () => {
    mounted.root.render(
      <RuntimePill
        file={codexFile}
        surface="structured"
        runtimeSettings={CODEX_STRUCTURED}
        runtimeSession={structuredSession("failed", "replacement host failed")}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(sendRuntimeFrom(codexFile)).toBeUndefined();
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ model: "gpt-5.6-sol", effort: "high", fast: false });
  await act(async () => mounted.root.unmount());

  const remounted = await renderPill(
    <RuntimePill file={codexFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />,
  );
  expect(remounted.host.querySelector("[data-runtime-pill]")?.textContent).toContain("5.6-Sol · High");
  await act(async () => remounted.root.unmount());
});

test("a failed newest selection restores the last confirmed browser profile", async () => {
  localStorage.setItem(key, JSON.stringify({ model: "gpt-5.6-sol", effort: "medium", fast: false }));
  localStorage.setItem(key + ":profile", JSON.stringify({ effort: "medium" }));
  const mounted = await renderPill(
    <RuntimePill file={codexFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />,
  );
  await click(mounted.host.querySelector("[data-runtime-pill]")!);
  const ultra = [...mounted.host.ownerDocument.querySelectorAll('[data-runtime-row="tier"]')]
    .find((row) => row.textContent === "Ultra")!;
  await click(ultra);
  await click(mounted.host.querySelector("[data-runtime-pill]")!);
  const max = [...mounted.host.ownerDocument.querySelectorAll('[data-runtime-row="tier"]')]
    .find((row) => row.textContent === "Max")!;
  await click(max);

  await act(async () => {
    mounted.root.render(
      <RuntimePill
        file={codexFile}
        surface="structured"
        runtimeSettings={CODEX_STRUCTURED}
        runtimeSession={structuredSession("failed", "newest replacement failed")}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  /* The face, the restored draft and the send are all what the conversation
     runs (high): the stale medium the seat inherited was dropped at mount. */
  expect(sendRuntimeFrom(codexFile)).toBeUndefined();
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ model: "gpt-5.6-sol", effort: "high", fast: false });
  await act(async () => mounted.root.unmount());
});

test("remount transfers rollback ownership from pending A to durable B before B fails", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    requestCount += 1;
    if (requestCount === 1) {
      return new Response(JSON.stringify({
        ok: true,
        structured: true,
        operationId: "reconfigure-a",
        receipt: { operationId: "reconfigure-a", status: "queued" },
      }), { status: 202, headers: { "content-type": "application/json" } });
    }
    return await new Promise<Response>(() => {});
  }) as typeof fetch;

  try {
    const mounted = await renderPill(
      <RuntimePill file={codexFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />,
    );
    await click(mounted.host.querySelector("[data-runtime-pill]")!);
    const ultra = [...mounted.host.ownerDocument.querySelectorAll('[data-runtime-row="tier"]')]
      .find((row) => row.textContent === "Ultra")!;
    await click(ultra);

    const pendingA = structuredSession("applied");
    pendingA.revision = 2;
    pendingA.recentReceipts = [];
    pendingA.pendingReconfigure = {
      operationId: "reconfigure-a",
      model: "gpt-5.6-sol",
      effort: "ultra",
      fast: false,
    };
    await act(async () => {
      mounted.root.render(
        <RuntimePill file={codexFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} runtimeSession={pendingA} />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await click(mounted.host.querySelector("[data-runtime-pill]")!);
    const max = [...mounted.host.ownerDocument.querySelectorAll('[data-runtime-row="tier"]')]
      .find((row) => row.textContent === "Max")!;
    await click(max);
    expect(requests).toHaveLength(2);
    const stalePendingA = { ...pendingA, revision: 3 };
    await act(async () => {
      mounted.root.render(
        <RuntimePill file={codexFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} runtimeSession={stalePendingA} />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(JSON.parse(localStorage.getItem(key + ":phase:rollback")!)).toMatchObject({
      operationId: null,
      supersededOperationId: "reconfigure-a",
      runtimeRevision: 2,
    });
    await act(async () => mounted.root.unmount());

    const pendingB = structuredSession("applied");
    pendingB.revision = 4;
    pendingB.recentReceipts = [];
    pendingB.pendingReconfigure = {
      operationId: "reconfigure-b",
      model: "gpt-5.6-sol",
      effort: "max",
      fast: false,
    };
    const remounted = await renderPill(
      <RuntimePill file={codexFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} runtimeSession={pendingB} />,
    );
    expect(JSON.parse(localStorage.getItem(key + ":phase:rollback")!).operationId).toBe("reconfigure-b");

    const failedB = structuredSession("failed", "replacement B failed");
    failedB.revision = 5;
    failedB.recentReceipts[0]!.operationId = "reconfigure-b";
    await act(async () => {
      remounted.root.render(
        <RuntimePill file={codexFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} runtimeSession={failedB} />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(sendRuntimeFrom(codexFile)).toBeUndefined();
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ model: "gpt-5.6-sol", effort: "high", fast: false });
    await act(async () => remounted.root.unmount());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const terminal of ["applied", "failed"] as const) {
  test(`a remounted pill clears a persisted pending phase after a durable ${terminal} receipt`, async () => {
    localStorage.setItem(key + ":phase", "pending");
    localStorage.setItem(key + ":phase:operation", "reconfigure-ui");
    const { host, root } = await renderPill(
      <RuntimePill
        file={codexFile}
        surface="structured"
        runtimeSettings={CODEX_STRUCTURED}
        runtimeSession={structuredSession(terminal, terminal === "failed" ? "replacement host failed" : null)}
      />,
    );

    expect(localStorage.getItem(key + ":phase")).toBeNull();
    expect(localStorage.getItem(key + ":phase:operation")).toBeNull();
    expect(host.querySelector("[data-runtime-switch-pending]")).toBeNull();
    if (terminal === "failed") expect(host.textContent).toContain("replacement host failed");
    await act(async () => root.unmount());
  });
}

test("a remounted pill adopts durable pending ownership before its terminal receipt", async () => {
  const pending = structuredSession("applied");
  pending.recentReceipts = [];
  pending.pendingReconfigure = {
    operationId: "reconfigure-pending",
    model: "gpt-5.6-terra",
    effort: "xhigh",
    fast: true,
  };
  const { host, root } = await renderPill(
    <RuntimePill file={codexFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} runtimeSession={pending} />,
  );
  expect(localStorage.getItem(key + ":phase:operation")).toBe("reconfigure-pending");
  expect(host.querySelector("[data-runtime-switch-pending]")).not.toBeNull();

  const failed = structuredSession("failed", "pending replacement failed");
  failed.recentReceipts[0]!.operationId = "reconfigure-pending";
  await act(async () => {
    root.render(
      <RuntimePill file={codexFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} runtimeSession={failed} />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(localStorage.getItem(key + ":phase:operation")).toBeNull();
  expect(host.querySelector("[data-runtime-switch-pending]")).toBeNull();
  expect(host.textContent).toContain("pending replacement failed");
  await act(async () => root.unmount());
});

test("the model drill-down keeps model rows available for turn-boundary reconfigure", async () => {
  const { host, root } = await renderPill(
    <RuntimePill file={codexFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />,
  );
  await click(host.querySelector("[data-runtime-pill]")!);
  const submenu = [...host.ownerDocument.querySelectorAll('[data-runtime-row="submenu"]')];
  expect(submenu.map((row) => row.getAttribute("data-runtime-value"))).toEqual(["model", "speed", "account"]);
  await click(submenu[0]!);
  // One anchored surface — the root panel is gone, the model panel is in place.
  const modelRows = [...host.ownerDocument.querySelectorAll('[data-runtime-row="model"]')];
  expect(modelRows.map((row) => row.textContent)).toEqual(["GPT-6-Astra", "GPT-6.1-Sol", "GPT-6.1-Terra", "GPT-6-Luna", "GPT-5.6-Sol"]);
  // The conversation runs on the retired 5.6 Sol, so its row stays, checked,
  // after the current choices; the others stay selectable.
  expect(modelRows[4]!.getAttribute("aria-checked")).toBe("true");
  expect(modelRows[0]!.getAttribute("aria-checked")).toBe("false");
  expect(modelRows[0]!.hasAttribute("disabled")).toBe(false);
  // The back row returns to the root panel; its accessible name is the wired
  // composer.backTo copy, distinct from the submenu row's "Model" (#405).
  const backRow = host.ownerDocument.querySelector('[data-runtime-row="back"]')!;
  expect(backRow.getAttribute("aria-label")).toBe("Back — Model");
  await click(backRow);
  expect(host.ownerDocument.querySelectorAll('[data-runtime-row="tier"]').length).toBe(6);
  await act(async () => root.unmount());
});

test("a conversation on a retired model can move to Terra 6.1 and back, and a current one lists only current choices", async () => {
  const { host, root } = await renderPill(
    <RuntimePill file={codexFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />,
  );
  const modelRows = () => [...host.ownerDocument.querySelectorAll('[data-runtime-row="model"]')];
  const openModels = async () => {
    if (!host.ownerDocument.querySelector('[data-runtime-row="submenu"]')) await click(host.querySelector("[data-runtime-pill]")!);
    await click([...host.ownerDocument.querySelectorAll('[data-runtime-row="submenu"]')].find((row) => row.getAttribute("data-runtime-value") === "model")!);
  };
  await openModels();
  await click(modelRows().find((row) => row.getAttribute("data-runtime-value") === "gpt-6.1-terra")!);
  expect(requests.at(-1)).toMatchObject({ action: "reconfigure", model: "gpt-6.1-terra" });
  expect(faceOf(host)).toContain("6.1-Terra");
  await openModels();
  // The drafted Terra is checked; the model the transcript still reports stays listed to go back to.
  expect(modelRows().map((row) => [row.textContent, row.getAttribute("aria-checked")])).toEqual([
    ["GPT-6-Astra", "false"], ["GPT-6.1-Sol", "false"], ["GPT-6.1-Terra", "true"], ["GPT-6-Luna", "false"], ["GPT-5.6-Sol", "false"],
  ]);
  await act(async () => root.unmount());

  const current = await renderPill(<RuntimePill file={{ ...codexFile, model: "gpt-6.1-sol" }} surface="structured" runtimeSettings={CODEX_STRUCTURED} />);
  await click(current.host.querySelector("[data-runtime-pill]")!);
  await click([...current.host.ownerDocument.querySelectorAll('[data-runtime-row="submenu"]')].find((row) => row.getAttribute("data-runtime-value") === "model")!);
  expect([...current.host.ownerDocument.querySelectorAll('[data-runtime-row="model"]')].map((row) => row.textContent))
    .toEqual(["GPT-6-Astra", "GPT-6.1-Sol", "GPT-6.1-Terra", "GPT-6-Luna"]);
  await act(async () => current.root.unmount());
});

test("Copilot runtime effort rows refresh from the selected account model catalogue", async () => {
  copilotModelCatalogResponse = {
    accountId: "copilot-fixture",
    capturedAt: "2026-09-23T00:00:00.000Z",
    source: "acp-config",
    models: [
      { id: "auto", name: "Auto", efforts: null, pickerEnabled: true },
      { id: "catalogue-specific-runtime-fixture", name: "Fixture Model", efforts: ["low", "high"], pickerEnabled: true },
    ],
  };
  const file = copilotFile("catalogue-specific-runtime-fixture", "xhigh");
  const { host, root } = await renderPill(<RuntimePill file={file} surface="resume" />);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  await click(host.querySelector("[data-runtime-pill]")!);
  const tiers = [...host.ownerDocument.querySelectorAll('[data-runtime-row="tier"]')];
  expect(tiers.map((row) => row.textContent)).toEqual(["Light", "High"]);
  expect(tiers.find((row) => row.getAttribute("aria-checked") === "true")?.textContent).toBe("Light");
  await act(async () => root.unmount());
});

test("choosing a Copilot catalogue model clamps the saved effort to that model's ladder", async () => {
  copilotModelCatalogResponse = {
    accountId: "copilot-fixture",
    capturedAt: "2026-09-23T00:00:00.000Z",
    source: "acp-config",
    models: [
      { id: "auto", name: "Auto", efforts: null, pickerEnabled: true },
      { id: "catalogue-specific-runtime-fixture", name: "Fixture Model", efforts: ["low", "high"], pickerEnabled: true },
    ],
  };
  const file = copilotFile("auto", "xhigh");
  const { host, root } = await renderPill(<RuntimePill file={file} surface="resume" />);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await click(host.querySelector("[data-runtime-pill]")!);
  const modelMenu = [...host.ownerDocument.querySelectorAll('[data-runtime-row="submenu"]')]
    .find((row) => row.getAttribute("data-runtime-value") === "model")!;
  await click(modelMenu);
  const model = [...host.ownerDocument.querySelectorAll('[data-runtime-row="model"]')]
    .find((row) => row.getAttribute("data-runtime-value") === "catalogue-specific-runtime-fixture")!;
  await click(model);

  expect(JSON.parse(localStorage.getItem(copilotResumeKey)!)).toEqual({
    model: "catalogue-specific-runtime-fixture", effort: "low", fast: false,
  });
  await act(async () => root.unmount());
});

test("speed rows exist only for codex and remain available on the structured surface", async () => {
  const codex = await renderPill(
    <RuntimePill file={codexFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />,
  );
  await click(codex.host.querySelector("[data-runtime-pill]")!);
  const speed = [...codex.host.ownerDocument.querySelectorAll('[data-runtime-row="submenu"]')]
    .find((row) => row.getAttribute("data-runtime-value") === "speed")!;
  await click(speed);
  const speedRows = [...codex.host.ownerDocument.querySelectorAll('[data-runtime-row="speed"]')];
  expect(speedRows.map((row) => row.textContent)).toEqual(["Standard", "Fast — priority tier", "Ultra — Ultrafast tier"]);
  expect(speedRows.slice(0, 2).every((row) => !row.hasAttribute("aria-disabled"))).toBe(true);
  /* No catalog answered for the account (404 here): Ultra is not offered, and says so. */
  expect(speedRows[2]!.getAttribute("aria-disabled")).toBe("true");
  expect(codex.host.ownerDocument.querySelector("[data-runtime-row-note]")!.textContent).toBe("Can't read default's model catalog to check Ultrafast");
  await act(async () => codex.root.unmount());

  // Claude has no speed concept anywhere in the popover.
  const claude = await renderPill(
    <RuntimePill file={claudeFile} surface="structured" runtimeSettings={CLAUDE_STRUCTURED} />,
  );
  await click(claude.host.querySelector("[data-runtime-pill]")!);
  const values = [...claude.host.ownerDocument.querySelectorAll('[data-runtime-row="submenu"]')]
    .map((row) => row.getAttribute("data-runtime-value"));
  expect(values).toEqual(["model", "account"]);
  await act(async () => claude.root.unmount());
});

test("a claude-broker queues a reasoning change at the active turn boundary", async () => {
  const { host, root } = await renderPill(
    <RuntimePill file={claudeFile} surface="structured" runtimeSettings={CLAUDE_STRUCTURED} />,
  );
  await click(host.querySelector("[data-runtime-pill]")!);
  const tiers = [...host.ownerDocument.querySelectorAll('[data-runtime-row="tier"]')];
  expect(tiers).toHaveLength(5); // claude scale: low…max
  expect(tiers.every((row) => !row.hasAttribute("disabled"))).toBe(true);
  await click(tiers[0]!);
  expect(JSON.parse(localStorage.getItem("llvAgentRuntime:conversation_claude:profile")!)).toEqual({ effort: "low" });
  expect(requests.at(-1)).toMatchObject({ action: "reconfigure", effort: "low" });
  await act(async () => root.unmount());
});

test("on the resume surface a selection saves the concrete :resume profile — auto-apply is the save", async () => {
  const { host, root } = await renderPill(<RuntimePill file={codexFile} surface="resume" />);
  await click(host.querySelector("[data-runtime-pill]")!);
  const medium = [...host.ownerDocument.querySelectorAll('[data-runtime-row="tier"]')].find((row) => row.textContent === "Medium")!;
  expect(medium.hasAttribute("disabled")).toBe(false);
  await click(medium);
  expect(JSON.parse(localStorage.getItem(key + ":resume")!)).toEqual({ model: "gpt-5.6-sol", effort: "medium", fast: false });
  expect(localStorage.getItem(key)).toBeNull();
  await act(async () => root.unmount());
});

test("a resume profile saved on a retired model stays listed and checked while the transcript runs a current one", async () => {
  localStorage.setItem(key + ":resume", JSON.stringify({ model: "gpt-5.6-terra", effort: "ultra", fast: false }));
  const { host, root } = await renderPill(<RuntimePill file={{ ...codexFile, model: "gpt-6.1-sol" }} surface="resume" />);
  expect(faceOf(host)).toContain("5.6-Terra");
  await click(host.querySelector("[data-runtime-pill]")!);
  await click([...host.ownerDocument.querySelectorAll('[data-runtime-row="submenu"]')].find((row) => row.getAttribute("data-runtime-value") === "model")!);
  expect([...host.ownerDocument.querySelectorAll('[data-runtime-row="model"]')].map((row) => [row.textContent, row.getAttribute("aria-checked")])).toEqual([
    ["GPT-6-Astra", "false"], ["GPT-6.1-Sol", "false"], ["GPT-6.1-Terra", "false"], ["GPT-6-Luna", "false"], ["GPT-5.6-Terra", "true"],
  ]);
  // Opening the list rewrites nothing that was saved.
  expect(JSON.parse(localStorage.getItem(key + ":resume")!)).toEqual({ model: "gpt-5.6-terra", effort: "ultra", fast: false });
  expect(requests).toHaveLength(0);
  await act(async () => root.unmount());
});

test("Escape closes the popover and returns focus to the pill", async () => {
  const { host, root } = await renderPill(
    <RuntimePill file={codexFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />,
  );
  const pill = host.querySelector("[data-runtime-pill]") as HTMLButtonElement;
  await click(pill);
  const menu = host.ownerDocument.querySelector("[data-runtime-popover]")!;
  await keydown(menu, "Escape");
  expect(host.ownerDocument.querySelector("[data-runtime-popover]")).toBeNull();
  expect(pill.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(pill);
  await act(async () => root.unmount());
});

test("at 390px the chip opens the «Next message» sheet, which stays open across selections", async () => {
  mobile = true;
  const { host, root } = await renderPill(
    <RuntimePill file={codexFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />,
  );
  /* Mobile v2 §4.4: the chip inside the composer box is what opens it, and the
     capture reaches it by that hook. */
  const chip = host.querySelector("[data-runtime-pill]")!;
  expect(chip.getAttribute("data-mobile2-open")).toBe("model");
  await click(chip);
  /* Portalled to the body (#1795), like the popover beside it, so it is looked
     for in the document rather than under the mount. */
  const sheet = document.querySelector('[role="dialog"][data-runtime-sheet]')!;
  expect(sheet.getAttribute("aria-modal")).toBe("true");
  expect(sheet.getAttribute("aria-label")).toBe("Model and reasoning — applies to your next message");
  expect(sheet.getAttribute("data-mobile2-sheet")).toBe("model");
  /* It says what it applies to, and in the operator's own tier words (§7 Q5). */
  expect(document.querySelector("[data-mobile2-next-message]")!.textContent)
    .toBe("Applies to your next message: 5.6-Sol · high");
  const sections = [...sheet.querySelectorAll('[role="radiogroup"]')];
  expect(sections.map((section) => section.getAttribute("aria-label"))).toEqual(["Model", "Reasoning", "Speed"]);
  const rows = [...sheet.querySelectorAll("[data-runtime-sheet-row]")];
  expect(rows.every((row) => row.className.includes("min-h-11"))).toBe(true);
  /* One vocabulary: the rows are the tier ids, never a third spelling of them. */
  const reasoning = [...sections[1]!.querySelectorAll("[data-runtime-sheet-row]")].map((row) => row.textContent);
  expect(reasoning).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  // Selecting a tier commits but keeps the sheet open (model + reasoning in one visit).
  const ultra = rows.find((row) => row.textContent === "ultra")!;
  await click(ultra);
  expect(JSON.parse(localStorage.getItem(key + ":profile")!)).toEqual({ effort: "ultra" });
  expect(document.querySelector("[data-runtime-sheet]")).not.toBeNull();
  await act(async () => root.unmount());
});

/* #1795: the operator tapped `high` on a conversation already running `high`
   and the Viewer tried to move it to a "new" reasoning tier. A patch equal to
   the face is not a change: nothing is applied, nothing is sent, and the sheet
   the tap was made in closes. */
test("re-selecting the tier, the model or the speed the conversation already runs on sends nothing and closes the sheet", async () => {
  mobile = true;
  const { host, root } = await renderPill(
    <RuntimePill file={codexFile} surface="live-root" runtimeSettings={CODEX_STRUCTURED} />,
  );
  const chip = host.querySelector("[data-runtime-pill]") as HTMLButtonElement;
  const openSheet = async () => {
    await click(chip);
    return document.querySelector("[data-runtime-sheet]")!;
  };
  const rowFor = (sheet: Element, label: string) =>
    [...sheet.querySelectorAll("[data-runtime-sheet-row]")].find((row) => row.textContent === label)!;

  const tier = rowFor(await openSheet(), "high");
  expect(tier.getAttribute("aria-checked")).toBe("true");
  await click(tier);
  expect(requests).toHaveLength(0);
  expect(document.querySelector("[data-runtime-sheet]")).toBeNull();

  const model = rowFor(await openSheet(), "GPT-5.6-Sol");
  expect(model.getAttribute("aria-checked")).toBe("true");
  await click(model);
  expect(requests).toHaveLength(0);
  expect(document.querySelector("[data-runtime-sheet]")).toBeNull();

  const speed = rowFor(await openSheet(), "Standard");
  expect(speed.getAttribute("aria-checked")).toBe("true");
  await click(speed);
  expect(requests).toHaveLength(0);
  expect(document.querySelector("[data-runtime-sheet]")).toBeNull();

  /* The stored draft is untouched too — a no-op writes no profile. */
  expect(localStorage.getItem(key)).toBeNull();

  /* And a row that IS a change still goes out, so the guard is about equality
     and nothing else. */
  await click(rowFor(await openSheet(), "low"));
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ action: "reconfigure", effort: "low" });
  await act(async () => root.unmount());
});

test("on the desktop, re-selecting the checked tier closes the menu and sends nothing", async () => {
  const { host, root } = await renderPill(
    <RuntimePill file={codexFile} surface="live-root" runtimeSettings={CODEX_STRUCTURED} />,
  );
  const pill = host.querySelector("[data-runtime-pill]") as HTMLButtonElement;
  await click(pill);
  const checked = [...document.querySelectorAll("[data-runtime-row=\"tier\"]")]
    .find((row) => row.getAttribute("aria-checked") === "true")!;
  await click(checked);
  expect(requests).toHaveLength(0);
  expect(document.querySelector("[data-runtime-popover]")).toBeNull();
  await act(async () => root.unmount());
});

test("no pill renders for engines without a runtime dial or on surfaces outside the matrix", async () => {
  const shell: FileEntry = { ...codexFile, engine: "shell" };
  const first = await renderPill(<RuntimePill file={shell} surface="structured" />);
  expect(first.host.querySelector("[data-runtime-pill]")).toBeNull();
  await act(async () => first.root.unmount());
  const second = await renderPill(<RuntimePill file={codexFile} surface="live-subagent" />);
  expect(second.host.querySelector("[data-runtime-pill]")).toBeNull();
  await act(async () => second.root.unmount());
});

const claudeSeat: FileEntry = { ...claudeFile, model: "opus", effort: "high" };
const faceOf = (host: HTMLElement) => host.querySelector("[data-runtime-pill]")?.textContent ?? "";
const rerender = async (root: Root, node: React.ReactElement) => {
  await act(async () => {
    root.render(node);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

test("a structured face seeded before the runtime reported an effort follows the poll that brings it", async () => {
  const { host, root } = await renderPill(
    <RuntimePill file={{ ...claudeSeat, effort: null }} surface="structured" runtimeSettings={CLAUDE_STRUCTURED} />,
  );
  expect(faceOf(host)).toContain("Opus 5.5 · Light");
  await rerender(root, <RuntimePill file={claudeSeat} surface="structured" runtimeSettings={CLAUDE_STRUCTURED} />);
  expect(faceOf(host)).toContain("Opus 5.5 · High");
  await act(async () => root.unmount());
});

test("a rotation does not carry the previous seat's runtime onto the new seat's face or sends", async () => {
  const previous: FileEntry = { ...codexFile, conversationId: "conversation_previous_seat", path: "/previous.jsonl" };
  const { host, root } = await renderPill(
    <RuntimePill file={previous} surface="structured" runtimeSettings={CODEX_STRUCTURED} />,
  );
  expect(faceOf(host)).toContain("5.6-Sol · High");
  localStorage.setItem("llvAgentRuntime:conversation_previous_seat", JSON.stringify({ model: "gpt-5.6-sol", effort: "low", fast: false }));
  localStorage.setItem("llvAgentRuntime:conversation_previous_seat:profile", JSON.stringify({ model: "gpt-5.6-sol", effort: "low" }));

  await rerender(root, <RuntimePill file={claudeSeat} surface="structured" runtimeSettings={CLAUDE_STRUCTURED} />);
  expect(faceOf(host)).toContain("Opus 5.5 · High");
  expect(sendRuntimeFrom(claudeSeat)).toBeUndefined();
  expect(localStorage.getItem("llvAgentRuntime:conversation_claude:profile")).toBeNull();
  expect(JSON.parse(localStorage.getItem("llvAgentRuntime:conversation_previous_seat:profile")!)).toEqual({ model: "gpt-5.6-sol", effort: "low" });
  await act(async () => root.unmount());
});

test("the same transcript changing identity still carries its own selection along", async () => {
  const provisional: FileEntry = { ...claudeSeat, conversationId: "conversation_provisional" };
  const { host, root } = await renderPill(
    <RuntimePill file={provisional} surface="structured" runtimeSettings={CLAUDE_STRUCTURED} />,
  );
  await click(host.querySelector("[data-runtime-pill]")!);
  await click([...host.ownerDocument.querySelectorAll('[data-runtime-row="tier"]')].find((row) => row.textContent === "Medium")!);
  expect(localStorage.getItem("llvAgentRuntime:conversation_provisional:profile")).not.toBeNull();

  await rerender(root, <RuntimePill file={{ ...provisional, conversationId: "conversation_claude" }} surface="structured" runtimeSettings={CLAUDE_STRUCTURED} />);
  expect(JSON.parse(localStorage.getItem("llvAgentRuntime:conversation_claude:profile")!)).toEqual({ effort: "medium" });
  expect(localStorage.getItem("llvAgentRuntime:conversation_provisional:profile")).toBeNull();
  await act(async () => root.unmount());
});

test("a chosen tier holds through the apply and the poll that reports it, then the runtime leads again", async () => {
  const { host, root } = await renderPill(
    <RuntimePill file={claudeSeat} surface="structured" runtimeSettings={CLAUDE_STRUCTURED} />,
  );
  await click(host.querySelector("[data-runtime-pill]")!);
  await click([...host.ownerDocument.querySelectorAll('[data-runtime-row="tier"]')].find((row) => row.textContent === "Medium")!);
  expect(requests.at(-1)).toMatchObject({ action: "reconfigure", model: "opus", effort: "medium" });
  expect(faceOf(host)).toContain("Opus 5.5 · Medium");

  /* An unrelated poll while the apply is in flight leaves the choice alone. */
  await rerender(root, <RuntimePill file={{ ...claudeSeat, mtime: 2 }} surface="structured" runtimeSettings={CLAUDE_STRUCTURED} />);
  expect(faceOf(host)).toContain("Opus 5.5 · Medium");

  const applied = structuredSession("applied");
  await rerender(root, <RuntimePill file={{ ...claudeSeat, effort: "medium" }} surface="structured" runtimeSettings={CLAUDE_STRUCTURED} runtimeSession={applied} />);
  expect(faceOf(host)).toContain("Opus 5.5 · Medium");

  /* Something else moves the runtime: the face says so. */
  await rerender(root, <RuntimePill file={{ ...claudeSeat, effort: "xhigh" }} surface="structured" runtimeSettings={CLAUDE_STRUCTURED} runtimeSession={applied} />);
  expect(faceOf(host)).toContain("Opus 5.5 · Extra High");
  await act(async () => root.unmount());
});

test("a model or account pick is built on what the conversation runs, never a stale draft", async () => {
  const { host, root } = await renderPill(
    <RuntimePill file={{ ...claudeSeat, effort: null }} surface="structured" runtimeSettings={CLAUDE_STRUCTURED} />,
  );
  await rerender(root, <RuntimePill file={claudeSeat} surface="structured" runtimeSettings={CLAUDE_STRUCTURED} />);
  await click(host.querySelector("[data-runtime-pill]")!);
  await click([...host.ownerDocument.querySelectorAll('[data-runtime-row="submenu"]')]
    .find((row) => row.getAttribute("data-runtime-value") === "model")!);
  await click([...host.ownerDocument.querySelectorAll('[data-runtime-row="model"]')]
    .find((row) => row.getAttribute("data-runtime-value") === "sonnet")!);
  expect(requests.at(-1)).toMatchObject({ action: "reconfigure", effort: "high" });
  await act(async () => root.unmount());
});

test("a selection the seat inherited never rides a send the face does not name", async () => {
  localStorage.setItem("llvAgentRuntime:conversation_claude", JSON.stringify({ model: "gpt-5.6-sol", effort: "low", fast: false }));
  localStorage.setItem("llvAgentRuntime:conversation_claude:profile", JSON.stringify({ model: "gpt-5.6-sol", effort: "low" }));
  const { host, root } = await renderPill(
    <RuntimePill file={claudeSeat} surface="structured" runtimeSettings={CLAUDE_STRUCTURED} />,
  );
  expect(faceOf(host)).toContain("Opus 5.5 · High");
  expect(sendRuntimeFrom(claudeSeat)).toBeUndefined();
  await act(async () => root.unmount());
});

test("ultrafast is visible and effort-only composer profiles preserve the thread tier", async () => {
  const file = { ...codexFile, model: "gpt-6-astra", serviceTier: "ultrafast", fast: true };
  const { host, root } = await renderPill(<RuntimePill file={file} surface="structured" runtimeSettings={CODEX_STRUCTURED} />);
  const pill = host.querySelector("[data-runtime-pill]")!;
  expect(pill.textContent).toContain("Ultrafast");
  await click(pill);
  const speed = document.querySelector('[data-runtime-row="submenu"][data-runtime-value="speed"]')!;
  expect(speed.textContent).toContain("Ultrafast tier");
  await click(speed);
  const standard = document.querySelector('[data-runtime-row="speed"][data-runtime-value="standard"]')!;
  await click(standard);
  /* Speed is the thread's own setting, changed in place: no per-turn override rides later sends. */
  expect(requests.at(-1)).toMatchObject({ action: "speed", serviceTier: "default", path: file.path });
  expect(sendRuntimeFrom(file)).toBeUndefined();
  localStorage.setItem(key + ":profile", JSON.stringify({ model: "gpt-6-astra", effort: "xhigh", fast: true }));
  expect(sendRuntimeFrom(file)).toMatchObject({ effort: "xhigh" });
  expect(sendRuntimeFrom(file)).not.toHaveProperty("fast");
  await act(async () => root.unmount());
});

/* Ultra on the seat's speed control (2026-10-26): offered from the running
   account's own catalog, chosen in place through the conversation's speed
   action, and read back from what the conversation reports. */
const solFile: FileEntry = { ...codexFile, model: "gpt-6.1-sol" };
const catalogOf = (label: string, tiers: Array<{ id: string; name: string }> | null): Answer => ({
  status: 200, body: { accounts: [{ id: "default", label, models: [{ slug: "gpt-6.1-sol", tiers }, { slug: "gpt-6-luna", tiers: [] }] }] },
});
const MAIN = catalogOf("Account A", [{ id: "priority", name: "Fast" }, { id: "ultrafast", name: "Ultrafast" }]);
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const openSpeedPanel = async (host: HTMLElement) => {
  await click(host.querySelector("[data-runtime-pill]")!);
  await click(document.querySelector('[data-runtime-row="submenu"][data-runtime-value="speed"]')!);
  await settle();
};
const speedRow = (value: string) => document.querySelector(`[data-runtime-row="speed"][data-runtime-value="${value}"]`) as HTMLButtonElement;
const deferred = () => { let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); return { gate, release }; };

test("Ultra is offered where the account's catalog lists it, and a pick changes the speed in place and reads back applied", async () => {
  codexCatalogAnswer = MAIN;
  const { host, root } = await renderPill(<RuntimePill file={solFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />);
  await openSpeedPanel(host);
  expect(catalogReads).toEqual(["/api/accounts/codex/models?account=default"]);
  expect(speedRow("ultrafast").hasAttribute("aria-disabled")).toBe(false);
  expect(document.querySelector("[data-runtime-row-note]")).toBeNull();
  await click(speedRow("ultrafast"));
  await settle();
  /* The choice took, so the speed rows close as any other pick does. */
  expect(document.querySelector("[data-runtime-popover]")).toBeNull();

  /* The in-place speed action, and nothing else: no reconfigure, no per-turn override. */
  expect(requests).toEqual([{ path: solFile.path, conversationId: "conversation_runtime", action: "speed", serviceTier: "ultrafast" }]);
  expect(sendRuntimeFrom(solFile)).toBeUndefined();
  expect(faceOf(host)).toContain("Ultrafast");
  expect(host.querySelector("[data-runtime-switch-pending]")).toBeNull();

  /* The poll reads the applied tier back: the face keeps it, now as what the conversation runs. */
  const applied = { ...solFile, fast: true, serviceTier: "ultrafast" };
  await rerender(root, <RuntimePill file={applied} surface="structured" runtimeSettings={CODEX_STRUCTURED} />);
  expect(faceOf(host)).toContain("6.1-Sol · High · Ultrafast");
  await openSpeedPanel(host);
  expect(speedRow("ultrafast").getAttribute("aria-checked")).toBe("true");
  expect(speedRow("fast").getAttribute("aria-checked")).toBe("false");
  await act(async () => root.unmount());
});

test("Ultra stays disabled with the account's own reason as visible text where its catalog lacks the tier", async () => {
  codexCatalogAnswer = catalogOf("Account B", [{ id: "priority", name: "Fast" }]);
  const desktop = await renderPill(<RuntimePill file={solFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />);
  await openSpeedPanel(desktop.host);
  const ultra = speedRow("ultrafast");
  expect(ultra.getAttribute("aria-disabled")).toBe("true");
  const note = document.querySelector("[data-runtime-row-note]")!;
  expect(note.textContent).toBe("Account B doesn't offer Ultrafast for GPT\u20116.1\u2011Sol (offers: Fast)");
  expect(ultra.getAttribute("aria-describedby")).toBe(note.id);
  await click(ultra);
  expect(requests).toHaveLength(0);
  await act(async () => desktop.root.unmount());

  /* The phone has no tooltip: the sheet carries the same reason under the row. */
  mobile = true;
  const phone = await renderPill(<RuntimePill file={solFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />);
  await click(phone.host.querySelector("[data-runtime-pill]")!);
  await settle();
  const row = document.querySelector('[data-runtime-sheet-value="ultrafast"]')!;
  expect(row.getAttribute("aria-disabled")).toBe("true");
  expect(row.getAttribute("aria-describedby")).toBe(document.querySelector("[data-runtime-sheet] [data-runtime-row-note]")!.id);
  await click(row);
  expect(requests).toHaveLength(0);
  expect(document.querySelector("[data-runtime-sheet] [data-runtime-row-note]")!.textContent)
    .toBe("Account B doesn't offer Ultrafast for GPT\u20116.1\u2011Sol (offers: Fast)");
  await act(async () => phone.root.unmount());
});

test("while the catalog read is open Ultra claims nothing, and a model the catalog has no tiers for offers none", async () => {
  const held = deferred();
  codexCatalogGate = held.gate;
  codexCatalogAnswer = MAIN;
  const { host, root } = await renderPill(<RuntimePill file={{ ...solFile, model: "gpt-6-luna" }} surface="structured" runtimeSettings={CODEX_STRUCTURED} />);
  await openSpeedPanel(host);
  expect(speedRow("ultrafast").getAttribute("aria-disabled")).toBe("true");
  expect(document.querySelector("[data-runtime-row-note]")).toBeNull();
  held.release();
  await settle();
  await settle();
  expect(speedRow("ultrafast").getAttribute("aria-disabled")).toBe("true");
  expect(document.querySelector("[data-runtime-row-note]")!.textContent).toBe("Account A doesn't offer Ultrafast for GPT\u20116\u2011Luna");
  await act(async () => root.unmount());
});

test("on the desktop, arrow keys reach the unavailable Ultra row, it announces the account's reason, and activating it sends nothing", async () => {
  codexCatalogAnswer = catalogOf("Account B", [{ id: "priority", name: "Fast" }]);
  const { host, root } = await renderPill(<RuntimePill file={solFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />);
  await openSpeedPanel(host);
  await settle();
  expect(document.activeElement).toBe(speedRow("standard"));
  const menu = document.querySelector("[data-runtime-popover]")!;
  await keydown(menu, "ArrowDown");
  expect(document.activeElement).toBe(speedRow("fast"));
  await keydown(menu, "ArrowDown");
  const ultra = document.activeElement as HTMLElement;
  expect(ultra).toBe(speedRow("ultrafast"));
  expect(ultra.getAttribute("role")).toBe("menuitemradio");
  expect(ultra.getAttribute("aria-disabled")).toBe("true");
  expect(document.getElementById(ultra.getAttribute("aria-describedby")!)!.textContent)
    .toBe("Account B doesn't offer Ultrafast for GPT\u20116.1\u2011Sol (offers: Fast)");
  await keydown(menu, "Enter");
  await keydown(menu, " ");
  await click(ultra);
  expect(requests).toHaveLength(0);
  expect(speedRow("standard").getAttribute("aria-checked")).toBe("true");
  /* The order wraps past it to Back, so it is one stop, never a trap. */
  await keydown(menu, "ArrowDown");
  expect(document.activeElement?.getAttribute("data-runtime-row")).toBe("back");
  await act(async () => root.unmount());
});

test("on the desktop a refused speed choice keeps the speed rows open and says why beside them, without a second click", async () => {
  codexCatalogAnswer = MAIN;
  const refusal = "service tier \"ultrafast\" is not offered for gpt-6.1-sol on pinned account \"default\"";
  const answer = deferred();
  speedAnswers.push({ answer: { status: 409, body: { ok: false, code: "service_tier_unavailable", error: refusal } }, gate: answer.gate });
  const { host, root } = await renderPill(<RuntimePill file={solFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />);
  await openSpeedPanel(host);
  await click(speedRow("ultrafast"));
  /* Checked at once while the action answers; the rows stay where the choice was made. */
  expect(speedRow("ultrafast").getAttribute("aria-checked")).toBe("true");
  answer.release();
  await settle();
  await settle();
  expect(document.querySelector("[data-runtime-popover]")).not.toBeNull();
  expect(document.querySelector("[data-runtime-speed-error]")!.textContent).toBe(refusal);
  expect([...document.querySelectorAll('[data-runtime-row="speed"]')].map((row) => row.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
  expect(faceOf(host)).not.toContain("Ultrafast");
  /* Back on the root panel, the account line carries it instead: once per panel. */
  await click(document.querySelector('[data-runtime-row="back"]')!);
  expect(document.querySelector("[data-runtime-speed-error]")).toBeNull();
  expect(document.querySelector("[data-runtime-popover-account]")!.textContent).toBe(refusal);
  await act(async () => root.unmount());
});

test("a speed refusal that lands after its panel closed is said in a toast", async () => {
  codexCatalogAnswer = MAIN;
  const answer = deferred();
  speedAnswers.push({ answer: { status: 409, body: { ok: false, error: "a runtime change is already in flight" } }, gate: answer.gate });
  const { host, root } = await renderPill(<><RuntimePill file={solFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} /><TaskToastHost /></>);
  await openSpeedPanel(host);
  await click(speedRow("ultrafast"));
  await keydown(document.querySelector("[data-runtime-popover]")!, "Escape");
  expect(document.querySelector("[data-runtime-popover]")).toBeNull();
  expect(document.querySelector("[data-task-toasts]")).toBeNull();
  answer.release();
  await settle();
  await settle();
  expect(document.querySelector("[data-task-toasts]")!.textContent).toContain("a runtime change is already in flight");
  await act(async () => root.unmount());
});

test("a refused speed choice returns to the speed the conversation runs and says why beside the speed rows", async () => {
  mobile = true;
  codexCatalogAnswer = MAIN;
  const refusal = "service tier \"ultrafast\" is not offered for gpt-6.1-sol on pinned account \"default\"";
  speedAnswers.push({ answer: { status: 409, body: { ok: false, code: "service_tier_unavailable", error: refusal } } });
  /* happy-dom lays nothing out: record what the sheet asks to bring into view. */
  const revealed: Element[] = [];
  const original = dom.Element.prototype.scrollIntoView;
  dom.Element.prototype.scrollIntoView = function (this: Element) { revealed.push(this); } as typeof original;
  try {
    const { host, root } = await renderPill(<RuntimePill file={solFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />);
    await click(host.querySelector("[data-runtime-pill]")!);
    await settle();
    await click(document.querySelector('[data-runtime-sheet-value="ultrafast"]')!);
    await settle();
    expect(requests.at(-1)).toMatchObject({ action: "speed", serviceTier: "ultrafast" });
    /* The reason lands under the last row and grows below the sheet's edge, so the sheet reveals it. */
    expect(revealed).toContain(document.querySelector("[data-runtime-speed-error]")!);
    const rows = [...document.querySelectorAll('[data-runtime-sheet] [role="radiogroup"][aria-label="Speed"] [data-runtime-sheet-row]')];
    expect(rows.map((row) => row.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(document.querySelector("[data-runtime-speed-error]")!.textContent).toBe(refusal);
    /* Once per surface: the account line does not repeat it. */
    expect(document.querySelector("[data-runtime-sheet-account-current]")!.textContent).not.toContain(refusal);
    expect(faceOf(host)).not.toContain("Ultrafast");
    await act(async () => root.unmount());
  } finally {
    dom.Element.prototype.scrollIntoView = original;
  }
});

test("a late refusal of an earlier speed choice never overrides the later one", async () => {
  mobile = true;
  codexCatalogAnswer = MAIN;
  const first = deferred();
  speedAnswers.push({ answer: { status: 409, body: { ok: false, error: "late refusal" } }, gate: first.gate });
  speedAnswers.push({ answer: { status: 200, body: { ok: true, appliedTier: "priority" } } });
  const { host, root } = await renderPill(<RuntimePill file={solFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />);
  await click(host.querySelector("[data-runtime-pill]")!);
  await settle();
  await click(document.querySelector('[data-runtime-sheet-value="ultrafast"]')!);
  const fast = [...document.querySelectorAll("[data-runtime-sheet-row]")].find((row) => row.textContent === "Fast — priority tier")!;
  await click(fast);
  await settle();
  first.release();
  await settle();
  expect(requests.map((request) => request.serviceTier)).toEqual(["ultrafast", "priority"]);
  expect(fast.getAttribute("aria-checked")).toBe("true");
  expect(document.querySelector("[data-runtime-speed-error]")).toBeNull();
  await act(async () => root.unmount());
});

test("the server's refusal of an unavailable Ultrafast is said as the Ultra row's own reason", async () => {
  codexCatalogAnswer = MAIN;
  /* The writer's own output: the account's catalog moved after the rows were read. */
  const refusal = serviceTierRefusal([{ id: "default", label: "Account B", tiers: ["priority"], alternativeModels: [] }], "gpt-6.1-sol", "ultrafast", "default");
  speedAnswers.push({ answer: { status: 409, body: { ok: false, code: "service_tier_unavailable", requestedTier: "ultrafast", error: refusal } } });
  const { host, root } = await renderPill(<RuntimePill file={solFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />);
  await openSpeedPanel(host);
  await click(speedRow("ultrafast"));
  await settle();
  await settle();
  expect(document.querySelector("[data-runtime-speed-error]")!.textContent).toBe("Account B doesn't offer Ultrafast for GPT\u20116.1\u2011Sol (offers: Fast)");
  await act(async () => root.unmount());
});

test("on the phone an applied Ultrafast is named on the face and in the sheet's summary", async () => {
  mobile = true;
  codexCatalogAnswer = MAIN;
  const applied = { ...solFile, fast: true, serviceTier: "ultrafast" };
  const { host, root } = await renderPill(<RuntimePill file={applied} surface="structured" runtimeSettings={CODEX_STRUCTURED} />);
  expect(faceOf(host)).toBe("6.1-Sol · high · Ultrafast");
  await click(host.querySelector("[data-runtime-pill]")!);
  await settle();
  expect(document.querySelector("[data-mobile2-next-message]")!.textContent).toBe("Applies to your next message: 6.1-Sol · high · Ultrafast");
  await act(async () => root.unmount());

  /* At the standard tier neither says a speed. */
  const plain = await renderPill(<RuntimePill file={solFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />);
  expect(faceOf(plain.host)).toBe("6.1-Sol · high");
  await click(plain.host.querySelector("[data-runtime-pill]")!);
  await settle();
  expect(document.querySelector("[data-mobile2-next-message]")!.textContent).toBe("Applies to your next message: 6.1-Sol · high");
  await act(async () => plain.root.unmount());
});

test("in the phone's sheet the tapped speed row says it is pending until its action answers", async () => {
  mobile = true;
  codexCatalogAnswer = MAIN;
  const answer = deferred();
  speedAnswers.push({ answer: { status: 200, body: { ok: true, requestedTier: "ultrafast", appliedTier: "ultrafast", echoed: true } }, gate: answer.gate });
  const { host, root } = await renderPill(<RuntimePill file={solFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />);
  await click(host.querySelector("[data-runtime-pill]")!);
  await settle();
  const ultra = () => document.querySelector('[data-runtime-sheet-value="ultrafast"]')!;
  await click(ultra());
  expect(ultra().getAttribute("aria-checked")).toBe("true");
  expect(ultra().querySelector("[data-runtime-sheet-pending]")!.textContent).toBe("switch pending");
  expect(ultra().textContent).toBe("Ultra — Ultrafast tier switch pending");
  expect(document.querySelectorAll("[data-runtime-sheet-pending]")).toHaveLength(1);
  answer.release();
  await settle();
  await settle();
  expect(ultra().getAttribute("aria-checked")).toBe("true");
  expect(document.querySelector("[data-runtime-sheet-pending]")).toBeNull();
  await act(async () => root.unmount());
});

test("a later change that supersedes a speed choice takes its pending mark off the speed row", async () => {
  mobile = true;
  codexCatalogAnswer = MAIN;
  const answer = deferred();
  speedAnswers.push({ answer: { status: 200, body: { ok: true, requestedTier: "ultrafast", appliedTier: "ultrafast", echoed: true } }, gate: answer.gate });
  const { host, root } = await renderPill(<RuntimePill file={solFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />);
  await click(host.querySelector("[data-runtime-pill]")!);
  await settle();
  await click(document.querySelector('[data-runtime-sheet-value="ultrafast"]')!);
  expect(document.querySelector("[data-runtime-sheet-pending]")).not.toBeNull();
  const reconfigure = deferred();
  reconfigureGate = reconfigure.gate;
  const low = [...document.querySelectorAll('[data-runtime-sheet] [role="radiogroup"][aria-label="Reasoning"] [data-runtime-sheet-row]')].find((row) => row.textContent === "low")!;
  await click(low);
  expect(requests.at(-1)).toMatchObject({ action: "reconfigure", effort: "low" });
  /* The reconfigure is still saving: nothing says the superseded speed is. */
  expect(host.querySelector("[data-runtime-pill]")!.getAttribute("aria-busy")).toBe("true");
  expect(document.querySelector("[data-runtime-sheet-pending]")).toBeNull();
  reconfigureGate = null;
  reconfigure.release();
  answer.release();
  await settle();
  await act(async () => root.unmount());
});

test("a refused speed choice drops its pending mark with its check", async () => {
  mobile = true;
  codexCatalogAnswer = MAIN;
  const answer = deferred();
  speedAnswers.push({ answer: { status: 409, body: { ok: false, error: "a runtime change is already in flight" } }, gate: answer.gate });
  const { host, root } = await renderPill(<RuntimePill file={solFile} surface="structured" runtimeSettings={CODEX_STRUCTURED} />);
  await click(host.querySelector("[data-runtime-pill]")!);
  await settle();
  await click(document.querySelector('[data-runtime-sheet-value="ultrafast"]')!);
  expect(document.querySelector("[data-runtime-sheet-pending]")).not.toBeNull();
  answer.release();
  await settle();
  await settle();
  expect(document.querySelector("[data-runtime-sheet-pending]")).toBeNull();
  expect(document.querySelector('[data-runtime-sheet-value="ultrafast"]')!.getAttribute("aria-checked")).toBe("false");
  expect(document.querySelector("[data-runtime-speed-error]")!.textContent).toBe("a runtime change is already in flight");
  await act(async () => root.unmount());
});

test("a pipeline's conversation keeps Standard and Fast on its own path and is offered no Ultra", async () => {
  codexCatalogAnswer = MAIN;
  const lineage: FileEntry["durableLineage"] = {
    kind: "spawn", role: "builder", parentConversationId: null, reviewsConversationId: null,
    memberships: [{ kind: "pipeline", containerId: "pipeline-fixture", role: "builder", slot: "stage", stageId: "ui", stageOrder: 1, round: null }],
  } as FileEntry["durableLineage"];
  const { host, root } = await renderPill(<RuntimePill file={{ ...solFile, durableLineage: lineage }} surface="structured" runtimeSettings={CODEX_STRUCTURED} />);
  await openSpeedPanel(host);
  expect([...document.querySelectorAll('[data-runtime-row="speed"]')].map((row) => row.getAttribute("data-runtime-value"))).toEqual(["standard", "fast"]);
  expect(catalogReads).toHaveLength(0);
  await click(speedRow("fast"));
  expect(requests.at(-1)).toMatchObject({ action: "reconfigure", fast: true });
  await act(async () => root.unmount());
});

test("a stage whose transcript has not named a model yet reads the model its launch asked for, never the engine default", async () => {
  const luna: FileEntry = { ...codexFile, model: null, launchModel: "gpt-6-luna", effort: "high" };
  for (const surface of ["structured", "resume"] as const) {
    const { host, root } = await renderPill(<RuntimePill file={luna} surface={surface} runtimeSettings={CODEX_STRUCTURED} />);
    expect(faceOf(host)).toContain("6-Luna · High");
    expect(faceOf(host)).not.toContain("Sol");
    await act(async () => root.unmount());
  }
  const { host, root } = await renderPill(<RuntimePill file={luna} surface="structured" runtimeSettings={CODEX_STRUCTURED} />);
  await click(host.querySelector("[data-runtime-pill]")!);
  const tier = [...host.ownerDocument.querySelectorAll('[data-runtime-row="tier"]')].find((row) => row.textContent === "Max")!;
  await click(tier);
  /* The effort pick is sent on the launch model, not a guess. */
  expect(requests.at(-1)).toMatchObject({ action: "reconfigure", model: "gpt-6-luna", effort: "max" });
  await act(async () => root.unmount());
});

test("the transcript's model wins over the launch's, in the face and on the phone sheet", async () => {
  const file: FileEntry = { ...codexFile, model: "gpt-6-astra", launchModel: "gpt-6-luna" };
  mobile = true;
  const { host, root } = await renderPill(<RuntimePill file={file} surface="structured" runtimeSettings={CODEX_STRUCTURED} />);
  expect(faceOf(host)).toContain("6-Astra · high");
  await click(host.querySelector("[data-runtime-pill]")!);
  expect(host.ownerDocument.querySelector("[data-mobile2-next-message]")?.textContent).toContain("6-Astra");
  await act(async () => root.unmount());
});

test("a conversation with no known model names none and holds the edits that would send one", async () => {
  const unknown: FileEntry = { ...codexFile, model: null, launchModel: null, effort: "high" };
  const { host, root } = await renderPill(<RuntimePill file={unknown} surface="structured" runtimeSettings={CODEX_STRUCTURED} />);
  const face = faceOf(host);
  expect(face).toContain("Model · High");
  expect(face).not.toContain("Sol");
  expect(host.querySelector("[data-runtime-pill]")!.getAttribute("aria-label")).not.toContain("Sol");
  await click(host.querySelector("[data-runtime-pill]")!);
  const tiers = [...host.ownerDocument.querySelectorAll('[data-runtime-row="tier"]')];
  expect(tiers.length).toBeGreaterThan(0);
  expect(tiers.every((row) => row.hasAttribute("aria-disabled"))).toBe(true);
  await click(tiers[0]!);
  expect(requests).toHaveLength(0);
  /* Picking a model is how the face gets one, and it is the model that is sent. */
  await click([...host.ownerDocument.querySelectorAll('[data-runtime-row="submenu"]')]
    .find((row) => row.getAttribute("data-runtime-value") === "model")!);
  await click([...host.ownerDocument.querySelectorAll('[data-runtime-row="model"]')]
    .find((row) => row.getAttribute("data-runtime-value") === "gpt-6-luna")!);
  expect(requests.at(-1)).toMatchObject({ action: "reconfigure", model: "gpt-6-luna" });
  expect(faceOf(host)).toContain("6-Luna");
  await act(async () => root.unmount());
});

test("a model the catalogue does not list is named as the transcript reports it, on both engines", async () => {
  const codex = await renderPill(<RuntimePill file={{ ...codexFile, model: "gpt-5.5", launchModel: "gpt-6-luna" }} surface="structured" runtimeSettings={CODEX_STRUCTURED} />);
  expect(faceOf(codex.host)).toContain("gpt-5.5");
  expect(faceOf(codex.host)).not.toContain("Sol");
  await act(async () => codex.root.unmount());
  const claude = await renderPill(<RuntimePill file={{ ...claudeSeat, model: "opus-4-1", launchModel: "opus" }} surface="structured" runtimeSettings={CLAUDE_STRUCTURED} />);
  expect(faceOf(claude.host)).toContain("Opus 4.1");
  expect(faceOf(claude.host)).not.toContain("Opus 5.5");
  await act(async () => claude.root.unmount());
});

test("a Fable conversation keeps its catalogue model: tiers stay enabled and an effort pick is sent on fable", async () => {
  for (const launchModel of ["fable", null] as const) {
    requests.length = 0;
    const fable: FileEntry = { ...claudeFile, model: "fable-5-1", launchModel, effort: "high" };
    const { host, root } = await renderPill(<RuntimePill file={fable} surface="structured" runtimeSettings={CLAUDE_STRUCTURED} />);
    expect(faceOf(host)).toContain("Fable");
    await click(host.querySelector("[data-runtime-pill]")!);
    expect(host.ownerDocument.querySelector("[data-runtime-hold]")).toBeNull();
    const tiers = [...host.ownerDocument.querySelectorAll('[data-runtime-row="tier"]')];
    expect(tiers.length).toBeGreaterThan(0);
    expect(tiers.some((row) => row.hasAttribute("aria-disabled"))).toBe(false);
    await click(tiers.find((row) => row.getAttribute("aria-checked") !== "true")!);
    expect(requests.at(-1)).toMatchObject({ action: "reconfigure", model: "fable" });
    await act(async () => root.unmount());
  }
});

test("a live Fable conversation settles its reconfigure once the transcript's release reports the effort picked", async () => {
  const fable: FileEntry = { ...claudeFile, model: "fable-5-1", launchModel: "fable", effort: "high" };
  const { host, root } = await renderPill(<RuntimePill file={fable} surface="live-root" runtimeSettings={CLAUDE_STRUCTURED} />);
  await click(host.querySelector("[data-runtime-pill]")!);
  await click([...host.ownerDocument.querySelectorAll('[data-runtime-row="tier"]')].find((row) => row.textContent === "Medium")!);
  expect(requests.at(-1)).toMatchObject({ action: "reconfigure", model: "fable", effort: "medium" });
  const phase = "llvAgentRuntime:conversation_claude:phase";
  expect(localStorage.getItem(phase)).toBe("confirming");
  /* A poll that has not moved the effort yet leaves the change confirming. */
  await rerender(root, <RuntimePill file={{ ...fable, mtime: 2 }} surface="live-root" runtimeSettings={CLAUDE_STRUCTURED} />);
  expect(localStorage.getItem(phase)).toBe("confirming");
  await rerender(root, <RuntimePill file={{ ...fable, mtime: 3, effort: "medium" }} surface="live-root" runtimeSettings={CLAUDE_STRUCTURED} />);
  expect(localStorage.getItem(phase)).toBeNull();
  await act(async () => root.unmount());
});

test("a held conversation says why in visible text, with other words for no model and for a model the pickers cannot send", async () => {
  const held = async (file: FileEntry, phone: boolean) => {
    mobile = phone;
    const { host, root } = await renderPill(<RuntimePill file={file} surface="structured" runtimeSettings={CODEX_STRUCTURED} />);
    await click(host.querySelector("[data-runtime-pill]")!);
    const line = host.ownerDocument.querySelector("[data-runtime-hold]")?.textContent ?? null;
    await act(async () => root.unmount());
    return line;
  };
  for (const phone of [false, true]) {
    const unknown = await held({ ...codexFile, model: null, launchModel: null }, phone);
    const unlisted = await held({ ...codexFile, model: "gpt-5.5", launchModel: null }, phone);
    expect(unknown).toContain("No model reported yet");
    expect(unlisted).toContain("gpt-5.5");
    expect(unlisted).toContain("not in the model list");
    expect(unlisted).not.toBe(unknown);
    expect(await held(codexFile, phone)).toBeNull();
  }
});
