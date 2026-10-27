import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import { codexSchemaBreaks } from "./codexSchemaCompatibility";

const read = (version: string, name: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dir, "protocol", version, `${name}.json`), "utf8"));

describe("reviewed pins", () => {
  test.each(["stable", "experimental"])("0.164.0 reviews file-backed images while retaining inline results (%s)", name => {
    const previous = read("0.163.0", name), current = read("0.164.0", name);
    expect(codexSchemaBreaks(previous, current)).toEqual([
      'v2.ThreadItem.oneOf[type="imageGeneration"].result: removed',
      'v2.ThreadItem.oneOf[type="imageGeneration"].result: became optional',
      'v2.ThreadItem.oneOf[type="imageGeneration"].anyOf: added',
    ]);
    const validate = (schema: typeof current) => new Ajv({ strict: false }).compile({
      $ref: "#/definitions/v2/ThreadItem", definitions: schema.definitions,
    });
    const accepts = validate(current), old = validate(previous);
    const item = { type: "imageGeneration", id: "image-item", status: "completed" };
    expect(accepts({ ...item, fileId: "stored-image" })).toBeTrue();
    expect(accepts({ ...item, result: "inline-image" })).toBeTrue();
    expect(accepts({ ...item, result: "", fileId: "stored-image" })).toBeTrue();
    expect(accepts(item)).toBeFalse();
    expect(accepts({ ...item, fileId: 42 })).toBeFalse();
    expect(old({ ...item, fileId: "stored-image" })).toBeFalse();
  });
  test.each(["stable", "experimental"])("0.163.0 extends 0.162.1 additively (%s)", name => {
    expect(codexSchemaBreaks(read("0.162.1", name), read("0.163.0", name))).toEqual([]);
  });
  test("earlier upgrades that needed review are reported as breaks", () => {
    // 0.162.1 dropped ModelProviderCapabilitiesReadResponse.namespaceTools; 0.159.0 dropped thread/rollback.
    expect(codexSchemaBreaks(read("0.159.0", "experimental"), read("0.162.1", "experimental"))).toContain("v2.ModelProviderCapabilitiesReadResponse.namespaceTools: removed");
    expect(codexSchemaBreaks(read("0.154.0", "experimental"), read("0.159.0", "experimental"))[0]).toBe('ClientRequest.oneOf: variant method="thread/rollback" removed or changed');
    expect(codexSchemaBreaks(read("0.163.0", "experimental"), read("0.162.1", "experimental")).length).toBeGreaterThan(0);
  });
});

const method = (name: string, params: object) => ({ type: "object", required: ["method", "params"], properties: { method: { type: "string", enum: [name] }, params } });
const bundle = (overrides: { request?: object[]; server?: object[]; notification?: object[]; params?: object } = {}) => ({
  $schema: "http://json-schema.org/draft-07/schema#",
  definitions: {
    ClientRequest: { oneOf: overrides.request ?? [method("turn/start", { $ref: "#/definitions/v2/TurnStartParams" })] },
    ServerRequest: { oneOf: overrides.server ?? [method("item/commandExecution/requestApproval", { type: "object" })] },
    ServerNotification: { oneOf: overrides.notification ?? [method("turn/started", { type: "object" })] },
    v2: {
      TurnStartParams: overrides.params ?? {
        type: "object", required: ["threadId"], description: "Start a turn.",
        properties: { threadId: { type: "string" }, title: { type: ["string", "null"] }, mode: { type: "string", enum: ["a", "b"] } },
      },
    },
  },
});
const params = (patch: (row: { type: string; required: string[]; properties: Record<string, object> }) => void) => {
  const row = structuredClone(bundle().definitions.v2.TurnStartParams) as { type: string; required: string[]; properties: Record<string, object> };
  patch(row);
  return bundle({ params: row });
};

