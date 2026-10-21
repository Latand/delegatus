import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/mcp/route";
import { TASK_DETAILS_LIMIT, type BoardTask } from "@/lib/tasks/types";
import { patchTask } from "@/lib/tasks/commands";
import { MAX_PIPELINE_STAGES, MAX_STAGE_OUTPUTS, MAX_STAGE_OUTPUT_PATH_LENGTH, MAX_STAGE_PROMPT_LENGTH, MAX_SPEC_LENGTH } from "@/lib/pipelines/limits";
import { parsePrototypeInput, PROTOTYPE_LIMITS } from "@/lib/prototypeReview/input";
import { completeFits } from "@/lib/bridge/reportComplete";
import { publishPrototype } from "@/lib/prototypeReview/store";
import * as pipelineEngine from "@/lib/pipelines/engine";
import { setMcpHttpDependenciesForTests } from "./http";
import { MCP_MAX_REQUEST_BODY_BYTES, MCP_MAX_TOOL_INPUT_ELEMENTS } from "./inputLimits";
import { ownFixtureChild, reapFixtureChildren } from "./ownedFixtureChildren";
import { createViewerMcpServer, TOOL_INPUT_SCHEMAS, type McpToolName, type McpToolService } from "./server";

const capability = "a".repeat(43);
const headers = { host: "127.0.0.1", "content-type": "application/json", accept: "application/json, text/event-stream",
  "x-llv-spawn-capability": capability };
const rpc = (name: McpToolName, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 1,
  method: "tools/call", params: { name, arguments: args } });

// Synthetic workflow envelopes, never operator data. Maximal collections use
// current domain bounds; long text also exercises three-byte UTF-8 characters.
const workloads: Array<[McpToolName, Record<string, unknown>]> = [
  ["create_pipeline", {
    clientRequestId: "pipeline-envelope", task: "Pipeline input envelope", repoDir: "/workspace/project",
    spec: "界".repeat(MAX_SPEC_LENGTH), autoStart: false,
    stages: Array.from({ length: MAX_PIPELINE_STAGES }, (_, i) => ({
      id: `stage-${i}`, kind: "run", prompt: "界".repeat(MAX_STAGE_PROMPT_LENGTH),
      next: i + 1 < MAX_PIPELINE_STAGES ? `stage-${i + 1}` : null,
      outputs: Array.from({ length: MAX_STAGE_OUTPUTS }, (_, j) => `output-${j}/` + "x".repeat(MAX_STAGE_OUTPUT_PATH_LENGTH - `output-${j}/`.length)),
      role: { roleId: "builder" }, engine: "codex", access: "read-only",
    })),
  }],
  ["publish_prototype_review", {
    clientRequestId: "prototype-envelope", title: "界".repeat(120),
    variants: Array.from({ length: PROTOTYPE_LIMITS.variants }, (_, i) => ({
      number: i + 1, name: "界".repeat(60), description: "界".repeat(300),
      frames: Array.from({ length: Math.floor(PROTOTYPE_LIMITS.media / PROTOTYPE_LIMITS.variants)
        + (i < PROTOTYPE_LIMITS.media % PROTOTYPE_LIMITS.variants ? 1 : 0) }, (_, j) => ({
        path: `/${'"'.repeat(4088 - 1 - `${i}-${j}`.length - 4)}${i}-${j}.png`,
        caption: "界".repeat(200), width: 3840, lang: "uk",
      })),
    })),
    questions: Array.from({ length: 7 }, (_, i) => ({ id: `question-${i}`, text: "界".repeat(300),
      options: Array.from({ length: 6 }, (_, j) => ({ label: `${j}` + "界".repeat(119), recommended: j === 0 })),
      multiple: true, other: true })),
  }],
  ["update_task", { clientRequestId: "task-envelope", taskId: "fixture-task", details: "界".repeat(TASK_DETAILS_LIMIT) }],
  ["bridge_report", { clientRequestId: "report-envelope", key: "fixture-report", class: "status",
    summary: "界".repeat(120), covers: Array.from({ length: 64 }, (_, i) => `outcome-${i}`),
    sections: Object.fromEntries(["prod", "merged", "inProgress", "queued", "decision"].map(name => [name,
      Array.from({ length: name === "decision" ? 3 : 6 }, () => "x".repeat(200))])) }],
];

