import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";

import type { AccountOption, ClaudeLoginView, EngineAccountsState } from "@/hooks/useEngineAccounts";
import { AGENT_INSTALL_COMMANDS_POWERSHELL, ANTIGRAVITY_INSTALL_COMMAND, type HostPlatform } from "@/lib/onboarding/agentInstallCommands";
import { installActEnv } from "@/test-helpers/actEnv";
import { installOnboardingDom, jsonResponse, settle, typeInto } from "@/test-helpers/onboardingDom";

import type { AntigravityAccount } from "./AntigravityAccount";
import type { ProgramInstalls } from "./ProgramRowParts";

/*
 * The Accounts step as rows (docs/design/onboarding-v2.md §3.2): one row per
 * agent program, a status dot leading each state line, at most one action a
 * row, what the state calls for under the row, and one "Check again" on the
 * heading's line that looks for all four programs.
 */

const dom = installOnboardingDom();
installActEnv();
const { createRoot } = await import("react-dom/client");
const { EnginesStep, shortPath } = await import("./EnginesStep");
const { programInstalls } = await import("./ProgramRowParts");
const { formatResetClock } = await import("@/components/rateLimit");

/* Unix seconds, as the dialog hands the time down. */
const NOW = 1_800_000_000;

function account(over: Partial<AccountOption> & { id: string; label: string }): AccountOption {
  return { kind: "managed", authPresent: true, authHealth: "authenticated", loginPending: false, loginState: "authenticated", deviceAuth: null, login: null, ...over } as AccountOption;
}

const signedOut = (over: Partial<AccountOption> & { id: string; label: string }) => account({ authPresent: false, authHealth: "signed_out", loginState: "idle", ...over });

function engineState(engine: "claude" | "codex", accounts: AccountOption[], active: string, over: Partial<EngineAccountsState> = {}): EngineAccountsState {
  return {
    engine, accounts, hidden: [], active, identityVersion: 0, status: "ready", notice: null, challenge: null, mutation: null, migration: null, autoBalance: null,
    refresh: async () => true, add: async () => true, retryNotice: async () => true, select: async () => true, submitLoginCode: async () => true,
    cancelLogin: async () => true, retryLogin: async () => true, remove: async () => true, restore: async () => true, cleanupOrphans: async () => true, copyTerminalCommand: async () => true,
    refreshLimits: async () => true, useResetCredit: async () => true, limitsBusy: null, limitsVersion: 0, removing: null, removal: null, dismissRemoval: () => {},
    ...over,
  } as EngineAccountsState;
}

const login = (phase: ClaudeLoginView["phase"], over: Partial<ClaudeLoginView> = {}): ClaudeLoginView => ({ operationId: "op-1", phase, loginUrl: "https://claude.ai/oauth/authorize?state=fixture", acceptsCode: phase === "awaiting_code", deadlineAt: new Date((NOW + 600) * 1000).toISOString(), result: null, ...over });

/** A fresh read of the session window with this share of it spent. */
const sessionUsed = (usedPercent: number): AccountOption["limits"] => ({ freshness: "fresh", session: { usedPercent, resetsAt: NOW + 3600, windowMinutes: 300 }, weekly: null, checkedAt: new Date((NOW - 60) * 1000).toISOString() });

let mounted: { root: Root; host: HTMLDivElement } | null = null;
afterEach(async () => {
  if (mounted) {
    await act(async () => mounted!.root.unmount());
    mounted.host.remove();
    mounted = null;
  }
  copilot = { present: true, accounts: [SIGNED_IN_COPILOT] };
  codexRetry = null;
  dom.dom.happyDOM.setURL("http://127.0.0.1:8898/");
});

/* What `/api/accounts/copilot` answers: the command present and one account signed in, unless a case says otherwise. */
const SIGNED_IN_COPILOT = { id: "gh-main", label: "octo", auth: "signed_in", active: true };
let copilot: { present: boolean; accounts: unknown[] } = { present: true, accounts: [SIGNED_IN_COPILOT] };
/* What a Codex device sign-in is answered with, or null to refuse it. */
let codexRetry: { url: string; code: string } | null = null;
dom.setRoute((url, init) => {
  if (url.includes("/api/accounts/copilot")) return jsonResponse({ cli: { present: copilot.present, reason: null }, active: "", accounts: copilot.accounts });
  if (url.includes("/api/accounts/codex") && init?.method === "POST") return codexRetry ? jsonResponse({ deviceAuth: codexRetry }) : jsonResponse({ error: "refused" }, 500);
  return undefined;
});

/** Antigravity as the dialog hands it down: the recorded state, with its checks counted. */
function agyAccount(over: Partial<AntigravityAccount> = {}): AntigravityAccount {
  return { cli: "found", auth: "signed_in", plan: null, loaded: true, probing: false, inconclusive: false, probe: async () => {}, reload: async () => {}, ...over };
}

type Cli = { claude: "found" | "missing"; codex: "found" | "missing"; antigravity?: "found" | "missing" };
const FOUND: Cli = { claude: "found", codex: "found" };

async function mount(claude: EngineAccountsState, codex: EngineAccountsState, options: { cli?: Cli; onRecheck?: () => unknown; antigravity?: AntigravityAccount; platform?: HostPlatform; installs?: ProgramInstalls } = {}): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  /* The dialog's body: a status dot's popover reads this surface for the words it must not cover. */
  host.setAttribute("data-settings-scroller", "");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(<EnginesStep claude={claude} codex={codex} antigravity={options.antigravity ?? agyAccount()} cli={options.cli ?? FOUND} installs={options.installs} now={NOW} platform={options.platform} onRecheck={options.onRecheck ?? (() => {})} />));
  await act(async () => { await settle(); });
  return host;
}

const row = (host: HTMLElement, program: string) => host.querySelector<HTMLElement>(`[data-onboarding-programs] > [data-onboarding-engine=${program}]`)!;
const words = (host: HTMLElement, program: string) => row(host, program).querySelector("[data-onboarding-engine-header]")?.textContent;
const buttonsNamed = (root: ParentNode, name: string) => Array.from(root.querySelectorAll("button")).filter((button) => button.textContent === name);
const filled = (root: ParentNode) => Array.from(root.querySelectorAll("button")).filter((button) => button.className.split(/\s+/).includes("bg-brand"));
const one = () => engineState("claude", [account({ id: "cl-main", label: "Main", plan: "max" })], "cl-main");
const none = (engine: "claude" | "codex") => engineState(engine, [], "");

