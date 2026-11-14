import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/transcribe/diagnostics/route";
import { newDictationTrace, publishDictationTrace, type DictationTrace } from "./dictationTrace";
import { dictationTraceSchema, recordDictationTrace } from "./dictationTraceStore";

const roots: string[] = [];
const priorState = process.env.LLV_STATE_DIR;
afterEach(async () => {
  if (priorState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = priorState;
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function isolate() { const root = await fs.mkdtemp(path.join(os.tmpdir(), "dictation-trace-")); roots.push(root); process.env.LLV_STATE_DIR = root; return root; }
function trace(index = 0) {
  return { ...newDictationTrace(), id: ["00000000", "0000", "4000", "8000", index.toString(16).padStart(12, "0")].join("-"), startedAt: 1000 + index, revision: 1 };
}
function request(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/transcribe/diagnostics", { method: "POST", headers: { host: "localhost", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

test("the real client writer's snapshots pass the persisted reader schema", () => {
  const first = trace(); expect(dictationTraceSchema.parse(first)).toEqual(first);
  const completed: DictationTrace = { ...first, revision: 2, path: "live-batch", provider: "soniox", stoppedAt: 2000, endedAt: 2500,
    tokenMs: 25, connectMs: 50, sampleRate: 16000, capturedSamples: 3200, sentSamples: 3200, bufferedSamples: 1600, peakBufferedSamples: 3200,
    finalSegments: 2, commits: 1, replayedFinals: 1, closeCode: 1006, closeReason: "abnormal", tokenOutcome: "ok", connectOutcome: "ok", drainOutcome: "error", batchOutcome: "ok", outcome: "complete" };
  expect(dictationTraceSchema.parse(completed)).toEqual(completed);
});

test("the route persists only strict diagnostics and rejects hostile payloads before writes", async () => {
  const root = await isolate();
  expect((await POST(request(trace(), { origin: "https://untrusted.invalid", "sec-fetch-site": "cross-site" }))).status).toBe(403);
  for (const body of [{ ...trace(), text: "private speech" }, { ...trace(), audio: "samples" }, { ...trace(), closeReason: "private speech" }, { ...trace(), tokenMs: -1 }, { ...trace(), id: "private-speech" }]) {
    expect((await POST(request(body))).status).toBe(400);
  }
  expect((await POST(request({ ...trace(), text: "x".repeat(5000) }))).status).toBe(413);
  expect(await fs.readdir(root)).toEqual([]);
  expect((await POST(request(trace()))).status).toBe(204);
  const rows = JSON.parse(await fs.readFile(path.join(root, "diagnostics/dictation.json"), "utf8"));
  expect(rows).toEqual([trace()]);
});

// Restart the actual writer: a process-local cache cannot establish retention or revision safety.
async function writer(root: string, rows: unknown[]) {
  const script = `const { recordDictationTrace } = await import("./src/lib/transcribe/dictationTraceStore.ts");
    for (const row of JSON.parse(process.env.DICTATION_TEST_ROWS)) await recordDictationTrace(row);`;
  const child = Bun.spawn([process.execPath, "--eval", script], { cwd: process.cwd(), env: { ...process.env, LLV_STATE_DIR: root, DICTATION_TEST_ROWS: JSON.stringify(rows) }, stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(child.stderr).text(); const code = await child.exited;
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
}
test("retention and revision guards survive a writer process restart", async () => {
  const root = await isolate();
  await writer(root, Array.from({ length: 105 }, (_, i) => trace(i)));
  const latest = { ...trace(104), revision: 3, endedAt: 3000, outcome: "incomplete" };
  await writer(root, [latest]); await writer(root, [{ ...trace(104), revision: 2 }, trace(0)]);
  const rows = JSON.parse(await fs.readFile(path.join(root, "diagnostics/dictation.json"), "utf8"));
  expect(rows).toHaveLength(100); expect(rows[0].id).toBe(trace(5).id); expect(rows.at(-1)).toEqual(latest);
  expect(rows.map((row: unknown) => dictationTraceSchema.parse(row))).toEqual(rows);
});

test("an unreadable stored record is retained and its failed write does not poison the queue", async () => {
  const root = await isolate(); const file = path.join(root, "diagnostics/dictation.json"); await fs.mkdir(path.dirname(file)); await fs.writeFile(file, "broken");
  expect((await POST(request(trace()))).status).toBe(503); expect(await fs.readFile(file, "utf8")).toBe("broken");
  await fs.writeFile(file, "[]"); expect((await POST(request(trace()))).status).toBe(204);
});


test("the writer refuses pending work above 32 without holding the queue", async () => {
  const root = await isolate();
  const writes = Array.from({ length: 40 }, (_, i) => recordDictationTrace(trace(i)));
  const results = await Promise.all(writes);
  expect(results.filter(Boolean)).toHaveLength(32); expect(results.slice(32)).toEqual(Array(8).fill(false));
  expect(await recordDictationTrace(trace(40))).toBe(true);
  const rows = JSON.parse(await fs.readFile(path.join(root, "diagnostics/dictation.json"), "utf8")); expect(rows).toHaveLength(33);
});


test("client checkpoints retry failures and remove only acknowledged revisions", async () => {
  const originalFetch = globalThis.fetch;
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const stored = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } } });
  const sent: unknown[] = []; const pending: Array<(response: Response) => void> = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => { sent.push(dictationTraceSchema.parse(JSON.parse(String(init?.body)))); return new Promise<Response>(resolve => { pending.push(resolve); }); }) as typeof fetch;
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  try {
    const record = trace(); publishDictationTrace(record); publishDictationTrace(record);
    pending.shift()!(new Response(null, { status: 204 })); await settle();
    expect(JSON.parse([...stored.values()][0])[0].revision).toBe(3);
    pending.shift()!(new Response(null, { status: 503 })); await settle();
    const other = trace(1); publishDictationTrace(other); expect(sent).toHaveLength(4);
    for (const resolve of pending.splice(0)) resolve(new Response(null, { status: 204 })); await settle();
    expect(JSON.parse([...stored.values()][0])).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
    if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor); else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
