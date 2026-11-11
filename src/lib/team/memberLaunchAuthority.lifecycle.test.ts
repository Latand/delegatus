import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry } from "@/lib/agent/registry";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { RuntimeJournal } from "@/runtime-host/journal";
import { runtimeJournalClient } from "@/lib/runtime/startupRecipient.fixture";
import { spawnStructuredConversation } from "@/lib/runtime/structuredSpawn";
import type { SpawnedStructuredHost } from "@/lib/runtime/structuredSpawn";
import { FakeEngineHost } from "@/lib/runtime/fixtures/fakeEngineHost";
import { claimInstall, createInvite, redeemJoin, restoreMember, revokeMember } from "./members";
import { resetTeamStoreForTests, teamStore } from "./store";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const release of cleanup.splice(0).reverse()) release(); });

for (const when of ["before-admission", "during-admission", "during-host-start", "after-restore"] as const) test(`member launch authority is read at the native boundary: ${when}`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "launch-revocation-"));
  const previous = process.env.LLV_STATE_DIR;
  cleanup.push(() => { resetTeamStoreForTests(); if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });
  process.env.LLV_STATE_DIR = root;
  resetTeamStoreForTests();
  const store = teamStore();
  const device = { surface: "desktop" as const, browser: "chrome" as const };
  const owner = claimInstall(store, "Owner", device).member;
  const person = redeemJoin(store, createInvite(store, owner, null).code, "Member A", device).member;
  const registry = new AgentRegistry(path.join(root, "registry.json"));
  cleanup.push(() => registry.close());
  const begun = beginLegacySpawnFixture(registry, { engine: "claude", cwd: root, transport: "structured", launchProfile: { workspace: { memberId: person.id, workspaceId: "workspace-a" } } });
  if (begun.kind !== "created") throw Error("fixture admission failed");
  const journal = new RuntimeJournal(path.join(root, "runtime.sqlite"), { structuredHosts: true });
  cleanup.push(() => journal.close());
  const client = runtimeJournalClient(journal);
  const command = client.command.bind(client);
  let starts = 0;
  if (when === "during-admission") client.command = async input => {
    const result = await command(input);
    if (input.kind === "spawn") revokeMember(store, owner, person);
    return result;
  };
  else if (when !== "during-host-start") {
    revokeMember(store, owner, person);
    if (when === "after-restore") restoreMember(store, owner, store.member(person.id)!);
  }
  let released = false;
  const run = (receipt = begun.receipt) => spawnStructuredConversation({ registry, client, receipt, engine: "claude", prompt: "Continue",
    account: { engine: "claude", accountId: "subscription-a", kind: "legacy", home: root, transcriptRoot: root, env: { NODE_ENV: "test" } },
    spec: { engine: "claude", command: "claude", cwd: root, windowName: "launch", launchProfile: receipt.launchProfile },
  }, { startHost: async () => {
    starts++;
    if (when === "during-host-start") {
      revokeMember(store, owner, person);
      const host = new FakeEngineHost();
      host.release = async () => { released = true; };
      return host as unknown as SpawnedStructuredHost;
    }
    throw Error("native start reached");
  } });
  await expect(run()).rejects.toThrow("member access revoked");
  expect(starts).toBe(when === "during-host-start" ? 1 : 0);
  if (when === "during-host-start") expect(released).toBe(true);
  if (when === "after-restore") {
    const fresh = beginLegacySpawnFixture(registry, { engine: "claude", cwd: root, transport: "structured", launchProfile: begun.receipt.launchProfile });
    if (fresh.kind !== "created") throw Error("fresh admission failed");
    await expect(run(fresh.receipt)).rejects.toThrow("native start reached");
    expect(starts).toBe(1);
  }
});
