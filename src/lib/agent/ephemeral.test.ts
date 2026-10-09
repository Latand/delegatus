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
    expect(settings.env).toEqual(agentPublicationIdentityEnv(request.account.env));
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
    env: agentPublicationIdentityEnv(request.account.env),
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
    const run = runEphemeralAgent({
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
  const run = runEphemeralAgent({
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
  expect(codex).toContain("web_search=live");
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