function elements(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  return Object.values(value).reduce<number>((sum, child) => sum + 1 + elements(child), 0);
}

afterEach(() => setMcpHttpDependenciesForTests(null));

test("readable control-character paths for 240 frames fit the HTTP budget and publish", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-control-path-"));
  const previousEvidenceRoots = process.env.LLV_EVIDENCE_ROOTS;
  try {
    process.env.LLV_EVIDENCE_ROOTS = root;
    let directory = root;
    const segments = 19;
    const segmentLength = Math.floor((4100 - root.length - segments - "/frame.png".length) / segments);
    expect(segmentLength).toBeLessThanOrEqual(255);
    for (let i = 0; i < segments; i++) {
      directory = path.join(directory, "\u0001".repeat(segmentLength));
      fs.mkdirSync(directory);
    }
    const framePath = path.join(directory, "frame.png");
    fs.writeFileSync(framePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(fs.readFileSync(framePath).byteLength).toBe(8);
    expect(framePath.length).toBeLessThanOrEqual(4096);

    const args = {
      clientRequestId: "control-path-envelope", title: "Control path envelope",
      variants: [{ number: 1, name: "Long path", description: "Readable segmented path",
        frames: Array.from({ length: PROTOTYPE_LIMITS.media }, () => ({ path: framePath, caption: "", width: 240, lang: "en" })) }],
      questions: Array.from({ length: 7 }, (_, i) => ({ id: `control-question-${i}`, text: "界".repeat(300),
        options: Array.from({ length: 6 }, (_, j) => ({ label: `${j}` + "界".repeat(119), recommended: j === 0 })),
        multiple: true, other: true })),
    };
    const parsed = parsePrototypeInput(args);
    const requestBody = JSON.stringify(rpc("publish_prototype_review", args));
    const bodyBytes = Buffer.byteLength(requestBody);
    console.info(`MCP control-character prototype envelope: path ${framePath.length} chars, ${elements(args)} elements, ${bodyBytes} bytes`);
    expect(bodyBytes).toBeGreaterThan(5_790_148);
    expect(bodyBytes).toBeLessThan(MCP_MAX_REQUEST_BODY_BYTES);

    let received = 0;
    setMcpHttpDependenciesForTests({ conversationForCapability: () => "fixture-caller", service: async () => ({
      async callTool(name, values) {
        expect(name).toBe("publish_prototype_review");
        expect(values).toEqual(args);
        received++;
        return { ok: true, toolName: name as McpToolName, clientRequestId: String(values.clientRequestId), replayed: false };
      },
    }) });
    const response = await POST(new NextRequest("http://127.0.0.1/api/mcp", { method: "POST", headers, body: requestBody }));
    expect(response.status).toBe(200);
    expect(received).toBe(1);

    const round = await publishPrototype(parsed, null, { conversationId: "fixture-conversation" }, "fixture-project");
    expect(round.variants.flatMap(variant => variant.frames).length).toBe(PROTOTYPE_LIMITS.media);
  } finally {
    if (previousEvidenceRoots === undefined) delete process.env.LLV_EVIDENCE_ROOTS;
    else process.env.LLV_EVIDENCE_ROOTS = previousEvidenceRoots;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const [name, args] of workloads) {
  test(`${name}: the measured workflow maximum passes its schema, SDK and HTTP ingress`, async () => {
    expect(TOOL_INPUT_SCHEMAS[name].safeParse(args).success).toBe(true);
    if (name === "create_pipeline") {
      const result = await pipelineEngine.createPipelineFromRequest(args as never, {
        ...pipelineEngine.defaultPipelinePorts(),
        preflightRepo: () => ({ ok: false, code: "missing", path: "/fixture/project" }),
      }, { allowOperatorDraftWithoutLineage: true });
      // A preflight refusal proves the engine's request validation accepted
      // every field, including the maximum supported spec and all stage bounds.
      expect(result).toMatchObject({ status: 400 });
      expect(result.error).not.toContain("spec exceeds");
      expect(result.error).toContain("does not exist");
    }
    if (name === "publish_prototype_review") {
      const parsed = parsePrototypeInput(args);
      expect(parsed.variants?.reduce((count, variant) => count + (variant.frames?.length ?? 0), 0)).toBe(PROTOTYPE_LIMITS.media);
      expect(parsed.variants?.flatMap(variant => variant.frames ?? []).every(frame => frame.path.length === 4088)).toBe(true);
    }
    if (name === "update_task") {
      const task: BoardTask = { id: "fixture-task", project: "fixture-project", status: "inbox", text: "Fixture task",
        placement: "unplaced", assignments: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
      expect(patchTask([task], task.id, { details: args.details }).ok).toBe(true);
    }
    if (name === "bridge_report") {
      const sections = args.sections as Record<string, string[]>;
      expect(completeFits({ summary: args.summary as string,
        sections: Object.entries(sections).map(([heading, items]) => ({ heading, items })) })).toBe(true);
      expect((args.covers as string[]).length).toBeLessThanOrEqual(64);
    }
    const count = elements(args);
    const bytes = Buffer.byteLength(JSON.stringify(rpc(name, args)));
    console.info(`MCP input envelope ${name}: ${count} elements, ${bytes} bytes`);
    expect(count).toBeLessThan(MCP_MAX_TOOL_INPUT_ELEMENTS / 4);
    expect(bytes).toBeLessThan(MCP_MAX_REQUEST_BODY_BYTES / 1.4);
    const received: Record<string, unknown>[] = [];
    const service: McpToolService = { async callTool(toolName, values) {
      received.push(values);
      return { ok: true, toolName: toolName as McpToolName, clientRequestId: String(values.clientRequestId), replayed: false };
    } };
    setMcpHttpDependenciesForTests({ service: async () => service, conversationForCapability: () => "fixture-caller" });
    const response = await POST(new NextRequest("http://127.0.0.1/api/mcp", {
      method: "POST", headers, body: JSON.stringify(rpc(name, args)),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { structuredContent: { ok: true } } });
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(args);
  });
}

test("the SDK accepts exactly the element budget and refuses the next element before dispatch", async () => {
  let dispatched = 0;
  const server = createViewerMcpServer({ async callTool() {
    dispatched++;
    return { ok: true, toolName: "get_task", clientRequestId: "boundary", replayed: false };
  } }, ["get_task"]);
  const client = new Client({ name: "input-limits-fixture", version: "1" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    // Two keys plus the entries in a nested array. Nested object members also
    // count: the second rejected form has no large array at all.
    const args = { taskId: "fixture-task", extra: Array(MCP_MAX_TOOL_INPUT_ELEMENTS - 2).fill(null) };
    expect(elements(args)).toBe(MCP_MAX_TOOL_INPUT_ELEMENTS);
    expect((await client.callTool({ name: "get_task", arguments: args })).isError).not.toBe(true);
    for (const rejected of [{ ...args, extra: [...args.extra, null] },
      { taskId: "fixture-task", extra: Object.fromEntries(Array.from({ length: MCP_MAX_TOOL_INPUT_ELEMENTS - 1 }, (_, i) => [`k${i}`, null])) }]) {
      const result = await client.callTool({ name: "get_task", arguments: rejected });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: `MCP error -32602: Invalid arguments for tool get_task: arguments contain more than the maximum of ${MCP_MAX_TOOL_INPUT_ELEMENTS} elements` }]);
    }
    expect(dispatched).toBe(1);
    // A refusal does not poison the next request.
    expect((await client.callTool({ name: "get_task", arguments: args })).isError).not.toBe(true);
    expect(dispatched).toBe(2);
  } finally { await Promise.all([client.close(), server.close()]); }
});

test("HTTP accepts exactly the byte budget and refuses one byte more before parsing", async () => {
  let dispatched = 0;
  setMcpHttpDependenciesForTests({ conversationForCapability: () => "fixture-caller", service: async () => ({
    async callTool() { dispatched++; return { ok: true, toolName: "get_task", clientRequestId: "byte-boundary", replayed: false }; },
  }) });
  const json = JSON.stringify(rpc("get_task", { taskId: "fixture-task" }));
  const body = json.padEnd(MCP_MAX_REQUEST_BODY_BYTES, " ");
  const accepted = await POST(new NextRequest("http://127.0.0.1/api/mcp", { method: "POST", headers, body }));
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ result: { structuredContent: { ok: true } } });
  const refused = await POST(new NextRequest("http://127.0.0.1/api/mcp", { method: "POST", headers, body: body + "!" }));
  expect(refused.status).toBe(413);
  expect(await refused.json()).toMatchObject({ error: { message: `Payload Too Large: Request body must not exceed ${MCP_MAX_REQUEST_BODY_BYTES} bytes` } });
  expect(dispatched).toBe(1);
  const again = await POST(new NextRequest("http://127.0.0.1/api/mcp", { method: "POST", headers, body }));
  expect(again.status).toBe(200);
  expect(dispatched).toBe(2);
});