test("the step is four program rows in the list's order, each with its name and one status dot leading its state", async () => {
  copilot = { present: true, accounts: [] };
  const host = await mount(one(), engineState("codex", [signedOut({ id: "cx-main", label: "Main" })], "cx-main"), { antigravity: agyAccount({ auth: "signed_out" }) });
  const rows = Array.from(host.querySelectorAll("[data-onboarding-programs] > li"));
  expect(rows.map((item) => item.getAttribute("data-onboarding-engine"))).toEqual(["claude", "codex", "antigravity", "copilot"]);
  expect(rows.map((item) => item.querySelector("[data-settings-row-label]")?.textContent)).toEqual(["Claude Code", "Codex", "Antigravity", "Copilot"]);
  expect(rows.map((item) => item.getAttribute("data-engine-state"))).toEqual(["connected", "signed-out", "signed-out", "signed-out"]);
  expect(rows.map((item) => item.querySelector("[data-onboarding-engine-header]")?.textContent)).toEqual(["Connected · Max", "Installed, signed out", "Installed, signed out", "Installed, signed out"]);
  for (const item of rows) {
    const dots = item.querySelectorAll("[data-settings-dot]");
    expect(dots).toHaveLength(1);
    /* The dot comes before its words on their line. */
    expect(dots[0]!.compareDocumentPosition(item.querySelector("[data-onboarding-engine-header]")!) & 4).toBe(4);
    expect(dots[0]!.getAttribute("aria-label")).toContain(item.querySelector("[data-settings-row-label]")!.textContent!);
  }
});

test("the heading names the accounts and the lead says one signed-in account is enough", async () => {
  const host = await mount(one(), none("codex"));
  expect(host.querySelector("h2")?.textContent).toBe("Your agent accounts");
  expect(host.querySelector("[data-onboarding-accounts-lead]")?.textContent).toBe("Agents run through the programs below, on your own subscriptions. One signed-in account is enough to start.");
});

test("with nothing installed one Check again stands on the heading's line, outside every row, and looks for all four programs", async () => {
  copilot = { present: false, accounts: [] };
  let rechecks = 0;
  let agyReloads = 0;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const host = await mount(none("claude"), none("codex"), {
    cli: { claude: "missing", codex: "missing", antigravity: "missing" },
    onRecheck: () => { rechecks += 1; return held; },
    antigravity: agyAccount({ cli: "missing", auth: "unknown", reload: async () => { agyReloads += 1; } }),
  });
  const buttons = buttonsNamed(host, "Check again");
  expect(buttons).toHaveLength(1);
  const button = buttons[0] as HTMLButtonElement;
  expect(button.closest("[data-onboarding-engine]")).toBeNull();
  expect(button.parentElement!.querySelector("h2")?.textContent).toBe("Your agent accounts");

  const before = dom.calls.filter((call) => call.url.includes("/api/accounts/copilot")).length;
  await act(async () => { button.click(); await settle(); });
  expect(rechecks).toBe(1);
  expect(agyReloads).toBe(1);
  expect(dom.calls.filter((call) => call.url.includes("/api/accounts/copilot")).length).toBe(before + 1);
  /* It stays busy until the last of the four has answered. */
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("aria-busy")).toBe("true");
  await act(async () => { release(); await settle(); });
  expect(button.disabled).toBe(false);
  expect(button.getAttribute("aria-busy")).toBeNull();
});

test("with every program installed and signed in there is nothing left to look for, so no Check again", async () => {
  const host = await mount(one(), engineState("codex", [account({ id: "cx-main", label: "Main", plan: "pro" })], "cx-main"));
  expect(buttonsNamed(host, "Check again")).toHaveLength(0);
  expect(words(host, "copilot")).toBe("Connected · octo");
});

test("a program that is not installed shows its command to copy and the sentence that points at the step's Check again", async () => {
  const codex = engineState("codex", [signedOut({ id: "cx-main", label: "Main" })], "cx-main");
  const host = await mount(one(), codex, { cli: { claude: "found", codex: "missing" } });
  const item = row(host, "codex");
  expect(item.getAttribute("data-engine-state")).toBe("missing");
  expect(words(host, "codex")).toBe("Not installed");
  expect(item.querySelector("[data-onboarding-install=codex] p")?.textContent).toBe("Paste this into Terminal on the computer running Delegatus, then press Check again beside this step's heading.");
  expect(item.querySelector("code")?.textContent).toBe("curl -fsSL https://chatgpt.com/codex/install.sh | sh");
  expect(item.querySelector("button[aria-label='Copy command']")).not.toBeNull();
  /* A missing command has no sign-in and no account to add: the row's only control besides the dot copies the command. */
  expect(item.querySelector("[data-onboarding-sign-in], [data-onboarding-add-account], [data-onboarding-accounts]")).toBeNull();
  /* Only the program without its command shows one. */
  expect(row(host, "claude").querySelector("code")).toBeNull();
  expect(buttonsNamed(host, "Check again")).toHaveLength(1);
});

test("on Windows a missing row shows the vendor's PowerShell line, and Codex asks for WSL 2 with no command", async () => {
  const host = await mount(none("claude"), none("codex"), { cli: { claude: "missing", codex: "missing", antigravity: "missing" }, antigravity: agyAccount({ cli: "missing", auth: "unknown" }), platform: "win32" });
  expect(row(host, "claude").querySelector("code")?.textContent).toBe(AGENT_INSTALL_COMMANDS_POWERSHELL.claude.command);
  expect(row(host, "claude").querySelector("[data-onboarding-install] p")?.textContent).toBe("Paste this into PowerShell on the computer running Delegatus, then press Check again beside this step's heading.");
  expect(row(host, "antigravity").querySelector("code")?.textContent).toBe(AGENT_INSTALL_COMMANDS_POWERSHELL.antigravity.command);
  const codex = row(host, "codex");
  expect(codex.getAttribute("data-engine-state")).toBe("unsupported");
  expect(words(host, "codex")).toBe("Needs WSL 2 on Windows");
  expect(codex.querySelector("code")).toBeNull();
  expect(codex.textContent).toContain("Start Delegatus inside WSL 2 to use Codex.");
  /* The popover of a missing program names every place Windows was searched, the installers' AppData folders among them. */
  for (const program of ["claude", "antigravity"]) expect(await popoverOf(host, program)).toBe("Not found in ~/.local/bin, ~/.bun/bin, AppData\\Local or PATH.");
});

