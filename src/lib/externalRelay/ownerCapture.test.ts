import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AnySchemaObject } from "ajv";
import pin from "./fixtures/relay_v1/owner-tools-response-schemas.json";
import { ownerRateLimitSchema, toolCallResultSchema } from "./protocol";
import { assertOwnerCaptureResponse, ownerCaptureOperations as operations } from "./ownerCapture.fixture";

const captureFile = path.join(import.meta.dir, "../../../evidence/external-relay/install_tool_loop_owner.json");

type CaptureCall = { body: { call_id: string; tool?: string; arguments?: Record<string, unknown>; cursor?: string };
  attempts: { response?: unknown; status?: number; body?: unknown }[] };
type Capture = { calls: CaptureCall[]; actions: { name: string; calls: CaptureCall[] }[] };
const capture = (): Capture => JSON.parse(fs.readFileSync(captureFile, "utf8"));

test("X4 committed owner responses validate against R8 public OpenAPI schemas", () => {
  const wire = capture();
  const runs = [{ name: "reads", calls: wire.calls }, ...wire.actions];
  let checked = 0;
  for (const run of runs) for (const [callIndex, call] of run.calls.entries()) {
    for (const [attemptIndex, attempt] of call.attempts.entries()) {
      const label = `${run.name}.calls[${callIndex}].attempts[${attemptIndex}]`;
      if (!attempt.response) {
        if (attempt.status === 429) ownerRateLimitSchema.parse(attempt.body);
        else {
          expect(attempt.status, label).toBe(409);
          expect(attempt.body, label).toEqual({ error: { code: "lease_lost", message: "lease lost" } });
        }
        continue;
      }
      const response = assertOwnerCaptureResponse(attempt.response);
      expect(response.call_id, label).toBe(call.body.call_id);
      expect(response.audience, label).toBe("owner");
      expect(Object.hasOwn(operations, response.tool), label).toBe(true);
      checked++;
      if (response.status === "ok") {
        // These route pages are small complete documents. Relay fragment paging
        // remains covered by X2 and must not join different public route pages.
        if (operations[response.tool]) {
          const output = JSON.parse(response.output);
          expect(response.output, label).toBe(JSON.stringify(output));
        } else expect(response.output, label).toBe(""); // 204 No Content
        expect(response.truncated, label).toBe(false);
        expect(response.cursor, label).toBeUndefined();
      } else if (response.status === "error") {
        const error = JSON.parse(response.output);
        expect(error).toEqual({ http_status: 404, message: "Grid not found" });
      } else {
        expect(["pending", "confirmation_pending"], label).toContain(response.status);
        expect(response.output, label).toBe("");
      }
    }
  }
  expect(checked).toBe(11);
});

test("the X4 generator guard rejects the former shapes, invalid nested items and nonempty 204", () => {
  for (const [tool, output] of [
    ["owner_list_grid_chats", [101, 102]],
    ["owner_list_grid_chats", { items: [101], next_cursor: null }],
    ["owner_list_grids", []],
    ["owner_activate_clone", []],
    ["owner_activate_clone", { bot_id: 42, status: "invalid", webhook_url: "https://hooks.example/clone" }],
    ["owner_attach_grid_chats", []],
    ["owner_new_operation", {}],
  ] as const) expect(() => assertOwnerCaptureResponse({
    call_id: "c".repeat(43), tool, status: "ok", output: JSON.stringify(output),
    truncated: false, effect: tool.startsWith("owner_list") ? "read" : "action",
    delivered: false, replayed: false, calls_remaining: 15, audience: "owner",
  }), tool).toThrow();
  const valid = { call_id: "c".repeat(43), tool: "owner_list_grids", status: "ok", output: '{"items":[]}',
    truncated: false, effect: "read", delivered: false, replayed: false, calls_remaining: 15, audience: "owner" };
  expect(() => assertOwnerCaptureResponse(valid)).not.toThrow();
  for (const changed of [{ audience: "admin" }, { effect: "action" }, { truncated: true, cursor: "p".repeat(43) }])
    expect(() => assertOwnerCaptureResponse({ ...valid, ...changed })).toThrow();
});

test("X4 grid route pages follow output.next_cursor and keep their JSON documents separate", () => {
  const calls = capture().calls;
  expect(calls).toHaveLength(2);
  const first = toolCallResultSchema.parse(calls[0]!.attempts.at(-1)!.response);
  const second = toolCallResultSchema.parse(calls[1]!.attempts.at(-1)!.response);
  const pageOne = JSON.parse(first.output);
  const pageTwo = JSON.parse(second.output);
  expect(pageOne.next_cursor).toBeString();
  expect(calls[1]!.body.tool).toBe("owner_list_grid_chats");
  expect(calls[1]!.body.arguments?.cursor).toBe(pageOne.next_cursor);
  expect(calls[1]!.body.cursor).toBeUndefined();
  expect(pageTwo.next_cursor).toBeNull();
  expect([...pageOne.items, ...pageTwo.items].map((item: { chat_id: number }) => item.chat_id)).toEqual([101, 102]);
});

test("X4 response schema pin agrees with an external Celestia OpenAPI document when supplied", () => {
  // CI uses the committed public schema closure. A cross-repository check
  // supplies a read-only export with LLV_CELESTIA_OPENAPI_FILE.
  const source = process.env.LLV_CELESTIA_OPENAPI_FILE;
  if (!source) return;
  const openapi = JSON.parse(fs.readFileSync(source, "utf8")) as {
    components: { schemas: Record<string, AnySchemaObject> };
    paths: Record<string, Record<string, { operationId?: string;
      responses?: Record<string, { content?: Record<string, { schema: AnySchemaObject }> }> }>>;
  };
  for (const [name, schema] of Object.entries(pin.components.schemas)) {
    expect(openapi.components.schemas[name], name).toEqual(schema);
  }
  for (const [name, schema] of Object.entries(operations)) {
    const operation = Object.values(openapi.paths).flatMap((methods) => Object.values(methods)).find((op) => op.operationId === name);
    expect(operation, name).toBeDefined();
    const responses = Object.entries(operation!.responses!).filter(([status]) => status.startsWith("2"));
    const bodies = responses.flatMap(([, response]) => response.content?.["application/json"]?.schema ?? []);
    expect(bodies, name).toEqual(schema ? [schema] : []);
  }
});
