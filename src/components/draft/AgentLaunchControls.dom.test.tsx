import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { setLocale } from "@/lib/i18n";

/*
 * The SHARED launch controls (PRD #976 slice A): one module owns engine, model,
 * effort, codex speed and the stored account for every «start an agent» surface,
 * so the orchestrator panel (#977), its rotate flow (#978) and the mobile create
 * sheet (#979) cannot drift apart. What is tested here is the contract those
 * slices depend on — the invariants that tie the fields together, and the
 * per-engine account catalog.
 */

const dom = new HappyWindow();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLSelectElement: dom.HTMLSelectElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
});

const {
  AgentLaunchControls,
  launchAccountCatalogOf,
  resolveLaunchAccountId,
  useAgentLaunchDraft,
} = await import("./AgentLaunchControls");

const catalog = {
  claude: { active: "primary", accounts: [{ id: "primary", label: "primary", authPresent: true }, { id: "spare", label: "spare", authPresent: false }] },
  codex: { active: "codex-a", accounts: [{ id: "codex-a", label: "codex-a", authPresent: true }] },
};

const realFetch = globalThis.fetch;
const roots = new Set<Root>();
beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === "/api/accounts") return { ok: true, status: 200, json: async () => catalog } as Response;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as typeof fetch;
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  dom.sessionStorage.clear();
  setLocale("en");
  globalThis.fetch = realFetch;
});

/** A host that keeps the draft in one place, like a real surface does. */
const store = new Map<string, string>();
function Harness({ onDraft }: { onDraft: (draft: ReturnType<typeof useAgentLaunchDraft>) => void }) {
  const draft = useAgentLaunchDraft({
    storage: {
      read: (name) => store.get(name) ?? "",
      write: (name, value) => {
        if (value) store.set(name, value);
        else store.delete(name);
      },
    },
    initialEngine: "claude",
    initialModel: "opus",
    initialEffort: "low",
  });
  onDraft(draft);
  return <AgentLaunchControls draft={draft} stacked />;
}

function mount(): { host: HTMLElement; draft: () => ReturnType<typeof useAgentLaunchDraft> } {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  let latest: ReturnType<typeof useAgentLaunchDraft> | null = null;
  flushSync(() => root.render(<Harness onDraft={(draft) => { latest = draft; }} />));
  return { host: host as unknown as HTMLElement, draft: () => latest! };
}

