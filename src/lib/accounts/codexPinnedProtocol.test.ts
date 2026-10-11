import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, test } from "bun:test";
import { CodexPinnedProtocol } from "./codexPinnedProtocol";
import { codexServerRequestKinds, encodeCodexServerResponse, routeCodexServerRequest } from "../runtime/codexServerRequests";

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
  test("the adapter's literal outgoing methods exist in every supported schema", () => {
    for (const relative of ["../runtime/codexAppServerHost.ts", "../runtime/nativeCodexQueue.ts", "../runtime/codexHistoryReader.ts", "codexAppServer.ts"]) {
      const file = path.join(import.meta.dir, relative);
      const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["rpc", "request", "notify"].includes(node.expression.name.text)) {
          const kind = node.expression.name.text === "notify" ? "ClientNotification" : "ClientRequest";
          const argument = node.arguments[0];
          const check = (arg: ts.Node) => {
            if (!ts.isStringLiteral(arg)) return;
            expect(protocol.hasMethod(kind, arg.text), `${relative}: ${arg.text}`).toBe(true);
            const params = node.arguments[1];
            if (kind === "ClientRequest" && params && ts.isObjectLiteralExpression(params)) {
              for (const property of params.properties) {
                if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
                  expect(protocol.hasRequestField(arg.text, property.name.text), `${relative}: ${arg.text} params.${property.name.text}`).toBe(true);
                }
              }
            }
          };
          if (argument) { if (ts.isConditionalExpression(argument)) { check(argument.whenTrue); check(argument.whenFalse); } else check(argument); }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  });
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
