import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

/*
 * #1876: the setup guide closes on Escape whatever holds focus. The capture
 * found a guide that ignored Escape once focus had left its panel, because the
 * key was only heard on the panel itself; it is now heard on the window for as
 * long as the dialog is open, Tab stays inside the panel, and focus returns to
 * whatever held it before the guide opened.
 */

const dom = new Window({ url: "http://localhost/" });
const matchMediaStub = (query: string) => ({
  matches: false,
  media: String(query),
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return false; },
});
(dom as unknown as { matchMedia: typeof matchMediaStub }).matchMedia = matchMediaStub;
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  CustomEvent: dom.CustomEvent,
  localStorage: dom.localStorage,
  matchMedia: matchMediaStub,
  fetch: (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null });
    if (url.includes("/api/telegram/bot")) return json({ bot: botStatus });
    if (url.includes("/api/projects/settings")) {
      if (init?.method === "PUT") {
        const written = (JSON.parse(String(init.body)) as { reportTelegram: { chat: string; name: string } | null }).reportTelegram;
        return json({ ok: true, reportTelegram: written ?? { chat: null }, reportDestination: written ? { ...written, source: "chosen" } : null, reportNameSuggestion: nameSuggestion, postableChats: 1 });
      }
      return json({ ok: true, reportNameSuggestion: nameSuggestion, ...reportSettings });
    }
    if (url.includes("/api/onboarding")) return json({ marker: null });
    if (url.includes("/api/roles")) return json(rolesBody);
    if (url.includes("/api/transcribe/backend")) return json({ backend: "local", lockedByEnv: false, options: [] });
    if (url.includes("/api/access")) return json({ tailnetUrl: null, phone: { state: "missing", dnsName: null, viewerPort: 8898, servingPort: null, persisted: false }, phoneError: null });
    if (url.includes("/api/orchestrator/seat")) return Promise.resolve(new Response("{}", { status: 404 }));
    if (url.includes("/api/accounts/copilot")) return json({ cli: { present: false, reason: null }, active: "", accounts: [] });
    if (url.endsWith("/api/accounts") || url.includes("/api/accounts?")) return json(accountsBody);
    return json({ claude: { active: "", accounts: [] }, codex: { active: "", accounts: [] } });
  },
});

/* What `/api/roles` answers; the agent mapping's case sets it. */
let rolesBody: unknown = { schemaVersion: 2, roles: [] };

/* Every request the guide made, and what the bot panel's status read answers:
   the Telegram step's cases set it (docs/design/orchestrator-reports.md §5.6). */
const requests: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
let nameSuggestion: string | null = "Widgets";
/* What the settings route answers about the destination: never chosen, and
   no chat the bot may post in, unless a case says otherwise. */
let reportSettings: Record<string, unknown> = { reportTelegram: null, reportDestination: null, postableChats: 0 };
let botStatus: unknown = { connected: false, bot: null, receiving: "stopped", lastUpdateAt: null, lastCheckedAt: null, chats: [], limits: [] };

/* What `/api/accounts` answers; the orchestrator step's cases set it. */
const signedIn = (id: string, label: string) => ({ id, label, kind: "legacy", authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null, auth: { state: "authenticated" } });
let accountsBody: unknown = { claude: { active: "", accounts: [] }, codex: { active: "", accounts: [] } };

const { OnboardingDialog } = await import("./OnboardingDialog");
/* The engine stores read `/api/accounts` once per process; each case that
   answers it differently starts them afresh. */
const { resetEngineAccountsStoresForTests } = await import("@/hooks/useEngineAccounts");
function answerAccounts(body: unknown): void {
  accountsBody = body;
  resetEngineAccountsStoresForTests();
}

afterAll(() => { void dom.happyDOM.close(); });

function key(target: EventTarget, name: string, shiftKey = false): void {
  target.dispatchEvent(new dom.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, shiftKey }) as unknown as Event);
}

test("Escape closes the guide with focus outside its panel, and focus returns to the opener", () => {
  const opener = document.createElement("button");
  opener.textContent = "Setup guide";
  const outside = document.createElement("button");
  outside.textContent = "somewhere else";
  document.body.append(opener, outside);
  opener.focus();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const closes: string[] = [];
  flushSync(() => root.render(<OnboardingDialog mode="mapping" marker={null} onClose={(outcome) => closes.push(outcome)} />));
  const panel = host.querySelector<HTMLElement>("[role=dialog]")!;
  expect(document.activeElement).toBe(panel);

  /* Tab from outside the panel lands back inside it. */
  outside.focus();
  key(outside, "Tab");
  expect(panel.contains(document.activeElement)).toBe(true);

  outside.focus();
  expect(panel.contains(document.activeElement)).toBe(false);
  key(outside, "Escape");
  expect(closes).toEqual(["dismissed"]);

  flushSync(() => root.unmount());
  expect(document.activeElement).toBe(opener);
  opener.remove();
  outside.remove();
  host.remove();
});

test("once the guide is gone, Escape no longer reaches it", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const closes: string[] = [];
  flushSync(() => root.render(<OnboardingDialog mode="mapping" marker={null} onClose={(outcome) => closes.push(outcome)} />));
  flushSync(() => root.unmount());
  key(document.body, "Escape");
  expect(closes).toEqual([]);
  host.remove();
});

