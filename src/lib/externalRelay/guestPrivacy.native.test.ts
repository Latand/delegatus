import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountManager } from "@/lib/accounts/manager";
import * as ephemeral from "@/lib/agent/ephemeral";
import { setCodexFeatureReaderForTest } from "@/lib/agent/codexSpawnPolicy";
import { runClaimedRequest } from "./runner";
import { requestSchema } from "./protocol";
import { updateRelayStore, newTargetSettings, readRunLedger, type PairedRelay } from "./store";
import { startTestRelay } from "./testRelay";
import { readAnswerRecord, relayAnswersRoot } from "./answers";
import { readConversations } from "./conversations";

// Uses the installed native CLI against a local synthetic Responses provider.
// The same opt-in as the native answer-profile probes; never calls a real model.
const nativeTest = process.env.LLV_ANSWER_PROFILE_PROBE === "1" && Bun.which("codex") ? test : test.skip;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "guest-native-privacy-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const files = (directory: string) => fs.existsSync(directory)
  ? [...new Bun.Glob("**/*").scanSync({ cwd: directory, absolute: true, dot: true, onlyFiles: true })] : [];

for (const ending of ["success", "failure", "cancellation"] as const)
  nativeTest(`real guest runner confines native trace and persistence after ${ending}`, async () => {
    fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
    const restoreFeatures = setCodexFeatureReaderForTest(undefined);
    const work = path.join(root, ending), home = path.join(work, "account");
    fs.mkdirSync(home, { recursive: true });
    const trace = path.join(home, "trace"), sqlite = path.join(home, "sqlite");
    const request = requestSchema.parse(JSON.parse(fs.readFileSync(
      path.join(import.meta.dir, "fixtures/relay_v1/claimed_guest_owner.json"), "utf8")).request);
    const markers = ["PRIVATE_NATIVE_BUSINESS_CANARY", "PRIVATE_NATIVE_HISTORY_CANARY", "PRIVATE_NATIVE_MEDIA_CANARY"];
    request.input.short_term_memory = markers[0]!;
    const trigger = request.input.conversation.find(message => message.id === request.input.respond_to)!;
    request.input.conversation.unshift({ ...trigger, id: "private_history", text: markers[1]!, reply_to: null,
      author: { key: "customer", name: "Customer", self: false },
      media: [{ ref: markers[2]!, kind: "photo", availability: "missing" }] });
    request.features = ["requester_context", "relay_media_in"];
    fs.writeFileSync(path.join(home, "auth.json"), "{}");
    fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [{
      slug: "fixture", display_name: "Fixture", description: null, base_instructions: "Return the synthetic answer.",
      supported_reasoning_levels: [], shell_type: "shell_command", visibility: "list", supported_in_api: true,
      priority: 0, availability_nux: null, upgrade: null, support_verbosity: false, default_verbosity: null,
      experimental_supported_tools: [], tool_mode: "direct", truncation_policy: { mode: "tokens", limit: 10000 },
      context_window: 32000, prefer_websockets: false,
    }] }));
    let ready!: (run: ephemeral.EphemeralAgentRun) => void;
    const launched = new Promise<ephemeral.EphemeralAgentRun>(resolve => { ready = resolve; });
    const original = ephemeral.runEphemeralAgent;
    const launch = spyOn(ephemeral, "runEphemeralAgent").mockImplementation(async input => {
      const run = await original(input); ready(run); return run;
    });
    let modelCalls = 0;
    const contexts: string[] = [];
    const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      contexts.push(await req.text()); modelCalls++;
      if (modelCalls === 1 && ending === "cancellation") (await launched).cancel();
      if (modelCalls === 1 && ending === "failure") return Response.json({ error: { message: "Synthetic refusal" } }, { status: 400 });
      const item = { type: "message", id: "fixture-message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: JSON.stringify({ action: "reply", text: "Done.", reply_to: null }), annotations: [] }] };
      const events = [{ type: "response.created", response: { id: "fixture-response" } },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "fixture-response", status: "completed", output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } });
    } });
    const command = path.join(work, "native-provider"), capture = path.join(work, "native-config.json");
    const extra = ["-c", "model_provider=fixture", "-c",
      `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${model.port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`,
      "--disable", "enable_request_compression", "-c", "analytics.enabled=false"];
    fs.writeFileSync(command, `#!${process.execPath}
require("fs").writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ home: process.env.CODEX_HOME }));
const child = Bun.spawn([${JSON.stringify(Bun.which("codex"))}, ...process.argv.slice(2), ...${JSON.stringify(extra)}],
  { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });
process.exit(await child.exited);`);
    fs.chmodSync(command, 0o700);
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_ROLLOUT_TRACE_ROOT: trace, CODEX_SQLITE_HOME: sqlite,
      HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1,localhost",
      http_proxy: "http://127.0.0.1:1", https_proxy: "http://127.0.0.1:1", all_proxy: "http://127.0.0.1:1", no_proxy: "127.0.0.1,localhost" };
    for (const key of ["OPENAI_API_KEY", "OPENAI_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "RUST_LOG"]) delete env[key];
    const selected = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available",
      account: { engine: "codex", accountId: "fixture", kind: "managed", home, transcriptRoot: home, env } });
    const service = await startTestRelay(() => ({ body: { status: "ok" } }));
    const relay: PairedRelay = { id: "native_fixture", origin: service.origin, api_base: service.origin + "/v1", name: "Fixture", description: "",
      credential: "x".repeat(43), owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null },
      pairedAt: "2026-10-06T12:00:00Z", paused: false, features: ["progress_steps"],
      limits: { max_wait_s: 25, max_response_bytes: 1048576, max_answer_chars: 4000 }, targets: [{
        ...newTargetSettings({ target_id: request.target_id, name: "Fixture", answered_by: "install", fallback: "service" }),
        engine: "codex", model: "fixture", ownerTier: true, memberLimitPerHour: null,
      }] };
    updateRelayStore(store => ({ ...store, relays: [relay] }));
    const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-06T12:00:01Z"));
    try {
      const result = await runClaimedRequest(relay, request, undefined, { leaseWorker: false, command });
      expect(result?.outcome).toBe(ending === "success" ? "answered" : "failed");
      if (ending === "cancellation") expect(result).toMatchObject({ reason: "cancelled" });
      expect(modelCalls).toBe(1);
      for (const marker of markers) expect(contexts[0]).toContain(marker);
      const native = JSON.parse(fs.readFileSync(capture, "utf8"));
      expect(fs.existsSync(path.dirname(native.home))).toBe(false);
      expect(readRunLedger().runs).toEqual([]);
      expect(readConversations()).toEqual([]);
      const record = readAnswerRecord(relay.id, request.target_id, request.request_id)!;
      expect(record.conversationId).toBeUndefined();
      for (const marker of markers) expect(JSON.stringify(record.input)).toContain(marker);
      // Check every marker independently, including binary stores. Only the
      // request's answer record may retain context once native cleanup ends.
      const retained = [...files(home), ...files(process.env.LLV_STATE_DIR!)].filter(file =>
        markers.some(marker => fs.readFileSync(file).includes(Buffer.from(marker))));
      expect(retained).toHaveLength(1);
      expect(retained[0]!.startsWith(relayAnswersRoot() + path.sep)).toBe(true);
      expect(fs.existsSync(trace)).toBe(false);
      expect(fs.existsSync(sqlite)).toBe(false);
      const follow = structuredClone(request);
      follow.request_id = "native_follow_up";
      follow.input.short_term_memory = null;
      follow.input.conversation = [{ ...trigger, id: "follow_up", text: "Follow up", reply_to: null }];
      follow.input.respond_to = "follow_up"; follow.input.request_text = "Follow up";
      expect((await runClaimedRequest(relay, follow, undefined, { leaseWorker: false, command }))?.outcome).toBe("answered");
      expect(modelCalls).toBe(2);
      for (const marker of markers) expect(contexts[1]).not.toContain(marker);
      const next = JSON.parse(fs.readFileSync(capture, "utf8"));
      expect(next.home).not.toBe(native.home);
      expect(fs.existsSync(path.dirname(next.home))).toBe(false);
    } finally {
      clock.mockRestore(); selected.mockRestore(); launch.mockRestore(); restoreFeatures();
      await service.close(); model.stop(true);
    }
  }, 30_000);