describe("synthetic changes", () => {
  test("additions are additive", () => {
    expect(codexSchemaBreaks(bundle(), bundle())).toEqual([]);
    expect(codexSchemaBreaks(bundle(), params(row => { row.properties.extra = { type: "boolean" }; }))).toEqual([]);
    expect(codexSchemaBreaks(bundle(), params(row => { row.properties.mode = { type: "string", enum: ["a", "b", "c"] }; }))).toEqual([]);
    expect(codexSchemaBreaks(bundle(), params(row => { (row as { description?: string }).description = "Reworded."; }))).toEqual([]);
    expect(codexSchemaBreaks(bundle(), bundle({ request: [method("turn/start", { $ref: "#/definitions/v2/TurnStartParams" }), method("thread/items/read", { type: "object" })] }))).toEqual([]);
    expect(codexSchemaBreaks(bundle(), bundle({ notification: [method("thread/readState/changed", { type: "object" }), method("turn/started", { type: "object" })] }))).toEqual([]);
  });

  test("narrowing, removal and new server requests break", () => {
    expect(codexSchemaBreaks(bundle(), params(row => { delete row.properties.mode; }))).toEqual(["v2.TurnStartParams.mode: removed"]);
    // A property named like an annotation keyword is still a property.
    expect(codexSchemaBreaks(bundle(), params(row => { delete row.properties.title; }))).toEqual(["v2.TurnStartParams.title: removed"]);
    expect(codexSchemaBreaks(bundle(), params(row => { row.properties.extra = { type: "boolean" }; row.required.push("extra"); }))).toEqual(["v2.TurnStartParams.extra: became required"]);
    expect(codexSchemaBreaks(bundle(), params(row => { row.required = []; }))).toEqual(["v2.TurnStartParams.threadId: became optional"]);
    expect(codexSchemaBreaks(bundle(), params(row => { row.properties.mode = { type: "string", enum: ["a"] }; }))).toEqual(["v2.TurnStartParams.mode: enum value removed"]);
    expect(codexSchemaBreaks(bundle(), params(row => { row.properties.threadId = { type: ["string", "null"] }; }))).toEqual(["v2.TurnStartParams.threadId: type changed"]);
    expect(codexSchemaBreaks(bundle(), bundle({ request: [method("turn/start", { $ref: "#/definitions/v2/Other" })] }))).toEqual(['ClientRequest.oneOf[method="turn/start"].params.$ref: changed']);
    expect(codexSchemaBreaks(bundle(), bundle({ request: [method("turn/begin", { $ref: "#/definitions/v2/TurnStartParams" })] }))).toEqual(['ClientRequest.oneOf: variant method="turn/start" removed or changed']);
    expect(codexSchemaBreaks(bundle(), bundle({ server: [method("item/commandExecution/requestApproval", { type: "object" }), method("item/future/requestApproval", { type: "object" })] })))
      .toEqual(['ServerRequest: new server request method="item/future/requestApproval"']);
    const missing = bundle() as { definitions: Record<string, unknown> };
    delete missing.definitions.ServerNotification;
    expect(codexSchemaBreaks(bundle(), missing)).toEqual(["ServerNotification: definition removed"]);
  });

  test("the report is bounded and carries paths, never schema values", () => {
    const breaks = codexSchemaBreaks(bundle(), { definitions: {} });
    expect(breaks).toHaveLength(3);
    expect(breaks.join(" ")).not.toContain("Start a turn");
  });
});

/* Delegatus decodes every incoming server request strictly against the pin
 * (unknown keys refused), so the whole closure its params reach must match. */
describe("the server-request closure", () => {
  const approval = (decision: object = { type: "string", enum: ["accept", "decline"] }, extra: Record<string, object> = {}) => ({
    $schema: "http://json-schema.org/draft-07/schema#",
    definitions: {
      ServerRequest: { oneOf: [method("item/commandExecution/requestApproval", { $ref: "#/definitions/v2/ApprovalParams" })] },
      ServerNotification: { oneOf: [method("turn/started", { $ref: "#/definitions/v2/TurnStarted" })] },
      v2: {
        ApprovalParams: { type: "object", required: ["threadId"], description: "Approve.", properties: { threadId: { type: "string" }, decisions: { type: "array", items: { $ref: "#/definitions/Decision" } }, ...extra } },
        TurnStarted: { type: "object", properties: { turnId: { type: "string" } } },
      },
      Decision: decision,
    },
  });

  test("an optional property, enum value or variant inside it is a break naming the path", () => {
    expect(codexSchemaBreaks(approval(), approval(undefined, { futureHint: { type: "string" } }))).toEqual(["v2.ApprovalParams.futureHint: added inside a server request"]);
    expect(codexSchemaBreaks(approval(), approval({ type: "string", enum: ["accept", "decline", "defer"] }))).toEqual(["Decision.enum: changed inside a server request"]);
    expect(codexSchemaBreaks(approval({ oneOf: [{ type: "string", enum: ["accept"] }] }), approval({ oneOf: [{ type: "string", enum: ["accept"] }, { type: "object" }] }))).toEqual(["Decision.oneOf: changed inside a server request"]);
  });

  test("outside it the same additions stay additive, and annotations never count", () => {
    const notification = approval() as ReturnType<typeof approval> & { definitions: { v2: { TurnStarted: { properties: Record<string, object> } } } };
    notification.definitions.v2.TurnStarted.properties.extra = { type: "boolean" };
    expect(codexSchemaBreaks(approval(), notification)).toEqual([]);
    const reworded = approval() as ReturnType<typeof approval> & { definitions: { v2: { ApprovalParams: { description: string } } } };
    reworded.definitions.v2.ApprovalParams.description = "Reworded.";
    expect(codexSchemaBreaks(approval(), reworded)).toEqual([]);
  });

  test("an optional field added to a real approval request is refused", () => {
    // The decoder rejects `futureHint` as unrecognized_keys, so Codex would hold the turn.
    const extended = read("0.162.1", "experimental");
    extended.definitions.CommandExecutionRequestApprovalParams.properties.futureHint = { type: ["string", "null"] };
    expect(codexSchemaBreaks(read("0.162.1", "experimental"), extended)).toEqual(["CommandExecutionRequestApprovalParams.futureHint: added inside a server request"]);
    // History: 0.159.0 changed McpServerElicitationRequestParams inside this closure.
    expect(codexSchemaBreaks(read("0.154.0", "experimental"), read("0.159.0", "experimental"))).toContain('McpServerElicitationRequestParams.oneOf[mode="openai/userVerification"]._meta: added inside a server request');
  });
});
