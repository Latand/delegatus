import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale } from "@/lib/i18n";

const dom = new Window({ url: "http://localhost", width: 1440, height: 900 });
installActEnv();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Event: dom.Event, MouseEvent: dom.MouseEvent, PointerEvent: dom.Event, KeyboardEvent: dom.KeyboardEvent, sessionStorage: dom.sessionStorage, localStorage: dom.localStorage });
const { WorkerLimitChip, WorkerLimitSettingsRow } = await import("./WorkerLimitChip");
const originalFetch = globalThis.fetch;
const { useOrchestratorIncumbent, resetOrchestratorIncumbentCacheForTests } = await import("./useOrchestratorIncumbent");
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; setLocale("en"); globalThis.fetch = originalFetch; });
const workers = { running: 7, runningMachine: 19, limit: 10, source: "project" as const, machine: 8 };
async function mount(props: Partial<Parameters<typeof WorkerLimitChip>[0]> = {}) {
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root.render(<WorkerLimitChip project="one" workers={workers} {...props} />); });
  return host;
}
test("a project limit has a tiny dot and source in the accessible name; over limit warns", async () => {
  const host = await mount();
  expect(host.textContent).toBe("workers 7 / 10");
  expect(host.querySelector("[data-worker-limit-own]")).not.toBeNull();
  expect(host.querySelector("button")!.getAttribute("aria-label")).toContain("this project's own");
  await act(async () => { root.render(<WorkerLimitChip project="one" workers={{ ...workers, running: 11 }} />); });
  expect(host.querySelector("button")!.className).toContain("text-warning");
});

const answer = (value: number | null, machine = 8) => ({ machine: { value: machine, default: 3, min: 1, max: 64, source: "machine", changedAt: null, changedBy: null }, project: { key: "one", value, effective: value ?? machine, source: value === null ? "machine" : "project" }, running: { here: 7, machine: 19 } });
async function open(host: HTMLElement) {
  const button = host.querySelector("button")!;
  button.getBoundingClientRect = () => ({ x: 10, y: 20, left: 10, top: 20, bottom: 44, right: 120, width: 110, height: 24, toJSON() {} });
  await act(async () => { button.click(); });
  return document.querySelector("[data-worker-limit-popover]")!;
}
async function blur(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new dom.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
  });
}
test("the inherited popover saves an own limit on blur, resets and closes on Escape", async () => {
  const writes: unknown[] = [];
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)); writes.push(body);
    return Response.json(answer(body.value));
  }) as typeof fetch;
  const host = await mount({ workers: { ...workers, source: "machine", limit: 8 } });
  let popover = await open(host);
  const field = popover.querySelector("input")!;
  expect(field.value).toBe(""); expect(field.placeholder).toBe("8");
  expect(popover.textContent).toContain("from the machine default");
  await blur(field, "10");
  expect(writes).toEqual([{ project: "one", value: 10 }]);
  expect(popover.textContent).toContain("own limit");
  await act(async () => { (popover.querySelector("button") as HTMLButtonElement).click(); });
  expect(writes).toEqual([{ project: "one", value: 10 }, { project: "one", value: null }]);
  expect(host.querySelector("[data-worker-limit-own]")).toBeNull();
  await act(async () => { document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event); });
  expect(document.querySelector("[data-worker-limit-popover]")).toBeNull();
  popover = await open(host);
  await act(async () => { root.render(<WorkerLimitChip project="two" workers={workers} />); });
  expect(document.querySelector("[data-worker-limit-popover]")).toBeNull();
});