const settle = async () => {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

test("a surface's canonical configuration is the opening state, and it persists through the host", async () => {
  store.clear();
  const { draft } = mount();
  await settle();
  expect(draft().engine).toBe("claude");
  expect(draft().model).toBe("opus");
  expect(draft().effort).toBe("low");

  flushSync(() => draft().setEffort("high"));
  expect(store.get("effort")).toBe("high");
});

test("switching engines preserves max supported by the new default model", async () => {
  store.clear();
  const { draft } = mount();
  await settle();
  flushSync(() => draft().setEffort("max"));
  flushSync(() => draft().setAccountId("spare"));
  expect(draft().accountId).toBe("spare");

  flushSync(() => draft().setEngine("codex"));
  await settle();

  expect(draft().engine).toBe("codex");
  expect(draft().model).not.toBe("opus");
  /* Astra supports the existing max selection. */
  expect(draft().effort).toBe("max");
  expect(draft().accountId).toBe("");
  expect(draft().launchAccountId).toBe("codex-a");
});

test("the account offered is per engine, and the value shown is the value sent", async () => {
  store.clear();
  const { host, draft } = mount();
  await settle();
  flushSync(() => undefined);

  const claudeSelect = host.querySelector('select[aria-label*="Claude"]') as HTMLSelectElement;
  expect([...claudeSelect.options].map((option) => option.value)).toEqual(["primary", "spare"]);
  /* A signed-out profile stays listed for history, but cannot be picked. */
  expect([...claudeSelect.options].map((option) => option.disabled)).toEqual([false, true]);
  expect(draft().launchAccountId).toBe("primary");

  flushSync(() => draft().setEngine("codex"));
  await settle();
  flushSync(() => undefined);
  expect(host.querySelector('select[aria-label*="Claude"]')).toBeNull();
  expect(host.querySelector('select[aria-label*="Codex"]')).not.toBeNull();
});

test("both engines' chips are offered, and the speed picker is codex-only", async () => {
  store.clear();
  const { host, draft } = mount();
  await settle();
  flushSync(() => undefined);

  expect([...host.querySelectorAll('[role="radio"]')].map((node) => node.textContent)).toEqual(["Claude", "Codex"]);
  expect(host.querySelector('select[aria-label*="Speed"]')).toBeNull();

  flushSync(() => draft().setEngine("codex"));
  await settle();
  flushSync(() => undefined);
  expect(host.querySelector('select[aria-label*="peed"]')).not.toBeNull();
});

test("an account id nobody offers falls back to the engine's active one", () => {
  const parsed = launchAccountCatalogOf(catalog);
  expect(resolveLaunchAccountId(parsed, "claude", "removed")).toBe("primary");
  expect(resolveLaunchAccountId(parsed, "claude", "spare")).toBe("spare");
  expect(resolveLaunchAccountId(parsed, "codex", "primary")).toBe("codex-a");
  expect(resolveLaunchAccountId(null, "claude", "primary")).toBe("");
});

test("a malformed accounts body hides the selector rather than breaking the draft", () => {
  const parsed = launchAccountCatalogOf({ claude: { accounts: [{ id: 5 }] }, codex: null });
  expect(parsed.claude.accounts).toEqual([]);
  expect(parsed.codex.accounts).toEqual([]);
  expect(parsed.claude.active).toBe("");
});


test.each([
  ["gpt-6-astra", "ultra", "gpt-5.6-luna"],
  ["gpt-6-astra", "max", "gpt-5.6-luna"],
  ["gpt-6-sol", "ultra", "gpt-6-luna"],
  ["gpt-6-sol", "max", "gpt-6-luna"],
] as const)("model switch reconciles and persists %s/%s for %s", async (from, effort, to) => {
  store.clear();
  store.set("engine", "codex");
  store.set("model", from);
  store.set("effort", effort);
  const { host, draft } = mount();
  await settle();
  const model = host.querySelector('select[aria-label="Agent model"]') as HTMLSelectElement;
  flushSync(() => {
    model.value = to;
    model.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event);
  });
  const expected = effort === "ultra" ? "" : effort;
  expect((host.querySelector('select[aria-label="Reasoning effort level"]') as HTMLSelectElement).value).toBe(expected);
  expect(draft().model).toBe(to);
  expect(draft().effort).toBe(expected);
  expect(store.get("effort")).toBe(expected || undefined);
});

/* #2170: what the engine readiness preflight reads out of `/api/accounts`. */
test("an account is signed out by its reconciled auth state, and an unreadable credential store is not signed out", async () => {
  const { launchAccountSection, launchReadiness } = await import("./AgentLaunchControls");
  const section = launchAccountSection({
    active: "default",
    accounts: [
      { id: "default", label: "Main", authPresent: false, auth: { state: "signed_out" } },
      { id: "locked", label: "Locked", authPresent: false, auth: { state: "unknown" } },
      { id: "expired", label: "Expired", authPresent: true, auth: { state: "signed_out" } },
      { id: "copilot-shape", label: "Copilot", authPresent: false },
    ],
  });
  expect(section.accounts.map((account) => [account.id, account.signedOut])).toEqual([
    ["default", true],
    ["locked", false],
    ["expired", true],
    ["copilot-shape", true],
  ]);
  const catalog = { claude: section, codex: { active: "", accounts: [] }, copilot: { active: "", accounts: [] } };
  expect(launchReadiness({ engine: "claude", catalog, launchAccountId: "default" })).toEqual({ kind: "signed-out", engine: "claude", accountId: "default", label: "Main" });
  expect(launchReadiness({ engine: "claude", catalog, launchAccountId: "locked" })).toEqual({ kind: "ready" });
  /* No catalog yet: nothing is known, so nothing is stopped here. */
  expect(launchReadiness({ engine: "claude", catalog: null, launchAccountId: "" })).toEqual({ kind: "ready" });
});
