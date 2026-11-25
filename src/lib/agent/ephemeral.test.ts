import { beforeEach, afterEach, afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildEphemeralCommand,
  EphemeralProfileError,
  runEphemeralAgent,
  type EphemeralAgentRequest,
} from "./ephemeral";
import type { AccountContext } from "@/lib/accounts/contracts";
import { agentPublicationIdentityEnv } from "@/lib/git/agentPublicationIdentity";
import { answerSchema } from "@/lib/externalRelay/protocol";
import { parseCodexFeatures, setCodexFeatureReaderForTest } from "./codexSpawnPolicy";
import { claudeKeychainService, readClaudeCredentials } from "@/lib/accounts/claudeCredentials";
import { claudeManagedEnvironment } from "@/lib/accounts/claude";

// Command/control tests use a fake interpreter and its explicit inventory.
let restoreFeatureReader: () => void;
beforeEach(() => {
  restoreFeatureReader = setCodexFeatureReaderForTest(() => parseCodexFeatures(
    "multi_agent stable true\nmulti_agent_v2 stable true\nfuture_worker experimental true",
  ));
});
afterEach(() => restoreFeatureReader());

const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ephemeral-test-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
function fixture(engine: "codex" | "claude"): EphemeralAgentRequest {
  const home = path.join(root, `${engine}-account`);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "auth.json"), "{}");
  fs.writeFileSync(
    path.join(home, "models_cache.json"),
    JSON.stringify({
      models: [
        {
          slug: "gpt-6-sol",
          multi_agent_version: "v2",
          apply_patch_tool_type: "freeform",
          preserved: 1,
        },
      ],
    }),
  );
  return {
    key: `${engine}:${crypto.randomUUID()}`,
    engine,
    model: engine === "codex" ? "gpt-6-sol" : "sonnet",
    effort: "low",
    account: {
      engine,
      accountId: `${engine}_${crypto.randomUUID().replaceAll("-", "")}`,
      kind: "managed",
      home,
      transcriptRoot: home,
      env: {
        ...process.env,
        LLV_TOKEN: "hidden",
        LLV_STATE_OWNER: "viewer",
        LLV_SPAWN_CAPABILITY: "hidden",
        LLV_RELAY_CREDENTIAL: "hidden",
      },
    } as AccountContext,
    ["prompt"]: "Question only on stdin",
    schema: answerSchema,
    runDir: fs.mkdtempSync(path.join(root, `${engine}-run-`)),
    hardCapMs: 60_000,
  };
}
for (const engine of ["claude", "codex"] as const) test(`private ${engine} context has request-local config and cannot persist a session`, () => {
  const request = { ...fixture(engine), privateContext: true };
  fs.writeFileSync(path.join(request.account.home, ".credentials.json"), "{}");
  fs.writeFileSync(path.join(request.account.home, "memory.md"), "OWNER_MEMORY_CANARY");
  const built = buildEphemeralCommand(request);
  const home = engine === "claude" ? built.env.CLAUDE_CONFIG_DIR! : built.env.CODEX_HOME!;
  expect(home.startsWith(request.runDir + path.sep)).toBe(true);
  expect(fs.readdirSync(home)).toEqual([engine === "claude" ? ".credentials.json" : "auth.json"]);
  expect(built.args).toContain(engine === "claude" ? "--no-session-persistence" : "--ephemeral");
  if (engine === "claude") {
    expect(built.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(JSON.parse(built.args[built.args.indexOf("--settings") + 1]!)).toMatchObject({ autoMemoryEnabled: false, disableAllHooks: true });
  } else expect(built.args[built.args.indexOf("memories") - 1]).toBe("--disable");
  for (const mode of ["start", "resume"] as const) expect(() => buildEphemeralCommand({ ...request,
    session: { mode, id: "private-session", cwd: request.runDir } })).toThrow("private context cannot resume or persist a session");
});

test("Codex answer profile is closed and the answer home links only auth", () => {
  const request = fixture("codex");
  fs.writeFileSync(
    path.join(request.account.home, "AGENTS.md"),
    "PERSONAL_MARKER",
  );
  const built = buildEphemeralCommand(request);
  const args = built.args.join(" ");
  expect(args).toContain("--disable shell_tool");
  expect(args).toContain("--disable apps");
  expect(args).toContain("--disable plugins");
  expect(args).toContain("web_search=disabled");
  expect(args).toContain("-c project_doc_max_bytes=0");
  expect(args).toContain("-c skills.include_instructions=false");
  expect(args).toContain("--output-schema");
  expect(args).not.toContain("dangerously");
  expect(args).not.toContain("PERSONAL_MARKER");
  expect(args).not.toContain(request.prompt);
  expect(built.stdin).toBe(request.prompt);
  expect(built.env.LLV_TOKEN).toBeUndefined();
  expect(built.env.LLV_STATE_OWNER).toBeUndefined();
  expect(built.env.LLV_SPAWN_CAPABILITY).toBeUndefined();
  expect(built.env.LLV_RELAY_CREDENTIAL).toBeUndefined();
  const home = built.env.CODEX_HOME!;
  expect(fs.readdirSync(home)).toEqual(["auth.json"]);
  expect(fs.readlinkSync(path.join(home, "auth.json"))).toBe(
    path.join(request.account.home, "auth.json"),
  );
  const catalog = JSON.parse(
    fs.readFileSync(path.join(request.runDir, "catalog.json"), "utf8"),
  );
  expect(catalog).toEqual({ models: [{ slug: "gpt-6-sol", preserved: 1 }] });
});

for (const kind of ["managed", "legacy"] as const) for (const status of [0, 44, 36, null])
  test(`private Claude keeps the selected ${kind} credential backend with Keychain status ${status}`, () => {
    const request = { ...fixture("claude"), privateContext: true };
    // A Keychain account has no credential file. A hostile inherited override
    // must not redirect either the managed or legacy account to another item.
    fs.rmSync(path.join(request.account.home, ".credentials.json"), { force: true });
    request.account.kind = kind;
    request.account.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = path.join(root, "other-account");
    const service = claudeKeychainService(request.account.home);
    const value = String(status);
    const calls: string[][] = [];
    const ports = { platform: "darwin", security: (args: string[]) => {
      calls.push(args);
      return args.at(-1) === service
        ? { status, stdout: status === 0 ? JSON.stringify({ claudeAiOauth: { accessToken: value } }) : "" }
        : { status: 44, stdout: "" };
    } };
    const source = readClaudeCredentials(request.account.home, ports);
    const built = buildEphemeralCommand(request);
    const credentialHome = built.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? built.env.CLAUDE_CONFIG_DIR!;
    expect(readClaudeCredentials(credentialHome, ports)).toEqual(source);
    expect(source.state).toBe(status === 0 ? "present" : status === 44 ? "absent" : "unknown");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(credentialHome).toBe(request.account.home);
    expect(built.env.CLAUDE_CONFIG_DIR).toBe(path.join(request.runDir, "claude-home"));
    expect(fs.readdirSync(built.env.CLAUDE_CONFIG_DIR!)).toEqual([]);
    expect(fs.existsSync(path.join(request.account.home, ".credentials.json"))).toBe(false);
    expect(built.args.join(" ")).not.toContain("claudeAiOauth");
  });

for (const kind of ["managed", "legacy"] as const) test(`private Claude disables inherited telemetry and diagnostic sinks for ${kind} accounts`, () => {
  const request = fixture("claude");
  request.account.kind = kind;
  const sinks = {
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1", OTEL_LOGS_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "console", OTEL_TRACES_EXPORTER: "otlp",
    OTEL_LOG_USER_PROMPTS: "1", OTEL_LOG_RAW_API_BODIES: "1", OTEL_LOG_TOOL_CONTENT: "1",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1", ANTHROPIC_LOG: "debug", DEBUG: "*", CLAUDE_DEBUG: "1",
    CLAUDE_CODE_DEBUG_LOG_LEVEL: "debug", CLAUDE_CODE_DEBUG_LOGS_DIR: path.join(root, "owner-debug"),
    CLAUDE_CODE_DIAGNOSTICS_FILE: path.join(root, "owner-diagnostics"), CLAUDE_CODE_SESSION_LOG: path.join(root, "owner-session"),
    CLAUDE_CODE_PERFETTO_TRACE: path.join(root, "owner-trace"), CLAUDE_CODE_PROFILE_QUERY: "1", CLAUDE_CODE_PROFILE_STARTUP: "1",
    CLAUDE_CODE_FRAME_TIMING_LOG: path.join(root, "owner-frames"), CLAUDE_CODE_TERMINAL_RECORDING: "1",
    CLAUDE_PTY_RECORD: path.join(root, "owner-terminal"), CLAUDE_RUNNER_DEBUG_LOG_PATH: path.join(root, "owner-runner"),
  };
  const switches = { CLAUDE_CODE_ENABLE_TELEMETRY: "1", DISABLE_TELEMETRY: "0", DISABLE_ERROR_REPORTING: "0", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "" };
  Object.assign(request.account.env, sinks, switches);
  const before = { ...request.account.env };
  const ordinary = buildEphemeralCommand(request);
  const guest = buildEphemeralCommand({ ...request, privateContext: true });
  for (const [key, value] of Object.entries({ ...sinks, ...switches })) expect(ordinary.env[key]).toBe(value);
  for (const key of Object.keys(sinks)) expect(guest.env[key]).toBeUndefined();
  expect(guest.env).toMatchObject({ CLAUDE_CODE_ENABLE_TELEMETRY: "0", DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_SECURESTORAGE_CONFIG_DIR: request.account.home });
  expect(request.account.env).toEqual(before);
  const following = buildEphemeralCommand(request);
  expect(following.env).toEqual(ordinary.env);
});

test("private Codex drops native persistence and telemetry overrides without changing ordinary profiles", () => {
  const request = fixture("codex");
  const overrides = {
    CODEX_ROLLOUT_TRACE_ROOT: path.join(root, "owner-traces"), CODEX_SQLITE_HOME: path.join(root, "owner-sqlite"),
    CODEX_TUI_RECORD_SESSION: "1", CODEX_TUI_SESSION_LOG_PATH: path.join(root, "owner-session.log"),
    RUST_LOG: "trace", OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1", OTEL_LOGS_EXPORTER: "otlp",
  };
  Object.assign(request.account.env, overrides);
  const ordinary = buildEphemeralCommand(request);
  const guest = buildEphemeralCommand({ ...request, privateContext: true });
  for (const [key, value] of Object.entries(overrides)) {
    expect(ordinary.env[key]).toBe(value);
    expect(guest.env[key]).toBeUndefined();
    expect(request.account.env[key]).toBe(value);
  }
  expect(guest.env.CODEX_HOME).toBe(path.join(request.runDir, "codex-home"));
});
test("the relay answer profile denies newly reported agent features", () => {
  const restore = setCodexFeatureReaderForTest(() => parseCodexFeatures("multi_agent stable true\nmulti_agent_v2 stable true\nfuture_worker experimental true"));
  try {
    const args = buildEphemeralCommand(fixture("codex")).args;
    for (const feature of ["multi_agent", "multi_agent_v2", "future_worker"]) expect(args[args.indexOf(feature) - 1]).toBe("--disable");
    expect(args).toContain("agents.enabled=false");
  } finally { restore(); }
});
test.each(["claude", "codex"] as const)("%s answer profile pins publication identity in env and engine settings", (engine) => {
  const request = fixture(engine);
  const email = ["no-reply", "build.example.invalid"].join("@");
  Object.assign(request.account.env, { DELEGATUS_PUBLICATION_NAME: "Build Agent", DELEGATUS_PUBLICATION_EMAIL: email });
  const built = buildEphemeralCommand(request);
  expect([built.env.GIT_AUTHOR_NAME, built.env.GIT_AUTHOR_EMAIL, built.env.GIT_COMMITTER_NAME, built.env.GIT_COMMITTER_EMAIL]).toEqual(["Build Agent", email, "Build Agent", email]);
  if (engine === "claude") {
    const settings = JSON.parse(built.args[built.args.indexOf("--settings") + 1]!);
    expect(settings.env).toEqual(agentPublicationIdentityEnv(claudeManagedEnvironment(request.account.home, request.account.env), request.session?.cwd ?? request.runDir));
  } else expect(built.args).toContain(`shell_environment_policy.set.GIT_AUTHOR_EMAIL=${JSON.stringify(email)}`);
});
test("Codex finds a new account model when the answer-home cache is stale", () => {
  const request = fixture("codex");
  buildEphemeralCommand(request);
  const answerHome = path.join(
    process.env.LLV_STATE_DIR!,
    "external-relay/codex-homes",
    request.account.accountId,
  );
  fs.writeFileSync(
    path.join(answerHome, "models_cache.json"),
    JSON.stringify({
      models: [{ slug: "old", multi_agent_version: "v2", apply_patch_tool_type: "freeform" }],
    }),
  );
  fs.writeFileSync(
    path.join(request.account.home, "models_cache.json"),
    JSON.stringify({
      models: [
        { slug: "old" },
        { slug: "new", multi_agent_version: "v2", apply_patch_tool_type: "freeform", preserved: 2 },
      ],
    }),
  );
  const built = buildEphemeralCommand({ ...request, model: "new" });
  expect(built.args).toContain("new");
  expect(
    JSON.parse(fs.readFileSync(path.join(request.runDir, "catalog.json"), "utf8")),
  ).toEqual({ models: [{ slug: "new", preserved: 2 }] });
  expect(() => buildEphemeralCommand({ ...request, model: "unknown" })).toThrow(
    "model absent from catalog",
  );
});
test("Codex replaces a stale auth link without leaving a temporary link", () => {
  const request = fixture("codex");
  const built = buildEphemeralCommand(request);
  const link = path.join(built.env.CODEX_HOME!, "auth.json");
  fs.rmSync(link);
  fs.symlinkSync(path.join(root, "stale-auth"), link);
  buildEphemeralCommand(request);
  expect(fs.readlinkSync(link)).toBe(path.join(request.account.home, "auth.json"));
  expect(fs.readdirSync(built.env.CODEX_HOME!)).toEqual(["auth.json"]);
});
test("Claude answer profile excludes account settings, connectors, and instruction marker", () => {
  const request = fixture("claude");
  fs.writeFileSync(
    path.join(request.account.home, "CLAUDE.md"),
    "PERSONAL_MARKER",
  );
  const built = buildEphemeralCommand(request);
  expect(built.args).toContain("--restricted");
  expect(built.args).toContain("--safe-mode");
  expect(built.args).toContain("--strict-mcp-config");
  expect(built.args).toContain("--json-schema");
  expect(built.args).toContain("");
  expect(JSON.parse(built.args[built.args.indexOf("--settings") + 1]!)).toEqual({
    env: agentPublicationIdentityEnv(claudeManagedEnvironment(request.account.home, request.account.env), request.session?.cwd ?? request.runDir),
  });
  for (const flag of [
    "--mcp-config",
    "--session-id",
    "--dangerously-skip-permissions",
  ])
    expect(built.args).not.toContain(flag);
  expect(built.args.join(" ")).not.toContain("PERSONAL_MARKER");
  expect(built.args.join(" ")).not.toContain(request.prompt);
  expect(built.stdin).toBe(request.prompt);
});
test("Claude provider account declines before launch", () => {
  const request = fixture("claude");
  request.account.claudeProvider = {
    baseUrl: "https://provider.invalid",
    model: "provider-model",
    smallFastModel: null,
  };
  expect(() => buildEphemeralCommand(request)).toThrow("provider account");
  expect(() => buildEphemeralCommand(request)).toThrow(EphemeralProfileError);
});
test("profile errors close before launch", () => {
  const request = fixture("codex");
  expect(() =>
    buildEphemeralCommand({ ...request, hardCapMs: 2 ** 31 }),
  ).toThrow();
  expect(() =>
    buildEphemeralCommand({ ...request, hardCapMs: Infinity }),
  ).toThrow();
  expect(() =>
    buildEphemeralCommand({ ...request, hardCapMs: 30_000 }),
  ).toThrow();
  fs.rmSync(path.join(request.account.home, "models_cache.json"));
  expect(() => buildEphemeralCommand(request)).toThrow("model catalog");
  fs.rmSync(path.join(request.account.home, "auth.json"));
  expect(() => buildEphemeralCommand(request)).toThrow("auth file");
});
test("stub CLI emits progress before a structured answer for each engine", async () => {
  const script = path.join(root, "stub-cli");
  fs.writeFileSync(
    script,
    `#!/usr/bin/env bun\nconst a=process.argv.slice(2);await Bun.stdin.text();if(a.includes('--output-last-message')){const p=a[a.indexOf('--output-last-message')+1];console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Working'}}));await Bun.write(p,JSON.stringify({action:'reply',text:'Done',reply_to:null}));}else{console.log(JSON.stringify({type:'system',subtype:'init',tools:['StructuredOutput'],mcp_servers:[]}));console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Working'}]}}));console.log(JSON.stringify({type:'result',subtype:'success',structured_output:{action:'reply',text:'Done',reply_to:null}}));}\n`,
  );
  fs.chmodSync(script, 0o700);
  for (const engine of ["codex", "claude"] as const) {
    const request = fixture(engine);
    const events: string[] = [];
    const run = await runEphemeralAgent({
      ...request,
      runtime: { command: script },
      onEvent: (event) => events.push(event.type),
    });
    const result = await run.done;
    expect(result.status).toBe("done");
    expect(result.answer).toEqual({
      action: "reply",
      text: "Done",
      reply_to: null,
    });
    expect(events).toContain("note");
  }
});
test("Claude keeps UTF-8 intact across tail reads in progress and answer", async () => {
  const script = path.join(root, "stub-utf8");
  fs.writeFileSync(script, `#!/usr/bin/env bun
await Bun.stdin.text();
process.stdout.write(JSON.stringify({type:'system',subtype:'init',tools:['StructuredOutput'],mcp_servers:[]})+'\\n');
const note=Buffer.from(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Привіт'}]}})+'\\n');
const noteCut=note.indexOf(Buffer.from('Привіт'))+1;
process.stdout.write(note.subarray(0,noteCut));
await Bun.sleep(700);
process.stdout.write(note.subarray(noteCut));
const result=Buffer.from(JSON.stringify({type:'result',subtype:'success',structured_output:{action:'reply',text:'Привіт',reply_to:null}})+'\\n');
const cut=result.indexOf(Buffer.from('Привіт'))+1;
process.stdout.write(result.subarray(0,cut));
await Bun.sleep(700);
process.stdout.write(result.subarray(cut));
`);
  fs.chmodSync(script, 0o700);
  const notes: string[] = [];
  const run = await runEphemeralAgent({
    ...fixture("claude"), runtime: { command: script },
    onEvent: (event) => { if (event.type === "note") notes.push(event.text); },
  });
  const result = await run.done;
  expect(result.status).toBe("done");
  expect(result.answer).toMatchObject({ text: "Привіт" });
  expect(notes).toEqual(["Привіт"]);
});
test("the native web search is the one tool the relay profile can add", () => {
  const codex = buildEphemeralCommand({ ...fixture("codex"), webSearch: true }).args;
  expect(codex).toContain("web_search=cached");
  expect(codex).not.toContain("web_search=disabled");
  for (const feature of ["shell_tool", "unified_exec", "apps", "plugins", "browser_use", "computer_use"])
    expect(codex[codex.indexOf(feature) - 1]).toBe("--disable");
  const claude = buildEphemeralCommand({ ...fixture("claude"), webSearch: true }).args;
  expect(claude[claude.indexOf("--tools") + 1]).toBe("WebSearch");
  expect(claude[claude.indexOf("--allowedTools") + 1]).toBe("WebSearch");
  for (const flag of ["--restricted", "--safe-mode", "--strict-mcp-config", "--no-session-persistence"])
    expect(claude).toContain(flag);
  expect(claude).not.toContain("--mcp-config");
  // Off unless asked for.
  const closed = buildEphemeralCommand(fixture("claude")).args;
  expect(closed[closed.indexOf("--tools") + 1]).toBe("");
  expect(closed).not.toContain("--allowedTools");
});

test("persistent flags keep the closed profile on start and resume", () => {
  for (const engine of ["claude", "codex"] as const) for (const mode of ["start", "resume"] as const) {
    const request = fixture(engine);
    const session = { mode, id: "00000000-0000-0000-0000-000000000000", cwd: path.join(root, "session-cwd"), codexHome: path.join(root, "session-codex") };
    const built = buildEphemeralCommand({ ...request, session });
    expect(built.args).not.toContain(engine === "claude" ? "--no-session-persistence" : "--ephemeral");
    if (engine === "claude") {
      expect(built.args).toContain(mode === "start" ? "--session-id" : "--resume");
      expect(built.args).toContain("--autocompact");
    } else {
      expect(built.env.CODEX_HOME).toBe(session.codexHome);
      expect(built.args).toContain("--ignore-user-config");
      if (mode === "resume") { expect(built.args.slice(0, 3)).toEqual(["exec", "resume", session.id]); expect(built.args).toContain("sandbox_mode=\"read-only\""); }
    }
  }
});

test("negotiated native images have a per-run home and a read-confined profile", () => {
  const request = fixture("codex");
  const readableRoot = path.join(request.runDir, "cwd");
  const built = buildEphemeralCommand({ ...request, imageGeneration: { readableRoot } });
  expect(built.args.join(" ")).not.toContain("--disable image_generation");
  expect(built.args).toContain('default_permissions="relay"');
  expect(built.args).toContain(`permissions.relay.filesystem={${JSON.stringify(readableRoot)}="read"}`);
  expect(built.args).not.toContain("read-only");
  expect(built.env.CODEX_HOME).toBe(path.join(request.runDir, "codex-home"));
  const mediaRoot = path.join(request.runDir, "media");
  const editing = buildEphemeralCommand({ ...request, imageGeneration: { readableRoot, readableMediaRoot: mediaRoot } });
  expect(editing.args).toContain(`permissions.relay.filesystem={${JSON.stringify(readableRoot)}="read",${JSON.stringify(mediaRoot)}="read"}`);
  const resumed = buildEphemeralCommand({ ...request, imageGeneration: { readableRoot }, session: { mode: "resume", id: "thread_1", cwd: readableRoot, codexHome: path.join(request.runDir, "session-home") } });
  expect(resumed.args.join(" ")).not.toContain("sandbox_mode");
  expect(resumed.env.CODEX_HOME).toBe(path.join(request.runDir, "session-home"));
  const claude = fixture("claude");
  expect(buildEphemeralCommand({ ...claude, imageGeneration: { readableRoot } })).toEqual(buildEphemeralCommand(claude));
});

test("negotiated inbound images reach each real launcher stdin or native image flag", async () => {
  const file = path.join(root, "media-user.jsonl");
  const native = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "fixture" } }] } }) + "\n";
  fs.writeFileSync(file, native);
  const image = path.join(root, "original.png"); fs.writeFileSync(image, "fixture image");
  const script = path.join(root, "media-cli");
  fs.writeFileSync(script, `#!/usr/bin/env bun
const args=process.argv.slice(2), text=await Bun.stdin.text();
if (args.includes('--output-last-message')) {
  if (!args.includes('--image') || !args.includes(${JSON.stringify(image)})) process.exit(2);
  await Bun.write(args[args.indexOf('--output-last-message')+1], JSON.stringify({action:'reply',text:'Photo received',reply_to:null}));
} else {
  if (text!==${JSON.stringify(native)} || !args.includes('--input-format')) process.exit(3);
  console.log(JSON.stringify({type:'system',subtype:'init',tools:['StructuredOutput'],mcp_servers:[]}));
  console.log(JSON.stringify({type:'result',subtype:'success',structured_output:{action:'reply',text:'Photo received',reply_to:null}}));
}
`); fs.chmodSync(script, 0o700);
  for (const engine of ["codex", "claude"] as const) {
    const request = fixture(engine);
    const run = await runEphemeralAgent({ ...request, inputImages: [image], ...(engine === "claude" ? { inputFile: file } : {}), runtime: { command: script } });
    expect(await run.done).toMatchObject({ status: "done", answer: { text: "Photo received" } });
  }
  const failed = await runEphemeralAgent({ ...fixture("claude"), inputFile: path.join(root, "missing-input"), runtime: { command: script } });
  expect((await failed.done).status).not.toBe("done");
});

