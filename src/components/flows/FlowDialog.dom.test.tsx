import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { FlowDialog } from "./FlowDialog";
import { BulkActionBar } from "@/components/scheme/BulkActionBar";
import type { SchemeNode } from "@/components/scheme/layout";
import type { FileEntry } from "@/lib/types";
import { setLocale } from "@/lib/i18n";

const dom = new Window({ url: "http://viewer.local" });
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
  Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent, localStorage: dom.localStorage });
const realFetch = globalThis.fetch;
let root: Root | null = null;
afterEach(() => { if (root) flushSync(() => root!.unmount()); root = null; globalThis.fetch = realFetch; document.body.replaceChildren(); setLocale("en"); });
async function until(predicate: () => boolean) {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  expect(predicate()).toBe(true);
}
const file = { path: "/example.jsonl", cwd: "/repo", projectRoot: "/repo", project: "demo", title: "Example", engine: "codex", root: "codex-sessions", kind: "session", fmt: "codex", activity: "idle" } as FileEntry;
function mount(element: React.ReactNode) {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  flushSync(() => root!.render(element)); return host;
}

test("the old creation entry creates an unstarted run graph without adopting the old conversation", async () => {
  const writes: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url.includes("preflight")) return Response.json({ ok: true, repoDir: "/repo" });
    if (init?.method === "POST") writes.push({ url, body: JSON.parse(String(init.body)) });
    return Response.json({ pipeline: { id: "draft-one" } });
  }) as unknown as typeof fetch;
  mount(<FlowDialog file={file} onClose={() => {}} />);
  await until(() => [...document.querySelectorAll("button")].some(button => button.textContent?.includes("Build") && !button.disabled));
  const button = [...document.querySelectorAll("button")].find(button => button.textContent?.includes("Build") && !button.disabled)!;
  flushSync(() => button.click());
  await until(() => writes.length === 1);
  expect(writes[0]!.url).toBe("/api/pipelines");
  expect(writes[0]!.body.autoStart).toBe(false);
  expect(writes[0]!.body.src).toBeUndefined();
  expect(writes[0]!.body.taskIds).toBeUndefined();
  const stages = writes[0]!.body.stages as { kind: string; onFail?: { maxRounds: number } }[];
  expect(stages.every(stage => stage.kind === "run")).toBe(true);
  expect(stages.find(stage => stage.onFail)?.onFail?.maxRounds).toBeGreaterThan(0);
});

test("failed repository admission leaves no enabled creation or flow write", async () => {
  const writes: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET" && !url.includes("preflight")) writes.push(url);
    return Response.json({ ok: false, code: "missing", path: "/repo" });
  }) as unknown as typeof fetch;
  mount(<FlowDialog file={file} onClose={() => {}} />);
  await until(() => Boolean(document.querySelector("[role=alert]")) || document.body.textContent!.includes("exist"));
  expect(writes).toEqual([]);
  expect(document.querySelector('input[type="number"]')).toBeNull();
  expect([...document.querySelectorAll("button")].some(button => button.textContent?.includes("Start") && !button.disabled)).toBe(false);
});

test("bulk selection offers one pipeline draft instead of a per-conversation flow launcher", () => {
  globalThis.fetch = (async () => Response.json({})) as unknown as typeof fetch;
  const host = mount(<BulkActionBar project="demo" nodes={[{ file } as SchemeNode]} flowsByImpl={new Map()} onRemove={() => {}} onFit={() => {}} onExit={() => {}} />);
  expect(host.textContent!.toLowerCase()).toContain("pipeline");
  expect(host.textContent).not.toContain("Start flows");
});


test("bulk picker portals its modal outside the transformed toolbar", async () => {
  globalThis.fetch = (async () => Response.json({ ok: true, repoDir: "/repo" })) as unknown as typeof fetch;
  let backgroundInputs = 0;
  const host = mount(<div onClick={() => backgroundInputs++} onPointerDown={() => backgroundInputs++}>
    <BulkActionBar project="demo" nodes={[{ file } as SchemeNode]} flowsByImpl={new Map()} onRemove={() => {}} onFit={() => {}} onExit={() => {}} />
  </div>);
  const entry = [...host.querySelectorAll("button")].find(button => button.textContent?.trim().endsWith("Pipeline"))!;
  flushSync(() => entry.click());
  await until(() => Boolean(document.querySelector('[data-pipeline-picker-state="ready"]')));
  const picker = document.querySelector("[data-pipeline-picker-state]")!;
  expect(picker.parentElement).toBe(document.body);
  expect(host.contains(picker)).toBe(false);
  expect(picker.querySelector("dialog")?.hasAttribute("open")).toBe(true);
  backgroundInputs = 0;
  picker.querySelector("input")!.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true }) as unknown as Event);
  (picker.querySelector("input") as HTMLInputElement).click();
  expect(backgroundInputs).toBe(0);
});