for (const ingress of ["authenticated", "native", "small-framed"] as const) {
  test(`${ingress}: oversized declared bodies are refused without reading or parsing`, async () => {
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({ pull() { reads++; throw new Error("body must not be read"); } }, { highWaterMark: 0 });
    if (ingress === "authenticated") setMcpHttpDependenciesForTests({ conversationForCapability: () => "fixture-caller",
      service: async () => ({ async callTool() { throw new Error("must not dispatch"); } }) });
    const requestHeaders: Record<string, string> = { ...headers, "content-length": String(MCP_MAX_REQUEST_BODY_BYTES + 1) };
    if (ingress === "native") {
      delete requestHeaders["x-llv-spawn-capability"];
      requestHeaders["x-delegatus-mcp-peer"] = "invalid-proof";
    }
    // A dishonest small Content-Length enters the production eager-parse path.
    if (ingress === "small-framed") requestHeaders["content-length"] = "1";
    const stream = ingress === "small-framed"
      ? new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MCP_MAX_REQUEST_BODY_BYTES + 1)); controller.close(); } }) : body;
    const response = await POST(new NextRequest("http://127.0.0.1/api/mcp", { method: "POST", headers: requestHeaders,
      body: stream, duplex: "half" }));
    expect(response.status).toBe(413);
    expect((await response.json()).error.message).toContain(`must not exceed ${MCP_MAX_REQUEST_BODY_BYTES} bytes`);
    expect(reads).toBe(0);
  });
}

