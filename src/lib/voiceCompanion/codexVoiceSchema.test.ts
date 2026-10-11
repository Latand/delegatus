import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexAccountBinary } from "@/lib/accounts/codexAppServer";
import { codexVoiceContext, codexVoiceStart, codexVoiceText, codexVoiceThread, codexVoiceToolResult } from "./codexProvider";
import { VOICE_IMAGES } from "./boardReads";

type Schema = boolean | { $ref?: string; oneOf?: Schema[]; anyOf?: Schema[]; allOf?: Schema[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema; enum?: unknown[]; type?: string | string[]; definitions?: Record<string, Schema> };
/** Unknown properties are rejected even where serde's schema allows them:
 * silently ignored fields would otherwise make this compatibility check pass. */
function check(value: unknown, schema: Schema, root: Schema, at = "params"): void {
  if (typeof schema === "boolean") { if (!schema) throw new Error(at); return; }
  if (schema.$ref) return check(value, (root as Exclude<Schema, boolean>).definitions![schema.$ref.split("/").at(-1)!]!, root, at);
  for (const part of schema.allOf ?? []) check(value, part, root, at);
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives) {
    if (!alternatives.some(part => { try { check(value, part, root, at); return true; } catch { return false; } })) throw new Error(`${at}: no schema variant`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${at}: enum`);
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const types = typeof schema.type === "string" ? [schema.type] : schema.type;
  if (types && !types.includes(actual) && !(actual === "number" && types.includes("integer") && Number.isSafeInteger(value))) throw new Error(`${at}: type`);
  if (Array.isArray(value) && schema.items) for (const item of value) check(item, schema.items, root, `${at}[]`);
  if (value && typeof value === "object" && !Array.isArray(value) && schema.properties) {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in object)) throw new Error(`${at}.${key}: required`);
    for (const [key, item] of Object.entries(object)) {
      if (!Object.hasOwn(schema.properties, key)) throw new Error(`${at}.${key}: unsupported`);
      check(item, schema.properties[key]!, root, `${at}.${key}`);
    }
  }
}
const codexBinary = codexAccountBinary();
test.if(Bun.which(codexBinary) !== null)("the installed Codex experimental schema contains every field the voice sends", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "voice-schema-"));
  try {
    const generated = Bun.spawnSync([codexBinary, "app-server", "generate-json-schema", "--experimental", "--out", directory], { stdout: "ignore", stderr: "pipe", env: { ...process.env, CODEX_HOME: directory } });
    expect(generated.exitCode).toBe(0);
    const cases = [
      ["v1/InitializeParams", { clientInfo: { name: "agent-log-viewer", version: "0.11.7" }, capabilities: { experimentalApi: true } }],
      ["v2/GetAccountParams", {}],
      ["v2/ThreadStartParams", codexVoiceThread(directory, false)],
      ["v2/ThreadStartParams", codexVoiceThread(directory, true)],
      ["v2/ThreadRealtimeStartParams", codexVoiceStart("fixture", "en", "v=0\n", "Fixture")],
      ["v2/ThreadRealtimeStopParams", { threadId: "fixture" }],
      ["v2/ThreadRealtimeAppendSpeechParams", { threadId: "fixture", text: "The board could not be read just now." }],
      ["v2/ThreadInjectItemsParams", codexVoiceContext("fixture", "The operator views the second project.")],
      ["v2/ThreadRealtimeAppendTextParams", codexVoiceText("fixture", "The operator views the second project.")],
      ["DynamicToolCallResponse", codexVoiceToolResult({ speech: "Frame attached", [VOICE_IMAGES]: [{ mime: "image/png", data: "fixture" }] })],
      ["DynamicToolCallResponse", { contentItems: [{ type: "inputText", text: "Fixture answer" }], success: true }],
    ] as const;
    for (const [name, params] of cases) {
      const schema = JSON.parse(fs.readFileSync(path.join(directory, `${name}.json`), "utf8")) as Schema;
      expect(() => check(params, schema, schema, name)).not.toThrow();
      expect(() => check({ ...params, unsupportedVoiceField: true }, schema, schema, name)).toThrow();
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}, 15000);