test("an engine whose command is missing reads Not installed even with a credential present", async () => {
  const { EnginesStep } = await import("./EnginesStep");
  type State = Parameters<typeof EnginesStep>[0]["claude"];
  const engineState = (engine: "claude" | "codex") => ({
    engine,
    status: "ready",
    active: "main",
    accounts: [{ id: "main", label: "Main", authPresent: true }],
  }) as unknown as State;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(
    <EnginesStep claude={engineState("claude")} codex={engineState("codex")} cli={{ claude: "found", codex: "missing" }} now={0} onRecheck={() => {}} />,
  ));
  expect(host.querySelector("[data-onboarding-engine=claude]")?.getAttribute("data-engine-state")).toBe("connected");
  const codex = host.querySelector("[data-onboarding-engine=codex]")!;
  expect(codex.getAttribute("data-engine-state")).toBe("missing");
  expect(codex.textContent).toContain("Not installed");
  expect(codex.textContent).not.toContain("Connected");
  expect(host.querySelector("[data-onboarding-engines-note]")?.textContent).toContain("With Claude only");
  flushSync(() => root.unmount());
  host.remove();
});

test("#2166: four numbered steps with the optional Telegram one, then Agents, Phone, Voice and Check under Later, counted to four", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(<OnboardingDialog mode="guide" marker={null} onClose={() => {}} />));
  const steps = Array.from(host.querySelectorAll("[data-onboarding-step]")).map((element) => element.getAttribute("data-onboarding-step"));
  expect(steps).toEqual(["engines", "project", "telegram", "orchestrator", "agents", "phone", "voice", "check"]);
  expect(Array.from(host.querySelectorAll("[data-step-mark=later]")).length).toBe(4);
  expect(host.textContent).toContain("Later, any time");
  expect(host.querySelector("[data-onboarding-step=engines]")?.getAttribute("aria-current")).toBe("step");
  expect(host.textContent).toContain("Step 1 of 4");
  expect(host.textContent).toContain("Telegram (optional)");
  /* Copilot sits beside Claude and Codex. */
  expect(host.querySelector("[data-onboarding-engine=copilot]")).not.toBeNull();
  flushSync(() => root.unmount());
  host.remove();
});

test("#2166: a six-step marker with Engines done lands on Project; the Tour is gone", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const marker = { schemaVersion: 1, completedAt: null, dismissedAt: null, reason: null, lastHealth: null, walk: null, steps: { engines: "done", project: null, telegram: null, orchestrator: null, agents: "done", phone: null, voice: null, check: null } } as const;
  flushSync(() => root.render(<OnboardingDialog mode="guide" marker={marker} onClose={() => {}} />));
  expect(host.querySelector("[data-onboarding-step=project]")?.getAttribute("aria-current")).toBe("step");
  expect(host.textContent).toContain("Step 2 of 4");
  expect(host.textContent).toContain("Pick the project it will work on");
  expect(host.querySelector("[data-onboarding-step=tour]")).toBeNull();
  flushSync(() => root.unmount());
  host.remove();
});

test("#2166: a Later step is outside Back and Continue and returns to the guide step it was opened from", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(<OnboardingDialog mode="guide" initialStep="project" marker={null} onClose={() => {}} />));
  flushSync(() => (host.querySelector("[data-onboarding-step=voice]") as HTMLElement).click());
  expect(host.querySelector("[data-onboarding-step=voice]")?.getAttribute("aria-current")).toBe("step");
  expect(host.textContent).toContain("Where your dictation is transcribed");
  expect(host.querySelector("[data-onboarding-back]")).toBeNull();
  const primary = host.querySelector("[data-onboarding-primary]") as HTMLElement;
  expect(primary.textContent).toBe("Back to setup");
  flushSync(() => primary.click());
  expect(host.querySelector("[data-onboarding-step=project]")?.getAttribute("aria-current")).toBe("step");
  flushSync(() => root.unmount());
  host.remove();
});

test("#2166: the Project step offers the projects with a folder, the one it opened over chosen", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const projects = [
    { project: "notes", name: "notes-app", cwd: "/work/notes-app", conversations: 12 },
    { project: "unresolved", name: "Unresolved project", cwd: null, conversations: 3 },
    { project: "todo", name: "todo-cli", cwd: "/work/todo-cli", conversations: 1 },
  ];
  flushSync(() => root.render(<OnboardingDialog mode="guide" initialStep="project" marker={null} projects={projects} currentProject="todo" onClose={() => {}} onCreateProject={async () => ({ ok: false, code: "ERROR" })} />));
  const rows = Array.from(host.querySelectorAll("[data-onboarding-project]"));
  expect(rows.map((row) => row.getAttribute("data-onboarding-project"))).toEqual(["notes", "todo"]);
  expect(host.querySelector("[data-onboarding-project=todo]")?.getAttribute("aria-checked")).toBe("true");
  expect(host.textContent).toContain("12 conversations");
  expect(host.textContent).toContain("1 conversation");
  expect(host.querySelector("[data-create-project-form]")).toBeNull();
  flushSync(() => (host.querySelector("[data-onboarding-project-other]") as HTMLElement).click());
  expect(host.querySelector("[data-create-project-form]")).not.toBeNull();
  flushSync(() => root.unmount());

  /* With no listed project the form is already open. */
  const empty = createRoot(host);
  flushSync(() => empty.render(<OnboardingDialog mode="guide" initialStep="project" marker={null} projects={[projects[1]!]} onClose={() => {}} onCreateProject={async () => ({ ok: false, code: "ERROR" })} />));
  expect(host.querySelector("[data-onboarding-project]")).toBeNull();
  expect(host.querySelector("[data-create-project-form]")).not.toBeNull();
  flushSync(() => empty.unmount());
  host.remove();
});

