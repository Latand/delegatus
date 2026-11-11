import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { startNativeCodexRuntime, type NativeCodexRuntime } from "./fixtures/nativeCodexRuntime";
import { claudeHostColumns, codexHostColumns } from "./registry";
import type { EngineHost } from "./engineHost";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { deliveryProgressStore } from "./deliveryProgress";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";

// Installed CLIs, credential-free local providers, real admission/socket/journal/
// controller/host/engine. Explicit opt-in also lets a clean checkout run without CLIs.
const codexBinary = process.env.LLV_NATIVE_CODEX_BINARY ?? process.env.NATIVE_CODEX_QUEUE_TEST_BINARY;
const claudeBinary = process.env.LLV_NATIVE_CLAUDE_BINARY;
const native = process.env.LLV_NATIVE_LONG_TURN_TEST === "1" || codexBinary ? test : test.skip;
const claudeNative = claudeBinary ? native : test.skip;
const EPOCH = Date.parse("2026-11-01T12:00:00Z");
afterEach(() => setSystemTime());
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const end = performance.now() + 25_000;
  while (!await check()) {
    if (performance.now() >= end) throw new Error("native delivery boundary did not arrive");
    await Bun.sleep(10);
  }
}
async function send(runtime: NativeCodexRuntime<EngineHost>, policy = "queue") {
  const response = await runtime.handle(new Request("http://localhost/api/runtime/send", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId: "long-turn-followup",
      idempotencyKey: "long-turn-followup", conversationId: runtime.conversationId, text: "long-turn-followup", policy }) }));
  expect(response.ok).toBe(true);
}
async function query(runtime: NativeCodexRuntime<EngineHost>) {
  return (await runtime.handle(new Request("http://localhost/api/runtime/operations/long-turn-followup"))).json();
}
for (const engine of ["claude", "codex"] as const) for (const checkpoint of ["stale", "current"] as const)
  (engine === "claude" ? claudeNative : native)(`${engine}: a queued message survives a 91-minute turn once; registry checkpoint ${checkpoint}`, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "long-turn-"));
  // Cleanup is installed before the fixture makes its first durable write.
  let runtime: NativeCodexRuntime<EngineHost> | null = null;
  let restoreSend = () => {};
  try {
    setSystemTime(EPOCH);
    const writerClaimOwner = `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`;
    runtime = engine === "claude"
      ? await startNativeCodexRuntime(directory, claudeBinary!, { engine, holdClaude: true, writerClaimOwner, settlementSweepMs: 5 })
      : await startNativeCodexRuntime(directory, codexBinary!, { writerClaimOwner, settlementSweepMs: 5 });
    const r = runtime;
    const sends = spyOn(r.host(), "send"); restoreSend = () => sends.mockRestore();
    const incumbent = r.host().send({ id: "incumbent", text: "incumbent" });
    void incumbent.catch(() => {});
    await until(() => r.provider.open() === 1);
    if (checkpoint === "current") {
      const health = await r.host().health();
      r.registry.setStructuredHost({ engine, sessionId: r.threadId }, engine === "claude"
        ? claudeHostColumns(health, 0) : codexHostColumns(health, 0));
    }
    await send(r);
    await kickStructuredDeliveryQueue();
    for (const minutes of [31, 91]) {
      setSystemTime(EPOCH + minutes * 60_000);
      await until(() => {
        const record = deliveryProgressStore().get("long-turn-followup");
        return !!record?.terminal || Date.parse(record?.deadlineAt ?? "") > Date.now();
      });
      const answer = await query(r);
      expect(answer.send.state).toBe("in-flight");
      if (checkpoint === "stale" || minutes === 91) expect(answer.progress.deadlinePolicy).toBe("turn-boundary");
      expect(r.provider.requests).toHaveLength(1);
    }
    expect(deliveryProgressStore().flush()).toBe(true);
    const settlementModule = new URL("./sendSettlement.ts", import.meta.url).pathname;
    const registryModule = new URL("../agent/registry.ts", import.meta.url).pathname;
    const clientModule = new URL("./client.ts", import.meta.url).pathname;
    const reader = Bun.spawn([process.execPath, "--eval", `const [{resolveSendReceipt},{AgentRegistry},{UnixRuntimeHostClient}]=await Promise.all([import(${JSON.stringify(settlementModule)}),import(${JSON.stringify(registryModule)}),import(${JSON.stringify(clientModule)})]); const receipt=await resolveSendReceipt("long-turn-followup",{registry:new AgentRegistry(${JSON.stringify(r.registry.filename)}),client:new UnixRuntimeHostClient(${JSON.stringify(r.socketPath)}),now:()=>${EPOCH + 91 * 60_000}}); console.log(JSON.stringify({state:receipt?.state}));`],
      { env: process.env, stdout: "pipe", stderr: "pipe" });
    expect(JSON.parse(await new Response(reader.stdout).text())).toEqual({ state: "in-flight" });
    expect(await reader.exited).toBe(0);
    r.provider.completeNext();
    await until(() => r.provider.requests.length === 2);
    r.provider.completeNext();
    await until(async () => (await query(r)).send.state === "delivered");
    await kickStructuredDeliveryQueue(); await kickStructuredDeliveryQueue();
    if (engine === "claude") expect(sends.mock.calls.filter(([entry]) => entry.id === "long-turn-followup")).toHaveLength(1);
    else expect(r.rpc.filter(call => ["turn/start", "thread/queue/add"].includes(call.method)
      && call.params.clientUserMessageId === "long-turn-followup")).toHaveLength(1);
    expect(r.provider.requests.filter(request => request.texts.some(text => text.includes("long-turn-followup")))).toHaveLength(1);
    expect((await query(r)).send.resend).toBe("not-needed");
  } finally {
    setSystemTime(); restoreSend();
    if (runtime) { while (runtime.provider.completeNext()) {} await runtime.close(); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

native("Codex hands a follow-up to turn/steer while the incumbent provider response is open", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "steer-turn-"));
  let runtime: NativeCodexRuntime | null = null;
  let restoreSteer = () => {};
  try {
    runtime = await startNativeCodexRuntime(directory, codexBinary!);
    const r = runtime;
    const steer = r.host().steer.bind(r.host());
    let steerAccepted = false;
    const steering = spyOn(r.host(), "steer").mockImplementation(async (...args) => {
      const result = await steer(...args);
      steerAccepted = true;
      return result;
    });
    restoreSteer = () => steering.mockRestore();
    const incumbent = r.host().send({ id: "incumbent", text: "incumbent" }); void incumbent.catch(() => {});
    await until(() => r.provider.open() === 1);
    await send(r, "steer-or-queue");
    // Dispatch can precede CLI acceptance; keep the incumbent open through its reply.
    await until(() => steerAccepted);
    expect(r.provider.open()).toBe(1);
    r.provider.completeNext();
    await until(() => r.provider.requests.length === 2);
    r.provider.completeNext();
    await until(async () => (await query(r)).send.state === "delivered");
    expect(r.rpc.filter(call => call.method === "turn/steer" && call.params.clientUserMessageId === "long-turn-followup")).toHaveLength(1);
    expect(r.rpc.filter(call => call.method === "turn/start" && call.params.clientUserMessageId === "long-turn-followup")).toHaveLength(0);
  } finally {
    restoreSteer();
    if (runtime) { while (runtime.provider.completeNext()) {} await runtime.close(); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