test("on Windows an installed Codex is an ordinary row", async () => {
  const host = await mount(one(), engineState("codex", [account({ id: "cx-main", label: "Main", plan: "plus" })], "cx-main"), { platform: "win32" });
  expect(row(host, "codex").getAttribute("data-engine-state")).toBe("connected");
  expect(words(host, "codex")).toBe("Connected · Plus");
});

test("Sign in on a signed-out Claude Code row starts that account's sign-in, and it is the step's one filled button", async () => {
  const started: string[] = [];
  const claude = engineState("claude", [signedOut({ id: "cl-main", label: "Main" })], "cl-main", { retryLogin: async (id: string) => { started.push(id); return true; } });
  const codex = engineState("codex", [signedOut({ id: "cx-main", label: "Main" })], "cx-main");
  const host = await mount(claude, codex, { antigravity: agyAccount({ auth: "signed_out" }) });
  const signIn = row(host, "claude").querySelector<HTMLButtonElement>("[data-onboarding-sign-in=cl-main]")!;
  expect(signIn.textContent).toBe("Sign in");
  /* Claude Code is the first program that needs an action; Codex offers the same button with a border. */
  expect(filled(host).map((button) => button.getAttribute("data-onboarding-sign-in"))).toEqual(["cl-main"]);
  expect(row(host, "codex").querySelector("[data-onboarding-sign-in=cx-main]")).not.toBeNull();
  await act(async () => { signIn.click(); await settle(); });
  expect(started).toEqual(["cl-main"]);
});

test("once an agent account is signed in no row holds a filled button: the footer's Continue is the one", async () => {
  const host = await mount(one(), engineState("codex", [signedOut({ id: "cx-main", label: "Main" })], "cx-main"));
  expect(row(host, "codex").querySelector("[data-onboarding-sign-in=cx-main]")).not.toBeNull();
  expect(filled(host)).toHaveLength(0);
});

test("Sign in on a Codex row asks for a device sign-in and shows its link and code under the row", async () => {
  codexRetry = { url: "https://auth.openai.com/codex/device", code: "ABCD-1234" };
  const codex = engineState("codex", [signedOut({ id: "cx-main", label: "Main" })], "cx-main");
  const host = await mount(one(), codex);
  await act(async () => { row(host, "codex").querySelector<HTMLButtonElement>("[data-onboarding-sign-in=cx-main]")!.click(); await settle(); });
  const post = dom.calls.find((call) => call.method === "POST" && call.url.includes("/api/accounts/codex"));
  expect(post?.body).toEqual({ action: "retry", id: "cx-main" });
  const item = row(host, "codex");
  expect(item.getAttribute("data-engine-state")).toBe("signing-in");
  expect(words(host, "codex")).toBe("Signing in");
  const block = item.querySelector("[data-account-signin=cx-main]")!;
  expect(block.textContent).toContain("ABCD-1234");
  expect(block.querySelector("a")?.getAttribute("href")).toBe("https://auth.openai.com/codex/device");
  expect(block.querySelector("[data-account-signin-cancel=cx-main]")).not.toBeNull();
  /* The row's own action is gone while the sign-in runs. */
  expect(item.querySelector("[data-onboarding-sign-in]")).toBeNull();
});

test("a Codex sign-in the server refuses leaves the row signed out with its Sign in", async () => {
  codexRetry = null;
  const host = await mount(one(), engineState("codex", [signedOut({ id: "cx-main", label: "Main" })], "cx-main"));
  await act(async () => { row(host, "codex").querySelector<HTMLButtonElement>("[data-onboarding-sign-in=cx-main]")!.click(); await settle(); });
  expect(row(host, "codex").getAttribute("data-engine-state")).toBe("signed-out");
  expect(row(host, "codex").querySelector("[data-onboarding-sign-in=cx-main]")).not.toBeNull();
  expect(row(host, "codex").querySelector("[data-account-signin]")).toBeNull();
});

test("a Claude Code account that awaits its code shows the code field under the row, and its Submit is the filled button", async () => {
  const submitted: Array<[string, string]> = [];
  const claude = engineState("claude", [signedOut({ id: "cl-main", label: "Main", loginPending: true, loginState: "pending", login: login("awaiting_code") })], "cl-main", {
    submitLoginCode: async (operationId: string, code: string) => { submitted.push([operationId, code]); return true; },
  });
  const host = await mount(claude, engineState("codex", [signedOut({ id: "cx-main", label: "Main" })], "cx-main"), { antigravity: agyAccount({ auth: "signed_out" }) });
  const item = row(host, "claude");
  expect(item.getAttribute("data-engine-state")).toBe("signing-in");
  expect(words(host, "claude")).toBe("Signing in");
  expect(item.querySelector("[data-onboarding-sign-in]")).toBeNull();
  const submit = item.querySelector<HTMLButtonElement>("[data-account-login-submit=cl-main]")!;
  /* The code holds the step's filled button, so the Codex row's Sign in is bordered. */
  expect(filled(host).map((button) => button.getAttribute("data-account-login-submit"))).toEqual(["cl-main"]);
  const field = item.querySelector<HTMLInputElement>("input")!;
  await act(async () => { typeInto(field, "code-from-the-browser"); });
  await act(async () => { submit.click(); await settle(); });
  expect(submitted).toEqual([["op-1", "code-from-the-browser"]]);
});

test("a Claude Code sign-in that failed says so under the row and offers its own retry in place of Sign in", async () => {
  const claude = engineState("claude", [signedOut({ id: "cl-main", label: "Main", login: login("failed", { result: { status: "failure", code: "timed_out", message: "" } }) })], "cl-main");
  const host = await mount(claude, none("codex"));
  const item = row(host, "claude");
  expect(item.getAttribute("data-engine-state")).toBe("signed-out");
  expect(item.querySelector("[data-onboarding-sign-in]")).toBeNull();
  expect(item.querySelector("[role=alert]")?.textContent).toContain("Retry");
  expect(buttonsNamed(item, "Retry")).toHaveLength(1);
});

test("a program with no account offers Add an account, which asks for a name and creates the account", async () => {
  const added: string[] = [];
  const codex = engineState("codex", [], "", { add: async (label: string) => { added.push(label); return true; } });
  const host = await mount(one(), codex);
  const item = row(host, "codex");
  expect(item.getAttribute("data-engine-state")).toBe("signed-out");
  expect(words(host, "codex")).toBe("Installed, signed out");
  const add = item.querySelector<HTMLButtonElement>("[data-onboarding-add-account=codex]")!;
  expect(add.textContent).toBe("Add an account");
  await act(async () => { add.click(); });
  const form = item.querySelector<HTMLFormElement>("[data-account-add-form=codex]")!;
  /* The form takes the action's place: the row still holds one way on. */
  expect(item.querySelector("[data-onboarding-add-account]")).toBeNull();
  await act(async () => { typeInto(form.querySelector("input")!, "  Work  "); });
  await act(async () => { form.querySelector<HTMLButtonElement>("button[type=submit]")!.click(); await settle(); });
  expect(added).toEqual(["Work"]);
  expect(item.querySelector("[data-account-add-form]")).toBeNull();
  expect(item.querySelector("[data-onboarding-add-account=codex]")).not.toBeNull();
});