test("#2166: Escape in the Project step's folder picker closes the picker, not the guide", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const closes: string[] = [];
  flushSync(() => root.render(<OnboardingDialog mode="guide" initialStep="project" marker={null} projects={[]} onClose={(outcome) => closes.push(outcome)} onCreateProject={async () => ({ ok: false, code: "ERROR" })} />));
  flushSync(() => (host.querySelector("[data-directory-trigger]") as HTMLElement).click());
  const combobox = host.querySelector("[role=combobox]") as HTMLElement;
  expect(combobox).not.toBeNull();
  flushSync(() => key(combobox, "Escape"));
  expect(closes).toEqual([]);
  expect(host.querySelector("[data-directory-picker=open]")).toBeNull();
  /* With the picker closed, Escape closes the guide as everywhere else. */
  flushSync(() => key(host.querySelector("[data-directory-trigger]")!, "Escape"));
  expect(closes).toEqual(["dismissed"]);
  flushSync(() => root.unmount());
  host.remove();
});

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

test("#2166: Create hands the project's draft a confirm on the chosen runtime and closes the guide as completed", async () => {
  answerAccounts({ claude: { active: "default", cli: "found", accounts: [signedIn("default", "Main")] }, codex: { active: "", cli: "found", accounts: [] }, copilot: { active: "", accounts: [] } });
  const { onOrchestratorDraftRequest, takePendingSeatConfirm } = await import("@/components/orchestrator/draftPrefill");
  const requests: unknown[] = [];
  const off = onOrchestratorDraftRequest((request) => requests.push(request));
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const closes: unknown[] = [];
  const projects = [{ project: "todo", name: "todo-cli", cwd: "/work/todo-cli", conversations: 0 }];
  flushSync(() => root.render(<OnboardingDialog mode="guide" initialStep="orchestrator" marker={null} projects={projects} onClose={(outcome, steps) => closes.push({ outcome, steps })} />));
  expect(host.textContent).toContain("Create its orchestrator");
  expect(host.textContent).toContain("The orchestrator takes your requests");
  expect(host.querySelector("[data-onboarding-primary]")?.textContent).toBe("Finish without it");
  await until(() => Boolean(host.querySelector<HTMLButtonElement>("[data-onboarding-orchestrator-create]:not([disabled])")) && (host.querySelector("[data-onboarding-orchestrator-runs-on]")?.textContent ?? "").includes("account Main"));
  expect(host.querySelector("[data-onboarding-orchestrator-runs-on]")?.textContent).toContain("Claude · Opus");
  expect(host.querySelector("[data-onboarding-orchestrator-runs-on]")?.textContent).toContain("high effort");
  flushSync(() => (host.querySelector("[data-onboarding-orchestrator-create]") as HTMLElement).click());
  off();
  expect(requests).toEqual([{ project: "todo", launch: { engine: "claude", model: "opus", effort: "high", account: "default" }, confirm: true }]);
  expect(closes).toEqual([{ outcome: "completed", steps: { orchestrator: "done" } }]);
  expect(takePendingSeatConfirm("todo")).toMatchObject({ project: "todo", launch: { account: "default" } });
  flushSync(() => root.unmount());
  host.remove();
});