for (const ingress of ["authenticated", "native", "unattributed"] as const) {
  test(`${ingress}: unframed UTF-8 streaming stops at the byte budget before malformed JSON parsing`, async () => {
    setMcpHttpDependenciesForTests({ conversationForCapability: () => "fixture-caller", service: async () => ({
      async callTool() { throw new Error("must not dispatch"); },
    }) });
    const chunk = new TextEncoder().encode("界".repeat(Math.floor(MCP_MAX_REQUEST_BODY_BYTES / 3) + 1));
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      reads++;
      if (reads === 1) controller.enqueue(chunk);
      else throw new Error("reader continued after limit");
    } }, { highWaterMark: 0 });
    const requestHeaders: Record<string, string> = { ...headers };
    if (ingress !== "authenticated") delete requestHeaders["x-llv-spawn-capability"];
    if (ingress === "native") requestHeaders["x-delegatus-mcp-peer"] = "invalid-proof";
    if (ingress === "unattributed") {
      const { internalServiceHeaders } = await import("@/lib/agent/callerClaims");
      Object.assign(requestHeaders, internalServiceHeaders("mcp"), { "x-delegatus-mcp-unattributed": "1" });
    }
    const response = await POST(new NextRequest("http://127.0.0.1/api/mcp", { method: "POST", headers: requestHeaders,
      body, duplex: "half" }));
    expect(response.status).toBe(413);
    expect(reads).toBe(1);
  });
}