test("an account the server did not create keeps the form open with the name typed", async () => {
  const codex = engineState("codex", [], "", { add: async () => false });
  const host = await mount(one(), codex);
  await act(async () => { row(host, "codex").querySelector<HTMLButtonElement>("[data-onboarding-add-account=codex]")!.click(); });
  const form = row(host, "codex").querySelector<HTMLFormElement>("[data-account-add-form=codex]")!;
  await act(async () => { typeInto(form.querySelector("input")!, "Work"); });
  await act(async () => { form.querySelector<HTMLButtonElement>("button[type=submit]")!.click(); await settle(); });
  expect(row(host, "codex").querySelector<HTMLInputElement>("[data-account-add-form=codex] input")?.value).toBe("Work");
});

test("one signed-in account reads its plan on the row, and Add an account is the row's one action", async () => {
  const host = await mount(one(), none("codex"));
  const item = row(host, "claude");
  expect(item.getAttribute("data-engine-state")).toBe("connected");
  expect(words(host, "claude")).toBe("Connected · Max");
  expect(item.querySelector("[data-onboarding-accounts]")).toBeNull();
  const actions = Array.from(item.querySelectorAll("button")).filter((button) => !button.hasAttribute("data-settings-dot"));
  expect(actions.map((button) => button.textContent)).toEqual(["Add an account"]);
});

test("several accounts unfold under the row: each with its dot, a dot that is not green with its reason in words, and Add an account last", async () => {
  const claude = engineState("claude", [
    account({ id: "cl-main", label: "Main", plan: "max", limits: sessionUsed(20) }),
    account({ id: "cl-lab", label: "Lab", plan: "pro", limits: sessionUsed(88) }),
    signedOut({ id: "cl-spare", label: "Spare" }),
  ], "cl-lab");
  const host = await mount(claude, engineState("codex", [account({ id: "cx-main", label: "Main", plan: "pro" })], "cx-main"));
  const item = row(host, "claude");
  expect(item.getAttribute("data-engine-state")).toBe("several");
  expect(words(host, "claude")).toBe("3 accounts · 1 needs sign-in");
  const lines = Array.from(item.querySelectorAll<HTMLElement>("[data-onboarding-accounts=claude] > [data-onboarding-account]"));
  expect(lines.map((line) => line.getAttribute("data-onboarding-account"))).toEqual(["cl-main", "cl-lab", "cl-spare"]);
  expect(lines.map((line) => line.querySelector("[data-settings-row-label]")?.textContent)).toEqual(["Main · Max", "Lab · Pro", "Spare"]);
  for (const line of lines) expect(line.querySelectorAll("[data-settings-dot]")).toHaveLength(1);
  expect(lines.map((line) => line.getAttribute("data-account-state"))).toEqual(["ready", "low", "needs-sign-in"]);
  /* A green dot needs no words; an amber one says why beside it. */
  expect(lines.map((line) => line.querySelector("[data-onboarding-account-words]")?.textContent ?? null)).toEqual([null, "12% of the session limit left", "needs sign-in"]);
  /* Only the account that waits offers a sign-in. */
  expect(Array.from(item.querySelectorAll("[data-onboarding-sign-in]")).map((button) => button.getAttribute("data-onboarding-sign-in"))).toEqual(["cl-spare"]);
  /* "Add an account" ends the list. */
  const add = item.querySelector("[data-onboarding-add-account=claude]")!;
  expect(lines.at(-1)!.compareDocumentPosition(add) & 4).toBe(4);
  /* One account is the same row without the list. */
  expect(row(host, "codex").querySelector("[data-onboarding-accounts]")).toBeNull();
});

test("Sign in beside one of several accounts starts that account's sign-in", async () => {
  const started: string[] = [];
  const claude = engineState("claude", [account({ id: "cl-main", label: "Main" }), signedOut({ id: "cl-spare", label: "Spare" })], "cl-main", { retryLogin: async (id: string) => { started.push(id); return true; } });
  const host = await mount(claude, none("codex"));
  await act(async () => { row(host, "claude").querySelector<HTMLButtonElement>("[data-onboarding-sign-in=cl-spare]")!.click(); await settle(); });
  expect(started).toEqual(["cl-spare"]);
});

test("while one of several accounts signs in, its block stands under its own line and Add an account waits", async () => {
  const claude = engineState("claude", [
    account({ id: "cl-main", label: "Main" }),
    signedOut({ id: "cl-spare", label: "Spare", loginPending: true, loginState: "pending", login: login("awaiting_code") }),
  ], "cl-main");
  const host = await mount(claude, none("codex"));
  const item = row(host, "claude");
  const spare = item.querySelector<HTMLElement>("[data-onboarding-account=cl-spare]")!;
  expect(spare.getAttribute("data-account-state")).toBe("signing-in");
  expect(spare.querySelector("[data-onboarding-account-words]")?.textContent).toBe("signing in");
  expect(spare.querySelector("[data-account-login-submit=cl-spare]")).not.toBeNull();
  expect(item.querySelector<HTMLElement>("[data-onboarding-account=cl-main]")!.querySelector("[data-account-login-submit]")).toBeNull();
  expect(item.querySelector<HTMLButtonElement>("[data-onboarding-add-account=claude]")!.disabled).toBe(true);
  /* An agent account is signed in already, so the code's Submit stays bordered. */
  expect(filled(host)).toHaveLength(0);
});

test("a status dot's popover adds what the state line leaves out", async () => {
  const host = await mount(none("claude"), none("codex"), { cli: { claude: "found", codex: "missing" } });
  const read = async (program: string) => {
    const dot = row(host, program).querySelector<HTMLButtonElement>("[data-settings-dot]")!;
    await act(async () => { dot.click(); });
    const text = document.querySelector("[data-settings-dot-popover]")?.textContent;
    await act(async () => { dot.click(); });
    return text;
  };
  expect(await read("claude")).toBe("Agents use their own Claude sign-in.");
  expect(await read("codex")).toBe("Not found in ~/.local/bin, ~/.bun/bin or PATH.");
  expect(await read("copilot")).toBe("Runs single agents. The orchestrator needs Claude or Codex.");
});