test("#2166: step 3 says what is missing: a project, an engine, or a signed-in account", async () => {
  const projects = [{ project: "todo", name: "todo-cli", cwd: "/work/todo-cli", conversations: 0 }];
  const host = document.createElement("div");
  document.body.appendChild(host);

  answerAccounts({ claude: { active: "default", cli: "found", accounts: [signedIn("default", "Main")] }, codex: { active: "", cli: "found", accounts: [] } });
  let root = createRoot(host);
  flushSync(() => root.render(<OnboardingDialog mode="guide" initialStep="orchestrator" marker={null} projects={[]} onClose={() => {}} />));
  await until(() => (host.textContent ?? "").includes("Pick a project first."));
  expect(host.querySelector("[data-onboarding-orchestrator-go=project]")).not.toBeNull();
  expect(host.querySelector("[data-onboarding-orchestrator-create]")).toBeNull();
  flushSync(() => root.unmount());

  answerAccounts({ claude: { active: "", cli: "found", accounts: [] }, codex: { active: "", cli: "found", accounts: [] } });
  root = createRoot(host);
  flushSync(() => root.render(<OnboardingDialog mode="guide" initialStep="orchestrator" marker={null} projects={projects} onClose={() => {}} />));
  await until(() => (host.textContent ?? "").includes("Connect Claude or Codex first."));
  expect(host.querySelector("[data-onboarding-orchestrator-go=engines]")).not.toBeNull();
  flushSync(() => root.unmount());

  /* Two Claude accounts: Main signed in, Work signed out and active. The
     step starts on the signed-in one; chosen by hand, Work turns the
     button into its sign-in. */
  const signedOut = { id: "work", label: "Work", kind: "managed", authPresent: false, loginPending: false, loginState: "idle", deviceAuth: null, auth: { state: "signed_out" } };
  answerAccounts({ claude: { active: "work", cli: "found", accounts: [signedOut] }, codex: { active: "", cli: "found", accounts: [signedIn("cx", "Codex main")] } });
  root = createRoot(host);
  flushSync(() => root.render(<OnboardingDialog mode="guide" initialStep="orchestrator" marker={null} projects={projects} onClose={() => {}} />));
  await until(() => Boolean(host.querySelector("[data-onboarding-orchestrator-create], [data-onboarding-orchestrator-signin]")) && (host.textContent ?? "").includes("account"));
  /* Claude has no signed-in account, so the runtime falls back to Codex. */
  expect(host.querySelector("[data-onboarding-orchestrator-runs-on]")?.textContent).toContain("Codex");
  flushSync(() => root.unmount());

  answerAccounts({ claude: { active: "work", cli: "found", accounts: [signedOut, { ...signedIn("default", "Main"), auth: { state: "signed_out" }, authPresent: true }] }, codex: { active: "", cli: "found", accounts: [] } });
  root = createRoot(host);
  flushSync(() => root.render(<OnboardingDialog mode="guide" initialStep="orchestrator" marker={null} projects={projects} onClose={() => {}} />));
  await until(() => Boolean(host.querySelector("[data-onboarding-orchestrator-signin]")));
  expect(host.textContent).toContain("is signed out, so the orchestrator cannot start yet.");
  expect(host.querySelector("[data-onboarding-orchestrator-signin]")?.textContent).toContain("Sign in to Claude first");
  flushSync(() => (host.querySelector("[data-onboarding-orchestrator-signin]") as HTMLElement).click());
  expect(host.querySelector("[data-onboarding-step=engines]")?.getAttribute("aria-current")).toBe("step");
  flushSync(() => root.unmount());
  host.remove();
  answerAccounts({ claude: { active: "", accounts: [] }, codex: { active: "", accounts: [] } });
});

test("slice 3: the Dictation menu mode shows the Voice step alone, without the step list or the footer", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(<OnboardingDialog mode="voice" marker={null} onClose={() => {}} />));
  expect(host.querySelector("[data-onboarding-dialog]")?.getAttribute("data-onboarding-dialog")).toBe("voice");
  expect(host.querySelector("[data-onboarding-step]")).toBeNull();
  expect(host.querySelector("[data-onboarding-primary]")).toBeNull();
  expect(host.querySelector("[role=dialog]")?.getAttribute("aria-label")).toBe("Dictation");
  expect(host.textContent).toContain("Where your dictation is transcribed");
  for (let attempt = 0; attempt < 50 && !host.querySelector("[data-onboarding-voice]"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(host.querySelector("[data-onboarding-voice]")).not.toBeNull();
  flushSync(() => root.unmount());
  host.remove();
});

/* Delegatus rename, slice 2: the guide names the product Delegatus in both
   languages, and the former name is gone from what it renders; #2166: the
   last step is the orchestrator's, in both languages. */
test("the guide's title names Delegatus and its last step creates the orchestrator, in en and in uk", async () => {
  const { setLocale } = await import("@/lib/i18n");
  const cases = [
    { locale: "en" as const, title: "Set up Delegatus", heading: "Create its orchestrator" },
    { locale: "uk" as const, title: "Налаштування Delegatus", heading: "Створіть його оркестратора" },
  ];
  try {
    for (const { locale, title, heading } of cases) {
      setLocale(locale);
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      flushSync(() => root.render(<OnboardingDialog mode="guide" initialStep="orchestrator" marker={null} onClose={() => {}} />));
      const panel = host.querySelector<HTMLElement>("[role=dialog]")!;
      expect(panel.getAttribute("aria-label")).toBe(title);
      expect(panel.querySelector("h2")?.textContent).toBe(heading);
      expect(host.textContent).not.toContain("Agent Log Viewer");
      flushSync(() => root.unmount());
      host.remove();
    }
  } finally {
    setLocale("en");
  }
});

/* docs/design/orchestrator-reports.md §5.6: the optional "Reports to Telegram"
   step, built from the bot panel's own pieces. Chats and names are invented. */

const PROJECTS = [{ project: "widgets", name: "widgets", cwd: "/work/widgets", conversations: 2 }];
const chatView = (over: Record<string, unknown>) => ({
  chatId: "-100101", title: "Team Reports", type: "supergroup", username: null, isForum: false, member: true, alias: "team-reports",
  postAllowed: true, postable: true, seesAllMessages: false, readdToApply: false, lastMessageAt: null, lastPostAt: null, lastPostBy: null, storedMessages: 0, ...over,
});
const connectedBot = (chats: unknown[]) => ({
  connected: true, bot: { name: "Report Bot", username: "report_test_bot", canReadAllGroupMessages: false, canJoinGroups: true },
  receiving: "polling", lastUpdateAt: null, lastCheckedAt: null, chats, limits: [],
});

function renderTelegramStep(onClose: (outcome: string, steps?: unknown) => void = () => {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(<OnboardingDialog mode="guide" initialStep="telegram" marker={null} projects={PROJECTS} currentProject="widgets" onClose={onClose} />));
  return { host, done: () => { flushSync(() => root.unmount()); host.remove(); } };
}

