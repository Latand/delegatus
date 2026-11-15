import { AgentRegistry } from "@/lib/agent/registry";
import { RuntimeJournal } from "@/runtime-host/journal";
import { runtimeJournalClient } from "@/lib/runtime/startupRecipient.fixture";
import { revokeMember } from "../members";
import { teamStore } from "../store";
import path from "node:path";
import assert from "node:assert/strict";
import { assertMemberLaunchAllowed } from "../memberLaunchAuthority";

const [mode, memberId, cut, now] = process.argv.slice(2);
const store = teamStore();
if (["adoption-exec-crash", "adoption-active-exec-crash", "adoption-preparing-crash"].includes(mode!)) {
  const { adoptClaudeRegistryHosts, adoptCodexRegistryHosts } = await import("@/lib/runtime/registry");
  const { spawnManagedEngine } = await import("@/lib/runtime/agentSignalSandbox");
  const { captureProcessIdentity } = await import("@/lib/processIdentity");
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "agent-registry.json"));
  if (mode === "adoption-preparing-crash") {
    const begin = registry.beginStructuredHostAdoption.bind(registry);
    registry.beginStructuredHostAdoption = (...args) => {
      begin(...args);
      console.log(JSON.stringify(registry.spawnReceipt(args[0])));
      process.exit(71);
    };
  }
  const adopt = cut === "codex" ? adoptCodexRegistryHosts : adoptClaudeRegistryHosts;
  await adopt(registry, () => ({ cwd: process.env.LLV_STATE_DIR!, env: process.env }),
    { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" }, () => true, undefined, {
      adoptHost: async (_id, options) => {
        options.assertCurrent?.();
        const child = await spawnManagedEngine(process.execPath, ["--no-env-file", "-e", "console.log('ready'); setInterval(() => {}, 1000)"],
          { cwd: options.cwd, env: options.env, detached: true }, null, undefined, process.env, undefined, options.assertCurrent);
        await new Promise<void>(resolve => child.stdout.once("data", () => resolve()));
        if (mode === "adoption-exec-crash") revokeMember(store, store.owner()!, store.member(memberId!)!);
        console.log(JSON.stringify(mode === "adoption-exec-crash" ? captureProcessIdentity(child.pid!) : registry.spawnReceiptForHost({ engine: cut === "codex" ? "codex" : "claude", sessionId: _id })));
        process.exit(71);
      },
    });
} else if (mode === "setup-crash" || mode === "setup-exec-crash") {
  const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "agent-registry.json"));
  const begun = beginLegacySpawnFixture(registry, { engine: "claude", cwd: process.env.LLV_STATE_DIR!, transport: "structured", ownStartingActuation: true,
    launchProfile: { workspace: { memberId: memberId!, workspaceId: "workspace-a" } } });
  if (begun.kind !== "created" || !begun.receipt.admissionOwner) throw Error("admission failed");
  registry.beginStructuredHostSetup(begun.receipt.launchId, begun.receipt.admissionOwner, 1_900_000_000_000);
  if (mode === "setup-exec-crash") {
    const { withStructuredSetupCustody } = await import("@/lib/runtime/structuredSetupCustody");
    const { spawnManagedEngine } = await import("@/lib/runtime/agentSignalSandbox");
    const owner = begun.receipt.admissionOwner;
    const child = await withStructuredSetupCustody({
      beforeExec: () => registry.recordStructuredHostSetup(begun.receipt.launchId, owner),
      record: native => registry.recordStructuredHostSetup(begun.receipt.launchId, owner, native),
    }, () => spawnManagedEngine(process.execPath, ["--no-env-file", "-e", "console.log('ready'); setInterval(() => {}, 1000)"],
      { cwd: process.env.LLV_STATE_DIR, env: process.env, detached: true }, null));
    await new Promise<void>(resolve => child.stdout.once("data", () => resolve()));
    console.log(JSON.stringify(registry.spawnReceipt(begun.receipt.launchId)));
    process.exit(71);
  }
  console.log(begun.receipt.launchId);
  registry.close();
} else if (mode === "revoke") {
  revokeMember(store, store.owner()!, store.member(memberId!)!);
} else if (mode === "authority") {
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "agent-registry.json"));
  assert.throws(() => assertMemberLaunchAllowed(registry.spawnReceipt(cut!)!, store), /member access revoked/);
  assertMemberLaunchAllowed(registry.spawnReceipt(now!)!, store);
  registry.close();
} else {
  const { reconcileMemberRevocations } = await import("../memberRevocation");
  const root = process.env.LLV_STATE_DIR!;
  const registry = new AgentRegistry(path.join(root, "agent-registry.json"));
  const journal = new RuntimeJournal(path.join(root, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeJournalClient(journal);
  const releaseSetup = registry.releaseStructuredSpawnAdmissionOwner.bind(registry);
  registry.releaseStructuredSpawnAdmissionOwner = (...args) => {
    const result = releaseSetup(...args);
    if (cut === "after-setup-release" && result.released && result.receipt.hostSetup) process.exit(71);
    return result;
  };
  const save = store.saveRevocationTarget.bind(store);
  store.saveRevocationTarget = target => {
    save(target);
    if (cut === "after-host-target" && target.kind === "host"
      || cut === "after-launch-target" && target.kind === "launch" && target.state === "gone"
      || cut === "after-retry-target" && target.stopAttempt === 1) process.exit(71);
  };
  const command = client.command.bind(client);
  client.command = async input => {
    if (cut === "before-interrupt" && input.kind === "interrupt") process.exit(71);
    const result = await command(input);
    if (cut === "after-interrupt" && input.kind === "interrupt" || cut === "after-kill" && input.kind === "kill") process.exit(71);
    return result;
  };
  await reconcileMemberRevocations({ store, registry, client, now: () => Number(now), assertActive: () => {} });
  journal.close();
  registry.close();
}
store.close();