test("accounts that could not be read say so in amber, with a way to add one still there", async () => {
  const host = await mount(engineState("claude", [], "", { status: "error" }), none("codex"));
  expect(words(host, "claude")).toBe("Could not check sign-in.");
  expect(row(host, "claude").querySelector("[data-onboarding-add-account=claude]")).not.toBeNull();
});

test("a row whose accounts are still being read holds its place with no state and no action", async () => {
  const host = await mount(engineState("claude", [], "", { status: "loading" }), none("codex"));
  const item = row(host, "claude");
  expect(item.getAttribute("data-engine-state")).toBe("loading");
  expect(item.querySelector("[data-onboarding-engine-header]")).toBeNull();
  expect(item.querySelector("button")).toBeNull();
});

test("Antigravity has its own row, and a missing agy shows its install command", async () => {
  const host = await mount(one(), none("codex"), { cli: { claude: "found", codex: "found", antigravity: "missing" }, antigravity: agyAccount({ cli: "missing", auth: "unknown" }) });
  const item = row(host, "antigravity");
  expect(item.getAttribute("data-engine-state")).toBe("missing");
  expect(words(host, "antigravity")).toBe("Not installed");
  expect(item.querySelector("code")?.textContent).toBe(ANTIGRAVITY_INSTALL_COMMAND.command);
  expect(item.querySelector("button[aria-label='Copy command']")).not.toBeNull();
  /* No sign-in while the command is not there to run. */
  expect(item.querySelector("[data-antigravity-signin]")).toBeNull();
  expect(buttonsNamed(host, "Check again")).toHaveLength(1);
});

test("an installed agy that is signed out shows the agy command and a Check sign-in that runs the probe", async () => {
  let probes = 0;
  const host = await mount(none("claude"), none("codex"), { cli: { claude: "found", codex: "found", antigravity: "found" }, antigravity: agyAccount({ auth: "signed_out", probe: async () => { probes += 1; } }) });
  const item = row(host, "antigravity");
  expect(item.getAttribute("data-engine-state")).toBe("signed-out");
  expect(words(host, "antigravity")).toBe("Installed, signed out");
  expect(item.querySelector("[data-antigravity-command]")?.textContent).toBe("agy");
  expect(item.querySelector("button[aria-label='Copy command']")).not.toBeNull();
  expect(item.textContent).toContain("choose Google OAuth");
  const check = item.querySelector<HTMLButtonElement>("[data-antigravity-check]")!;
  expect(check.textContent).toBe("Check sign-in");
  await act(async () => { check.click(); });
  expect(probes).toBe(1);
});

test("a signed-in agy reads Connected with its tier, offers no sign-in, and counts as the agent account", async () => {
  const host = await mount(engineState("claude", [signedOut({ id: "cl-main", label: "Main" })], "cl-main"), none("codex"), { cli: { claude: "found", codex: "found", antigravity: "found" }, antigravity: agyAccount({ auth: "signed_in", plan: "Google AI Pro" }) });
  const item = row(host, "antigravity");
  expect(item.getAttribute("data-engine-state")).toBe("connected");
  expect(words(host, "antigravity")).toBe("Connected · Google AI Pro");
  expect(item.querySelector("[data-antigravity-signin]")).toBeNull();
  /* With Antigravity signed in, Claude Code's Sign in is no longer the step's filled button. */
  expect(row(host, "claude").querySelector("[data-onboarding-sign-in=cl-main]")).not.toBeNull();
  expect(filled(host)).toHaveLength(0);
});

test("Copilot's row is one sentence and no button: installed and signed out points at its own terminal and the step's Check again", async () => {
  copilot = { present: true, accounts: [] };
  const host = await mount(one(), none("codex"));
  const item = row(host, "copilot");
  expect(item.getAttribute("data-engine-state")).toBe("signed-out");
  expect(words(host, "copilot")).toBe("Installed, signed out");
  expect(item.querySelector("[data-onboarding-copilot-manual]")?.textContent).toBe("Run copilot in a terminal on this computer and sign in there, then press Check again beside this step's heading.");
  expect(Array.from(item.querySelectorAll("button")).filter((button) => !button.hasAttribute("data-settings-dot"))).toHaveLength(0);
  expect(buttonsNamed(host, "Check again")).toHaveLength(1);
});

test("a missing Copilot says to install it yourself, with no command and no button", async () => {
  copilot = { present: false, accounts: [] };
  const host = await mount(one(), none("codex"));
  const item = row(host, "copilot");
  expect(item.getAttribute("data-engine-state")).toBe("missing");
  expect(words(host, "copilot")).toBe("Not installed");
  expect(item.querySelector("[data-onboarding-copilot-manual]")?.textContent).toBe("Install the GitHub Copilot CLI yourself, then press Check again beside this step's heading.");
  expect(item.querySelector("code")).toBeNull();
  expect(Array.from(item.querySelectorAll("button")).filter((button) => !button.hasAttribute("data-settings-dot"))).toHaveLength(0);
});

test("opened from another device, a terminal sentence names the computer running Delegatus", async () => {
  dom.dom.happyDOM.setURL("http://box.example:8898/");
  copilot = { present: true, accounts: [] };
  const host = await mount(one(), none("codex"), { antigravity: agyAccount({ auth: "signed_out" }) });
  expect(row(host, "copilot").querySelector("[data-onboarding-copilot-manual]")?.textContent).toBe("Run copilot in a terminal on the computer running Delegatus and sign in there, then press Check again beside this step's heading.");
  expect(row(host, "antigravity").querySelector("[data-antigravity-signin] p")?.textContent).toContain("on the computer running Delegatus");
  expect(row(host, "antigravity").textContent).not.toContain("on this computer");
});

