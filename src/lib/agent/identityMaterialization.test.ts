import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { identityMaterializationFence } from "./identityMaterialization";
import { normalizeRegistry } from "./registry";
import { buildRegistryPerformanceDataset, scaledRegistryPerformanceShape } from "./registryPerformanceDataset";
import { SqliteAgentRegistryStore } from "./sqliteRegistryStore";

test("indexed materialization keeps staged paths private and holds its snapshot across foreign writes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "materialization-snapshot-"));
  const stores: SqliteAgentRegistryStore[] = [];
  try {
    const dataset = buildRegistryPerformanceDataset(directory, scaledRegistryPerformanceShape(0.05));
    const open = () => {
      const store = new SqliteAgentRegistryStore(dataset.filename, { normalize: normalizeRegistry,
        initialSnapshot: () => { throw new Error("dataset must already exist"); } });
      stores.push(store);
      return store;
    };
    const writer = open();
    const reader = open();
    const launchId = writer.read(file => Object.keys(file.receipts).find(key => {
      const receipt = file.receipts[key]!;
      return receipt.key && file.conversations[receipt.conversationId]
        && file.entries[`${receipt.key.engine}:${receipt.key.sessionId}`];
    })!);
    const { result: staged } = writer.mutate(file => {
      const receipt = file.receipts[launchId]!;
      receipt.state = "path-pending";
      receipt.transport = "structured";
      receipt.artifactPath = "/fixture/staged.jsonl";
      receipt.purpose = "launch";
      const conversation = file.conversations[receipt.conversationId]!;
      const generation = conversation.generations.at(-1)!;
      conversation.generations = [{ ...generation, path: "/fixture/readable.jsonl" }, { ...generation, path: receipt.artifactPath }];
      file.conversationAliases.conversation_alias = conversation.id;
      return { conversationId: conversation.id, path: receipt.artifactPath };
    }, false);
    const held = reader.readOnlySnapshot().file;
    const heldFence = identityMaterializationFence(held);
    expect(heldFence.allowsReceipt(held.receipts[launchId]!)).toBe(false);
    // The first path read happens after the writer moves the indexed receipt.
    writer.mutate(file => { file.receipts[launchId]!.artifactPath = "/fixture/moved.jsonl"; }, false);
    expect(heldFence.allowsPath(staged.path)).toBe(false);
    expect(heldFence.pathForConversation("conversation_alias")).toBe("/fixture/readable.jsonl");
    expect(identityMaterializationFence(reader.readOnlySnapshot().file).allowsPath(staged.path)).toBe(true);

    writer.mutate(file => {
      const receipt = file.receipts[launchId]!;
      receipt.artifactPath = staged.path;
      receipt.purpose = "resume-successor";
      receipt.resumeSourcePath = staged.path;
    }, false);
    const resumed = reader.readOnlySnapshot().file;
    const resumedFence = identityMaterializationFence(resumed);
    expect(resumedFence.allowsReceipt(resumed.receipts[launchId]!)).toBe(false);
    expect(resumedFence.allowsPath(staged.path)).toBe(true);
    expect(resumedFence.pathForConversation(staged.conversationId)).toBe(staged.path);

    writer.mutate(file => {
      const receipt = file.receipts[launchId]!;
      receipt.transport = null;
      receipt.purpose = "launch";
      receipt.state = "failed";
      const entry = file.entries[`${receipt.key!.engine}:${receipt.key!.sessionId}`]!;
      entry.structuredHost = null;
      entry.structuredHostOperationId = launchId;
    }, false);
    const failed = reader.readOnlySnapshot().file;
    expect(identityMaterializationFence(failed).allowsPath(staged.path)).toBe(false);
    writer.mutate(file => { file.receipts[launchId]!.state = "completed"; }, false);
    expect(identityMaterializationFence(reader.readOnlySnapshot().file).allowsPath(staged.path)).toBe(true);
    expect(identityMaterializationFence(failed).allowsPath(staged.path)).toBe(false);
  } finally {
    for (const store of stores) store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
