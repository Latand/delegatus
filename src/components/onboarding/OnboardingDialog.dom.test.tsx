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
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  CustomEvent: dom.CustomEvent,
  localStorage: dom.localStorage,
  matchMedia: matchMediaStub,
  fetch: (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/roles")) return json({ schemaVersion: 2, roles: [] });
    if (url.includes("/api/transcribe/backend")) return json({ backend: "local", lockedByEnv: false, options: [] });
    if (url.includes("/api/access")) return json({ tailnetUrl: null, phone: { state: "missing", dnsName: null, viewerPort: 8898, servingPort: null, persisted: false }, phoneError: null });
    if (url.includes("/api/orchestrator/seat")) return Promise.resolve(new Response("{}", { status: 404 }));
    if (url.includes("/api/accounts/copilot")) return json({ cli: { present: false, reason: null }, active: "", accounts: [] });
    if (url.endsWith("/api/accounts") || url.includes("/api/accounts?")) return json(accountsBody);
    return json({ claude: { active: "", accounts: [] }, codex: { active: "", accounts: [] } });
  },
});

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

test("#2166: three numbered steps, then Agents, Phone, Voice and Check under Later, counted to three", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(<OnboardingDialog mode="guide" marker={null} onClose={() => {}} />));
  const steps = Array.from(host.querySelectorAll("[data-onboarding-step]")).map((element) => element.getAttribute("data-onboarding-step"));
  expect(steps).toEqual(["engines", "project", "orchestrator", "agents", "phone", "voice", "check"]);
  expect(Array.from(host.querySelectorAll("[data-step-mark=later]")).length).toBe(4);
  expect(host.textContent).toContain("Later, any time");
  expect(host.querySelector("[data-onboarding-step=engines]")?.getAttribute("aria-current")).toBe("step");
  expect(host.textContent).toContain("Step 1 of 3");
  /* Copilot sits beside Claude and Codex. */
  expect(host.querySelector("[data-onboarding-engine=copilot]")).not.toBeNull();
  flushSync(() => root.unmount());
  host.remove();
});

test("#2166: a six-step marker with Engines done lands on Project; the Tour is gone", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const marker = { schemaVersion: 1, completedAt: null, dismissedAt: null, reason: null, lastHealth: null, walk: null, steps: { engines: "done", project: null, orchestrator: null, agents: "done", phone: null, voice: null, check: null } } as const;
  flushSync(() => root.render(<OnboardingDialog mode="guide" marker={marker} onClose={() => {}} />));
  expect(host.querySelector("[data-onboarding-step=project]")?.getAttribute("aria-current")).toBe("step");
  expect(host.textContent).toContain("Step 2 of 3");
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
