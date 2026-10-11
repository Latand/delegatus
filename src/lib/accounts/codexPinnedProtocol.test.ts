import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, test } from "bun:test";
import { CodexPinnedProtocol } from "./codexPinnedProtocol";
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

describe.each(["0.154.0", "0.159.0", "0.162.1"])("pinned Codex %s", version => {
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
              // Conditional turn/start vs turn/steer carries expectedTurnId
              // only on the steer branch. Actual wire builders are validated
              // at runtime; this source check admits fields from either branch.
              expect(outgoingMethods.some(method => protocol.hasRequestField(method, field)),
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
  expect(() => new CodexPinnedProtocol("0.999.0")).toThrow("has no pinned schema");
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
