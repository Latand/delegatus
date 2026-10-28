import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { beforeEach, describe, expect, test } from "bun:test";
import { CodexPinnedProtocol, generateCodexSchemas, resetCodexProtocolAdmissionsForTest, resolveCodexProtocol, type CodexSchemaGenerator } from "./codexPinnedProtocol";
import { CodexAppServerClient } from "./codexAppServer";
import { NativeCodexQueue, type NativeQueueInput } from "../runtime/nativeCodexQueue";
import { CodexAppServerHost } from "../runtime/codexAppServerHost";
import { codexServerRequestKinds, encodeCodexServerResponse, routeCodexServerRequest } from "../runtime/codexServerRequests";

const adapterFiles = ["../runtime/codexAppServerHost.ts", "../runtime/nativeCodexQueue.ts", "../runtime/codexHistoryReader.ts", "codexAppServer.ts"];
// Let TypeScript resolve bindings, inferred helper returns and spread unions.
// Collect once for all pins; the compiler reads source and never executes it.
let adapterProgram: ts.Program | undefined;
function adapterSources() {
  if (!adapterProgram) {
    const configPath = path.resolve(import.meta.dir, "../../../tsconfig.json");
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
    const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
    adapterProgram = ts.createProgram(adapterFiles.map(file => path.join(import.meta.dir, file)), options);
  }
  return { program: adapterProgram, checker: adapterProgram.getTypeChecker() };
}

