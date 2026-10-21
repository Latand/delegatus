import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHeadlessClaudeOnce } from "./claudeHeadless";
import { headlessRuns } from "./headless";
import type { AccountContext } from "@/lib/accounts/contracts";
import { agentRegistry, AgentRegistry } from "./registry";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(body: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-json-test-")); roots.push(root);
  const binary = path.join(root, "cli");
  fs.writeFileSync(binary, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  const home = path.join(root, "account"); fs.mkdirSync(home);
  const env = { ...process.env };
  for (const [name, value] of [["ANTHROPIC_API_KEY", "ambient-fixture"], ["ANTHROPIC_BASE_URL", "https://example.invalid"], ["LLV_STATE_OWNER", "viewer"], ["LLV_TOKEN", "private-fixture"]]) env[name] = value;
  const account: AccountContext = { engine: "claude", accountId: "fixture", kind: "managed", home, transcriptRoot: path.join(home, "projects"),
    env };
  return { root, binary, account };
}
test("real owned launch disables tools, customizations and MCP, pins model and schema, and isolates state", async () => {
  const f = fixture(`let prompt = ""; for await (const chunk of process.stdin) prompt += chunk;
console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,structured_output:{args:process.argv.slice(2),prompt,env:{state:process.env.LLV_STATE_DIR,config:process.env.XDG_CONFIG_HOME,account:process.env.CLAUDE_CONFIG_DIR,owner:process.env.LLV_STATE_OWNER,key:process.env.ANTHROPIC_API_KEY,url:process.env.ANTHROPIC_BASE_URL,token:process.env.LLV_TOKEN,max:process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS}}}));`);
  const wholeStore = spyOn(agentRegistry(), "readOnlySnapshot").mockImplementation(() => { throw Error("retained registry history must not be read for a headless launch"); });
  try {
    const result = await runHeadlessClaudeOnce({ account: f.account, prompt: "Fixture only", schema: { type: "object" }, model: "claude-opus-5-5", maxTokens: 4096, timeoutMs: 3000, runtime: { command: f.binary } });
    expect(result.status).toBe("done");
    const answer = result.records[0].structured_output as { args: string[]; prompt: string; env: Record<string, string> };
    expect(answer.prompt).toBe("Fixture only");
    for (const [flag, value] of [["--tools", ""], ["--model", "claude-opus-5-5"], ["--effort", "low"], ["--mcp-config", '{"mcpServers":{}}'], ["--setting-sources", ""], ["--json-schema", '{"type":"object"}']]) expect(answer.args[answer.args.indexOf(flag) + 1]).toBe(value);
    expect(answer.args).toContain("--safe-mode"); expect(answer.args).toContain("--strict-mcp-config");
    expect(answer.env.account).toBe(f.account.home); expect(answer.env.state).not.toBe(process.env.LLV_STATE_DIR);
    for (const name of ["key", "url", "owner", "token"]) expect(answer.env[name]).toBeUndefined();
    expect(answer.env.max).toBe("4096"); expect(headlessRuns.size).toBe(0);
  } finally { wholeStore.mockRestore(); }
}, 15000);
test("headless memory count includes every active structured status and excludes retained history", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "headless-count-test-")); roots.push(root);
  const registry = new AgentRegistry(path.join(root, "registry.json"), () => false, undefined, { sqliteMode: "sqlite" });
  const host = { kind: "claude-broker" as const, endpoint: "stdio:fixture", process: null, eventCursor: 0,
    protocolVersion: null, writerClaimEpoch: 0, activeTurnRef: null, pendingAttention: [], activeFlags: [] };
  try {
    for (const status of ["starting", "live", "idle", "handoff", "unhosted", "dead"] as const) registry.upsert({
      key: { engine: "claude", sessionId: status }, artifactPath: path.join(root, `${status}.jsonl`), cwd: root, accountId: null,
      status, host: null, structuredHost: host, claimEpoch: 0, claimOwner: null, pendingAction: null,
    });
    for (let index = 0; index < 128; index++) registry.upsert({
      key: { engine: "claude", sessionId: `retained-${index}` }, artifactPath: path.join(root, `retained-${index}.jsonl`), cwd: root, accountId: null,
      status: "dead", host: null, structuredHost: host, claimEpoch: 0, claimOwner: null, pendingAction: null,
    });
    registry.upsert({ key: { engine: "claude", sessionId: "legacy-host" }, artifactPath: path.join(root, "legacy.jsonl"), cwd: root, accountId: null,
      status: "live", host: null, structuredHost: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
    const wholeStore = spyOn(registry, "readOnlySnapshot").mockImplementation(() => { throw Error("full snapshot refused"); });
    try { expect(registry.liveStructuredHostCount()).toBe(4); } finally { wholeStore.mockRestore(); }
  } finally { registry.close(); }
}, 15000);
test("nonzero exit outranks a complete answer", async () => {
  const f = fixture('console.log(JSON.stringify({type:"result",subtype:"success",structured_output:{ok:true}})); process.exit(1);');
  expect(await runHeadlessClaudeOnce({ account: f.account, prompt: "Fixture", timeoutMs: 3000, runtime: { command: f.binary } })).toEqual({ status: "failed", records: [] });
}, 15000);
test("deadline joins the owned process before returning and discards its answer", async () => {
  const f = fixture('console.log(JSON.stringify({type:"result",subtype:"success",structured_output:{ok:true}})); setInterval(()=>{},1000);');
  expect(await runHeadlessClaudeOnce({ account: f.account, prompt: "Fixture", timeoutMs: 300, runtime: { command: f.binary } })).toEqual({ status: "timeout", records: [] });
  expect(headlessRuns.size).toBe(0);
}, 15000);
test("authority lost after async preparation refuses the launch", async () => {
  const f = fixture('throw Error("must never run")');
  expect(await runHeadlessClaudeOnce({ account: f.account, prompt: "Fixture", timeoutMs: 3000, authorized: () => false, runtime: { command: f.binary } })).toEqual({ status: "failed", records: [] });
});
test.skipIf(process.platform !== "linux")("the independent deadline survives owner death and a replacement process", async () => {
  const markerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-deadline-test-")); roots.push(markerRoot);
  const marker = path.join(markerRoot, "ready");
  const f = fixture(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(()=>{},1000);`);
  const modulePath = fileURLToPath(new URL("./claudeHeadless.ts", import.meta.url));
  const transport = fileURLToPath(new URL("../runtime/agentSignalSandbox.ts", import.meta.url));
  const code = `import { spawn } from "node:child_process"; const {setHeadlessSpawnForTests}=await import(${JSON.stringify(transport)}); setHeadlessSpawnForTests(spawn); const {runHeadlessClaudeOnce}=await import(${JSON.stringify(modulePath)}); const keep=setInterval(()=>{},1000); await runHeadlessClaudeOnce({account:{...${JSON.stringify({ ...f.account, env: undefined })},env:process.env},prompt:"Fixture",timeoutMs:2000,runtime:{command:${JSON.stringify(f.binary)}}}); clearInterval(keep);`;
  const owner = Bun.spawn([process.execPath, "-e", code], { env: { ...process.env }, stdout: "ignore", stderr: "pipe" });
  let cliPid = 0;
  try {
    const readyBy = performance.now() + 5000;
    while (!fs.existsSync(marker) && performance.now() < readyBy) await Bun.sleep(25);
    expect(fs.existsSync(marker)).toBe(true); cliPid = Number(fs.readFileSync(marker, "utf8"));
    owner.kill("SIGKILL"); await owner.exited;
    // A replacement owner does not inherit or reset the old worker's deadline.
    const next = fixture('console.log(JSON.stringify({type:"result",subtype:"success",structured_output:{ok:true}}));');
    const restart = code.replace(JSON.stringify(f.binary), JSON.stringify(next.binary))
      .replace("await runHeadlessClaudeOnce(", "const completed = await runHeadlessClaudeOnce(")
      .replace("clearInterval(keep);", 'clearInterval(keep); if (completed.status !== "done") process.exit(1);');
    const replacement = Bun.spawn([process.execPath, "-e", restart], { env: { ...process.env }, stdout: "ignore", stderr: "pipe" });
    expect(await replacement.exited).toBe(0);
    const goneBy = performance.now() + 5000;
    const alive = () => { try { return !fs.readFileSync(`/proc/${cliPid}/stat`, "utf8").split(") ")[1]?.startsWith("Z"); } catch { return false; } };
    while (alive() && performance.now() < goneBy) await Bun.sleep(25);
    expect(alive()).toBe(false);
  } finally {
    if (owner.exitCode === null) { owner.kill("SIGKILL"); await owner.exited; }
    // The watchdog owns its child; this test never signals an unrecorded PID.
  }
}, 15000);