test("in a narrow card a row's action stands under its head, and a dot's words open in the row under the state line", async () => {
  const view = dom.dom as unknown as { matchMedia: (query: string) => { matches: boolean } };
  const desktop = view.matchMedia;
  const phone = (query: string) => ({ ...desktop(query), matches: query.includes("max-width") });
  view.matchMedia = phone;
  Object.assign(globalThis, { matchMedia: phone });
  try {
    const host = await mount(one(), engineState("codex", [signedOut({ id: "cx-main", label: "Main" })], "cx-main"), { installs: INSTALLS });
    for (const [program, selector] of [["claude", "[data-onboarding-add-account=claude]"], ["codex", "[data-onboarding-sign-in=cx-main]"]] as const) {
      const item = row(host, program);
      const action = item.querySelector(selector)!;
      const head = item.querySelector("[data-program-dot-row]")!;
      /* It is no longer the value beside the name, and it follows the head's line. */
      expect(action.closest("[data-settings-row-value]")).toBeNull();
      expect(head.parentElement!.contains(action)).toBe(false);
      expect(head.compareDocumentPosition(action) & 4).toBe(4);
    }
    /* A press on the dot opens its words inside the row's head, after the state line; nothing floats. */
    const head = row(host, "codex").querySelector("[data-program-dot-row]")!;
    const dot = head.querySelector<HTMLButtonElement>("[data-settings-dot]")!;
    const notes = () => Array.from(document.querySelectorAll("[data-settings-dot-popover]"));
    await act(async () => { dot.click(); });
    expect(notes().map((note) => spaced(note.textContent))).toEqual(["Version 0.170.0 at ~/.npm-global/bin/codex"]);
    expect(head.contains(notes()[0]!)).toBe(true);
    expect(head.querySelector("[data-onboarding-engine-header]")!.compareDocumentPosition(notes()[0]!) & 4).toBe(4);
    expect(dot.getAttribute("aria-expanded")).toBe("true");
    /* Escape closes it, and so does a second press. */
    await act(async () => { dot.dispatchEvent(new dom.dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event); });
    expect(notes()).toHaveLength(0);
    await act(async () => { dot.click(); });
    expect(notes()).toHaveLength(1);
    await act(async () => { dot.click(); });
    expect(notes()).toHaveLength(0);
    expect(dot.getAttribute("aria-expanded")).toBe("false");
  } finally {
    view.matchMedia = desktop;
    Object.assign(globalThis, { matchMedia: desktop });
  }
});

test("in a wide card a row's action stands beside its head, and a dot's words float outside the row", async () => {
  const host = await mount(one(), engineState("codex", [signedOut({ id: "cx-main", label: "Main" })], "cx-main"));
  for (const [program, selector] of [["claude", "[data-onboarding-add-account=claude]"], ["codex", "[data-onboarding-sign-in=cx-main]"]] as const) {
    const item = row(host, program);
    const head = item.querySelector("[data-program-dot-row]")!;
    expect(head.parentElement!.contains(item.querySelector(selector))).toBe(true);
    expect(item.querySelector(selector)!.closest("[data-settings-row-value]")).not.toBeNull();
  }
  await act(async () => { row(host, "codex").querySelector<HTMLButtonElement>("[data-settings-dot]")!.click(); });
  const popover = document.querySelector("[data-settings-dot-popover]")!;
  expect(popover.textContent).toBe("No account is signed in yet.");
  expect(host.contains(popover)).toBe(false);
});

/* What the check learned of each program, as `/api/accounts` hands it to the guide. */
const INSTALLS: ProgramInstalls = {
  claude: { path: "~/.local/bin/claude", version: "2.1.4" },
  codex: { path: "~/.npm-global/bin/codex", version: "0.170.0" },
  antigravity: { path: "~/.local/bin/agy", version: "1.5.17" },
  copilot: { path: "~/.bun/bin/copilot", version: "1.0.87" },
};

/** A drawn sentence with its no-break spaces as plain ones: the words are what a case reads. */
const spaced = (text: string | null | undefined) => text?.replaceAll("\u00a0", " ");

/** Presses a row's own dot, reads what it opened, and closes it again. */
async function popoverOf(host: HTMLElement, program: string): Promise<string | undefined> {
  const dot = row(host, program).querySelector<HTMLButtonElement>("[data-program-dot-row] [data-settings-dot]")!;
  await act(async () => { dot.click(); });
  const text = spaced(document.querySelector("[data-settings-dot-popover]")?.textContent);
  await act(async () => { dot.click(); });
  return text;
}

test("an installed, signed-out program's popover names its version and the path its command was found at", async () => {
  copilot = { present: true, accounts: [] };
  const host = await mount(engineState("claude", [signedOut({ id: "cl-main", label: "Main" })], "cl-main"), none("codex"), { antigravity: agyAccount({ auth: "signed_out" }), installs: INSTALLS });
  expect(await popoverOf(host, "claude")).toBe("Version 2.1.4 at ~/.local/bin/claude");
  expect(await popoverOf(host, "codex")).toBe("Version 0.170.0 at ~/.npm-global/bin/codex");
  expect(await popoverOf(host, "antigravity")).toBe("Version 1.5.17 at ~/.local/bin/agy");
  expect(await popoverOf(host, "copilot")).toBe("Version 1.0.87 at ~/.bun/bin/copilot");
});

test("a signed-in program's popover holds its version and the limit left; with no limit read, the version and the path", async () => {
  const claude = engineState("claude", [account({ id: "cl-main", label: "Main", plan: "max", limits: sessionUsed(20) })], "cl-main");
  const codex = engineState("codex", [account({ id: "cx-main", label: "Main", plan: "pro" })], "cx-main");
  const host = await mount(claude, codex, { antigravity: agyAccount({ auth: "signed_in", plan: "Google AI Pro" }), installs: INSTALLS });
  expect(await popoverOf(host, "claude")).toBe("Version 2.1.4. 80% of the session limit left.");
  expect(await popoverOf(host, "codex")).toBe("Version 0.170.0 at ~/.npm-global/bin/codex");
  expect(await popoverOf(host, "antigravity")).toBe("Version 1.5.17 at ~/.local/bin/agy");
});

test("a check that learned only part of an install says that part, and one that learned nothing keeps the row's sentence", async () => {
  copilot = { present: true, accounts: [] };
  const limited = engineState("claude", [account({ id: "cl-main", label: "Main", plan: "max", limits: sessionUsed(20) })], "cl-main");
  /* A version with no place (the command came through PATH alone), a place with no version (its --version failed), and nothing. */
  const host = await mount(limited, none("codex"), { antigravity: agyAccount({ auth: "signed_out" }), installs: { claude: { path: "~/.local/bin/claude", version: null }, codex: { path: null, version: "0.170.0" }, antigravity: { path: "~/.local/bin/agy", version: null }, copilot: { path: null, version: null } } });
  /* With no version the signed-in row falls back to the limit and its hour. */
  expect(await popoverOf(host, "claude")).toBe(`80% of the session limit left. Resets at ${formatResetClock(NOW + 3600, NOW)}.`);
  expect(await popoverOf(host, "codex")).toBe("Version 0.170.0.");
  expect(await popoverOf(host, "antigravity")).toBe("Found at ~/.local/bin/agy");
  expect(await popoverOf(host, "copilot")).toBe("The copilot command is installed and no account is signed in.");
});

