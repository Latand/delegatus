import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { RuntimeVoiceDelivery } from "@/lib/runtime/voiceDelivery";
import { installActEnv } from "@/test-helpers/actEnv";

const dom = new Window();
installActEnv();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement });
const { configureRealtimeClientForTests, useCodexRealtime } = await import("./useCodexRealtime");
const originalFetch = globalThis.fetch;
let root: Root | null = null;
afterEach(async () => { if (root) await act(() => root!.unmount()); root = null; document.body.replaceChildren(); globalThis.fetch = originalFetch; configureRealtimeClientForTests(null); });

const delivery: RuntimeVoiceDelivery = { deliveryId: 'voice:["turn-one",["response-one"]]', turnId: "turn-one", ready: true, responses: [{ responseId: "response-one", text: "Canonical worker response" }] };
const stub = { ...delivery, responses: [{ responseId: "response-one", text: "" }] };
const idle = { phase: "idle" as const, lines: [], error: null, agentUnavailable: null, startedAt: null, micMuted: false, outputMuted: false, notice: null };
function harness() {
  let starts = 0;
  const reconciled: RuntimeVoiceDelivery[][] = [];
  configureRealtimeClientForTests(() => ({ subscribe: () => () => {}, getSnapshot: () => idle, micStream: () => null,
    toggleMic() {}, toggleOutput() {}, start: async () => { starts++; }, stop: async () => {}, updateWorkerProgress() {},
    reconcileWorkerDeliveries: (value, options) => { if (options?.ready !== false) reconciled.push([...value]); }, reconcileCanonicalTranscript() {}, reportBackingHost() {}, realtimeSession: () => null, onDeliveryAcknowledged: () => () => {},
  }));
  let api: ReturnType<typeof useCodexRealtime>;
  function Probe({ rows, revision }: { rows: RuntimeVoiceDelivery[]; revision?: number }) {
    api = useCodexRealtime("conversation_example", true, "", "", false, rows, [], "hosted", revision);
    return null;
  }
  const host = document.createElement("div");document.body.append(host); root = createRoot(host);
  return { starts: () => starts, reconciled, api: () => api!, render: (rows: RuntimeVoiceDelivery[], revision?: number) => act(() => root!.render(<Probe rows={rows} revision={revision} />)) };
}

test("voice fetches only its targeted bodies before starting and cannot resurrect acknowledged ids", async () => {
  const view = harness();
  let resolve!: (response: Response) => void;
  const requests: string[] = [];
  globalThis.fetch = ((url: string) => { requests.push(url); return new Promise<Response>(done => { resolve = done; }); }) as unknown as typeof fetch;
  await view.render([stub], 4);
  expect(requests).toHaveLength(0);
  expect(view.reconciled).toHaveLength(0);
  let start!: Promise<void>;
  await act(() => { start = view.api().start(); });
  expect(requests).toEqual(["/api/runtime/snapshot?voiceFor=conversation_example"]);
  expect(view.starts()).toBe(0);
  await act(async () => { resolve(Response.json({ sessions: [{ conversationId: "conversation_example", revision: 4, voiceDeliveries: [delivery] }] })); await start; });
  expect(view.starts()).toBe(1);
  expect(view.reconciled.at(-1)?.[0]?.responses[0]?.text).toBe(delivery.responses[0]!.text);
  // The event stream's current id set remains authoritative after tombstones expire.
  await view.render([], 4);
  expect(view.reconciled.at(-1)).toEqual([]);
  await view.render([], 4);
  expect(view.reconciled.at(-1)).toEqual([]);
});

test("a stale or unavailable body read never starts voice or clears retained deliveries", async () => {
  const view = harness();
  globalThis.fetch = (async () => Response.json({ sessions: [{ conversationId: "conversation_example", revision: 3, voiceDeliveries: [delivery] }] })) as unknown as typeof fetch;
  await view.render([stub], 4);
  await act(async () => { await expect(view.api().start()).rejects.toThrow("incomplete"); });
  expect(view.starts()).toBe(0);
  expect(view.reconciled).toHaveLength(0);
});

test("legacy full snapshots keep voice working without another read", async () => {
  const view = harness();
  globalThis.fetch = (async () => { throw new Error("unexpected read"); }) as unknown as typeof fetch;
  await view.render([delivery]);
  await act(async () => { await view.api().start(); });
  expect(view.starts()).toBe(1);
  expect(view.reconciled.at(-1)).toEqual([delivery]);
});


test("stopping during body hydration cannot start a call when the read finishes", async () => {
  const view = harness();
  let resolve!: (response: Response) => void;
  globalThis.fetch = (() => new Promise<Response>(done => { resolve = done; })) as unknown as typeof fetch;
  await view.render([stub], 4);
  let starting!: Promise<void>;
  await act(() => { starting = view.api().start(); });
  expect(view.api().phase).toBe("connecting");
  await act(async () => { await view.api().stop(); });
  await act(async () => { resolve(Response.json({ sessions: [{ conversationId: "conversation_example", revision: 4, voiceDeliveries: [delivery] }] })); await starting; });
  expect(view.starts()).toBe(0);
  expect(view.api().phase).toBe("idle");
});
