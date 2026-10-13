import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";

import { normalizeRegistry, type RegistryFile } from "./registry";
import { buildRegistryPerformanceDataset, scaledRegistryPerformanceShape } from "./registryPerformanceDataset";
import { SqliteAgentRegistryStore } from "./sqliteRegistryStore";

const directories: string[] = [];
const stores: SqliteAgentRegistryStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(local: boolean) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "registry-refresh-"));
  directories.push(directory);
  const dataset = buildRegistryPerformanceDataset(directory, scaledRegistryPerformanceShape(0.05));
  const open = () => {
    const store = new SqliteAgentRegistryStore(dataset.filename, {
      normalize: normalizeRegistry,
      initialSnapshot: () => { throw new Error("the dataset must already exist"); },
    });
    stores.push(store);
    return store;
  };
  const reader = open();
  const writer = local ? reader : open();
  const judge = open();
  const initial = judge.snapshot().file;
  const subject = dataset.grantSubjects.find(({ collection, key, servers }) => {
    const receipt = initial.receipts[key];
    return collection === "receipts" && servers.includes("telegram") && receipt?.parentConversationId
      && receipt.key && dataset.activeEntryKeys.includes(`${receipt.key.engine}:${receipt.key.sessionId}`)
      && initial.lineageEdges[receipt.conversationId];
  });
  expect(subject).toBeDefined();
  const receipt = structuredClone(initial.receipts[subject!.key]!);
  const child = receipt.conversationId;
  const parent = receipt.parentConversationId!;
  const entry = `${receipt.key!.engine}:${receipt.key!.sessionId}`;
  const unrelated = dataset.grantSubjects.find(({ collection, key }) => collection === "receipts"
    && initial.receipts[key]!.parentConversationId !== parent && initial.receipts[key]!.conversationId !== parent
    && initial.conversations[initial.receipts[key]!.conversationId])!;
  expect(unrelated).toBeDefined();
  const unrelatedConversation = initial.receipts[unrelated.key]!.conversationId;
  let decisions = 0;
  const observed = reader as unknown as { decideStoredRow: (...args: unknown[]) => unknown };
  const decide = observed.decideStoredRow.bind(reader);
  observed.decideStoredRow = (...args) => { decisions += 1; return decide(...args); };
  const grants = (file: RegistryFile) => ({
    entry: file.entries[entry]!.launchProfile!.mcpServers,
    receipt: file.receipts[receipt.launchId]!.launchProfile.mcpServers,
    conversation: file.conversations[child]!.generations[0]!.launchProfile.mcpServers,
  });
  const held = reader.readOnlySnapshot().file;
  expect(grants(held)).toEqual({ entry: ["viewer", "telegram"], receipt: ["viewer", "telegram"], conversation: ["viewer", "telegram"] });
  let sequence = 0;
  const mixedWrite = (edit: (file: RegistryFile) => void) => writer.mutate((file) => {
    // The same refresh must observe this receipt and every attestor edit.
    file.receipts[unrelated.key]!.clientAttemptId = `mixed-refresh-${++sequence}`;
    edit(file);
  }, false);
  const refresh = () => {
    decisions = 0;
    const view = reader.readOnlySnapshot().file;
    const count = decisions;
    expect(grants(view)).toEqual(grants(judge.snapshot().file));
    expect(view.receipts[unrelated.key]!.clientAttemptId).toBe(`mixed-refresh-${sequence}`);
    // An old view keeps the decision it pinned, including after revocation.
    expect(grants(held)).toEqual({ entry: ["viewer", "telegram"], receipt: ["viewer", "telegram"], conversation: ["viewer", "telegram"] });
    return { ...grants(view), count };
  };
  return { reader, initial, receipt, child, parent, unrelatedConversation, mixedWrite, refresh };
}

for (const local of [false, true]) {
  const mode = local ? "same connection" : "another connection";

  test(`${mode}: one refresh of mixed conversation and receipt writes leaves unrelated grants alone`, () => {
    const { reader, child, mixedWrite, refresh } = fixture(local);
    for (const updatedAt of ["2026-10-13T00:00:01.000Z", "2026-10-13T00:00:02.000Z"]) {
      mixedWrite((file) => { file.conversations[child]!.updatedAt = updatedAt; });
      const result = refresh();
      expect(result.entry).toEqual(["viewer", "telegram"]);
      expect(reader.readOnlySnapshot().file.conversations[child]!.updatedAt).toBe(updatedAt);
      // Bound the work to the two changed rows and their dependants.
      expect(result.count).toBeLessThanOrEqual(9);
    }
  });

  test(`${mode}: mixed writes revoke and restore grants in the first refresh, including absent and contradictory attestors`, () => {
    const { initial, receipt, child, parent, unrelatedConversation, mixedWrite, refresh } = fixture(local);
    const allowed = ["viewer", "telegram"];
    const denied = ["viewer"];

    mixedWrite((file) => { delete file.conversations[parent]; });
    expect(refresh()).toMatchObject({ entry: denied, receipt: denied, conversation: denied });
    mixedWrite((file) => { file.conversations[parent] = structuredClone(initial.conversations[parent]!); });
    expect(refresh()).toMatchObject({ entry: allowed, receipt: allowed, conversation: allowed });

    // This new row was absent when the dependency set was recorded. Its
    // generation identity contradicts both the entry and the launch receipt.
    const forged = structuredClone(initial.conversations[child]!);
    forged.id = "conversation_refresh-contradiction" as typeof forged.id;
    forged.agentRole = "orchestrator";
    forged.delegationDepth = 0;
    forged.generations[0]!.launchProfile.parentConversationId = null;
    forged.generations[0]!.launchProfile.mcpServers = denied;
    mixedWrite((file) => { file.conversations[forged.id] = structuredClone(forged); });
    expect(refresh()).toMatchObject({ entry: denied, receipt: denied, conversation: allowed });
    mixedWrite((file) => { delete file.conversations[forged.id]; });
    expect(refresh()).toMatchObject({ entry: allowed, receipt: allowed, conversation: allowed });

    // Receipt authority changes reach the entry and conversation in the same
    // refresh as an unrelated conversation write. Restamping the parent here
    // would also invalidate the child and hide missing receipt dependencies.
    mixedWrite((file) => {
      file.receipts[receipt.launchId]!.telegramSeatGrant = false;
      file.conversations[unrelatedConversation]!.updatedAt = "2026-10-13T00:00:03.000Z";
    });
    expect(refresh()).toMatchObject({ entry: denied, receipt: denied, conversation: denied });
    mixedWrite((file) => {
      file.receipts[receipt.launchId] = structuredClone(receipt);
      file.conversations[unrelatedConversation]!.updatedAt = "2026-10-13T00:00:04.000Z";
    });
    expect(refresh()).toMatchObject({ entry: allowed, receipt: allowed, conversation: allowed });

    mixedWrite((file) => { delete file.lineageEdges[child]; });
    expect(refresh()).toMatchObject({ entry: denied, receipt: denied, conversation: denied });
    mixedWrite((file) => { file.lineageEdges[child] = structuredClone(initial.lineageEdges[child]!); });
    expect(refresh()).toMatchObject({ entry: allowed, receipt: allowed, conversation: allowed });
  });
}
