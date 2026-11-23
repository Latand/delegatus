import { expect, test } from "bun:test";
import path from "node:path";
import { AgentRegistry } from "@/lib/agent/registry";
import { claudeStartupHostOptions } from "./startup";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { CodexAppServerHost } from "./codexAppServerHost";
import { installCodexHostFixture, MemoryEventStore, FakeAppServer, fakeSpawn } from "./codexAppServerHost.fixture";
import { claudeStructuredHostOptions } from "./structuredSpawn";

installCodexHostFixture(() => {});

for (const resumed of [false, true]) for (const handoffOnly of [false, true]) {
  test(`Codex owner handoff excludes native execution on ${resumed ? "resume" : "start"} with restriction=${handoffOnly}`, async () => {
    const server = new FakeAppServer("owner-handoff-thread");
    const captured: { args?: string[] } = {};
    const options = { cwd: "/repo", cleanMemory: true, ownerRelayHandoffOnly: handoffOnly,
      eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server, captured) };
    const host = resumed ? await CodexAppServerHost.adopt("owner-handoff-thread", options) : await CodexAppServerHost.start(options);
    try {
      const params = server.requests.find(row => row.method === (resumed ? "thread/resume" : "thread/start"))!.params as { config: { features: Record<string, unknown> } };
      for (const feature of ["shell_tool", "shell_snapshot", "unified_exec", "unified_exec_tty", "experimental_use_unified_exec_tool", "image_generation", "computer_use"]) {
        expect(captured.args!.includes(`features.${feature}=false`)).toBe(handoffOnly);
        expect(params.config.features[feature]).toBe(handoffOnly ? false : undefined);
      }
    } finally { await host.release(); }
  });
}

for (const handoffOnly of [false, true]) {
  test(`Claude owner handoff restricts native tools with restriction=${handoffOnly}`, async () => {
    const home = process.env.HOME!;
    const profile = emptyLaunchProfile({ cwd: home, cleanMemory: true, ownerRelayHandoffOnly: handoffOnly });
    const options = await claudeStructuredHostOptions({ spec: { engine: "claude", command: "claude", windowName: "owner-handoff", cwd: home, launchProfile: profile },
      account: { engine: "claude", accountId: "fixture", kind: "managed", home, transcriptRoot: home, env: {} } },
    { env: process.env, host: {} });
    expect(options.tools).toEqual(handoffOnly ? ["Read"] : undefined);
  });
}

for (const handoffOnly of [false, true]) {
  test(`Claude startup retains the owner handoff tool restriction=${handoffOnly}`, async () => {
    const home = process.env.HOME!;
    const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "handoff-registry.json"), undefined, undefined, { sqliteMode: "off" });
    registry.upsert({ key: { engine: "claude", sessionId: "owner-handoff" }, artifactPath: path.join(home, "handoff.jsonl"), cwd: home,
      accountId: null, launchProfile: emptyLaunchProfile({ cwd: home, cleanMemory: true, permissionMode: "never", ownerRelayHandoffOnly: handoffOnly }),
      status: "dead", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
    try {
      const entry = registry.readOnlySnapshot().entries["claude:owner-handoff"]!;
      const options = await claudeStartupHostOptions(entry, null, null, process.env);
      try { expect(options.tools).toEqual(handoffOnly ? ["Read"] : undefined); }
      finally { options.releaseCleanup?.(); }
    } finally { registry.close(); }
  });
}
