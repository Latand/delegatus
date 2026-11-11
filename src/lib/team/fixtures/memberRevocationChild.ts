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
if (mode === "revoke") {
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
