import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";

import type { AccountOption, EngineAccountsState } from "@/hooks/useEngineAccounts";
import { installActEnv } from "@/test-helpers/actEnv";
import { installOnboardingDom, jsonResponse } from "@/test-helpers/onboardingDom";

/*
 * Several accounts per engine (#2004, design §2.1): the Engines card is the
 * engine's account list, every account with its state, and the accounts
 * panel's own "Add a {engine} account" row last. The header line names the
 * account future launches use.
 */

const dom = installOnboardingDom();
installActEnv();
const { createRoot } = await import("react-dom/client");
const { EnginesStep } = await import("./EnginesStep");

function account(over: Partial<AccountOption> & { id: string; label: string }): AccountOption {
  return { kind: "managed", authPresent: true, authHealth: "authenticated", loginPending: false, loginState: "authenticated", deviceAuth: null, login: null, ...over } as AccountOption;
}

function engineState(engine: "claude" | "codex", accounts: AccountOption[], active: string): EngineAccountsState {
  return {
    engine, accounts, hidden: [], active, identityVersion: 0, status: "ready", notice: null, challenge: null, mutation: null, migration: null, autoBalance: null,
    refresh: async () => true, add: async () => true, retryNotice: async () => true, select: async () => true, submitLoginCode: async () => true,
    cancelLogin: async () => true, retryLogin: async () => true, remove: async () => true, restore: async () => true, cleanupOrphans: async () => true, copyTerminalCommand: async () => true,
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

/* What `/api/accounts/copilot` answers: the Copilot command is present unless a case says it is not. */
let copilotPresent = true;
dom.setRoute((url) => url.includes("/api/accounts/copilot") ? jsonResponse({ cli: { present: copilotPresent, reason: null }, active: "", accounts: [] }) : undefined);

async function mount(claude: EngineAccountsState, codex: EngineAccountsState, cli: { claude: "found" | "missing"; codex: "found" | "missing" } = { claude: "found", codex: "found" }, onRecheck: () => void = () => {}): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(<EnginesStep claude={claude} codex={codex} cli={cli} now={1_800_000_000} onRecheck={onRecheck} />));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
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

test("an engine whose command is missing shows the install command with a copy control and offers no account rows", async () => {
  const codex = engineState("codex", [account({ id: "cx-main", label: "Main", authPresent: false, authHealth: "signed_out", loginState: "idle" })], "cx-main");
  const host = await mount(engineState("claude", [account({ id: "cl-main", label: "Main" })], "cl-main"), codex, { claude: "found", codex: "missing" });
  const card = host.querySelector("[data-onboarding-engine=codex]")!;
  expect(card.getAttribute("data-engine-state")).toBe("missing");
  expect(card.querySelector("[data-onboarding-engine-header]")?.textContent).toBe("Not installed");
  /* A missing command has no sign-in or add row to press. */
  expect(card.querySelector("[data-onboarding-accounts]")).toBeNull();
  expect(card.querySelector("[data-mobile2-account]")).toBeNull();
  expect(card.querySelector("[data-onboarding-claude-signin]")).toBeNull();
  expect(card.textContent).toContain("Paste this into Terminal on the computer running Delegatus, then press Check again.");
  expect(card.querySelector("code")?.textContent).toBe("curl -fsSL https://chatgpt.com/codex/install.sh | sh");
  expect(card.querySelector("button[aria-label='Copy command']")).not.toBeNull();
  expect(host.querySelector("[data-onboarding-accounts=claude]")).not.toBeNull();
  /* Only the engine without a tool shows a command. */
  expect(host.querySelector("[data-onboarding-engine=claude] code")).toBeNull();
});

test("Claude without its tool carries its own command and no second-sign-in note", async () => {
  const host = await mount(engineState("claude", [], ""), engineState("codex", [account({ id: "cx-main", label: "Main" })], "cx-main"), { claude: "missing", codex: "found" });
  const card = host.querySelector("[data-onboarding-engine=claude]")!;
  expect(card.querySelector("code")?.textContent).toBe("curl -fsSL https://claude.ai/install.sh | bash");
  expect(card.querySelector("[data-onboarding-claude-signin]")).toBeNull();
  expect(card.querySelector("[data-onboarding-accounts]")).toBeNull();
});

test("with no tool at all there is exactly one Check again, on the first card, and it looks for all three tools", async () => {
  copilotPresent = false;
  try {
    let rechecks = 0;
    const host = await mount(engineState("claude", [], ""), engineState("codex", [], ""), { claude: "missing", codex: "missing" }, () => { rechecks += 1; });
    const buttons = Array.from(host.querySelectorAll("button")).filter((button) => button.textContent === "Check again");
    expect(buttons).toHaveLength(1);
    expect(host.querySelector("[data-onboarding-engine=claude]")!.contains(buttons[0]!)).toBe(true);
    /* Copilot is not installed either, and its card holds no accounts and no button. */
    const copilot = host.querySelector("[data-onboarding-engine=copilot]")!;
    expect(copilot.getAttribute("data-engine-state")).toBe("missing");
    expect(copilot.querySelector("[data-onboarding-accounts]")).toBeNull();
    expect(copilot.textContent).toContain("Install the GitHub Copilot CLI");
    const before = dom.calls.filter((call) => call.url.includes("/api/accounts/copilot")).length;
    await act(async () => { (buttons[0] as HTMLButtonElement).click(); });
    expect(rechecks).toBe(1);
    expect(dom.calls.filter((call) => call.url.includes("/api/accounts/copilot")).length).toBe(before + 1);
  } finally {
    copilotPresent = true;
  }
});

test("the Check again button moves to the next card without a tool when the first has one", async () => {
  const host = await mount(engineState("claude", [account({ id: "cl-main", label: "Main" })], "cl-main"), engineState("codex", [], ""), { claude: "found", codex: "missing" });
  const buttons = Array.from(host.querySelectorAll("button")).filter((button) => button.textContent === "Check again");
  expect(buttons).toHaveLength(1);
  expect(host.querySelector("[data-onboarding-engine=codex]")!.contains(buttons[0]!)).toBe(true);
});

test("one engine connected needs no note; none connected puts its warning above the cards", async () => {
  const one = await mount(engineState("claude", [account({ id: "cl-main", label: "Main" })], "cl-main"), engineState("codex", [], ""), { claude: "found", codex: "missing" });
  expect(one.querySelector("[data-onboarding-engines-note]")).toBeNull();
  await act(async () => mounted!.root.unmount()); mounted!.host.remove(); mounted = null;
  const none = await mount(engineState("claude", [], ""), engineState("codex", [], ""), { claude: "found", codex: "found" });
  const note = none.querySelector("[data-onboarding-engines-note]")!;
  expect(note.textContent).toContain("Connect at least one engine");
  /* First in the step, before the cards. */
  expect(note.parentElement!.firstElementChild).toBe(note);
  expect(note.compareDocumentPosition(none.querySelector("[data-onboarding-engine=claude]")!) & 4).toBe(4);
});

test("Claude explains the expected second sign-in on its own card", async () => {
  const host = await mount(engineState("claude", [], ""), engineState("codex", [], ""));
  const note = host.querySelector("[data-onboarding-engine=claude] [data-onboarding-claude-signin]");
  expect(note?.textContent).toContain("own Claude sign-in in an isolated configuration");
  expect(note?.textContent).toContain("second sign-in is expected");
  expect(host.querySelector("[data-onboarding-engine=codex] [data-onboarding-claude-signin]")).toBeNull();
});
