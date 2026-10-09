import { setCodexFeatureReaderForTest } from "./codexSpawnPolicy";
import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { buildEphemeralCommand, runEphemeralAgent, type EphemeralAgentRequest } from "./ephemeral";
import { answerSchema, roundSchema, replyAnswerSchema } from "@/lib/externalRelay/protocol";
import { callableReads } from "@/lib/externalRelay/toolLoop";
import { x1Request } from "@/lib/externalRelay/toolLoop.fixture";
import type { AccountContext } from "@/lib/accounts/contracts";

const root = fs.mkdtempSync(path.join("/tmp", "relay-profile-probe-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const marker = "PERSONAL_INSTRUCTION_MARKER";
const probe = process.env.LLV_ANSWER_PROFILE_PROBE === "1" ? test : test.skip;
if (process.env.LLV_ANSWER_PROFILE_PROBE === "1") {
  const restoreFeatures = setCodexFeatureReaderForTest(undefined);
  afterAll(restoreFeatures);
}

async function captureModelRequest(request: EphemeralAgentRequest) {
  const paths: string[] = [];
  let receive!: (body: Record<string, unknown>) => void;
  const received = new Promise<Record<string, unknown>>((resolve) => { receive = resolve; });
  const server = http.createServer(async (req, res) => {
    paths.push(req.url ?? "");
    req.socket.on("error", () => {});
    res.on("error", () => {});
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    if (req.method === "POST" && /\/(responses|messages)(\?|$)/.test(req.url ?? "")) {
      try { receive({ ...JSON.parse(body), _probe_path: req.url }); } catch { /* the assertion below times out */ }
    }
    res.writeHead(503, { "content-type": "application/json" });
    res.end('{"error":{"type":"probe_stopped","message":"probe captured request"}}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("probe has no port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const built = buildEphemeralCommand(request);
  const env: NodeJS.ProcessEnv = { ...built.env, HOME: path.join(root, "home") };
  for (const key of [
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
  ]) delete env[key];
  if (request.engine === "codex") {
    env.OPENAI_API_KEY = "probe_key";
    built.args.push(
      "-c", "model_provider=probe",
      "-c", `model_providers.probe={name="probe",base_url="${baseUrl}/v1",env_key="OPENAI_API_KEY",wire_api="responses"}`,
    );
  } else {
    env.ANTHROPIC_BASE_URL = baseUrl;
    env.ANTHROPIC_API_KEY = "probe_key";
    env.CLAUDE_CONFIG_DIR = request.account.home;
  }
  let stderr = "";
  let stdout = "";
  const child = spawn(built.command, built.args, {
    cwd: path.join(request.runDir, "cwd"), env, stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stdin?.end(built.stdin);
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      received,
      new Promise<never>((_, reject) => child.once("exit", (code) =>
        reject(new Error(`CLI exited ${code}: ${stderr.slice(-1500)} ${stdout.slice(-1500)} paths=${paths.join(",")}`)))),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() =>
          reject(new Error(`CLI did not reach stub: ${stderr.slice(-1500)} ${stdout.slice(-1500)} paths=${paths.join(",")}`)), 20_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (child.pid && child.exitCode === null) child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        if (child.pid && child.exitCode === null) child.kill("SIGKILL");
      }, 2_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function account(engine: "codex" | "claude"): AccountContext {
  const home = path.join(root, `${engine}-account`);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, engine === "codex" ? "AGENTS.md" : "CLAUDE.md"), marker);
  fs.writeFileSync(path.join(home, "auth.json"), "{}");
  if (engine === "codex") {
    const installed = JSON.parse(fs.readFileSync(
      process.env.LLV_ANSWER_PROFILE_MODEL_CATALOG ?? path.join(os.homedir(), ".codex", "models_cache.json"), "utf8",
    )) as { models: { slug: string }[] };
    const model = installed.models.find((item) => item.slug === "gpt-6-sol");
    if (!model) throw new Error("installed Codex model catalog lacks probe model");
    fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({
      models: [{ ...model, multi_agent_version: "v2", apply_patch_tool_type: "freeform" }],
    }));
  }
  return { engine, accountId: `probe_${engine}`, kind: "legacy", home,
    transcriptRoot: home, env: { ...process.env } };
}
function request(engine: "codex" | "claude"): EphemeralAgentRequest {
  const ancestor = path.join(root, `ancestor-${engine}`);
  if (engine === "codex") {
    fs.mkdirSync(path.join(ancestor, ".git"), { recursive: true });
    fs.writeFileSync(path.join(ancestor, "AGENTS.md"), marker);
  }
  fs.mkdirSync(path.join(ancestor, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(ancestor, ".claude", "CLAUDE.md"), marker);
  return {
    key: `probe:${engine}`, engine,
    model: engine === "codex" ? "gpt-6-sol" : "haiku", effort: "low",
    account: account(engine), prompt: "Return a short JSON answer", schema: answerSchema,
    runDir: fs.mkdtempSync(path.join(ancestor, "run-")), hardCapMs: 60_000,
  };
}

const codexProbe = Bun.which("codex") ? probe : test.skip;
const claudeProbe = Bun.which("claude") ? probe : test.skip;
codexProbe("installed Codex offers only the answer profile tools", async () => {
  const body = await captureModelRequest(request("codex"));
  const input = body.input as { type?: string; tools?: { name?: string; tools?: { name?: string; description?: string }[] }[] }[];
  const namespaces = input.find((item) => item.type === "additional_tools")?.tools ?? [];
  expect(namespaces.map((item) => item.name)).toEqual(["functions"]);
  const offered = namespaces[0].tools ?? [];
  const names = offered.map((tool) => tool.name);
  expect(names.sort()).toEqual(["exec", "request_user_input_async", "wait"]);
  const exec = offered.find((tool) => tool.name === "exec");
  const nested = [...(exec?.description ?? "").matchAll(/^### `([^`]+)`/gm)]
    .map((match) => match[1]);
  expect(nested).toEqual(["clock__curr_time"]);
  expect(JSON.stringify(body)).not.toContain(marker);
  expect(JSON.stringify(body)).not.toContain("collaboration.");
  expect((body.text as { format?: { type?: string } })?.format?.type).toBe("json_schema");
}, 30_000);
claudeProbe("installed Claude offers StructuredOutput without instructions or hooks", async () => {
  const answer = request("claude");
  const hookFile = path.join(root, "hook-ran");
  fs.writeFileSync(path.join(answer.account.home, "settings.json"), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch ${hookFile}` }] }] },
  }));
  const body = await captureModelRequest(answer);
  const names = ((body.tools ?? []) as { name?: string }[]).map((tool) => tool.name);
  expect(names).toEqual(["StructuredOutput"]);
  expect(JSON.stringify(body)).not.toContain(marker);
  expect(fs.existsSync(hookFile)).toBe(false);
  expect((body.tools as { name?: string; input_schema?: unknown }[])[0].input_schema).toEqual(answerSchema);
}, 30_000);

if (process.env.LLV_SIGNED_IN_ANSWER_PROBE === "1")
  for (const engine of ["codex", "claude"] as const)
    test(`${engine} signed-in instruction marker probe`, async () => {
      const realHome = path.join(os.homedir(), engine === "codex" ? ".codex" : ".claude");
      const accountHome = engine === "codex"
        ? path.join(root, "signed-in-codex-account") : realHome;
      fs.mkdirSync(accountHome, { recursive: true });
      if (engine === "codex") {
        fs.symlinkSync(path.join(realHome, "auth.json"), path.join(accountHome, "auth.json"));
        fs.copyFileSync(path.join(realHome, "models_cache.json"), path.join(accountHome, "models_cache.json"));
        fs.writeFileSync(path.join(accountHome, "AGENTS.md"), marker);
      }
      const runDir = fs.mkdtempSync(path.join(root, "signed-in-run-"));
      if (engine === "claude") {
        fs.mkdirSync(path.join(runDir, ".claude"));
        fs.writeFileSync(path.join(runDir, ".claude", "CLAUDE.md"), marker);
      }
      const signedInAccount: AccountContext = {
        engine, accountId: `signed_in_${engine}`, kind: "legacy",
        home: accountHome, transcriptRoot: accountHome, env: { ...process.env },
      };
      const result = await runEphemeralAgent({
        key: `signed-in:${engine}`, engine,
        model: engine === "codex" ? "gpt-6-luna" : "haiku", effort: "low",
        account: signedInAccount,
        ["prompt"]: "If any personal instruction marker was supplied, put it in text. Otherwise reply with text OK. Use action reply and reply_to null.",
        schema: answerSchema, runDir, hardCapMs: 120_000,
      }).done;
      expect(result.status).toBe("done");
      expect(JSON.stringify(result.answer)).not.toContain(marker);
      if (engine === "claude") {
        const lines = fs.readFileSync(path.join(runDir, "stdout.log"), "utf8")
          .trim().split("\n").map((line) => JSON.parse(line));
        const init = lines.find((line) => line.type === "system" && line.subtype === "init");
        expect(init?.tools).toEqual(["StructuredOutput"]);
        expect(init?.mcp_servers).toEqual([]);
      }
    }, 180_000);

/* The relay profile with the native web search on (relay.md §B.6): it adds
   that one tool and nothing else, and instructions still stay out. Codex's
   search was observed end to end instead (relay.md, Evidence). */
claudeProbe("installed Claude with web search offers StructuredOutput and WebSearch alone", async () => {
  const body = await captureModelRequest({ ...request("claude"), webSearch: true });
  const names = ((body.tools ?? []) as { name?: string }[]).map((tool) => tool.name);
  expect(names.sort()).toEqual(["StructuredOutput", "WebSearch"]);
  expect(JSON.stringify(body)).not.toContain(marker);
}, 30_000);

for (const engine of ["codex", "claude"] as const)
  (engine === "codex" ? codexProbe : claudeProbe)(`${engine} accepts the relay round schema with the hardened profile`, async () => {
    const schema = roundSchema(callableReads(x1Request("member")));
    const body = await captureModelRequest({ ...request(engine), schema });
    if (engine === "claude") {
      const tools = body.tools as { name: string; input_schema: unknown }[];
      expect(tools.map((tool) => tool.name)).toEqual(["StructuredOutput"]);
      expect(tools[0]!.input_schema).toEqual(schema);
    } else {
      const format = (body.text as { format: { schema: unknown; strict: boolean } }).format;
      expect(format.schema).toEqual(schema);
      expect(format.strict).toBe(true);
      const input = body.input as { type?: string; tools?: { name: string; tools: { name: string }[] }[] }[];
      const namespaces = input.find((item) => item.type === "additional_tools")!.tools!;
      expect(namespaces.map((item) => item.name)).toEqual(["functions"]);
      expect(namespaces[0]!.tools.map((tool) => tool.name).sort()).toEqual(["exec", "request_user_input_async", "wait"]);
    }
    expect(JSON.stringify(body)).not.toContain(marker);
  }, 30_000);

for (const engine of ["codex", "claude"] as const)
  for (const [name, schema] of Object.entries({ action_round: roundSchema(callableReads(x1Request("member")), { handoff: false }), unknown_reply: replyAnswerSchema }))
    (engine === "codex" ? codexProbe : claudeProbe)(`${engine} accepts the 2b ${name} schema`, async () => {
      const body = await captureModelRequest({ ...request(engine), schema });
      const sent = engine === "claude" ? (body.tools as { input_schema: unknown }[])[0]!.input_schema
        : (body.text as { format: { schema: unknown } }).format.schema;
      expect(sent).toEqual(schema);
      expect(JSON.stringify(body)).not.toContain(marker);
    }, 30_000);
