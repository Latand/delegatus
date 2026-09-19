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
