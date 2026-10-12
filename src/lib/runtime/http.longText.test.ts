import fs from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { handleRuntimeCommand } from "./http";
import { assertStructuredTextEnvelope } from "./structuredContent";
import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";

function request(text: string, idempotencyKey: string, files: unknown[] = []) {
  return new NextRequest("http://127.0.0.1/api/runtime/send", {
    method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ conversationId: "conversation_long_text", text, idempotencyKey, files }),
  });
}

const delivered: string[] = [];
const dependencies: NonNullable<Parameters<typeof handleRuntimeCommand>[2]> = {
  enabled: () => true, structuredEnabled: () => true, client: () => null,
  enqueue: async (input) => {
    try { assertStructuredTextEnvelope(input.text); }
    catch (error) { return { ok: false, structured: true, outcome: "failed", status: 413, error: (error as Error).message }; }
    delivered.push(input.text);
    return { ok: true, structured: true, target: "conversation_long_text", outcome: "queued", operationId: "op_long_text",
      receipt: { operationId: "op_long_text", status: "queued" } } as never;
  },
};

test("30,000 Cyrillic characters reach the envelope as a complete UTF-8 text file", async () => {
  const text = "я".repeat(30_000);
  const response = await handleRuntimeCommand(request(text, "long-text"), "send", dependencies);
  expect(response.status).toBe(202);
  const payload = delivered.at(-1)!;
  const written = payload.split("\n").at(-1)!;
  expect(path.extname(written)).toBe(".txt");
  expect(fs.readFileSync(written)).toEqual(Buffer.from(text, "utf8"));
  expect(payload).toContain("Read the file in full");
  expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(32_000);
});

test("a short message is byte-identical to the current trimmed delivery", async () => {
  const text = "  коротко\n без змін  ";
  const response = await handleRuntimeCommand(request(text, "short-text"), "send", dependencies);
  expect(response.status).toBe(202);
  expect(Buffer.from(delivered.at(-1)!)).toEqual(Buffer.from(text.trim()));
});

test("padded short text keeps the existing delivery bytes and does not become a file", async () => {
  const text = "\n".repeat(32_000) + "коротко\n\t ";
  const response = await handleRuntimeCommand(request(text, "padded-short-text"), "send", dependencies);
  expect(response.status).toBe(202);
  expect(Buffer.from(delivered.at(-1)!)).toEqual(Buffer.from(text.trim()));
  expect((await response.json()).textAttachment).toBeUndefined();
});

test("retry of a message refused by the old envelope guard succeeds and reuses its file", async () => {
  const text = "ю".repeat(30_000);
  expect(() => assertStructuredTextEnvelope(text)).toThrow("32000-byte envelope");
  const first = await handleRuntimeCommand(request(text, "retry-long-text"), "send", dependencies);
  expect(first.status).toBe(202);
  const payload = delivered.at(-1)!;
  const retry = await handleRuntimeCommand(request(text, "retry-long-text"), "send", dependencies);
  expect(retry.status).toBe(202);
  expect(delivered.at(-1)).toBe(payload);
  expect(fs.readFileSync(payload.split("\n").at(-1)!, "utf8")).toBe(text);
});

test("all operator attachments survive conversion, including a matching filename", async () => {
  const files = ["message.txt", "notes.log", "export.csv"].map(name => ({ name, base64: Buffer.from(name).toString("base64") }));
  const text = "ї".repeat(30_000);
  const response = await handleRuntimeCommand(request(text, "long-with-files", files), "send", dependencies);
  expect(response.status).toBe(202);
  const paths = delivered.at(-1)!.split("\n").slice(1);
  expect(paths).toHaveLength(4);
  for (let index = 0; index < 3; index++) expect(fs.readFileSync(paths[index]!, "utf8")).toBe(files[index]!.name);
  expect(fs.readFileSync(paths[3]!, "utf8")).toBe(text);
});

test("a converted runtime message keeps its operator image uploads", async () => {
  let images: unknown;
  const req = new NextRequest("http://127.0.0.1/api/runtime/send", { method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ conversationId: "conversation_long_text", text: "я".repeat(30_000), idempotencyKey: "long-text-image",
      images: [{ mime: "image/png", base64: Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex").toString("base64") }] }) });
  const response = await handleRuntimeCommand(req, "send", { ...dependencies, enqueue: async input => {
    images = input.images;
    return dependencies.enqueue!(input);
  } });
  expect(response.status).toBe(202);
  expect(images).toEqual([{ mime: "image/png", base64: Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex").toString("base64") }]);
});

test("a terminal refusal releases the generated file and exposes no file chip", async () => {
  let filePath = "";
  const response = await handleRuntimeCommand(request("я".repeat(30_000), "long-text-refused"), "send", {
    ...dependencies, enqueue: async input => {
      filePath = input.text.split("\n").at(-1)!;
      expect(fs.existsSync(filePath)).toBe(true);
      return { ok: false, structured: true, outcome: "failed", status: 409, error: "refused" };
    },
  });
  expect(response.status).toBe(409);
  expect(fs.existsSync(filePath)).toBe(false);
  expect((await response.json()).textAttachment).toBeUndefined();
});

test("the production delivery queue durably admits the converted message under its original retry key", async () => {
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "long-text-registry.json"));
  const transcript = path.join(process.env.HOME!, "sessions", "long-text.jsonl");
  registry.reconcileConversations([{ engine: "codex", path: transcript, accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null }, observedAt: new Date().toISOString() }]);
  const conversation = registry.conversationForPath(transcript)!;
  const generation = conversation.generations.at(-1)!;
  registry.upsert({ key: { engine: "codex", sessionId: generation.id }, artifactPath: transcript,
    cwd: "/repo", accountId: "default", launchProfile: generation.launchProfile, status: "idle", host: null,
    structuredHost: { kind: "codex-app-server", endpoint: "stdio:fixture", process: { pid: process.pid, startIdentity: "fixture" },
      eventCursor: 1, protocolVersion: "v2", writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    claimEpoch: 1, claimOwner: "structured-host:fixture", pendingAction: null });
  const text = "я".repeat(30_000);
  const key = "production-long-text-retry";
  const enqueueDependencies = { registry: () => registry, client: () => null, requestMigrationTick: () => {} };
  const refused = await enqueueStructuredMessage({ conversationId: conversation.id, path: transcript, text, clientMessageId: key }, enqueueDependencies);
  expect(refused).toMatchObject({ ok: false, status: 413 });
  const req = new NextRequest("http://127.0.0.1/api/runtime/send", { method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ conversationId: conversation.id, text, idempotencyKey: key }) });
  const response = await handleRuntimeCommand(req, "send", { ...dependencies, registry: () => registry,
    enqueue: input => enqueueStructuredMessage(input, enqueueDependencies) });
  expect(response.status).toBe(202);
  const body = await response.json();
  expect(body.held).toBe(true);
  expect(fs.readFileSync(body.textAttachment.path, "utf8")).toBe(text);
  expect(registry.deliveryAdmissionForKey(conversation.id, key).outcome).toBe("admitted");
});
