import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";

import type { AccountOption, EngineAccountsState } from "@/hooks/useEngineAccounts";
import { installActEnv } from "@/test-helpers/actEnv";
import { installOnboardingDom } from "@/test-helpers/onboardingDom";

/*
 * Several accounts per engine (#2004, design §2.1): the Engines card is the
 * engine's account list, every account with its state, and the accounts
 * panel's own "Add a {engine} account" row last. The header line names the
 * account future launches use.
 */

installOnboardingDom();
installActEnv();
const { createRoot } = await import("react-dom/client");
const { EnginesStep } = await import("./EnginesStep");

function account(over: Partial<AccountOption> & { id: string; label: string }): AccountOption {
  return { kind: "managed", authPresent: true, authHealth: "authenticated", loginPending: false, loginState: "authenticated", deviceAuth: null, login: null, ...over } as AccountOption;
}

function engineState(engine: "claude" | "codex", accounts: AccountOption[], active: string): EngineAccountsState {
  return {
    engine, accounts, active, identityVersion: 0, status: "ready", notice: null, challenge: null, mutation: null, migration: null, autoBalance: null,
    refresh: async () => true, add: async () => true, retryNotice: async () => true, select: async () => true, submitLoginCode: async () => true,
    cancelLogin: async () => true, retryLogin: async () => true, remove: async () => true, cleanupOrphans: async () => true, copyTerminalCommand: async () => true,
    refreshLimits: async () => true, useResetCredit: async () => true, limitsBusy: null, limitsVersion: 0, removing: null, removal: null, dismissRemoval: () => {},
  } as EngineAccountsState;
}

let mounted: { root: Root; host: HTMLDivElement } | null = null;
afterEach(async () => {
  if (mounted) {
    await act(async () => mounted!.root.unmount());
    mounted.host.remove();
    mounted = null;
  }
});

async function mount(claude: EngineAccountsState, codex: EngineAccountsState, cli: { claude: "found" | "missing"; codex: "found" | "missing" } = { claude: "found", codex: "found" }): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(<EnginesStep claude={claude} codex={codex} cli={cli} now={1_800_000_000} onRecheck={() => {}} />));
  return host;
}

test("three accounts on one engine list three rows and the add row, and the header names the active one", async () => {
  const claude = engineState("claude", [
    account({ id: "cl-main", label: "Main", plan: "max" }),
    account({ id: "cl-lab", label: "Lab", plan: "pro" }),
    account({ id: "cl-spare", label: "Spare", authPresent: false, authHealth: "signed_out", loginState: "idle" }),
  ], "cl-lab");
  const codex = engineState("codex", [account({ id: "cx-main", label: "Main", plan: "pro" })], "cx-main");
  const host = await mount(claude, codex);

  const card = host.querySelector("[data-onboarding-engine=claude]")!;
  const rows = Array.from(card.querySelectorAll("[data-mobile2-account]")).map((row) => row.getAttribute("data-mobile2-account"));
  expect(rows.sort()).toEqual(["cl-lab", "cl-main", "cl-spare"]);
  expect(card.querySelector("[data-mobile2-account=cl-spare]")?.getAttribute("data-mobile2-account-state")).toBe("needsSignIn");
  expect(card.querySelector("[data-mobile2-account-add=claude]")).not.toBeNull();
  expect(card.querySelector("[data-onboarding-engine-header]")?.textContent).toBe("3 accounts · Lab is active · 1 needs sign-in");
  /* The old "Sign in" toggle is gone: the rows carry their own sign-in. */
  expect(card.querySelector("[data-onboarding-sign-in]")).toBeNull();

  const codexCard = host.querySelector("[data-onboarding-engine=codex]")!;
  expect(codexCard.querySelector("[data-onboarding-engine-header]")?.textContent).toBe("Connected · pro");
  expect(codexCard.querySelectorAll("[data-mobile2-account]").length).toBe(1);
  expect(codexCard.querySelector("[data-mobile2-account-add=codex]")).not.toBeNull();
});

test("an engine with no account still offers the add row as its way in", async () => {
  const host = await mount(engineState("claude", [], ""), engineState("codex", [], ""));
  const card = host.querySelector("[data-onboarding-engine=codex]")!;
  expect(card.getAttribute("data-engine-state")).toBe("signed-out");
  expect(card.querySelector("[data-mobile2-account-add=codex]")).not.toBeNull();
});

test("an engine whose command is missing lists its accounts but offers no sign-in or add until it is installed", async () => {
  const codex = engineState("codex", [account({ id: "cx-main", label: "Main", authPresent: false, authHealth: "signed_out", loginState: "idle" })], "cx-main");
  const host = await mount(engineState("claude", [account({ id: "cl-main", label: "Main" })], "cl-main"), codex, { claude: "found", codex: "missing" });
  const card = host.querySelector("[data-onboarding-engine=codex]")!;
  expect(card.getAttribute("data-engine-state")).toBe("missing");
  expect(card.querySelector("[data-mobile2-account=cx-main]")).not.toBeNull();
  /* Pressing sign-in or add would run the command that is not there. */
  expect(card.querySelector("[data-onboarding-accounts=codex]")?.hasAttribute("inert")).toBe(true);
  expect(card.textContent).toContain("Install the Codex CLI");
  expect(host.querySelector("[data-onboarding-accounts=claude]")?.hasAttribute("inert")).toBe(false);
});
