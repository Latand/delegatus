import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import { codexSchemaBreaks } from "./codexSchemaCompatibility";

const read = (version: string, name: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dir, "protocol", version, `${name}.json`), "utf8"));

describe("reviewed pins", () => {
  const validator = (schema: { definitions: object }, ref: string) => new Ajv({ strict: false }).compile({ $ref: ref, definitions: schema.definitions });

  test.each(["stable", "experimental"])("0.171.0 scopes MCP elicitations and drops the project position (%s)", name => {
    const previous = read("0.170.0", name), current = read("0.171.0", name);
    expect(codexSchemaBreaks(previous, current)).toEqual(name === "stable" ? [
      "McpServerElicitationRequestParams.environmentId: added inside a server request",
      "v2.Project.position: removed",
      "v2.Project.position: became optional",
    ] : [
      "CurrentTimeReadParams: definition removed",
      "CurrentTimeReadResponse: definition removed",
      "McpServerElicitationRequestParams.environmentId: added inside a server request",
    ]);
    const elicitation = { serverName: "docs", threadId: "thread", turnId: null, mode: "url", message: "Open", url: "https://example.invalid", elicitationId: "e" };
    const before = validator(previous, "#/definitions/McpServerElicitationRequestParams"), after = validator(current, "#/definitions/McpServerElicitationRequestParams");
    expect(before(elicitation)).toBeTrue();
    expect(after(elicitation)).toBeTrue();
    expect(after({ ...elicitation, environmentId: "remote" })).toBeTrue();
    const methods = (schema: typeof current) => schema.definitions.ServerRequest.oneOf.map((row: { properties: { method: { enum: string[] } } }) => row.properties.method.enum[0]);
    expect(methods(previous).includes("currentTime/read")).toBe(name === "experimental");
    expect(methods(current)).not.toContain("currentTime/read");
    // Every other change is additive or an annotation.
    for (const key of ["McpServerElicitationRequestParams", "ServerRequest", "CurrentTimeReadParams", "CurrentTimeReadResponse"]) {
      if (key in previous.definitions) current.definitions[key] = previous.definitions[key];
    }
    current.definitions.v2.Project = previous.definitions.v2.Project;
    expect(codexSchemaBreaks(previous, current)).toEqual([]);
  });

  test.each(["stable", "experimental"])("0.172.0 renames the saved realtime input item (%s)", name => {
    const previous = read("0.171.0", name), current = read("0.172.0", name);
    expect(codexSchemaBreaks(previous, current)).toEqual(["v2.ThreadRealtimeItem.oneOf: variant type=\"sessionEndInputSaved\" removed or changed"]);
    const before = validator(previous, "#/definitions/v2/ThreadRealtimeItemCompletedNotification");
    const after = validator(current, "#/definitions/v2/ThreadRealtimeItemCompletedNotification");
    // The only item Delegatus reads is unchanged.
    const segment = { threadId: "thread", item: { id: "segment", realtimeSessionId: "call", type: "transcriptSegment", role: "assistant", text: "Done." } };
    expect(before(segment)).toBeTrue();
    expect(after(segment)).toBeTrue();
    const saved = { id: "saved", realtimeSessionId: "call", input: "hello", input_item_id: "input", source_event_ids: ["event"] };
    expect(before({ threadId: "thread", item: { ...saved, type: "sessionEndInputSaved" } })).toBeTrue();
    expect(after({ threadId: "thread", item: { ...saved, type: "sessionEndInputSaved" } })).toBeFalse();
    expect(after({ threadId: "thread", item: { ...saved, type: "sessionInputSaved", reason: "sessionEnd" } })).toBeTrue();
    current.definitions.v2.ThreadRealtimeItem = previous.definitions.v2.ThreadRealtimeItem;
    expect(codexSchemaBreaks(previous, current)).toEqual([]);
  });

  test.each(["stable", "experimental"])("0.170.0 changes recovered answer display (%s)", name => {
    const previous = read("0.169.0", name), current = read("0.170.0", name);
    expect(codexSchemaBreaks(previous, current)).toEqual([
      "v2.AgentMessageDisplay.properties: removed",
      "v2.AgentMessageDisplay.action: became optional",
      "v2.AgentMessageDisplay: type changed",
    ]);
    const compile = (schema: typeof current) => new Ajv({ strict: false }).compile({
      $ref: "#/definitions/v2/ItemCompletedNotification", definitions: schema.definitions,
    });
    const completion = (display: object | null) => ({
      threadId: "thread", turnId: "turn", completedAtMs: 1,
      item: { type: "agentMessage", id: "answer", text: "done", moderation: { moderated: true, display } },
    });
    const before = compile(previous), after = compile(current);
    const legacy = completion({ action: "show" });
    expect(before(legacy)).toBeTrue();
    expect(after(legacy)).toBeFalse();
    expect(before(completion(null))).toBeTrue();
    expect(after(completion(null))).toBeTrue();
    for (const display of [
      { version: 1, mode: "show", trustedContacts: "skip" },
      { version: 1, mode: "hide", replacement: { kind: "wellbeingPromptHelpline" } },
      { version: 1, mode: "block", reason: { kind: "cyber" } },
    ]) {
      expect(before(completion(display))).toBeFalse();
      expect(after(completion(display))).toBeTrue();
    }
    expect(after(completion({ version: 1, mode: "show" }))).toBeFalse();
    expect(after(completion({ version: 2, mode: "show", trustedContacts: "skip" }))).toBeFalse();
    // The other changes are additive or annotations.
    current.definitions.v2.AgentMessageDisplay = previous.definitions.v2.AgentMessageDisplay;
    expect(codexSchemaBreaks(previous, current)).toEqual([]);
  });

  test.each(["stable", "experimental"])("0.168.0 extends 0.167.0 additively (%s)", name => {
    expect(codexSchemaBreaks(read("0.167.0", name), read("0.168.0", name))).toEqual([]);
  });

  for (const previous of ["0.167.0", "0.168.0"]) test.each(["stable", "experimental"])(`0.169.0 needs its own pin above ${previous} (%s)`, name => {
    const before = read(previous, name), current = read("0.169.0", name);
    expect(codexSchemaBreaks(before, current)).toEqual([
      'ClientRequest.oneOf[method="account/gatewayOAuth/read"].params: type changed',
      'ClientRequest.oneOf[method="account/gatewayOAuth/read"].params.anyOf: added',
      'ClientRequest.oneOf[method="account/gatewayOAuth/login"].params: type changed',
    ]);
    // The diagnostic is bounded to three paths. Compare each changed method
    // separately so neither the login union nor the audio change is hidden.
    for (const method of ["account/gatewayOAuth/read", "account/gatewayOAuth/login"]) {
      const isolate = (schema: typeof current) => ({ definitions: { ClientRequest: {
        oneOf: schema.definitions.ClientRequest.oneOf.filter((row: { properties: { method: { enum: string[] } } }) => row.properties.method.enum.includes(method)),
      } } });
      expect(codexSchemaBreaks(isolate(before), isolate(current))).toEqual([
        `ClientRequest.oneOf[method="${method}"].params: type changed`,
        `ClientRequest.oneOf[method="${method}"].params.anyOf: added`,
      ]);
    }
    const withoutGatewayChanges = structuredClone(current);
    withoutGatewayChanges.definitions.ClientRequest = before.definitions.ClientRequest;
    expect(codexSchemaBreaks(before, withoutGatewayChanges)).toEqual([
      'v2.FunctionCallOutputContentItem.oneOf[type="input_audio"].audio_url: removed',
      'v2.FunctionCallOutputContentItem.oneOf[type="input_audio"].audio_url: became optional',
      'v2.FunctionCallOutputContentItem.oneOf[type="input_audio"].anyOf: added',
    ]);
    const compile = (schema: typeof current) => new Ajv({ strict: false }).compile({
      $ref: "#/definitions/v2/FunctionCallOutputContentItem", definitions: schema.definitions,
    });
    const old = compile(before), accepts = compile(current);
    const url = { type: "input_audio", audio_url: "data:audio/wav;base64,AA==" };
    expect(old(url)).toBeTrue();
    expect(accepts(url)).toBeTrue();
    expect(old({ type: "input_audio", file_id: "stored-audio" })).toBeFalse();
    expect(accepts({ type: "input_audio", file_id: "stored-audio" })).toBeTrue();
    expect(accepts({ ...url, file_id: "stored-audio" })).toBeTrue();
    for (const audio of [{ type: "input_audio" }, { type: "input_audio", file_id: 7 }, { type: "input_audio", audio_url: 7 }]) expect(accepts(audio)).toBeFalse();
  });

  test.each(["stable", "experimental"])("0.167.0 human command approvals need their reviewed server-request contract (%s)", name => {
    const previous = read("0.166.0", name), current = read("0.167.0", name);
    expect(codexSchemaBreaks(previous, current)).toEqual([
      "CommandExecutionApprovalKind.enum: removed",
      "CommandExecutionApprovalKind: type changed",
      "CommandExecutionApprovalKind.oneOf: added",
    ]);
    const compile = (schema: typeof current) => new Ajv({ strict: false }).compile({
      $ref: "#/definitions/CommandExecutionApprovalKind", definitions: schema.definitions,
    });
    const before = compile(previous), after = compile(current);
    for (const kind of ["command", "writeStdin"]) {
      expect(before(kind)).toBeTrue();
      expect(after(kind)).toBeTrue();
    }
    expect(before("humanCommand")).toBeFalse();
    expect(after("humanCommand")).toBeTrue();
    expect(after("unknownCommand")).toBeFalse();
  });
  test.each(["stable", "experimental"])("0.165.0 extends 0.164.0 additively (%s)", name => {
    const previous = read("0.164.0", name), current = read("0.165.0", name);
    expect(codexSchemaBreaks(previous, current)).toEqual([]);
    const compile = (schema: typeof current, definition: string) => new Ajv({ strict: false }).compile({
      $ref: `#/definitions/v2/${definition}`, definitions: schema.definitions,
    });
    const error = compile(current, "CodexErrorInfo");
    for (const value of previous.definitions.v2.CodexErrorInfo.anyOf[0].enum) expect(error(value)).toBeTrue();
    expect(error("modelNotFound")).toBeTrue();
    const account = compile(current, "Account");
    expect(account({ type: "gcp" })).toBeTrue();
    expect(account({ type: "unknown-provider" })).toBeFalse();
    expect(compile(current, "NetworkRequirements")({ reviewDomains: ["example.test"] })).toBeTrue();
    expect(compile(current, "NetworkRequirements")({ reviewDomains: 7 })).toBeFalse();
  });
  test.each(["stable", "experimental"])("0.166.0 drops detached reviews and is reviewed under its own pin (%s)", name => {
    const previous = read("0.165.0", name), current = read("0.166.0", name);
    expect(codexSchemaBreaks(previous, current)).toEqual([
      "v2.HookRunSummary.sourcePath.$ref: changed",
      "v2.ReviewDelivery: enum value removed",
      "v2.ThreadItem: type changed",
    ]);
    const compile = (schema: typeof current, definition: string) => new Ajv({ strict: false }).compile({
      $ref: `#/definitions/v2/${definition}`, definitions: schema.definitions,
    });
    // The renamed path reference is the same string shape.
    expect(previous.definitions.v2.AbsolutePathBuf.type).toBe("string");
    expect(current.definitions.v2.LegacyAppPathString).toEqual({ type: "string" });
    // ThreadItem keeps every variant and gains optional item timestamps.
    const item = { type: "agentMessage", id: "item", text: "done" };
    for (const schema of [previous, current]) expect(compile(schema, "ThreadItem")(item)).toBeTrue();
    expect(compile(current, "ThreadItem")({ ...item, startedAtMs: 1, completedAtMs: null })).toBeTrue();
    expect(compile(current, "ThreadItem")({ ...item, startedAtMs: "soon" })).toBeFalse();
    expect(compile(current, "ThreadItem")({ type: "unknownItem", id: "item" })).toBeFalse();
    // The only narrowing: review/start no longer accepts detached delivery.
    expect(compile(previous, "ReviewDelivery")("detached")).toBeTrue();
    expect(compile(current, "ReviewDelivery")("detached")).toBeFalse();
    expect(compile(current, "ReviewDelivery")("inline")).toBeTrue();
  });
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

  test("untagged enum growth matches only an otherwise unchanged anyOf branch", () => {
    const union = "anyOf";
    const shape = (variants: object[]) => ({ definitions: { Choice: { [union]: variants } } });
    const before = shape([{ type: "string", enum: ["a", "b"] }, { type: "integer" }]);
    expect(codexSchemaBreaks(before, shape([{ type: "integer" }, { type: "string", enum: ["a", "b", "c"] }]))).toEqual([]);
    for (const candidate of [
      { type: "string", enum: ["a", "c"] },
      { type: "string", enum: ["a", "b", "c"], maxLength: 1 },
      { type: ["string", "null"], enum: ["a", "b", "c"] },
    ]) expect(codexSchemaBreaks(before, shape([candidate, { type: "integer" }]))).toEqual([
      `Choice.${union}: variant untagged removed or changed`,
    ]);
  });

  test("oneOf enum growth that overlaps another branch is refused", () => {
    const before = { oneOf: [{ type: "string", enum: ["a", "b"] }, { type: "string", enum: ["c", "d"] }] };
    const after = { oneOf: [{ type: "string", enum: ["a", "b", "c"] }, { type: "string", enum: ["c", "d"] }] };
    const ajv = new Ajv({ strict: false });
    expect(ajv.compile(before)("c")).toBeTrue();
    expect(ajv.compile(after)("c")).toBeFalse();
    expect(codexSchemaBreaks({ definitions: { Choice: before } }, { definitions: { Choice: after } })).toEqual([
      "Choice.oneOf: variant untagged removed or changed",
    ]);
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

  test.each(["oneOf", "anyOf"])("enum growth inside a server-request union stays refused (%s)", union => {
    const before = approval({ [union]: [{ type: "string", enum: ["accept", "decline"] }] });
    const after = approval({ [union]: [{ type: "string", enum: ["accept", "decline", "defer"] }] });
    expect(codexSchemaBreaks(before, after)).toEqual([union === "anyOf"
      ? "Decision.anyOf[0].enum: changed inside a server request"
      : "Decision.oneOf: variant untagged removed or changed"]);
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
