import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";

import type { AccountRemovalRefusal } from "@/hooks/useEngineAccounts";
import { installActEnv } from "@/test-helpers/actEnv";
import { installOnboardingDom } from "@/test-helpers/onboardingDom";

import type { CopilotAccountRow, CopilotAccounts } from "./CopilotFooterRow";

/* Task d7759de2: Copilot accounts are removed through the same remove control
   as Claude and Codex ones: arm, confirm, and a refusal that names live work. */

installOnboardingDom();
installActEnv();
const { createRoot } = await import("react-dom/client");
const { CopilotAccountList, useCopilotAccounts } = await import("./CopilotFooterRow");

const row = (over: Partial<CopilotAccountRow> & { id: string; label: string }): CopilotAccountRow => ({
  kind: "managed", active: false, auth: "signed_in", user: "fixture-user", loginCommand: null, login: null, ...over,
});

function accounts(over: Partial<CopilotAccounts> = {}): CopilotAccounts {
  return {
    body: { cli: { present: true, reason: null }, active: "work", accounts: [row({ id: "default", label: "Default", kind: "legacy" }), row({ id: "work", label: "Work", active: true })] },
    error: null, copied: null, refusal: null,
    load: async () => {}, post: async () => true, copy: async () => {}, remove: async () => {}, dismissRefusal: () => {},
    ...over,
  };
}

let mounted: { root: Root; host: HTMLDivElement } | null = null;
afterEach(async () => {
  if (mounted) {
    await act(async () => mounted!.root.unmount());
    mounted.host.remove();
    mounted = null;
  }
});

async function render(value: CopilotAccounts): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(<CopilotAccountList accounts={value} />));
  return host;
}

const click = async (element: Element | null) => {
  await act(async () => (element as HTMLElement).click());
};

test("a Copilot account arms on Remove and is removed only on the confirm", async () => {
  const removed: string[] = [];
  const host = await render(accounts({ remove: async (account) => { removed.push(account.id); } }));
  await click(host.querySelector('[data-account-remove="work"]'));
  expect(removed).toEqual([]);
  const armed = host.querySelector('[data-account-remove-armed="work"]')!;
  expect(armed.textContent).toContain("Remove Work? Its sign-in file is deleted");
  await click(armed.querySelector('[data-account-remove-confirm="work"]'));
  expect(removed).toEqual(["work"]);
});

test("the default Copilot home arms with the hide wording, and a refusal names its live work", async () => {
  const refusal: AccountRemovalRefusal = { accountId: "work", label: "Work", reasons: ["live_sessions"], sessions: [{ conversationId: "conversation_copilot", path: null, title: "Copilot task" }], sessionCount: 1 };
  const host = await render(accounts({ refusal }));
  await click(host.querySelector('[data-account-remove="default"]'));
  expect(host.querySelector('[data-account-remove-armed="default"]')!.textContent).toContain("Nothing in its own folder is deleted");
  const link = host.querySelector('[data-copilot-account="work"] [data-account-refusal-sessions] a') as HTMLAnchorElement;
  expect(link.textContent).toBe("Copilot task");
  expect(link.getAttribute("href")).toBe("#c=conversation_copilot");
});

test("a hidden Copilot Default is offered back in the list and restored through the route's restore", async () => {
  const posted: Record<string, unknown>[] = [];
  const host = await render(accounts({
    body: { cli: { present: true, reason: null }, active: "work", accounts: [row({ id: "work", label: "Work", active: true })], hidden: [{ id: "default", label: "Default" }] },
    post: async (payload) => { posted.push(payload); return true; },
  }));
  expect(host.querySelector('[data-copilot-account="default"]')).toBeNull();
  const offer = host.querySelector('[data-account-hidden-offer="default"]')!;
  expect(offer.textContent).toContain("Default is removed from Delegatus. Its folder is untouched.");
  await click(offer.querySelector('[data-account-restore="default"]'));
  expect(posted).toEqual([{ action: "restore", id: "default" }]);
});

