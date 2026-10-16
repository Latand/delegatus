import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { codexSchemaBreaks } from "./codexSchemaCompatibility";

const read = (version: string, name: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dir, "protocol", version, `${name}.json`), "utf8"));

describe("reviewed pins", () => {
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