describe.each(["0.154.0", "0.159.0", "0.162.1", "0.163.0", "0.164.0"])("pinned Codex %s", version => {
  const protocol = new CodexPinnedProtocol(version);
  test("the reviewed generator artifacts retain their recorded digests", () => {
    const directory = path.join(import.meta.dir, "protocol", version);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
    for (const name of ["stable", "experimental"]) expect(createHash("sha256").update(fs.readFileSync(path.join(directory, `${name}.json`))).digest("hex")).toBe(manifest.sha256[name]);
  });
  test("model selection receipts and reroutes expose the fields the host consumes", () => {
    const schema = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "protocol", version, "experimental.json"), "utf8"));
    for (const [name, fields] of [
      ["ThreadStartResponse", ["model"]],
      ["ThreadResumeResponse", ["model"]],
      ["ModelReroutedNotification", ["threadId", "turnId", "toModel"]],
    ] as const) {
      for (const field of fields) expect(schema.definitions.v2[name].properties, `${name}.${field}`).toHaveProperty(field);
    }
  });
  test("missing methods and fields fail with method, path and version", () => {
    expect(() => protocol.assertRequest("thread/invented", {})).toThrow(`CLI ${version} thread/invented method`);
    expect(() => protocol.assertRequest("turn/interrupt", { threadId: "thread", turnId: "turn", inventedField: true })).toThrow(`CLI ${version} turn/interrupt params.inventedField`);
    expect(() => protocol.assertRequest("turn/interrupt", { threadId: "thread", turnId: 42 })).toThrow("params.turnId");
  });
  test("stable account clients and experimental queue clients declare only their needed opt-in", () => {
    expect(protocol.initializeCapabilities(["account/read", "account/rateLimits/read"])).toEqual({ experimentalApi: false });
    expect(protocol.initializeCapabilities(["thread/queue/list"])).toEqual({ experimentalApi: true });
    expect(() => protocol.assertRequest("thread/queue/list", { threadId: "thread" }, false)).toThrow("stable pinned schema");
    expect(protocol.initializeCapabilities(["thread/resume"], [{ method: "thread/resume", field: "path" }])).toEqual({ experimentalApi: true });
    expect(() => protocol.assertRequest("thread/resume", { threadId: "thread", path: "/sessions/thread.jsonl" }, false)).toThrow("stable-params.path");
  });
  test("real account resume payloads, including the spread fallback, fit the pin", async () => {
    // Use the real public builder with an in-memory transport. No CLI, account,
    // host or process is opened; validation happens before returning a receipt.
    const client = Object.create(CodexAppServerClient.prototype) as CodexAppServerClient;
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    Object.defineProperty(client, "request", { value: async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      protocol.assertRequest(method, params);
      if (method === "config/read") return { config: { mcp_servers: {} } };
      if (!params.excludeTurns) throw new Error("Full history is not supported");
      return { thread: { id: "thread", path: "/sessions/thread.jsonl" } };
    } });
    expect(await client.resumeThread("thread", {
      path: "/sessions/thread.jsonl", cwd: "/workspace", model: "model", effort: "high",
      serviceTier: "standard", approvalPolicy: "never", sandbox: "read-only",
    })).toEqual({ id: "thread", path: "/sessions/thread.jsonl" });
    expect(requests.map(request => request.method)).toEqual(["config/read", "thread/resume", "thread/resume"]);
    expect(requests[2].params).toEqual({ ...requests[1].params, excludeTurns: true });
  });
  test("real queue method builders and spread payloads fit the pin", async () => {
    const input: NativeQueueInput[] = [{ type: "text", text: "queued input", text_elements: [] }];
    const submission = { id: "submission", clientUserMessageId: "client", input };
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const queue = new NativeCodexQueue({ rpc: async (method, params) => {
      calls.push({ method, params });
      protocol.assertRequest(method, params);
      if (method === "thread/queue/list") return { data: [], nextCursor: null };
      if (["thread/queue/add", "thread/queue/update"].includes(method)) return { queuedSubmission: submission };
      if (method === "thread/queue/delete") return { deleted: true };
      if (method === "thread/queue/start") return { turn: { id: "turn", status: "inProgress", items: [] } };
      return {};
    } }, "thread");
    try {
      await queue.refresh();
      await queue.add("client", input);
      await queue.update(submission, input);
      await queue.delete("submission");
      await queue.reorder(["submission"]);
      await queue.start();
      await queue.start("submission");
      expect(calls.map(call => call.method)).toEqual([
        "thread/queue/list", "thread/queue/add", "thread/queue/update", "thread/queue/delete",
        "thread/queue/reorder", "thread/queue/start", "thread/queue/start",
      ]);
    } finally { queue.dispose(); }
  });
  test("real host resume payloads, including forwarded fields and the spread fallback, fit the pin", async () => {
    // Exercise the private helper on its real prototype without starting a
    // host or process. Its caller's inferred fields are checked below; here
    // the transport checks fields added after the Record type erases them.
    const host = Object.create(CodexAppServerHost.prototype) as {
      resumeThreadTolerantly(params: Record<string, unknown>): Promise<unknown>;
    };
    Object.defineProperty(host, "identity", { value: { threadId: "thread", path: null } });
    for (const access of [
      { sandbox: "danger-full-access", approvalPolicy: "never" },
      { sandbox: "workspace-write", approvalPolicy: "on-request" },
      { sandbox: "read-only", approvalPolicy: "untrusted" },
      { permissions: "read-only-stage", approvalPolicy: "never" },
    ]) {
      for (const paginated of [false, true]) {
        const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
        Object.defineProperty(host, "rpc", { configurable: true, value: async (method: string, params: Record<string, unknown>) => {
          protocol.assertRequest(method, params);
          requests.push({ method, params: structuredClone(params) });
          if (paginated && !params.excludeTurns) throw new Error("Codex app-server request failed: list_turns is not supported yet");
          return { thread: { id: "thread", path: null } };
        } });
        const params = { threadId: "thread", ...access, approvalsReviewer: "user", serviceTier: "standard",
          developerInstructions: "Resume instructions", config: { model_reasoning_effort: "high" } };
        expect(await host.resumeThreadTolerantly(params)).toEqual({
          thread: { id: "thread", path: null, ...(paginated ? { turns: [] } : {}) },
        });
        expect(requests).toEqual([
          { method: "thread/resume", params },
          ...(paginated ? [{ method: "thread/resume", params: { ...params, excludeTurns: true } }] : []),
        ]);
      }
    }
  });
  test("the adapter's outgoing methods and inferred payload fields exist in every supported schema", () => {
    const { program, checker } = adapterSources();
    const fields = (type: ts.Type): string[] => type.isUnion()
      ? type.types.flatMap(fields) : checker.getPropertiesOfType(type).map(property => property.name);
    const methods = (type: ts.Type): string[] => type.isUnion()
      ? type.types.flatMap(methods) : type.isStringLiteral() ? [type.value] : [];
    const opaque = (type: ts.Type): boolean => type.isUnion()
      ? type.types.some(opaque) : Boolean(type.getStringIndexType() || type.getNumberIndexType()
        || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)));
    for (const relative of adapterFiles) {
      const file = path.join(import.meta.dir, relative);
      const source = program.getSourceFile(file)!;
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
          const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text
            : ts.isIdentifier(node.expression) ? node.expression.text : "";
          if (!["rpc", "request", "notify", "resumeThreadTolerantly", "call", "readPage"].includes(name)) {
            ts.forEachChild(node, visit);
            return;
          }
          const kind = name === "notify" ? "ClientNotification" : "ClientRequest";
          const argument = node.arguments[0];
          const outgoingMethods = name === "resumeThreadTolerantly" ? ["thread/resume"]
            : argument ? methods(checker.getTypeAtLocation(argument)) : [];
          if (argument && !outgoingMethods.length) {
            const declarations = checker.getSymbolAtLocation(argument)?.declarations ?? [];
            // Transport callbacks forward parameters from builders checked at
            // their call sites. The queue's action template is exercised above
            // through every public operation. Refuse any other opaque builder.
            const forwarding = declarations.some(ts.isParameter);
            const testedQueueBuilder = relative === "../runtime/nativeCodexQueue.ts"
              && declarations.some(declaration => ts.isVariableDeclaration(declaration)
                && declaration.initializer && ts.isTemplateExpression(declaration.initializer));
            expect(forwarding || testedQueueBuilder, `${relative}: unchecked method ${argument.getText(source)}`).toBe(true);
          }
          for (const method of outgoingMethods) expect(protocol.hasMethod(kind, method), `${relative}: ${method}`).toBe(true);
          const params = node.arguments[name === "resumeThreadTolerantly" ? 0 : 1];
          if (kind === "ClientRequest" && params && outgoingMethods.length) {
            if (opaque(checker.getTypeAtLocation(params))) {
              // Only this forwarded payload is covered by the real helper
              // matrix above. An index signature supplies no field evidence.
              const checkedHostResume = relative === "../runtime/codexAppServerHost.ts"
                && checker.getSymbolAtLocation(params)?.declarations?.some(declaration =>
                  ts.isParameter(declaration) && ts.isMethodDeclaration(declaration.parent)
                  && declaration.parent.name.getText(source) === "resumeThreadTolerantly");
              expect(checkedHostResume, `${relative}: unchecked payload ${params.getText(source)}`).toBe(true);
            }
            for (const field of fields(checker.getTypeAtLocation(params))) {
              // A field behind the real protocol capability guard is sent
              // only to pins that advertise it. Recognize the exact spread
              // builder; an unconditional or differently guarded field fails.
              const guarded = ts.isObjectLiteralExpression(params) && params.properties.some(property => {
                if (!ts.isSpreadAssignment(property) || !ts.isParenthesizedExpression(property.expression)) return false;
                const branch = property.expression.expression;
                if (!ts.isConditionalExpression(branch) || !ts.isCallExpression(branch.condition)) return false;
                const guard = branch.condition;
                return ts.isPropertyAccessExpression(guard.expression) && guard.expression.name.text === "hasRequestField"
                  && guard.expression.expression.getText(source) === "this.protocol"
                  && guard.arguments.length === 2 && guard.arguments.every(ts.isStringLiteral)
                  && outgoingMethods.includes((guard.arguments[0] as ts.StringLiteral).text)
                  && (guard.arguments[1] as ts.StringLiteral).text === field
                  && ts.isObjectLiteralExpression(branch.whenTrue) && branch.whenTrue.properties.length === 1
                  && branch.whenTrue.properties[0].name?.getText(source) === field
                  && ts.isObjectLiteralExpression(branch.whenFalse) && branch.whenFalse.properties.length === 0;
              });
              // Conditional turn/start vs turn/steer carries expectedTurnId
              // only on the steer branch. Actual wire builders are validated
              // at runtime; this source check admits fields from either branch.
              expect(guarded || outgoingMethods.some(method => protocol.hasRequestField(method, field)),
                `${relative}: ${outgoingMethods.join("|")} params.${field}`).toBe(true);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }, 30_000);
});