test("a program that is not installed never quotes a version or a path, whatever an earlier check left", async () => {
  copilot = { present: false, accounts: [] };
  const host = await mount(none("claude"), none("codex"), { cli: { claude: "missing", codex: "missing", antigravity: "missing" }, antigravity: agyAccount({ cli: "missing", auth: "unknown" }), installs: INSTALLS });
  for (const program of ["claude", "codex", "antigravity", "copilot"]) {
    const text = await popoverOf(host, program);
    expect(text).not.toContain("Version");
    expect(text).not.toContain("bin/");
    expect(text).toBe(program === "copilot" ? "The copilot command was not found on PATH." : "Not found in ~/.local/bin, ~/.bun/bin or PATH.");
  }
});

test("a long path keeps its last folders and the file behind an ellipsis, and a short one is whole", () => {
  expect(shortPath("~/.local/bin/claude")).toBe("~/.local/bin/claude");
  expect(shortPath("~/.npm-global/bin/codex")).toBe("~/.npm-global/bin/codex");
  expect(shortPath("/opt/homebrew/Caskroom/codex/0.170.0/bin/codex")).toBe("…/codex/0.170.0/bin/codex");
  expect(shortPath("/opt/homebrew/Caskroom/antigravity/1.5.17/bin/agy")).toBe("…/1.5.17/bin/agy");
  expect(shortPath("~\\AppData\\Local\\agy\\bin\\agy.exe")).toBe("…\\Local\\agy\\bin\\agy.exe");
  /* A file name longer than the room is kept whole: the name is the part that tells programs apart. */
  expect(shortPath("/srv/tools/a-launcher-with-a-very-long-name")).toBe("…/a-launcher-with-a-very-long-name");
  expect(shortPath("agy")).toBe("agy");
});

test("the installs block is read per program, and anything that is no text is no answer", () => {
  expect(programInstalls({ claude: { path: " ~/.local/bin/claude ", version: "2.1.4" }, codex: { path: "", version: 7 }, antigravity: null, copilot: "1.0.87", other: { path: "/x", version: "1.0.0" } })).toEqual({
    claude: { path: "~/.local/bin/claude", version: "2.1.4" },
    codex: { path: null, version: null },
  });
  for (const nothing of [null, undefined, "found", 3]) expect(programInstalls(nothing)).toEqual({});
});

/** Runs a case in the narrow card, where a dot's words open in the row. */
async function narrow(run: () => Promise<void>): Promise<void> {
  const view = dom.dom as unknown as { matchMedia: (query: string) => { matches: boolean } };
  const desktop = view.matchMedia;
  const phone = (query: string) => ({ ...desktop(query), matches: query.includes("max-width") });
  view.matchMedia = phone;
  Object.assign(globalThis, { matchMedia: phone });
  try { await run(); } finally {
    view.matchMedia = desktop;
    Object.assign(globalThis, { matchMedia: desktop });
  }
}

const severalWithLow = (limits: AccountOption["limits"]) => engineState("claude", [
  account({ id: "cl-main", label: "Main", plan: "max", limits: sessionUsed(20) }),
  account({ id: "cl-lab", label: "Lab", plan: "pro", limits }),
], "cl-main");

test("in a narrow card a low account's opened note adds only the hour its limit starts over: the share is said once", async () => {
  await narrow(async () => {
    const host = await mount(severalWithLow(sessionUsed(88)), none("codex"));
    const line = row(host, "claude").querySelector<HTMLElement>("[data-onboarding-account=cl-lab]")!;
    const said = line.querySelector("[data-onboarding-account-words]")!.textContent!;
    expect(said).toBe("12% of the session limit left");
    const dot = line.querySelector<HTMLButtonElement>("[data-settings-dot]")!;
    const resets = `Resets at ${formatResetClock(NOW + 3600, NOW)}.`;
    await act(async () => { dot.click(); });
    const note = line.querySelector("[data-settings-dot-popover]")!;
    expect(spaced(note.textContent)).toBe(resets);
    expect(line.textContent!.split("12%")).toHaveLength(2);
    /* It stands under the words it completes, and a screen reader still hears the whole of it on the dot. */
    expect(line.querySelector("[data-onboarding-account-words]")!.compareDocumentPosition(note) & 4).toBe(4);
    expect(spaced(dot.getAttribute("aria-label"))).toBe(`Lab: 12% of the session limit left. ${resets}`);
    await act(async () => { dot.click(); });
    /* An account with room left has no words under its name, so its note says the share itself. */
    const main = row(host, "claude").querySelector<HTMLElement>("[data-onboarding-account=cl-main]")!;
    await act(async () => { main.querySelector<HTMLButtonElement>("[data-settings-dot]")!.click(); });
    expect(spaced(main.querySelector("[data-settings-dot-popover]")!.textContent)).toBe(`80% of the session limit left. ${resets}`);
  });
});

test("in a narrow card a low account with no reset hour known has nothing to add: its dot opens nothing and keeps its name", async () => {
  await narrow(async () => {
    const past: AccountOption["limits"] = { freshness: "fresh", session: { usedPercent: 88, resetsAt: null, windowMinutes: 300 }, weekly: null, checkedAt: new Date((NOW - 60) * 1000).toISOString() } as AccountOption["limits"];
    const host = await mount(severalWithLow(past), none("codex"));
    const line = row(host, "claude").querySelector<HTMLElement>("[data-onboarding-account=cl-lab]")!;
    expect(line.querySelector("[data-onboarding-account-words]")!.textContent).toBe("12% of the session limit left");
    const dot = line.querySelector<HTMLElement>("[data-settings-dot]")!;
    expect(dot.getAttribute("data-settings-dot")).toBe("warn");
    expect(dot.tagName).toBe("SPAN");
    expect(dot.getAttribute("role")).toBe("img");
    expect(spaced(dot.getAttribute("aria-label"))).toBe("Lab: 12% of the session limit left.");
    await act(async () => { dot.click(); });
    expect(document.querySelectorAll("[data-settings-dot-popover]")).toHaveLength(0);
    expect(line.textContent!.split("12%")).toHaveLength(2);
  });
});

