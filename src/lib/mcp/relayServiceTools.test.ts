import avatarSeeds from "../externalRelay/fixtures/relay_v1/avatar_seed.json";
import { expect, spyOn, test } from "bun:test";
import { createMcpToolService, MemoryMcpReceiptStore, MCP_TOOL_NAMES, type McpToolBindings } from "./server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createViewerMcpServer } from "./server";
import { viewerMcpBindings, productionDomainDependencies } from "./bindings";
import { openOwnerServiceTools } from "../externalRelay/ownerServiceTools";
import { createToolResultMedia } from "../externalRelay/toolResultMedia";
import { ownerRequest } from "../externalRelay/toolLoop.fixture";
import { destinationRelay, destinationTarget } from "../externalRelay/ownerDestination.fixture";
import { startTestRelay } from "../externalRelay/testRelay";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const mediaRef = (i = 1) => `media_${i.toString(16).padStart(32, "0")}`;
const clock = Date.parse("2026-10-19T12:00:00Z");

async function mediaSession(clientName = "codex-mcp-client", change: Record<string, unknown> = {}, count = 1, downloadFailure: boolean | string = false, options: { deadlineMs?: number; waitDownload?: Promise<void>; downloadStarted?: () => void; paddedImage?: boolean; firstUnavailable?: boolean; nativeContext?: boolean; nativeAttribution?: boolean; seedCase?: keyof typeof avatarSeeds.examples; expireBeforeSerialization?: boolean; unbindBeforeSerialization?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "owner-mcp-media-"));
  let png = await (await import("sharp")).default({ create: { width: 2, height: 3, channels: 3, background: "red" } }).png().toBuffer();
  if (options.paddedImage) png = Buffer.concat([png, Buffer.alloc(1024 * 1024 - png.length)]);
  const sample = options.seedCase ? avatarSeeds.examples[options.seedCase] : undefined;
  const readTool = sample ? "get_profile_photo" : "get_media";
  let now = clock, downloads = 0, allowed = true;
  let ackWait: Promise<void> | undefined, ackEntered: (() => void) | undefined;
  const posts: Record<string, unknown>[] = [];
  const relayServer = await startTestRelay(async (req, body) => {
    if (req.url?.includes("/media/")) {
      downloads++; options.downloadStarted?.(); await options.waitDownload;
      return downloadFailure ? { status: 404, body: { error: { code: typeof downloadFailure === "string" ? downloadFailure : "not_found" } } }
        : { raw: png, headers: { "content-type": "image/png", "content-length": String(png.length) } };
    }
    const call = body as Record<string, unknown>; posts.push(call);
    if (sample && call.tool !== readTool) return { body: { ...sample.result, call_id: call.call_id, tool: call.tool } };
    return { body: { call_id: call.call_id, tool: call.tool, status: "ok", effect: call.tool === readTool ? "read" : "action",
      truncated: false, replayed: false, delivered: false, calls_remaining: 16 - posts.length,
      output: (call.arguments as Record<string, unknown>)?.longOutput ? "\\".repeat(15_900) : call.tool === readTool ? JSON.stringify({ ...(sample?.avatar_result ?? {}), [change.frame ? "selected_frames" : "media"]: Array.from({ length: count }, (_, i) => ({ ref: mediaRef(i + 1), kind: "photo",
        availability: "ready", mime_type: "image/png", byte_size: png.length, expires_at: "2026-10-19T12:10:00Z", ...change, ...(options.firstUnavailable && i === 0 ? { availability: "missing" } : {}) })).map(item => change.frame ? { file: item } : item) }) : "Generated" } };
  });
  const request = ownerRequest("mcp_media");
  const { richRequest } = await import("../externalRelay/rich.fixture");
  const rich = richRequest(true); request.answer = rich.answer; request.input.format = rich.input.format;
  request.features = ["requester_context", "relay_media_in", "relay_rich_messages", "relay_media_out"];
  request.input.tools = [{ name: readTool, summary: "Read media", mode: "direct", effect: "read", parameters: { type: "object" } },
    { name: sample?.call.tool ?? "generate_image", summary: "Generate", mode: "direct", effect: "action", parameters: sample?.parameters ?? { type: "object", properties: { seed_media_refs: { type: "array" } } } }];
  const target = destinationTarget(request.target_id, true);
  const relay = { ...destinationRelay([target]), api_base: `${relayServer.origin}/v1` };
  const abort = new AbortController();
  const media = createToolResultMedia(relay, request, directory, { signal: abort.signal, deadlineAt: clock + (options.deadlineMs ?? 600_000), now: () => now,
    authorize: () => { if (!allowed) throw new Error("revoked"); } });
  const adapter = openOwnerServiceTools(relay, target, request, [], { signal: abort.signal, deadlineAt: clock + 600_000, ack: async () => { ackEntered?.(); await ackWait; return true; }, lose: () => {} },
    { now: () => now }, () => allowed, media);
  adapter.bindConversation("conversation_media");
  const { reserveRun, dropRun, updateRelayStore } = await import("../externalRelay/store");
  const { procBackend } = await import("@/lib/proc");
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  dropRun(request.request_id);
  reserveRun({ requestId: request.request_id, leaseId: request.lease_id, relayId: relay.id, targetId: request.target_id,
    childPid: null, childIdentity: null, ownerPid: process.pid, ownerIdentity: procBackend.processIdentity(process.pid)!, runDir: directory,
    startedAt: new Date().toISOString(), conversationId: "conversation_media", ownerTurn: { clientAttemptId: "owner-media-test", request: { text: "Photo", requestText: null } } }, 1);
  const { openOwnerAnswer } = await import("../externalRelay/ownerAnswer");
  const parts = openOwnerAnswer(relay.id, request, directory, [], () => allowed, abort.signal, media);
  const contextPath = path.join(directory, "context", "session.jsonl");
  if (options.nativeContext) {
    await fs.mkdir(path.dirname(contextPath), { mode: 0o755 });
    await fs.writeFile(contextPath, "context", { mode: 0o664 }); await fs.chmod(contextPath, 0o664);
  }
  const bindings = viewerMcpBindings(undefined, { get: async () => ({}), post: async () => ({}) }, {
    ...productionDomainDependencies, callerAttribution: () => ({ kind: "agent", conversationId: "conversation_media", role: null, ...(options.nativeContext && options.nativeAttribution !== false ? { native: true as const } : {}) }),
    workspaceConversation: () => options.nativeContext ? ({ engine: "codex", generations: [{ path: contextPath }] }) as never : null,
  });
  const receipts = new MemoryMcpReceiptStore();
  const receipt = spyOn(receipts, "claim");
  const service = createMcpToolService(bindings, receipts);
  const server = createViewerMcpServer({ ...service, async callTool(...args: Parameters<typeof service.callTool>) {
    const result = await service.callTool(...args);
    if (options.expireBeforeSerialization) now += options.deadlineMs ?? 600_000;
    if (options.unbindBeforeSerialization) adapter.unbindConversation("conversation_media");
    return result;
  } }, ["relay_service_tools", "relay_answer"]);
  const client = new Client({ name: clientName, version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = (tool = readTool, args = {}) => client.callTool({ name: "relay_service_tools", arguments: { op: "call", calls: [{ tool, arguments: args }] } });
  return { png, media, parts, request, relay, contextPath, posts, receipt, call, client, directory, downloads: () => downloads, holdAck: (wait: Promise<void>, entered: () => void) => { ackWait = wait; ackEntered = entered; }, advance: (ms = 600_001) => { now += ms; }, revoke: () => { allowed = false; },
    close: async () => { await client.close(); await server.close(); await adapter.dispose(); dropRun(request.request_id); await parts.dispose(); await media.dispose(); await relayServer.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}

test.each(["codex-mcp-client", "claude-code", "sdk-client"])("real binding supplies exact image bytes beside text without structured content (%s)", async name => {
  const f = await mediaSession(name);
  try {
    const result = await f.call();
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toEqual([expect.objectContaining({ type: "text" }), { type: "image", mimeType: "image/png", data: f.png.toString("base64") }]);
    const text = (result.content as { type: string; text?: string }[])[0]!.text!;
    expect(text).toContain(mediaRef()); expect(text).not.toContain(f.png.toString("base64")); expect(text).not.toContain(f.directory);
    expect((await f.call()).content).toEqual(result.content); expect(f.downloads()).toBe(1); expect(f.receipt).not.toHaveBeenCalled();
    await f.media.dispose(); expect(await fs.readdir(f.directory)).toEqual([]);
  } finally { await f.close(); }
});

for (const [change, cause, failed] of [
  [{ byte_size: 20 * 1024 * 1024 + 1 }, "too_large", false], [{ availability: "missing" }, "missing", false],
  [{ expires_at: "2026-10-19T11:00:00Z" }, "media_unavailable", false], [{ mime_type: "video/mp4", kind: "video" }, "unsupported_media_type", false],
  [{}, "not_found", true],
] as const) test(`real binding keeps bounded cause text for ${cause}`, async () => {
  const f = await mediaSession("sdk-client", change, 1, failed);
  try {
    const result = await f.call();
    expect(result.content).toHaveLength(1);
    expect(JSON.stringify(result.content)).toContain(cause);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(70_000);
    expect(f.downloads()).toBe(failed ? 1 : 0); expect(f.media.files).toEqual([]);
  } finally { await f.close(); }
});

test("real binding caps an answer and request at ten attempts, including cached retries", async () => {
  const f = await mediaSession("codex-mcp-client", {}, 11);
  try {
    const result = await f.call();
    expect((result.content as { type: string }[]).filter(item => item.type === "image")).toHaveLength(10);
    expect(JSON.stringify(result)).toContain("too_large");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(14 * 1024 * 1024);
    await f.call("get_media", { page: 2 }); expect(f.downloads()).toBe(10);
  } finally { await f.close(); }
});

test("binding admits this request's successful seeds, refuses expiry and isolates the next request", async () => {
  const f = await mediaSession();
  try {
    await f.call();
    await f.client.callTool({ name: "relay_service_tools", arguments: { op: "describe", names: ["generate_image"] } });
    await f.call("generate_image", { seed_media_refs: [mediaRef()] });
    expect(f.posts).toHaveLength(2);
    f.advance();
    const expired = await f.call("generate_image", { seed_media_refs: [mediaRef()], prompt: "Again" });
    expect(JSON.stringify(expired)).toContain("invalid_arguments"); expect(f.posts).toHaveLength(2);
    f.revoke(); expect((await f.call()).isError).toBe(true);
  } finally { await f.close(); }
  const second = await mediaSession();
  try {
    await second.client.callTool({ name: "relay_service_tools", arguments: { op: "describe", names: ["generate_image"] } });
    expect(JSON.stringify(await second.call("generate_image", { seed_media_refs: [mediaRef()] }))).toContain("invalid_arguments");
    expect(second.posts).toEqual([]);
  } finally { await second.close(); }
});

test("cached image answers respect current expiry", async () => {
  const f = await mediaSession();
  try { await f.call(); f.advance(); expect((await f.call()).content).toHaveLength(1); }
  finally { await f.close(); }
});

test("video frames are visible but explicitly refused as image seeds", async () => {
  const f = await mediaSession("codex-mcp-client", { frame: true });
  try {
    expect((await f.call()).content).toHaveLength(2);
    await f.client.callTool({ name: "relay_service_tools", arguments: { op: "describe", names: ["generate_image"] } });
    const result = await f.call("generate_image", { seed_media_refs: [mediaRef()] });
    expect(JSON.stringify(result)).toContain("video_frame_seed_unsupported"); expect(f.posts).toHaveLength(1);
  } finally { await f.close(); }
});

test("binding stages an admitted original ref through the existing attachment worker and upload", async () => {
  const f = await mediaSession();
  try {
    await f.call();
    const result = await f.client.callTool({ name: "relay_answer", arguments: { attachments: [{ media_ref: mediaRef(), kind: "photo", caption: "Photo" }] } });
    expect(result.isError).not.toBe(true);
    const staged = f.parts.parts().attachments;
    expect(staged).toHaveLength(1); expect(await fs.readFile(staged[0]!.file)).toEqual(f.png);
    const { uploadAnswerAttachments } = await import("../externalRelay/attachments");
    const uploads: Buffer[] = [];
    const service = await startTestRelay((_req, body) => {
      uploads.push(body as Buffer);
      return { body: { attachment_id: staged[0]!.id, mime_type: "image/png", filename: staged[0]!.filename, byte_size: f.png.length, sha256: staged[0]!.sha256, expires_at: "2099-01-01T00:00:00Z", kind: "photo" } };
    });
    try {
      const uploaded = await uploadAnswerAttachments({ ...f.relay, api_base: `${service.origin}/v1` }, f.request, staged, Date.now() + 30_000, new AbortController().signal, []);
      expect(uploaded).toHaveLength(1); expect(uploads).toEqual([f.png]);
    } finally { await service.close(); }
    const first = staged[0]!.file;
    await f.client.callTool({ name: "relay_answer", arguments: { attachments: [] } });
    expect(await fs.exists(first)).toBe(false);
    f.advance();
    const expired = await f.client.callTool({ name: "relay_answer", arguments: { attachments: [{ media_ref: mediaRef(), kind: "photo" }] } });
    expect(JSON.stringify(expired)).toContain("media_ref_expired"); expect(f.parts.parts().attachments).toEqual([]);
  } finally { await f.close(); }
});

test("binding refuses unknown refs, ambiguous selectors, mutation, missing negotiation and revocation without replacing answer parts", async () => {
  const f = await mediaSession();
  try {
    await f.call();
    const answer = (attachments: unknown[]) => f.client.callTool({ name: "relay_answer", arguments: { attachments } });
    expect(JSON.stringify(await answer([{ media_ref: mediaRef(99), kind: "photo" }]))).toContain("media_ref_unavailable");
    expect((await answer([{ path: "file.png", media_ref: mediaRef(), kind: "photo" }])).isError).toBe(true);
    f.request.features = f.request.features!.filter(feature => feature !== "relay_media_out");
    expect(JSON.stringify(await answer([{ media_ref: mediaRef(), kind: "photo" }]))).toContain("media_not_negotiated");
    f.request.features.push("relay_media_out");
    await fs.writeFile(f.media.files[0]!.path, Buffer.alloc(f.png.length));
    expect(JSON.stringify(await answer([{ media_ref: mediaRef(), kind: "photo" }]))).toContain("media_ref_changed");
    expect(f.parts.parts().attachments).toEqual([]);
    f.revoke(); expect((await answer([{ media_ref: mediaRef(), kind: "photo" }])).isError).toBe(true);
  } finally { await f.close(); }
});

test("a silent download is bounded by the earlier deadline and consumes its attempt", async () => {
  let release!: () => void;
  const waitDownload = new Promise<void>(resolve => { release = resolve; });
  const f = await mediaSession("codex-mcp-client", {}, 1, false, { deadlineMs: 50, waitDownload });
  try {
    const result = await f.call();
    expect(result.content).toHaveLength(1); expect(JSON.stringify(result)).toContain("download_deadline");
    await f.call(); expect(f.downloads()).toBe(1); expect(f.media.files).toEqual([]);
  } finally { release(); await f.close(); }
});

test("revocation during a download returns no images and removes the owned partial", async () => {
  let release!: () => void, entered!: () => void;
  const waitDownload = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = await mediaSession("claude-code", {}, 1, false, { waitDownload, downloadStarted: entered });
  const pending = f.call();
  try {
    await started; f.revoke(); release();
    expect((await pending).isError).toBe(true);
    expect(f.media.files).toEqual([]);
  } finally { release(); await pending; await f.close(); }
});

test("seed expiry during lease admission refuses before the action reaches the service", async () => {
  const f = await mediaSession();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  try {
    await f.call();
    await f.client.callTool({ name: "relay_service_tools", arguments: { op: "describe", names: ["generate_image"] } });
    f.holdAck(held, entered);
    const action = f.call("generate_image", { seed_media_refs: [mediaRef()] });
    await started; f.advance(); release();
    expect(JSON.stringify(await action)).toContain("media_ref_expired"); expect(f.posts).toHaveLength(1);
  } finally { release(); await f.close(); }
});

test("untrusted download errors cannot turn private refs into diagnostics", async () => {
  const privateCode = `media_${"f".repeat(32)}`;
  const f = await mediaSession("codex-mcp-client", {}, 1, privateCode);
  try {
    const result = await f.call();
    expect(JSON.stringify(result)).not.toContain(privateCode);
    expect(JSON.stringify(result)).toContain("download_failed");
  } finally { await f.close(); }
});

test("a fresh MCP process cannot recover the prior process's media registry", async () => {
  const f = await mediaSession();
  try {
    await f.call();
    const child = Bun.spawn([process.execPath, "-e", `
      import {Client} from "@modelcontextprotocol/sdk/client/index.js";
      import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
      import {createMcpToolService,createViewerMcpServer,MemoryMcpReceiptStore} from "./src/lib/mcp/server.ts";
      import {viewerMcpBindings,productionDomainDependencies} from "./src/lib/mcp/bindings.ts";
      const bindings=viewerMcpBindings(undefined,{get:async()=>({}),post:async()=>({})},{...productionDomainDependencies,callerAttribution:()=>({kind:"agent",conversationId:"conversation_media",role:null})});
      const server=createViewerMcpServer(createMcpToolService(bindings,new MemoryMcpReceiptStore()),["relay_service_tools"]);
      const client=new Client({name:"restart-fixture",version:"1"});
      const [a,b]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(b),client.connect(a)]);
      const result=await client.callTool({name:"relay_service_tools",arguments:{op:"list"}});
      console.log(JSON.stringify({refused:result.isError===true}));await client.close();await server.close();
    `], { cwd: process.cwd(), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      const [output, errors, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ exit, errors }).toEqual({ exit: 0, errors: "" }); expect(JSON.parse(output)).toEqual({ refused: true });
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
  } finally { await f.close(); }
});

test("ten one-MiB inline originals fit, and an answer over 14 MiB explicitly omits images", async () => {
  const f = await mediaSession("codex-mcp-client", {}, 10, false, { paddedImage: true });
  try {
    const first = await f.call();
    expect((first.content as { type: string }[]).filter(item => item.type === "image")).toHaveLength(10);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(14 * 1024 * 1024);
    const result = await f.client.callTool({ name: "relay_service_tools", arguments: { op: "call", calls: Array.from({ length: 4 }, (_, index) => ({ tool: "get_media", arguments: { pad: "\\".repeat(32_650), index, longOutput: index > 0 } })) } });
    const value = JSON.parse((result.content as { text: string }[])[0]!.text);
    expect({ imageCount: (result.content as { type: string }[]).filter(item => item.type === "image").length,
      bytes: Buffer.byteLength(JSON.stringify(result)), rows: value.results?.map((row: { status: string; output: string; arguments?: { pad?: string } }) => ({ status: row.status, output: row.output.length, pad: row.arguments?.pad?.length })) })
      .toMatchObject({ imageCount: 0 });
    expect(JSON.stringify(result).includes("answer_size_limit")).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(14 * 1024 * 1024);
    expect(f.downloads()).toBe(10);
  } finally { await f.close(); }
});

test("seed admission requires the advertised seed parameter", async () => {
  const f = await mediaSession();
  try {
    await f.call();
    f.request.input.tools!.find(tool => tool.name === "generate_image")!.parameters = { type: "object" };
    await f.client.callTool({ name: "relay_service_tools", arguments: { op: "describe", names: ["generate_image"] } });
    const result = await f.call("generate_image", { seed_media_refs: [mediaRef()] });
    expect(JSON.stringify(result)).toContain("seed_refs_not_advertised"); expect(f.posts).toHaveLength(1);
  } finally { await f.close(); }
});

test("inline image indices identify their descriptors when an earlier image is unavailable", async () => {
  const f = await mediaSession("codex-mcp-client", {}, 3, false, { firstUnavailable: true });
  try {
    const result = await f.call();
    const text = (result.content as { type: string; text?: string }[])[0]!.text!;
    const value = JSON.parse(text);
    expect(value.results[0].media_images).toEqual([{ ref: mediaRef(2), image_index: 0 }, { ref: mediaRef(3), image_index: 1 }]);
    expect(result.content).toHaveLength(3);
  } finally { await f.close(); }
});

test("concurrent retries join downloads and keep independent image mappings", async () => {
  const f = await mediaSession("codex-mcp-client", {}, 3);
  try {
    const replies = await Promise.all(Array.from({ length: 4 }, () => f.call()));
    for (const reply of replies) expect(reply.content).toEqual(replies[0]!.content);
    expect(f.downloads()).toBe(3);
    const value = JSON.parse((replies[0]!.content as { text: string }[])[0]!.text);
    expect(value.results[0].media_images).toHaveLength(3);
  } finally { await f.close(); }
});

test.each([true, false])("binding protects context and refuses a linked transcript (native attribution=%s)", async nativeAttribution => {
  const f = await mediaSession("codex-mcp-client", {}, 1, false, { nativeContext: true, nativeAttribution });
  try {
    expect((await f.call()).content).toHaveLength(2);
    expect((await fs.stat(f.contextPath)).mode & 0o077).toBe(0);
    expect((await fs.stat(path.dirname(f.contextPath))).mode & 0o077).toBe(0);
    const foreign = path.join(f.directory, "foreign.jsonl"); await fs.writeFile(foreign, "other context"); await fs.chmod(foreign, 0o664);
    await fs.unlink(f.contextPath); await fs.symlink(foreign, f.contextPath);
    const result = await f.call("get_media", { next: true });
    expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain("media_context_unavailable");
    expect((await fs.stat(foreign)).mode & 0o077).not.toBe(0); expect(f.posts).toHaveLength(1);
  } finally { await f.close(); }
});

for (const name of ["reference_only", "current_and_reference", "current_avatar_also_explicit_seed", "edit_image", "ten_references", "outside_chat", "membership_unavailable", "unreadable_reference"] as const)
  test(`mirrored seed contract crosses the real MCP binding: ${name}`, async () => {
    const example = avatarSeeds.examples[name];
    const f = await mediaSession("codex-mcp-client", {}, name === "ten_references" ? 10 : 1, false, { seedCase: name });
    try {
      await f.call();
      await f.client.callTool({ name: "relay_service_tools", arguments: { op: "describe", names: [example.call.tool] } });
      const result = await f.call(example.call.tool, example.call.arguments);
      const value = JSON.parse((result.content as { text: string }[])[0]!.text);
      expect(value.results[0]).toMatchObject({ status: example.result.status, output: example.result.output });
      expect(f.posts.at(-1)).toMatchObject({ tool: example.call.tool, arguments: example.call.arguments });
      expect(f.posts).toHaveLength(2);
    } finally { await f.close(); }
  });

test("the earlier lease cutoff fences cached pixels, seeds and ref attachments", async () => {
  const f = await mediaSession("codex-mcp-client", {}, 1, false, { deadlineMs: 1000 });
  try {
    await f.call();
    await f.client.callTool({ name: "relay_service_tools", arguments: { op: "describe", names: ["generate_image"] } });
    f.advance(1000);
    const cached = await f.call(); expect(cached.isError).toBe(true); expect(cached.content).toHaveLength(1);
    expect(JSON.stringify(cached)).toContain("lease_lost");
    expect(JSON.stringify(await f.call("generate_image", { seed_media_refs: [mediaRef()] }))).toContain("invalid_arguments");
    const attached = await f.client.callTool({ name: "relay_answer", arguments: { attachments: [{ media_ref: mediaRef(), kind: "photo" }] } });
    expect(attached.isError).toBe(true); expect(f.parts.parts().attachments).toEqual([]); expect(f.posts).toHaveLength(1);
  } finally { await f.close(); }
});

test("lease expiry after the service await is checked again by the MCP serializer", async () => {
  const f = await mediaSession("codex-mcp-client", {}, 1, false, { deadlineMs: 1000, expireBeforeSerialization: true });
  try {
    const result = await f.call();
    expect((result.content as { type: string }[]).every(item => item.type === "text")).toBe(true);
    expect(JSON.stringify(result)).toContain("lease_lost"); expect(JSON.stringify(result)).not.toContain(f.png.toString("base64"));
  } finally { await f.close(); }
});

test("losing the conversation binding after the service await withholds pixels and refs", async () => {
  const f = await mediaSession("codex-mcp-client", {}, 1, false, { unbindBeforeSerialization: true });
  try {
    const result = await f.call();
    expect(result.isError).toBe(true); expect(result.content).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(mediaRef()); expect(JSON.stringify(result)).not.toContain(f.png.toString("base64"));
  } finally { await f.close(); }
});

test("native context can finish appearing while the first media call waits", async () => {
  const f = await mediaSession("codex-mcp-client", {}, 1, false, { nativeContext: true });
  await fs.unlink(f.contextPath);
  const pending = f.call();
  try {
    await new Promise(resolve => setTimeout(resolve, 25));
    await fs.writeFile(f.contextPath, "context", { mode: 0o664 });
    expect((await pending).content).toHaveLength(2); expect((await fs.stat(f.contextPath)).mode & 0o077).toBe(0);
  } finally { await pending; await f.close(); }
});

test("request tools are always fresh and receipt-free, including retries with explicit keys", async () => {
  let calls = 0;
  const receipts = new MemoryMcpReceiptStore();
  const claim = spyOn(receipts, "claim"), lookup = spyOn(receipts, "lookup"), complete = spyOn(receipts, "complete");
  const bindings = Object.fromEntries(MCP_TOOL_NAMES.map(name => [name, async () => ({})])) as unknown as McpToolBindings;
  bindings.relay_service_tools = async () => ({ count: ++calls });
  const service = createMcpToolService(bindings, receipts);
  let expected = 0;
  for (const args of [{ op: "list" }, { op: "list", clientRequestId: "same" }, { op: "list", clientRequestId: "same" }])
    expect(await service.callTool("relay_service_tools", args)).toMatchObject({ ok: true, replayed: false, count: ++expected });
  expect(calls).toBe(3); expect(claim).not.toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
});
