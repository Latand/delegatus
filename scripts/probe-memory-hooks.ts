/** Live native-hook probe. Only synthetic context, isolated homes and owned hosts. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ClaudeStreamBrokerHost } from "../src/lib/runtime/claudeStreamBrokerHost";
import { CodexAppServerHost } from "../src/lib/runtime/codexAppServerHost";
import { prepareClaudeIntegrationTestHome, prepareCodexIntegrationTestHome } from "../src/lib/runtime/integrationTestHome";
import type { EngineHost } from "../src/lib/runtime/engineHost";

for (const engine of (process.argv.includes("--codex") ? ["codex"] : ["claude", "codex"]) as ("claude" | "codex")[]) {
  const home = engine === "claude" ? prepareClaudeIntegrationTestHome("claude") : prepareCodexIntegrationTestHome("codex");
  if (!home) { console.log(JSON.stringify({ engine, error: "subscription credential unavailable" })); continue; }
  let hookInput: Record<string, string> | undefined;
  let hookCalls = 0;
  let host: EngineHost | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const marker = crypto.randomBytes(12).toString("hex");
    const followupMarker = crypto.randomBytes(12).toString("hex");
    const deliveryId = crypto.randomUUID();
    const followupDeliveryId = crypto.randomUUID();
    const receipt = path.join(home.directory, "hook-ran");
    const script = path.join(home.directory, "hook.sh");
    const output = { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `${process.argv.includes("--limit") ? "Synthetic filler: " + "龘".repeat(9500) + "\n" : ""}The synthetic hook verification word is ${marker}.` } };
    fs.writeFileSync(script, `#!/bin/sh\ncat >/dev/null\ntouch '${receipt}'\nprintf '%s\\n' '${JSON.stringify(output)}'\n`, { mode: 0o700 });
    const hooks = { UserPromptSubmit: [{ hooks: [{ type: "command", command: script, additionalContextLimit: 40000 }] }] };
    const cwd = path.join(home.directory, "project");
    fs.mkdirSync(cwd);
    const env = { ...home.env, LLV_STATE_DIR: path.join(home.directory, "state") };
    if (process.argv.includes("--managed")) {
      server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
        const input = await request.json(); hookInput = input; hookCalls++;
        console.log(JSON.stringify({ engine, hookFields: Object.keys(input).sort() }));
        if (engine === "claude") console.log(JSON.stringify({ engine, exactDeliveryIdentity: input.delegatus_delivery_id === (hookCalls === 1 ? deliveryId : followupDeliveryId) }));
        if (input.hook_event_name === "UserPromptSubmit") fs.writeFileSync(receipt, "hook");
        return Response.json({ block: hookCalls > 1 && process.argv.includes("--followup")
          ? `The synthetic followup verification word is ${followupMarker}.` : output.hookSpecificOutput.additionalContext });
      } });
      Object.assign(env, { LLV_SPAWN_CAPABILITY: crypto.randomBytes(32).toString("base64url"), LLV_VIEWER_PORT: String(server.port) });
    }
    if ("claudeConfigDir" in home) {
      fs.writeFileSync(path.join(home.claudeConfigDir, "settings.json"), JSON.stringify(process.argv.includes("--managed") ? {} : { hooks }));
      host = await ClaudeStreamBrokerHost.start({ cwd, env, claudeConfigDir: home.claudeConfigDir,
        claudeProjectsDir: home.claudeProjectsDir, model: "haiku", tools: [], mcpServers: [], requestTimeoutMs: 30000 });
    } else {
      fs.writeFileSync(path.join(home.codexHome, "hooks.json"), JSON.stringify(process.argv.includes("--managed") ? {} : { hooks }));
      host = await CodexAppServerHost.start({ cwd, env, codexHome: home.codexHome,
        model: "gpt-6.1-sol", effort: "low", mcpServers: [], fileAuthCredentials: true, approvalPolicy: "never", requestTimeoutMs: 30000 });
      const result = await (host as unknown as { rpc(method: string, params: unknown): Promise<{ data: { hooks: { key: string; currentHash: string; trustStatus: string; enabled: boolean }[] }[] }> }).rpc("hooks/list", { cwds: [cwd] });
      console.log(JSON.stringify({ engine, hooks: result.data.flatMap(d => d.hooks.map(h => ({ trust: h.trustStatus, enabled: h.enabled }))) }));

    }
    const events = host.attach(0)[Symbol.asyncIterator]();
    await host.send({ id: deliveryId, text: "Reply only with the synthetic hook verification word supplied in additional context. If absent reply ABSENT. Do not call tools.", origin: { kind: "operator" } });
    if (process.argv.includes("--followup")) {
      const ack = await host.send({ id: followupDeliveryId, text: "Reply only with the synthetic followup verification word supplied for THIS message. If absent reply ABSENT. Do not call tools.", origin: { kind: "operator" } });
      console.log(JSON.stringify({ engine, followupAck: ack.outcome }));
    }
    let answer = "";
    let status = "timeout";
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const item = await Promise.race([events.next(), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.max(1, deadline-Date.now())); })]);
      clearTimeout(timer);
      if (!item || item.done) break;
      if (item.value.kind === "delta") answer += item.value.text;
      if (item.value.kind === "item") answer += JSON.stringify(item.value.item);
      if (item.value.kind === "turn-ended") {
        status = item.value.status;
        if (!process.argv.includes("--followup") || answer.includes(followupMarker)) break;
      }
    }
    const transcriptFiles = [...new Bun.Glob("**/*.jsonl").scanSync({ cwd: home.directory, absolute: true })];
    const hookId = hookInput?.prompt_id ?? hookInput?.turn_id;
    console.log(JSON.stringify({ engine, nativeHookIdInTranscript: Boolean(hookId && transcriptFiles.some(file => fs.readFileSync(file, "utf8").includes(hookId))) }));
    console.log(JSON.stringify({ engine, hookFired: fs.existsSync(receipt), contextReachedTurn: answer.includes(marker), status }));
    if (process.argv.includes("--followup")) console.log(JSON.stringify({ engine, hookCalls, followupContextReachedTurn: answer.includes(followupMarker) }));
  } catch (error) {
    console.log(JSON.stringify({ engine, error: error instanceof Error ? error.message : "probe failed" }));
  } finally { await host?.release(); server?.stop(true); home.cleanup(); }
}