test("invalid and refused saves restore the stored value; clearing resets", async () => {
  let refused = true;
  const writes: unknown[] = [];
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)); writes.push(body);
    return refused ? Response.json({}, { status: 500 }) : Response.json(answer(body.value));
  }) as typeof fetch;
  const host = await mount(); const popover = await open(host);
  const field = popover.querySelector("input")!;
  await blur(field, "65");
  expect(writes).toHaveLength(0); expect(field.value).toBe("10");
  expect(popover.textContent).toContain("From 1 to 64");
  await blur(field, "12");
  expect(field.value).toBe("10"); expect(popover.textContent).toContain("Could not save");
  refused = false; await blur(field, "");
  expect(writes.at(-1)).toEqual({ project: "one", value: null });
  expect(host.textContent).toBe("workers 7 / 8");
});

for (const lang of ["en", "uk"] as const) test(`${lang}: settings edits the machine default, shows the project's own limit and rolls back a refusal`, async () => {
  setLocale(lang); let refused = false; let machine = 8;
  const writes: unknown[] = [];
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)); writes.push(body);
      if (refused) return Response.json({}, { status: 500 });
      machine = body.value;
    }
    return Response.json(answer(10, machine));
  }) as typeof fetch;
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root.render(<WorkerLimitSettingsRow project="one" />); });
  const field = host.querySelector("input")!;
  expect(host.textContent).toContain(lang === "en" ? "Here: own limit 10" : "Тут свій ліміт: 10");
  await blur(field, "12"); expect(writes).toEqual([{ value: 12 }]);
  refused = true; await blur(field, "14"); expect(field.value).toBe("12");
  await blur(field, "0"); expect(writes).toHaveLength(2);
});

test("a status read held before the save cannot overwrite the confirmed worker limit", async () => {
  resetOrchestratorIncumbentCacheForTests();
  let held: ((response: Response) => void) | null = null;
  let reads = 0;
  const status = () => Response.json({ project: "one", designated: true, workers: { ...workers, source: "machine", limit: 8 } });
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("/seat/status")) {
      reads++;
      if (reads === 1) return status();
      return new Promise<Response>(resolve => { held = resolve; });
    }
    return Response.json(answer(JSON.parse(String(init?.body)).value));
  }) as typeof fetch;
  function Host() {
    const read = useOrchestratorIncumbent("one", true);
    return <><WorkerLimitChip project="one" workers={read.incumbent?.workers} /><button data-refresh onClick={() => { void read.refresh(); }}>Refresh</button></>;
  }
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root.render(<Host />); });
  await act(async () => { (host.querySelector("[data-refresh]") as HTMLButtonElement).click(); });
  const popover = await open(host);
  await blur(popover.querySelector("input")!, "10");
  expect(host.querySelector("[data-worker-limit-chip]")!.textContent).toBe("workers 7 / 10");
  await act(async () => { held!(status()); });
  expect(host.querySelector("[data-worker-limit-chip]")!.textContent).toBe("workers 7 / 10");
});

test("finishing Enter for the previous project leaves the current project's popover open", async () => {
  let finish: ((response: Response) => void) | null = null;
  globalThis.fetch = (() => new Promise<Response>(resolve => { finish = resolve; })) as unknown as typeof fetch;
  const host = await mount(); const popover = await open(host); const field = popover.querySelector("input")!;
  await act(async () => {
    field.focus();
    field.value = "12";
    expect(field.value).toBe("12");
    expect(field.validity.badInput).toBe(false);
    field.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
  });
  expect(finish).not.toBeNull();
  await act(async () => { root.render(<WorkerLimitChip project="two" workers={workers} />); });
  await open(host);
  await act(async () => { finish!(Response.json(answer(12))); });
  expect(document.querySelector("[data-worker-limit-popover]")?.getAttribute("data-worker-limit-popover")).toBe("two");
});
test("the machine face in Ukrainian has no dot and missing readings draw nothing", async () => {
  setLocale("uk");
  const host = await mount({ workers: { ...workers, source: "machine" } });
  expect(host.textContent).toBe("воркери 7 / 10");
  expect(host.querySelector("[data-worker-limit-own]")).toBeNull();
  await act(async () => { root.render(<WorkerLimitChip project="one" workers={null} />); });
  expect(host.textContent).toBe("");
});