/* Audit B33, B37: through the real hook, «Use» moves the active badge at once
   and both rows wait; a restore puts Default back at once; a refusal takes
   either back with the reason, and an "already listed" answer is a restore. */
async function renderLive(body: object, answer: () => Promise<Response>) {
  const posts: unknown[] = [];
  const saved = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== "POST") return Response.json(body);
    posts.push(JSON.parse(String(init.body)));
    return answer();
  }) as typeof fetch;
  function Live() {
    return <CopilotAccountList accounts={useCopilotAccounts({ polling: false })} />;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => { root.render(<Live />); await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { host, posts, restore: () => { globalThis.fetch = saved; } };
}
function held(): { answer: () => Promise<Response>; release: (response: Response) => Promise<void> } {
  let release: (response: Response) => void = () => {};
  return {
    answer: () => new Promise<Response>((resolve) => { release = resolve; }),
    release: (response) => act(async () => { release(response); await new Promise((resolve) => setTimeout(resolve, 0)); }),
  };
}
const LISTED = { cli: { present: true, reason: null }, active: "work", accounts: [row({ id: "default", label: "Default", kind: "legacy" }), row({ id: "work", label: "Work", active: true })] };

test("«Use» moves the active badge at once, both rows wait for the answer, and a refusal moves it back with the reason", async () => {
  const server = held();
  const live = await renderLive(LISTED, server.answer);
  try {
    const selectButton = (id: string) => live.host.querySelector(`[data-copilot-account="${id}"] button.text-accent`) as HTMLButtonElement | null;
    const badge = (id: string) => live.host.querySelector(`[data-copilot-account="${id}"]`)!.textContent!.includes("active");
    await click(selectButton("default"));
    expect(badge("default")).toBe(true);
    expect(badge("work")).toBe(false);
    expect(selectButton("work")!.disabled).toBe(true);
    await click(selectButton("work"));
    expect(live.posts).toEqual([{ action: "select", id: "default" }]);
    await server.release(Response.json({ error: "Copilot accounts are busy" }, { status: 503 }));
    expect(badge("work")).toBe(true);
    expect(selectButton("default")!.disabled).toBe(false);
    expect(live.host.querySelector('[role="alert"]')!.textContent).toBe("Copilot accounts are busy");
  } finally { live.restore(); }
});

test("a restored Default is listed at once with its sign-in unchecked, a refusal offers it again, and an already-listed answer keeps it", async () => {
  const hidden = { cli: { present: true, reason: null }, active: "work", accounts: [row({ id: "work", label: "Work", active: true })], hidden: [{ id: "default", label: "Default" }] };
  const server = held();
  const live = await renderLive(hidden, server.answer);
  try {
    await click(live.host.querySelector('[data-account-restore="default"]'));
    expect(live.host.querySelector('[data-copilot-account="default"] [data-copilot-account-status]')!.textContent).toBe("sign-in status unknown");
    expect(live.host.querySelector('[data-account-hidden-offer="default"]')).toBeNull();
    expect(live.posts).toEqual([{ action: "restore", id: "default" }]);
    await server.release(Response.json({ error: "Copilot accounts are busy" }, { status: 503 }));
    expect(live.host.querySelector('[data-copilot-account="default"]')).toBeNull();
    expect(live.host.querySelector('[data-account-hidden-offer="default"]')).not.toBeNull();
    expect(live.host.querySelector('[role="alert"]')!.textContent).toBe("Copilot accounts are busy");

    await click(live.host.querySelector('[data-account-restore="default"]'));
    await server.release(Response.json({ error: "Default is already listed" }, { status: 404 }));
    expect(live.host.querySelector('[role="alert"]')).toBeNull();
    expect(live.posts).toHaveLength(2);
  } finally { live.restore(); }
});