test("with no bot connected the step shows the bot panel's token form, and Skip leaves reports bridge-only", async () => {
  requests.length = 0;
  botStatus = { connected: false, bot: null, receiving: "stopped", lastUpdateAt: null, lastCheckedAt: null, chats: [], limits: [] };
  const { host, done } = renderTelegramStep();
  await until(() => (host.textContent ?? "").includes("paste the token BotFather gave you"));
  expect(host.textContent).toContain("Step 3 of 4");
  expect(host.querySelector("input[type=password]")).not.toBeNull();
  expect(host.textContent).toContain("reports carry no private information, and they are posted silently, with no links");
  flushSync(() => (host.querySelector("[data-onboarding-telegram-skip]") as HTMLElement).click());
  expect(host.querySelector("[data-onboarding-step=orchestrator]")?.getAttribute("aria-current")).toBe("step");
  expect(host.querySelector("[data-onboarding-step=telegram]")?.textContent).toContain("skipped");
  expect(requests.filter((request) => request.url.includes("/api/projects/settings") && request.method === "PUT")).toEqual([]);
  expect(requests.some((request) => request.url.includes("/api/onboarding") && JSON.stringify(request.body) === JSON.stringify({ steps: { telegram: "skipped" } }))).toBe(true);
  done();
});

test("a connected bot lists the chats that accept posts, allows another in place, prefills the name and requires it, and Use this writes the destination", async () => {
  requests.length = 0;
  botStatus = connectedBot([chatView({}), chatView({ chatId: "-100202", title: "Lounge", alias: null, postAllowed: false, postable: false })]);
  const { host, done } = renderTelegramStep();
  await until(() => Boolean(host.querySelector("[data-onboarding-report-chat=team-reports]")) && (host.querySelector<HTMLInputElement>("[data-onboarding-report-name]")?.value ?? "") === "Widgets");
  expect(host.textContent).toContain("Bot: Report Bot");
  expect(host.querySelector("[data-onboarding-report-chat=log-only]")).not.toBeNull();
  /* The chat the bot may not post to yet has the panel's own switch; the bot
     route answers the switch with both chats accepting posts. */
  botStatus = connectedBot([chatView({}), chatView({ chatId: "-100202", title: "Lounge", alias: "lounge" })]);
  const allow = host.querySelector("[role=switch]") as HTMLButtonElement;
  expect(allow.getAttribute("aria-label")).toContain("Lounge");
  flushSync(() => allow.click());
  await until(() => Boolean(host.querySelector("[data-onboarding-report-chat=lounge]")));
  expect(requests.find((request) => request.method === "POST")!.body).toEqual({ action: "chat", chatId: "-100202", alias: "lounge", postAllowed: true });

  /* Two chats now accept posts and none was chosen: nothing to use yet. */
  const save = host.querySelector("[data-onboarding-telegram-save]") as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  flushSync(() => (host.querySelector("[data-onboarding-report-chat=team-reports]") as HTMLElement).click());
  flushSync(() => (host.querySelector("[data-onboarding-telegram-save]") as HTMLElement).click());
  await until(() => Boolean(host.querySelector("[data-onboarding-report-saved]")));
  expect(requests.find((request) => request.url.includes("/api/projects/settings") && request.method === "PUT")!.body).toEqual({ project: "widgets", reportTelegram: { chat: "team-reports", name: "Widgets" } });
  expect(host.querySelector("[data-onboarding-report-saved]")?.textContent).toBe("Reports go to the log and to team-reports.");
  expect(requests.some((request) => request.url.includes("/api/onboarding") && JSON.stringify(request.body) === JSON.stringify({ steps: { telegram: "done" } }))).toBe(true);
  done();
});

/* The operator allowed one chat in the bot panel and never chose in the step:
   the step shows that chat as where reports go now. */
test("a project that never chose starts on the bot's one allowed chat, marked in use", async () => {
  botStatus = connectedBot([chatView({})]);
  reportSettings = { reportTelegram: null, reportDestination: { chat: "team-reports", name: "Widgets", source: "only-allowed-chat" }, postableChats: 1 };
  try {
    const { host, done } = renderTelegramStep();
    await until(() => host.querySelector("[data-onboarding-report-chat=team-reports]")?.getAttribute("aria-checked") === "true");
    expect(host.querySelector("[data-onboarding-report-chat=log-only]")!.getAttribute("aria-checked")).toBe("false");
    const inUse = host.querySelector("[data-onboarding-report-chat=team-reports] [data-onboarding-report-in-use]");
    expect(inUse?.getAttribute("data-onboarding-report-in-use")).toBe("only-allowed-chat");
    expect(inUse?.textContent).toBe("In use now: the only chat agents may post in");
    expect(host.querySelector("[data-onboarding-report-asking]")).toBeNull();
    done();
  } finally {
    reportSettings = { reportTelegram: null, reportDestination: null, postableChats: 0 };
  }
});

test("with several allowed chats and no choice, nothing is preselected and the step asks for one", async () => {
  botStatus = connectedBot([chatView({}), chatView({ chatId: "-100202", title: "Lounge", alias: "lounge" })]);
  reportSettings = { reportTelegram: null, reportDestination: null, postableChats: 2 };
  try {
    const { host, done } = renderTelegramStep();
    await until(() => Boolean(host.querySelector("[data-onboarding-report-asking]")));
    expect([...host.querySelectorAll("[data-onboarding-report-chat]")].map((node) => node.getAttribute("aria-checked"))).toEqual(["false", "false", "false"]);
    expect(host.querySelector("[data-onboarding-report-asking]")!.textContent).toBe("Agents may post in several chats: pick one. Until then reports go to the log only.");
    expect(host.querySelector("[data-onboarding-report-chat=log-only] [data-onboarding-report-in-use]")).not.toBeNull();
    done();
  } finally {
    reportSettings = { reportTelegram: null, reportDestination: null, postableChats: 0 };
  }
});