test("an unreviewed CLI is refused before a thread can be started", () => {
  expect(() => new CodexPinnedProtocol("0.999.0")).toThrow("has no pinned schema. Pin the CLI to a supported version, or regenerate with scripts/generate-codex-protocol.ts");
});

describe("an executable without its own pin", () => {
  const pinned = (version: string) => ({
    stable: fs.readFileSync(path.join(import.meta.dir, "protocol", version, "stable.json"), "utf8"),
    experimental: fs.readFileSync(path.join(import.meta.dir, "protocol", version, "experimental.json"), "utf8"),
  });
  const recording = (result: () => Promise<{ stable: string; experimental: string }>) => {
    const calls: string[] = [];
    const generate: CodexSchemaGenerator = async binary => { calls.push(binary); return result(); };
    return { calls, generate };
  };
  // The generator is injected, so no executable reads this environment.
  const noEnv = {} as NodeJS.ProcessEnv;
  beforeEach(() => resetCodexProtocolAdmissionsForTest());

  test.each(["0.154.0", "0.159.0", "0.162.1", "0.163.0", "0.164.0"])("pinned %s never generates a schema", async version => {
    const { calls, generate } = recording(async () => { throw new Error("unexpected"); });
    const protocol = await resolveCodexProtocol(version, "codex-fixture", noEnv, generate);
    expect([protocol.version, protocol.cliVersion, protocol.unpinned]).toEqual([version, version, null]);
    expect(calls).toEqual([]);
  });

  test("an additive extension runs under the nearest older pin and keeps that pin's contract", async () => {
    // 0.163.0's real schema stands in for a self-updated 0.162.9 above pin 0.162.1.
    const { calls, generate } = recording(async () => pinned("0.163.0"));
    const protocol = await resolveCodexProtocol("0.162.9", "codex-fixture", noEnv, generate);
    expect([protocol.version, protocol.cliVersion]).toEqual(["0.162.1", "0.162.9"]);
    expect(protocol.unpinned).toEqual({ cliVersion: "0.162.9", cliSchemaDigest: createHash("sha256").update(pinned("0.163.0").experimental).digest("hex") });
    expect(protocol.schemaDigest).toBe(JSON.parse(fs.readFileSync(path.join(import.meta.dir, "protocol", "0.162.1", "manifest.json"), "utf8")).sha256.experimental);
    // Methods the newer CLI added stay unreviewed and unusable.
    expect(() => protocol.assertRequest("thread/items/read", { threadId: "thread" })).toThrow("CLI 0.162.9 (under pin 0.162.1) thread/items/read method is absent");
    expect(() => protocol.assertRequest("turn/interrupt", { threadId: "thread", turnId: "turn" })).not.toThrow();
    await resolveCodexProtocol("0.162.9", "codex-fixture", noEnv, generate);
    expect(calls).toEqual(["codex-fixture"]);
  });

  test("a CLI newer than every pin is compared with the newest", async () => {
    const { generate } = recording(async () => pinned("0.164.0"));
    const protocol = await resolveCodexProtocol("0.165.0", "codex-fixture", noEnv, generate);
    expect([protocol.version, protocol.cliVersion]).toEqual(["0.164.0", "0.165.0"]);
  });

  test("a breaking schema is refused with the remedy and the first breaks, and the verdict is kept", async () => {
    // 0.162.1's real schema dropped a field that 0.159.0 had.
    const { calls, generate } = recording(async () => pinned("0.162.1"));
    const refusal = resolveCodexProtocol("0.160.0", "codex-fixture", noEnv, generate);
    await expect(refusal).rejects.toThrow("CLI 0.160.0; Supported: 0.164.0, 0.163.0, 0.162.1, 0.159.0, 0.154.0; cause: not an additive extension of pin 0.159.0; stable v2.CodexErrorInfo.oneOf: removed");
    await expect(resolveCodexProtocol("0.160.0", "codex-fixture", noEnv, generate)).rejects.toThrow("not an additive extension");
    expect(calls).toHaveLength(1);
  });

  test("a field added inside an existing server request is refused, because the host could not decode it", async () => {
    // Incoming requests are decoded strictly against the pin; an extra key is unrecognized.
    const approval = { threadId: "thread", turnId: "turn", itemId: "item", startedAtMs: 1, command: "echo example" };
    const pin = new CodexPinnedProtocol("0.162.1");
    expect(() => pin.assertServerRequest("item/commandExecution/requestApproval", approval)).not.toThrow();
    expect(() => pin.assertServerRequest("item/commandExecution/requestApproval", { ...approval, futureHint: "x" })).toThrow("server-params.futureHint: unrecognized_keys");
    const extend = (text: string) => {
      const bundle = JSON.parse(text);
      bundle.definitions.CommandExecutionRequestApprovalParams.properties.futureHint = { type: ["string", "null"] };
      return JSON.stringify(bundle);
    };
    const { generate } = recording(async () => { const base = pinned("0.162.1"); return { stable: extend(base.stable), experimental: extend(base.experimental) }; });
    await expect(resolveCodexProtocol("0.162.5", "codex-fixture", noEnv, generate)).rejects.toThrow("cause: not an additive extension of pin 0.162.1; stable CommandExecutionRequestApprovalParams.futureHint:");
    await expect(resolveCodexProtocol("0.162.5", "codex-fixture", noEnv, generate)).rejects.toThrow("added inside a server request");
  });

  test("a CLI older than every pin, or an unparsed version, is refused without running it", async () => {
    const { calls, generate } = recording(async () => pinned("0.163.0"));
    await expect(resolveCodexProtocol("0.150.0", "codex-fixture", noEnv, generate)).rejects.toThrow("CLI 0.150.0; Supported: 0.164.0, 0.163.0, 0.162.1, 0.159.0, 0.154.0; cause: no older pin");
    await expect(resolveCodexProtocol("unknown", "codex-fixture", noEnv, generate)).rejects.toThrow("no older pin");
    expect(calls).toEqual([]);
  });

  test("a failed generation refuses this launch and is retried by the next one", async () => {
    let fail = true;
    const { calls, generate } = recording(async () => { if (fail) throw new Error("generate-json-schema failed (exit 2)"); return pinned("0.163.0"); });
    await expect(resolveCodexProtocol("0.163.1", "codex-fixture", noEnv, generate)).rejects.toThrow("CLI 0.163.1; Supported: 0.164.0, 0.163.0, 0.162.1, 0.159.0, 0.154.0; cause: generate-json-schema failed (exit 2)");
    fail = false;
    expect((await resolveCodexProtocol("0.163.1", "codex-fixture", noEnv, generate)).cliVersion).toBe("0.163.1");
    expect(calls).toHaveLength(2);
  });

  test("concurrent launches share one generation", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { calls, generate } = recording(async () => { await gate; return pinned("0.163.0"); });
    const first = resolveCodexProtocol("0.163.2", "codex-fixture", noEnv, generate);
    const second = resolveCodexProtocol("0.163.2", "codex-fixture", noEnv, generate);
    release();
    expect((await Promise.all([first, second])).map(protocol => protocol.cliVersion)).toEqual(["0.163.2", "0.163.2"]);
    expect(calls).toHaveLength(1);
  });

  test("the default generator runs the executable and removes its scratch output", async () => {
    // A real child process stands in for the CLI: it writes the bundle where
    // `generate-json-schema --out` asks, or fails when told to.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-schema-fixture-"));
    try {
      const binary = path.join(root, "codex");
      fs.writeFileSync(binary, `#!/bin/sh
[ "$1 $2" = "app-server generate-json-schema" ] && [ "$3" = "--out" ] || exit 64
[ -n "$FIXTURE_FAIL" ] && exit 3
mkdir -p "$4"
if [ "$5" = "--experimental" ]; then cp "$FIXTURE_SCHEMAS/experimental.json" "$4/codex_app_server_protocol.schemas.json"
else cp "$FIXTURE_SCHEMAS/stable.json" "$4/codex_app_server_protocol.schemas.json"; fi
`, { mode: 0o755 });
      const scratch = path.join(root, "tmp");
      fs.mkdirSync(scratch);
      const previousTmp = process.env.TMPDIR;
      process.env.TMPDIR = scratch;
      try {
        const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, FIXTURE_SCHEMAS: path.join(import.meta.dir, "protocol", "0.163.0") };
        expect(await generateCodexSchemas(binary, env)).toEqual(pinned("0.163.0"));
        expect((await resolveCodexProtocol("0.163.3", binary, env)).unpinned?.cliVersion).toBe("0.163.3");
        await expect(generateCodexSchemas(binary, { ...env, FIXTURE_FAIL: "1" })).rejects.toThrow("generate-json-schema failed (exit 3)");
        expect(fs.readdirSync(scratch)).toEqual([]);
      } finally {
        if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test("a generator that ignores SIGTERM is killed at the deadline, refused, and not awaited by the next launch", async () => {
    // The fixture ignores SIGTERM, as a hung CLI or a wrapper that keeps a
    // child would, and leaves a grandchild in its group. Each launch records
    // both pids so this test stops only what it started.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-schema-hang-"));
    const pidsFile = path.join(root, "pids");
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const started = () => fs.existsSync(pidsFile) ? fs.readFileSync(pidsFile, "utf8").split(/\s+/).filter(Boolean).map(Number) : [];
    try {
      const binary = path.join(root, "codex");
      fs.writeFileSync(binary, `#!/bin/sh
if [ -n "$FIXTURE_HANG" ] && [ -e "$FIXTURE_HANG" ]; then
  trap "" TERM
  sleep 30 &
  echo "$$ $!" >> "$FIXTURE_PIDS"
  wait
  exit 0
fi
mkdir -p "$4"
if [ "$5" = "--experimental" ]; then cp "$FIXTURE_SCHEMAS/experimental.json" "$4/codex_app_server_protocol.schemas.json"
else cp "$FIXTURE_SCHEMAS/stable.json" "$4/codex_app_server_protocol.schemas.json"; fi
`, { mode: 0o755 });
      const hang = path.join(root, "hang");
      fs.writeFileSync(hang, "");
      const scratch = path.join(root, "tmp");
      fs.mkdirSync(scratch);
      const previousTmp = process.env.TMPDIR;
      process.env.TMPDIR = scratch;
      try {
        const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, FIXTURE_HANG: hang, FIXTURE_PIDS: pidsFile, FIXTURE_SCHEMAS: path.join(import.meta.dir, "protocol", "0.163.0") };
        let calls = 0;
        const generate: CodexSchemaGenerator = (cli, childEnv) => { calls++; return generateCodexSchemas(cli, childEnv, { timeoutMs: 200 }); };
        const began = performance.now();
        await expect(resolveCodexProtocol("0.163.5", binary, env, generate)).rejects.toThrow("CLI 0.163.5; Supported: 0.164.0, 0.163.0, 0.162.1, 0.159.0, 0.154.0; cause: generate-json-schema failed (timed out)");
        expect(performance.now() - began).toBeLessThan(5_000);
        const hung = started();
        expect(hung).toHaveLength(2);
        const deadline = performance.now() + 2_000;
        while (hung.some(alive) && performance.now() < deadline) await Bun.sleep(20);
        expect(hung.filter(alive)).toEqual([]);
        expect(fs.readdirSync(scratch)).toEqual([]);
        // The refusal was evicted: the next launch generates afresh.
        fs.rmSync(hang);
        expect((await resolveCodexProtocol("0.163.5", binary, env, generate)).unpinned?.cliVersion).toBe("0.163.5");
        expect(calls).toBe(2);
        expect(fs.readdirSync(scratch)).toEqual([]);
      } finally {
        if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
      }
    } finally {
      for (const pid of started()) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});

test("the router dispatches a generated request to its typed handler and response codec", async () => {
  const result = await routeCodexServerRequest(new CodexPinnedProtocol(), {
    method: "item/commandExecution/requestApproval", id: "request", params: { kind: "command", startedAtMs: 1, environmentId: null, threadId: "thread", turnId: "turn", itemId: "item", command: "echo approved" },
  }, {
    "item/commandExecution/requestApproval": request => {
      expect(request.params.itemId).toBe("item");
      return { decision: "accept" };
    },
  });
  expect(result).toEqual({ decision: "accept" });
});

test("typed command/patch/permission/question codecs reject invalid responses", () => {
  const protocol = new CodexPinnedProtocol();
  for (const decision of ["accept", "acceptForSession", "decline", "cancel", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["echo"] } }, { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.invalid", action: "allow" } } }]) {
    expect(encodeCodexServerResponse(protocol, "item/commandExecution/requestApproval", { decision })).toEqual({ decision });
  }
  expect(() => encodeCodexServerResponse(protocol, "item/fileChange/requestApproval", { decision: "acceptWithExecpolicyAmendment" })).toThrow("result.decision");
  expect(encodeCodexServerResponse(protocol, "item/permissions/requestApproval", { permissions: {}, scope: "turn" })).toEqual({ permissions: {}, scope: "turn" });
  expect(encodeCodexServerResponse(protocol, "item/tool/requestUserInput", { answers: { first: { answers: ["yes"] }, second: { answers: ["no"] } } })).toEqual({ answers: { first: { answers: ["yes"] }, second: { answers: ["no"] } } });
  expect(() => encodeCodexServerResponse(protocol, "future/request", {})).toThrow("raw answers are disabled");
  for (const method of Object.keys(codexServerRequestKinds)) expect(protocol.hasMethod("ServerRequest", method)).toBe(true);
});
