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
  localStorage: dom.localStorage,
  matchMedia: matchMediaStub,
  fetch: (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/roles")) return json({ schemaVersion: 2, roles: [] });
    if (url.includes("/api/transcribe/backend")) return json({ backend: "local", lockedByEnv: false, options: [] });
    if (url.includes("/api/access")) return json({ tailnetUrl: null, phone: { state: "missing", dnsName: null, viewerPort: 8898, servingPort: null, persisted: false }, phoneError: null });
    return json({ claude: { active: "", accounts: [] }, codex: { active: "", accounts: [] } });
  },
});

const { OnboardingDialog } = await import("./OnboardingDialog");

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

test("slice 3: the guide lists six steps, counts to six and opens on the step it was asked for", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(<OnboardingDialog mode="guide" initialStep="voice" marker={null} onClose={() => {}} />));
  const steps = Array.from(host.querySelectorAll("[data-onboarding-step]")).map((element) => element.getAttribute("data-onboarding-step"));
  expect(steps).toEqual(["engines", "agents", "phone", "voice", "tour", "check"]);
  expect(host.querySelector("[data-onboarding-step=voice]")?.getAttribute("aria-current")).toBe("step");
  expect(host.textContent).toContain("Step 4 of 6");
  expect(host.textContent).toContain("Where your dictation is transcribed");
  flushSync(() => root.unmount());
  host.remove();
});

test("slice 3: a marker written by the three-step guide lands a returning user on Phone", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const marker = { schemaVersion: 1, completedAt: null, dismissedAt: null, reason: null, lastHealth: null, steps: { engines: "done", agents: "done", phone: null, voice: null, tour: null, check: null } } as const;
  flushSync(() => root.render(<OnboardingDialog mode="guide" marker={marker} onClose={() => {}} />));
  expect(host.querySelector("[data-onboarding-step=phone]")?.getAttribute("aria-current")).toBe("step");
  expect(host.textContent).toContain("Step 3 of 6");
  flushSync(() => root.unmount());
  host.remove();
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
   languages, in its title and on the tour step that says what the product is,
   and the former name is gone from what it renders. */
test("the guide's title and tour heading name Delegatus, in en and in uk", async () => {
  const { setLocale } = await import("@/lib/i18n");
  const cases = [
    { locale: "en" as const, title: "Set up Delegatus", heading: "What Delegatus is" },
    { locale: "uk" as const, title: "Налаштування Delegatus", heading: "Що таке Delegatus" },
  ];
  try {
    for (const { locale, title, heading } of cases) {
      setLocale(locale);
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      flushSync(() => root.render(<OnboardingDialog mode="guide" initialStep="tour" marker={null} onClose={() => {}} />));
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