/* The operator allows a second chat inside the step: the one allowed chat is
   no longer where reports go, since the Viewer now posts nowhere until a pick. */
test("allowing a second chat in the step moves the in-use marker to Log only and asks for a pick", async () => {
  botStatus = connectedBot([chatView({}), chatView({ chatId: "-100202", title: "Design Lounge", alias: null, postAllowed: false, postable: false })]);
  reportSettings = { reportTelegram: null, reportDestination: { chat: "team-reports", name: "Widgets", source: "only-allowed-chat" }, reportFallbackName: "Widgets", postableChats: 1 };
  try {
    const { host, done } = renderTelegramStep();
    await until(() => host.querySelector("[data-onboarding-report-chat=team-reports] [data-onboarding-report-in-use]") !== null);
    expect(host.querySelector("[data-onboarding-report-chat=team-reports]")!.getAttribute("aria-checked")).toBe("true");
    /* The bot route answers the switch with two chats that accept posts. */
    botStatus = connectedBot([chatView({}), chatView({ chatId: "-100202", title: "Design Lounge", alias: "design-lounge" })]);
    flushSync(() => (host.querySelector("[role=switch]") as HTMLElement).click());
    await until(() => Boolean(host.querySelector("[data-onboarding-report-chat=design-lounge]")));
    expect(host.querySelector("[data-onboarding-report-chat=team-reports] [data-onboarding-report-in-use]")).toBeNull();
    expect(host.querySelector("[data-onboarding-report-chat=log-only] [data-onboarding-report-in-use]")).not.toBeNull();
    expect(host.querySelector("[data-onboarding-report-asking]")).not.toBeNull();
    expect([...host.querySelectorAll("[data-onboarding-report-chat]")].map((node) => node.getAttribute("aria-checked"))).toEqual(["false", "false", "false"]);
    expect((host.querySelector("[data-onboarding-telegram-save]") as HTMLButtonElement).disabled).toBe(true);
    done();
  } finally {
    reportSettings = { reportTelegram: null, reportDestination: null, postableChats: 0 };
  }
});

/* The reverse: the bot is in one chat it may not post to yet, and allowing it
   in the step makes it where reports go now, under the fallback name. */
test("allowing the only chat in the step makes it the chat in use, with the name reports carry", async () => {
  botStatus = connectedBot([chatView({ alias: null, postAllowed: false, postable: false })]);
  reportSettings = { reportTelegram: null, reportDestination: null, reportFallbackName: "Widgets", postableChats: 0 };
  try {
    const { host, done } = renderTelegramStep();
    await until(() => host.querySelector("[data-onboarding-report-chat=log-only] [data-onboarding-report-in-use]") !== null);
    expect(host.querySelector("[data-onboarding-report-chat=log-only]")!.getAttribute("aria-checked")).toBe("true");
    botStatus = connectedBot([chatView({})]);
    flushSync(() => (host.querySelector("[role=switch]") as HTMLElement).click());
    await until(() => Boolean(host.querySelector("[data-onboarding-report-chat=team-reports]")));
    expect(host.querySelector("[data-onboarding-report-chat=team-reports]")!.getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector("[data-onboarding-report-chat=team-reports] [data-onboarding-report-in-use]")?.getAttribute("data-onboarding-report-in-use")).toBe("only-allowed-chat");
    expect(host.querySelector("[data-onboarding-report-chat=log-only] [data-onboarding-report-in-use]")).toBeNull();
    expect(host.querySelector<HTMLInputElement>("[data-onboarding-report-name]")!.value).toBe("Widgets");
    done();
  } finally {
    reportSettings = { reportTelegram: null, reportDestination: null, postableChats: 0 };
  }
});

/* No GitHub remote: the Viewer posts in the one allowed chat under the
   project's display name, and the step shows that name as in use. */
test("with no GitHub name, the one allowed chat shows the display name reports carry, and nothing claims it stays local", async () => {
  nameSuggestion = null;
  botStatus = connectedBot([chatView({})]);
  reportSettings = { reportTelegram: null, reportDestination: { chat: "team-reports", name: "widgets", source: "only-allowed-chat" }, reportFallbackName: "widgets", postableChats: 1 };
  try {
    const { host, done } = renderTelegramStep();
    await until(() => (host.querySelector<HTMLInputElement>("[data-onboarding-report-name]")?.value ?? "") === "widgets");
    expect(host.querySelector("[data-onboarding-report-chat=team-reports]")!.getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector("[data-onboarding-report-name]")!.getAttribute("aria-invalid")).toBe("false");
    expect(host.querySelector("[data-onboarding-report-name-in-use]")?.textContent).toBe("Reports in this chat carry “widgets” now: the project has no GitHub repository, so this is its name on this computer. Change it here to use another name.");
    expect(host.textContent).not.toContain("stays on this computer");
    expect((host.querySelector("[data-onboarding-telegram-save]") as HTMLButtonElement).disabled).toBe(false);
    done();
  } finally {
    nameSuggestion = "Widgets";
    reportSettings = { reportTelegram: null, reportDestination: null, postableChats: 0 };
  }
});

