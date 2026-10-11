import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import Ajv2020, { type AnySchemaObject } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import pin from "./fixtures/relay_v1/owner-tools-response-schemas.json";
import { ownerRateLimitSchema, toolCallResultSchema } from "./protocol";

const captureFile = path.join(import.meta.dir, "../../../evidence/external-relay/install_tool_loop_owner.json");
const operations = pin.operations as Record<string, AnySchemaObject | null>;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validators = Object.fromEntries(Object.entries(operations).map(([name, schema]) => [name,
  schema ? ajv.compile({ ...schema, components: pin.components }) : null,
]));

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
      const response = toolCallResultSchema.parse(attempt.response);
      expect(response.call_id, label).toBe(call.body.call_id);
      expect(response.audience, label).toBe("owner");
      expect(Object.hasOwn(operations, response.tool), label).toBe(true);
      checked++;
      if (response.status === "ok") {
        // These route pages are small complete documents. Relay fragment paging
        // remains covered by X2 and must not join different public route pages.
        const validate = validators[response.tool];
        if (validate) {
          const output = JSON.parse(response.output);
          expect(validate(output), `${label}: ${ajv.errorsText(validate.errors)}`).toBe(true);
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

test("R8 schema validation rejects the former X4 shapes and invalid nested route items", () => {
  for (const [tool, output] of [
    ["owner_list_grid_chats", [101, 102]],
    ["owner_list_grid_chats", { items: [101], next_cursor: null }],
    ["owner_list_grids", []],
    ["owner_activate_clone", []],
    ["owner_activate_clone", { bot_id: 42, status: "invalid", webhook_url: "https://hooks.example/clone" }],
  ] as const) expect(validators[tool]!(output), tool).toBe(false);
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
    const operation = Object.values(openapi.paths).flatMap(Object.values).find((op) => op.operationId === name);
    expect(operation, name).toBeDefined();
    const responses = Object.entries(operation!.responses!).filter(([status]) => status.startsWith("2"));
    const bodies = responses.flatMap(([, response]) => response.content?.["application/json"]?.schema ?? []);
    expect(bodies, name).toEqual(schema ? [schema] : []);
  }
});