for (const action of ["search", "open_page", "incomplete"] as const) test(`native provider evidence and note suppression: ${action}`, async () => {
  const script = path.join(root, `provider-${action}`);
  fs.writeFileSync(script, `#!/usr/bin/env bun
    const a=process.argv;await Bun.stdin.text();
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Before search'}}));
    console.log(JSON.stringify({type:'item.started',item:{id:'search-item',type:'web_search',action:{type:'other'}}}));
    if(${JSON.stringify(action)}!=='incomplete')console.log(JSON.stringify({type:'item.completed',item:{id:'search-item',type:'web_search',action:${JSON.stringify(action === "search" ? { type: "search", query: "page" } : { type: "open_page", url: "https://example.org" })}}}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'PAGE_NOTE_CANARY'}}));
    await Bun.write(a[a.indexOf('--output-last-message')+1],JSON.stringify({action:'reply',text:'Done',reply_to:null}));
  `); fs.chmodSync(script, 0o700);
  const notes: string[] = [];
  const request = fixture("codex"); request.key = `provider-${action}`; request.account.accountId = `provider_${action}`;
  const run = await runEphemeralAgent({ ...request, webSearch: true, runtime: { command: script }, onEvent: event => { if (event.type === "note") notes.push(event.text); } });
  const result = await run.done;
  expect(result.status).toBe("done"); expect(notes).toEqual(["Before search"]);
  if (action === "search") expect(result.providerOpens).toEqual([]);
  else expect(result.providerOpens).toHaveLength(1);
});