test("a stored Log only starts on Log only, in use, even with one allowed chat", async () => {
  botStatus = connectedBot([chatView({})]);
  reportSettings = { reportTelegram: { chat: null, changedAt: "2026-09-26T10:00:00.000Z", changedBy: "operator" }, reportDestination: null, postableChats: 1 };
  try {
    const { host, done } = renderTelegramStep();
    await until(() => host.querySelector("[data-onboarding-report-chat=log-only]")?.getAttribute("aria-checked") === "true");
    expect(host.querySelector("[data-onboarding-report-chat=team-reports]")!.getAttribute("aria-checked")).toBe("false");
    expect(host.querySelector("[data-onboarding-report-chat=log-only] [data-onboarding-report-in-use]")?.getAttribute("data-onboarding-report-in-use")).toBe("chosen");
    expect(host.querySelector("[data-onboarding-report-chat=team-reports] [data-onboarding-report-in-use]")).toBeNull();
    done();
  } finally {
    reportSettings = { reportTelegram: null, reportDestination: null, postableChats: 0 };
  }
});

/* The operator chose a chat, then switched posting off in the bot panel: the
   Viewer still addresses that chat, so the step shows it chosen and in use,
   says posts are refused, and Save cannot write it again. */
test("a chosen chat that refuses posts stays chosen and in use, cannot be saved again, and a pick moves Save on", async () => {
  requests.length = 0;
  botStatus = connectedBot([chatView({}), chatView({ chatId: "-100202", title: "Design Lounge", alias: "design-lounge", postAllowed: false, postable: false })]);
  reportSettings = { reportTelegram: { chat: "design-lounge", name: "Atlas", changedAt: "2026-09-26T10:00:00.000Z", changedBy: "operator" }, reportDestination: { chat: "design-lounge", name: "Atlas", source: "chosen" }, postableChats: 1 };
  try {
    const { host, done } = renderTelegramStep();
    await until(() => host.querySelector("[data-onboarding-report-chat=design-lounge]")?.getAttribute("aria-checked") === "true");
    const lounge = host.querySelector("[data-onboarding-report-chat=design-lounge]") as HTMLButtonElement;
    expect(lounge.disabled).toBe(true);
    expect(lounge.textContent).toContain("Design Lounge");
    expect(lounge.querySelector("[data-onboarding-report-in-use]")?.getAttribute("data-onboarding-report-in-use")).toBe("chosen");
    expect(lounge.querySelector("[data-onboarding-report-refused]")?.textContent).toBe("Agents may not post in this chat now, so reports reach the log only. Allow it, or pick another chat.");
    expect(host.querySelector("[data-onboarding-report-chat=team-reports]")!.getAttribute("aria-checked")).toBe("false");
    expect(host.querySelector("[data-onboarding-report-chat=team-reports] [data-onboarding-report-in-use]")).toBeNull();
    expect(host.querySelector<HTMLInputElement>("[data-onboarding-report-name]")!.value).toBe("Atlas");
    const save = host.querySelector("[data-onboarding-telegram-save]") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    flushSync(() => save.click());
    expect(requests.some((request) => request.method === "PUT")).toBe(false);
    /* The switch to allow it again is right there. */
    expect((host.querySelector("[role=switch]") as HTMLElement).getAttribute("aria-label")).toContain("Design Lounge");
    flushSync(() => (host.querySelector("[data-onboarding-report-chat=team-reports]") as HTMLElement).click());
    expect(host.querySelector("[data-onboarding-report-chat=team-reports]")!.getAttribute("aria-checked")).toBe("true");
    expect(lounge.getAttribute("aria-checked")).toBe("false");
    expect(lounge.querySelector("[data-onboarding-report-in-use]")).not.toBeNull();
    expect(save.disabled).toBe(false);
    done();
  } finally {
    reportSettings = { reportTelegram: null, reportDestination: null, postableChats: 0 };
  }
});

test("with no GitHub name to suggest, a chosen chat needs a name before it can be used", async () => {
  nameSuggestion = null;
  botStatus = connectedBot([chatView({}), chatView({ chatId: "-100202", title: "Lounge", alias: "lounge" })]);
  try {
    const { host, done } = renderTelegramStep();
    await until(() => Boolean(host.querySelector("[data-onboarding-report-chat=team-reports]")));
    flushSync(() => (host.querySelector("[data-onboarding-report-chat=team-reports]") as HTMLElement).click());
    expect(host.querySelector<HTMLInputElement>("[data-onboarding-report-name]")!.value).toBe("");
    expect(host.querySelector("[data-onboarding-report-name]")!.getAttribute("aria-invalid")).toBe("true");
    expect((host.querySelector("[data-onboarding-telegram-save]") as HTMLButtonElement).disabled).toBe(true);
    expect(host.textContent).toContain("Required with a chat: a folder name stays on this computer.");
    /* Log only needs no name. */
    flushSync(() => (host.querySelector("[data-onboarding-report-chat=log-only]") as HTMLElement).click());
    expect((host.querySelector("[data-onboarding-telegram-save]") as HTMLButtonElement).disabled).toBe(false);
    done();
  } finally {
    nameSuggestion = "Widgets";
  }
});

