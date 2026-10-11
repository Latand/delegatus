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
const { CopilotAccountList } = await import("./CopilotFooterRow");

const row = (over: Partial<CopilotAccountRow> & { id: string; label: string }): CopilotAccountRow => ({
  kind: "managed", active: false, auth: "signed_in", user: "fixture-user", loginCommand: null, login: null, ...over,
});

function accounts(over: Partial<CopilotAccounts> = {}): CopilotAccounts {
  return {
    body: { cli: { present: true, reason: null }, active: "work", accounts: [row({ id: "default", label: "Default", kind: "legacy" }), row({ id: "work", label: "Work", active: true })] },
    error: null, copied: null, refusal: null,
    load: async () => {}, post: async () => {}, copy: async () => {}, remove: async () => {}, dismissRefusal: () => {},
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
