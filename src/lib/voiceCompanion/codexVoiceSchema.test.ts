import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexAccountBinary } from "@/lib/accounts/codexAppServer";
import { CODEX_V3_VOICES, CODEX_VOICE, codexVoiceContext, codexVoiceStart, codexVoiceText, codexVoiceThread, codexVoiceToolResult } from "./codexProvider";
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
      ["v2/ThreadStartParams", codexVoiceThread(directory,true,"M".repeat(2400))],
      ["v2/ThreadRealtimeStartParams", codexVoiceStart("fixture", "en", "v=0\n", "Fixture", undefined,"M".repeat(2400))],
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

/** The installed Codex names the voices a V3 call accepts only in the refusal of
 * one it does not: `listVoices` answers v1 and v2 lists, and V3 validates
 * against its own set. No account is needed: the refusal comes before the
 * backend is asked. */
test.if(Bun.which(codexBinary) !== null)("the installed Codex accepts exactly the listed V3 voices, the operator's pick among them", async () => {
  expect(CODEX_V3_VOICES).toContain(CODEX_VOICE);
  expect(codexVoiceStart("fixture", "en", "v=0\n").voice).toBe(CODEX_VOICE);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "voice-list-"));
  const child = Bun.spawn([codexBinary, "-c", "cli_auth_credentials_store=file", "-c", "mcp_servers={}", "-c", "analytics.enabled=false", "--enable", "realtime_conversation", "app-server"],
    { cwd: directory, stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { PATH: process.env.PATH, HOME: directory, CODEX_HOME: directory, TMPDIR: directory } });
  try {
    type Line = { id?: number; method?: string; params?: { message?: string }; result?: { voices?: { v1: string[] }; thread?: { id: string } } };
    const received: Line[] = [];
    void (async () => {
      const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffer = "";
      for (let read = await reader.read(); !read.done; read = await reader.read()) {
        buffer += decoder.decode(read.value, { stream: true });
        for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) { received.push(JSON.parse(buffer.slice(0, at))); buffer = buffer.slice(at + 1); }
      }
    })();
    const line = async (match: (row: Line) => boolean) => {
      for (const deadline = Date.now() + 15_000; Date.now() < deadline; await Bun.sleep(10)) { const found = received.find(match); if (found) return found; }
      throw new Error("no answer from the app-server");
    };
    let next = 0;
    const request = (method: string, params: unknown) => {
      const id = ++next; child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); child.stdin.flush();
      return line(row => row.id === id);
    };
    await request("initialize", { clientInfo: { name: "agent-log-viewer", version: "0.11.7" }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const listed = await request("thread/realtime/listVoices", {});
    expect([...listed.result!.voices!.v1].sort()).toEqual([...CODEX_V3_VOICES].sort());
    const thread = await request("thread/start", { cwd: directory, ephemeral: true, approvalPolicy: "never", sandbox: "read-only" });
    await request("thread/realtime/start", { threadId: thread.result!.thread!.id, version: "v3", outputModality: "audio", transport: { type: "webrtc", sdp: "v=0\r\n" }, voice: "alloy", prompt: "fixture" });
    const refusal = String((await line(row => row.method === "thread/realtime/error")).params?.message);
    const accepted = refusal.match(/supported voices: (.*)$/)?.[1]?.split(", ") ?? [];
    expect(accepted.sort()).toEqual([...CODEX_V3_VOICES].sort());
  } finally { child.kill(); await child.exited; fs.rmSync(directory, { recursive: true, force: true }); }
}, 30000);


test("orchestrator message, action and show schemas are identical on API and Codex dynamic tools", async () => {
  const { COMPANION_TOOLS } = await import("./tools");
  const thread = codexVoiceThread("/fixture", false);
  for (const name of ["orchestrator_messages", "orchestrator_actions", "show_orchestrator_message", "list_projects"]) {
    const api = COMPANION_TOOLS.find(tool => tool.name === name)!;
    const dynamic = thread.dynamicTools.find(tool => tool.name === name)!;
    expect(dynamic.inputSchema).toEqual(api.parameters);
    expect(dynamic.description).toBe(api.description);
    expect(api.parameters.required).toEqual(Object.keys(api.parameters.properties));
    expect(api.parameters.additionalProperties).toBe(false);
  }
});