test("in a narrow card an account that waits for its sign-in says so once, in its words: its dot opens nothing there and floats its note in a wide card", async () => {
  const waiting = () => engineState("claude", [
    account({ id: "cl-main", label: "Main", plan: "max" }),
    signedOut({ id: "cl-spare", label: "Spare" }),
    signedOut({ id: "cl-new", label: "New", loginPending: true, loginState: "pending", login: login("awaiting_code") }),
  ], "cl-main");
  await narrow(async () => {
    const host = await mount(waiting(), none("codex"));
    for (const [id, said, heard] of [["cl-spare", "needs sign-in", "Spare: No sign-in yet."], ["cl-new", "signing in", "New: Its sign-in is in progress."]] as const) {
      const line = row(host, "claude").querySelector<HTMLElement>(`[data-onboarding-account=${id}]`)!;
      expect(line.querySelector("[data-onboarding-account-words]")!.textContent).toBe(said);
      const dot = line.querySelector<HTMLElement>("[data-settings-dot]")!;
      expect(dot.tagName).toBe("SPAN");
      expect(spaced(dot.getAttribute("aria-label"))).toBe(heard);
      await act(async () => { dot.click(); });
      expect(document.querySelectorAll("[data-settings-dot-popover]")).toHaveLength(0);
    }
  });
  await act(async () => mounted!.root.unmount());
  mounted!.host.remove();
  const host = await mount(waiting(), none("codex"));
  const line = row(host, "claude").querySelector<HTMLElement>("[data-onboarding-account=cl-spare]")!;
  await act(async () => { line.querySelector<HTMLButtonElement>("button[data-settings-dot]")!.click(); });
  expect(spaced(document.querySelector("[data-settings-dot-popover]")!.textContent)).toBe("No sign-in yet.");
});

/** The dot that leads a program's own state line. */
const programDot = (host: HTMLElement, program: string) => row(host, program).querySelector<HTMLElement>(":scope > div > [data-program-dot-row] [data-settings-dot]")!;

test("in a narrow card a program that is signing in says so once: its dot opens nothing there and keeps its note for a screen reader", async () => {
  const signingIn = () => [
    engineState("claude", [signedOut({ id: "cl-main", label: "Main", loginPending: true, loginState: "pending", login: login("awaiting_code") })], "cl-main"),
    engineState("codex", [signedOut({ id: "cx-main", label: "Main", loginPending: true, loginState: "pending" })], "cx-main"),
  ] as const;
  await narrow(async () => {
    const [claude, codex] = signingIn();
    const host = await mount(claude, codex, { installs: INSTALLS });
    for (const [program, name] of [["claude", "Claude Code"], ["codex", "Codex"]] as const) {
      expect(row(host, program).getAttribute("data-engine-state")).toBe("signing-in");
      expect(words(host, program)).toBe("Signing in");
      const dot = programDot(host, program);
      expect(dot.getAttribute("data-settings-dot")).toBe("warn");
      expect(dot.tagName).toBe("SPAN");
      expect(dot.getAttribute("role")).toBe("img");
      expect(spaced(dot.getAttribute("aria-label"))).toBe(`${name}: Its sign-in is in progress.`);
      await act(async () => { dot.click(); });
      expect(document.querySelectorAll("[data-settings-dot-popover]")).toHaveLength(0);
      /* The row says it is signing in once, in its state line. */
      expect(row(host, program).querySelector("[data-program-dot-row]")!.textContent!.split("Signing in")).toHaveLength(2);
    }
  });
  await act(async () => mounted!.root.unmount());
  mounted!.host.remove();
  /* A wide card's popover stands beside the name, and keeps the sentence. */
  const [claude, codex] = signingIn();
  const host = await mount(claude, codex, { installs: INSTALLS });
  expect(programDot(host, "codex").tagName).toBe("BUTTON");
  expect(await popoverOf(host, "codex")).toBe("Its sign-in is in progress.");
});

test("in a narrow card a note that only says its line again opens nothing, and one that adds to the line opens under it", async () => {
  copilot = { present: true, accounts: [] };
  await narrow(async () => {
    /* No check learned a version or a path, so each row keeps its own sentence. */
    const connected = engineState("claude", [account({ id: "cl-main", label: "Main", plan: "max" })], "cl-main");
    const host = await mount(connected, engineState("codex", [signedOut({ id: "cx-main", label: "Main" })], "cx-main"), { antigravity: agyAccount({ auth: "signed_out" }) });
    for (const [program, said, heard] of [
      ["claude", "Connected · Max", "Claude Code: Signed in."],
      ["codex", "Installed, signed out", "Codex: No account is signed in yet."],
      ["antigravity", "Installed, signed out", "Antigravity: agy is installed and its Google sign-in is missing."],
      ["copilot", "Installed, signed out", "Copilot: The copilot command is installed and no account is signed in."],
    ] as const) {
      expect(words(host, program)).toBe(said);
      const dot = programDot(host, program);
      expect(dot.tagName).toBe("SPAN");
      expect(spaced(dot.getAttribute("aria-label"))).toBe(heard);
      await act(async () => { dot.click(); });
      expect(document.querySelectorAll("[data-settings-dot-popover]")).toHaveLength(0);
    }
  });
  await act(async () => mounted!.root.unmount());
  mounted!.host.remove();
  await narrow(async () => {
    /* A signed-out Claude Code with nothing learned says whose sign-in it waits for, and a known version and path open whole. */
    const host = await mount(engineState("claude", [signedOut({ id: "cl-main", label: "Main" })], "cl-main"), engineState("codex", [signedOut({ id: "cx-main", label: "Main" })], "cx-main"), { installs: { codex: INSTALLS.codex } });
    for (const [program, note] of [["claude", "Agents use their own Claude sign-in."], ["codex", "Version 0.170.0 at ~/.npm-global/bin/codex"]] as const) {
      const dot = programDot(host, program);
      expect(dot.tagName).toBe("BUTTON");
      await act(async () => { dot.click(); });
      const opened = row(host, program).querySelector("[data-program-dot-note] [data-settings-dot-popover]")!;
      expect(spaced(opened.textContent)).toBe(note);
      await act(async () => { dot.click(); });
    }
  });
});

test("in a wide card the low account's floating popover keeps the share and the hour", async () => {
  const host = await mount(severalWithLow(sessionUsed(88)), none("codex"));
  const line = row(host, "claude").querySelector<HTMLElement>("[data-onboarding-account=cl-lab]")!;
  await act(async () => { line.querySelector<HTMLButtonElement>("[data-settings-dot]")!.click(); });
  const popover = document.querySelector("[data-settings-dot-popover]")!;
  expect(spaced(popover.textContent)).toBe(`12% of the session limit left. Resets at ${formatResetClock(NOW + 3600, NOW)}.`);
  expect(host.contains(popover)).toBe(false);
});