test("the configured HTTP transport also refuses oversized bodies before parsing", async () => {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined,
    enableJsonResponse: true, maxRequestBodySize: MCP_MAX_REQUEST_BODY_BYTES });
  try {
    const response = await transport.handleRequest(new Request("http://127.0.0.1/api/mcp", {
      method: "POST", headers, body: "!".repeat(MCP_MAX_REQUEST_BODY_BYTES + 1),
    }));
    expect(response.status).toBe(413);
    expect((await response.json()).error.message).toContain(`must not exceed ${MCP_MAX_REQUEST_BODY_BYTES} bytes`);
  } finally { await transport.close(); }
});

test("ordinary malformed JSON keeps its parse error", async () => {
  setMcpHttpDependenciesForTests({ conversationForCapability: () => "fixture-caller", service: async () => ({
    async callTool() { throw new Error("must not dispatch"); },
  }) });
  const response = await POST(new NextRequest("http://127.0.0.1/api/mcp", { method: "POST", headers, body: "!" }));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: -32700 } });
});

test("both limits remain active after a real process restart", async () => {
  const pids: number[] = [];
  for (let generation = 0; generation < 2; generation++) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-input-restart-"));
    const env = { ...process.env };
    for (const key of ["HOME", "TMPDIR", "XDG_CONFIG_HOME", "LLV_STATE_DIR"]) {
      env[key] = path.join(root, key); fs.mkdirSync(env[key]!);
    }
    const child = ownFixtureChild(Bun.spawn([process.execPath, "-e", `
      import { NextRequest } from "next/server";
      import { POST } from "./src/app/api/mcp/route";
      import { setMcpHttpDependenciesForTests } from "./src/lib/mcp/http";
      import { MCP_MAX_TOOL_INPUT_ELEMENTS as limit, MCP_MAX_REQUEST_BODY_BYTES as bytes } from "./src/lib/mcp/inputLimits";
      setMcpHttpDependenciesForTests({ conversationForCapability: () => "fixture", service: async () => ({
        async callTool() { return { ok: true, toolName: "get_task", clientRequestId: "restart", replayed: false }; }
      }) });
      const headers = { host: "127.0.0.1", "content-type": "application/json", accept: "application/json, text/event-stream",
        "x-llv-spawn-capability": "a".repeat(43) };
      const answers = [];
      for (const excess of [0, 1]) {
        const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_task",
          arguments: { taskId: "fixture-task", extra: Array(limit - 2 + excess).fill(null) } } });
        answers.push(await (await POST(new NextRequest("http://127.0.0.1/api/mcp", { method: "POST", headers, body }))).json());
      }
      const large = await POST(new NextRequest("http://127.0.0.1/api/mcp", { method: "POST", headers, body: "!".repeat(bytes + 1) }));
      console.log(JSON.stringify({ pid: process.pid, accepted: answers[0].result.structuredContent.ok,
        refused: answers[1].result.isError, error: answers[1].result.content[0].text, bodyStatus: large.status }));
    `], { env, stdout: "pipe", stderr: "pipe" }));
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      const answer = JSON.parse(stdout);
      expect(answer).toMatchObject({ accepted: true, refused: true, bodyStatus: 413 });
      expect(answer.error).toContain(`arguments contain more than the maximum of ${MCP_MAX_TOOL_INPUT_ELEMENTS} elements`);
      pids.push(answer.pid);
    } finally { await reapFixtureChildren(); fs.rmSync(root, { recursive: true, force: true }); }
  }
  expect(new Set(pids).size).toBe(2);
}, 15_000);