test("a skipped Telegram step is settled: the guide never reopens on it", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const marker = { schemaVersion: 1, completedAt: null, dismissedAt: null, reason: null, lastHealth: null, walk: null, steps: { engines: "done", project: "done", telegram: "skipped", orchestrator: null, agents: null, phone: null, voice: null, check: null } } as const;
  flushSync(() => root.render(<OnboardingDialog mode="guide" marker={marker} onClose={() => {}} />));
  expect(host.querySelector("[data-onboarding-step=orchestrator]")?.getAttribute("aria-current")).toBe("step");
  flushSync(() => root.unmount());
  host.remove();
});

test("Continue on the Telegram step without choosing anything is a skip, and writes no destination", async () => {
  requests.length = 0;
  botStatus = connectedBot([chatView({})]);
  const { host, done } = renderTelegramStep();
  await until(() => Boolean(host.querySelector("[data-onboarding-report-chat=team-reports]")));
  flushSync(() => (host.querySelector("[data-onboarding-primary]") as HTMLElement).click());
  expect(host.querySelector("[data-onboarding-step=orchestrator]")?.getAttribute("aria-current")).toBe("step");
  expect(requests.filter((request) => request.url.includes("/api/projects/settings") && request.method === "PUT")).toEqual([]);
  expect(requests.some((request) => request.url.includes("/api/onboarding") && JSON.stringify(request.body) === JSON.stringify({ steps: { telegram: "skipped" } }))).toBe(true);
  done();
});

test("the Telegram step reads in Ukrainian", async () => {
  const { setLocale } = await import("@/lib/i18n");
  setLocale("uk");
  try {
    botStatus = connectedBot([chatView({})]);
    const { host, done } = renderTelegramStep();
    await until(() => Boolean(host.querySelector("[data-onboarding-report-chat=log-only]")));
    expect(host.textContent).toContain("Надсилати звіти ще й у Telegram");
    expect(host.textContent).toContain("Лише журнал, без Telegram");
    expect(host.textContent).toContain("Назва у звітах");
    done();
  } finally {
    setLocale("en");
  }
});

/* docs/design/model-sizing-tiers.md §5 and §6: the mapping lists the
   small-change and docs rows, says which row an update reset and restores it
   in one click, and offers no Sonnet or Haiku where the server refuses them. */
test("the mapping shows the small-change and docs rows, a reset row with Restore, and no Sonnet on a denied row", async () => {
  const { mergeRoleDefinitions } = await import("@/lib/roles/store");
  const { ROLE_VARIANT_DEFAULTS } = await import("@/lib/roles/paramConfig");
  const from = { engine: "claude", model: "opus", effort: "xhigh" };
  const roles = mergeRoleDefinitions({}).map((role) => ({
    ...role,
    promptPreview: role.promptScaffold,
    shipped: { config: role.config, ...(role.id in ROLE_VARIANT_DEFAULTS ? { variants: ROLE_VARIANT_DEFAULTS[role.id as keyof typeof ROLE_VARIANT_DEFAULTS] } : {}) },
  }));
  rolesBody = { schemaVersion: 3, roles, resets: [{ id: "2026-09-builder-frontend-opus-xhigh", row: "builder:frontend", from, at: "2026-09-27T08:00:00.000Z" }] };
  requests.length = 0;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(<OnboardingDialog mode="mapping" marker={null} onClose={() => {}} />));
    await until(() => Boolean(host.querySelector("[data-mapping-row]")));
    const rows = [...host.querySelectorAll("[data-mapping-row]")].map((row) => row.getAttribute("data-mapping-row"));
    expect(rows.slice(0, 8)).toEqual(["builder", "builder:trivial", "builder:frontend", "builder:docs", "builder:apply-fixes", "reviewer", "reviewer:trivial", "verifier"]);
    expect(host.querySelector("[data-mapping-row='builder:trivial']")?.textContent).toContain("Builder, small changes");
    expect(host.querySelector("[data-mapping-row='builder:docs']")?.textContent).toContain("Builder, docs and text");
    expect(host.querySelector("[data-mapping-row='reviewer:trivial']")?.textContent).toContain("Reviewer, small changes");

    const retired = host.querySelector("[data-mapping-retired='builder:frontend']");
    expect(retired?.textContent).toContain("Set to the default when Delegatus updated (was Opus 5.5 · xhigh).");
    expect(host.querySelectorAll("[data-mapping-retired]")).toHaveLength(1);

    const modelsOf = (row: string) => [...host.querySelectorAll(`[data-mapping-row='${row}'] select`)][0]!.querySelectorAll("option");
    const ids = (row: string) => [...modelsOf(row)].map((option) => option.getAttribute("value"));
    expect(ids("architect")).not.toContain("sonnet");
    expect(ids("architect")).not.toContain("haiku");
    expect(ids("architect")).toContain("opus");
    expect(ids("builder:trivial")).toContain("sonnet");

    flushSync(() => (host.querySelector("[data-mapping-restore='builder:frontend']") as HTMLElement).click());
    await until(() => requests.some((request) => request.method === "PUT" && request.url.includes("/api/roles")));
    expect(requests.find((request) => request.method === "PUT")?.body).toEqual({ overrides: { builder: { variants: { frontend: from } } } });
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    rolesBody = { schemaVersion: 2, roles: [] };
  }
});
