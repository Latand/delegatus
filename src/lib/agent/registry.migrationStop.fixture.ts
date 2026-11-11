import fs from "node:fs";
import path from "node:path";

import { AgentRegistry, type RegistryFile } from "./registry";

/*
 * A registry shaped like the one a stale account migration was stopped on
 * (docs/design/viewer-stalls-root-cause.md, section 4.1): one engine with many
 * conversations, most of them on an account that is not the migration target,
 * many settled deliveries, and one draining intent that owns a handful of
 * conversations. Every identity is generated from an index and every database
 * is a private temporary file.
 */

export interface MigrationStopFixtureShape {
  /** Conversations of the migrating engine that are not on the target account. */
  sourceConversations: number;
  /** Conversations of the migrating engine already on the target account. */
  targetConversations: number;
  /** Conversations of another engine; a stop must never touch them. */
  otherEngineConversations: number;
  /** Settled deliveries spread over the source conversations. */
  deliveredDeliveries: number;
  /** How many of the source conversations a launch pinned to their account. */
  pinnedSourceConversations?: number;
}

export interface MigrationStopFixture {
  filename: string;
  sqliteFilename: string;
  intentId: string;
  intentRevision: number;
  /** The intent's last progress; a hygiene pass run five minutes later stops it. */
  intentUpdatedAt: string;
  /** Owned by the intent and still waiting: the stop rolls each back. */
  requested: Array<{ conversationId: string; heldDeliveryId: string }>;
  /** Owned by the intent and already committed: the stop leaves the migration as it is. */
  committedConversationId: string;
  /** Ids of the bulk rows, for keyed assertions. */
  sourceConversationIds: string[];
  targetConversationIds: string[];
  otherEngineConversationIds: string[];
  /** The first source conversations, pinned to the source account. */
  pinnedConversationIds: string[];
}

const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const id = (index: number) => `conversation_${uuid(index)}` as RegistryFile["conversations"][string]["id"];
export const MIGRATION_STOP_TARGET = "account-target";
export const MIGRATION_STOP_SOURCE = "account-source";

/** The production fixture of section 4.1: 14 000 conversations on one engine and 27 000 deliveries. */
export const MIGRATION_STOP_INCIDENT_SHAPE: MigrationStopFixtureShape = Object.freeze({
  sourceConversations: 13_400,
  targetConversations: 600,
  otherEngineConversations: 400,
  deliveredDeliveries: 27_000,
});

/**
 * Builds the registry through the real store: a seed registry makes the intent,
 * its owned conversations and their held deliveries through the public
 * methods, the bulk rows are copies of rows that seed wrote, and the result is
 * imported by a registry opened the way a release opens it.
 */
export function buildMigrationStopFixture(directory: string, shape: MigrationStopFixtureShape): MigrationStopFixture {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const seedPath = path.join(directory, "seed.json");
  const seed = new AgentRegistry(seedPath, undefined, undefined, { sqliteMode: "off" });
  const sessionPath = (index: number) => `/sessions/${uuid(index)}.jsonl`;
  /* Indexes 0 to 3 are the conversations the intent owns; 4 is the bulk template. */
  const owned = [0, 1, 2, 3].map(index => seed.ensureConversation("codex", sessionPath(index), MIGRATION_STOP_SOURCE));
  const held = owned.slice(0, 3).map((conversation, index) =>
    seed.holdDelivery(conversation.id, `held message ${index}`, `held-client-${index}`));
  const intent = seed.commitMigrationIntent({
    engine: "codex",
    targetId: MIGRATION_STOP_TARGET,
    origin: "manual",
    requestId: "migration-stop-fixture",
    expectedRevision: seed.engineRouting("codex").revision,
    scope: "all",
  });
  const template = seed.ensureConversation("codex", sessionPath(4), MIGRATION_STOP_SOURCE);
  const other = seed.ensureConversation("claude", "/sessions/other-engine-template.jsonl", "claude-account");
  const settled = seed.holdDelivery(template.id, "settled message", "settled-client");
  const file = seed.snapshot();
  seed.close();
  fs.rmSync(seedPath, { force: true });

  if (file.migrationIntents[intent.id]?.state !== "draining") throw new Error("the fixture intent must be draining");
  /* The fourth owned conversation reached its target: a committed migration
     stays with the intent and a stop does not reopen it. */
  const committed = file.conversations[owned[3]!.id]!;
  committed.migration = { ...committed.migration!, phase: "committed" };
  committed.generations.at(-1)!.accountId = MIGRATION_STOP_TARGET;

  const bulkTemplate = file.conversations[template.id]!;
  const otherTemplate = file.conversations[other.id]!;
  const deliveryTemplate = file.heldDeliveries[settled.id]!;
  const ownerTemplate = file.deliveryOperationOwners[deliveryTemplate.command.operationId]!;
  delete file.conversations[template.id];
  delete file.conversations[other.id];
  delete file.heldDeliveries[settled.id];
  delete file.deliveryOperationOwners[deliveryTemplate.command.operationId];

  const clone = (index: number, source: typeof bulkTemplate, accountId: string, engine: string) => {
    const conversation = structuredClone(source);
    conversation.id = id(index);
    const generation = conversation.generations.at(-1)!;
    generation.id = uuid(index);
    generation.path = `/sessions/${engine}-${uuid(index)}.jsonl`;
    generation.accountId = accountId;
    file.conversations[conversation.id] = conversation;
    return conversation.id;
  };
  let next = 100;
  const sourceConversationIds = Array.from({ length: shape.sourceConversations }, () => clone(next++, bulkTemplate, MIGRATION_STOP_SOURCE, "codex"));
  const pinnedConversationIds = sourceConversationIds.slice(0, shape.pinnedSourceConversations ?? 0);
  for (const pinned of pinnedConversationIds) file.conversations[pinned]!.pinnedAccountId = MIGRATION_STOP_SOURCE;
  const targetConversationIds = Array.from({ length: shape.targetConversations }, () => clone(next++, bulkTemplate, MIGRATION_STOP_TARGET, "codex"));
  const otherEngineConversationIds = Array.from({ length: shape.otherEngineConversations }, () => clone(next++, otherTemplate, "claude-account", "claude"));
  for (let index = 0; index < shape.deliveredDeliveries; index++) {
    const deliveryId = `fixture-delivery-${index}`;
    const operationId = `fixture-operation-${index}`;
    file.heldDeliveries[deliveryId] = {
      ...structuredClone(deliveryTemplate),
      id: deliveryId,
      conversationId: sourceConversationIds[index % Math.max(1, sourceConversationIds.length)]! as typeof deliveryTemplate.conversationId,
      clientMessageId: `fixture-client-${index}`,
      command: { ...structuredClone(deliveryTemplate.command), operationId },
      state: "delivered",
      deliveredAt: deliveryTemplate.createdAt,
    };
    file.deliveryOperationOwners[operationId] = { ...structuredClone(ownerTemplate), deliveryId, terminalState: "delivered" };
  }

  const filename = path.join(directory, "registry.json");
  fs.writeFileSync(filename, JSON.stringify(file), { mode: 0o600 });
  const imported = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  const stored = imported.readOnlySnapshot();
  const storedIntent = stored.migrationIntents[intent.id]!;
  const fixture: MigrationStopFixture = {
    filename,
    sqliteFilename: path.join(directory, "registry.sqlite"),
    intentId: intent.id,
    intentRevision: storedIntent.revision,
    intentUpdatedAt: [storedIntent.updatedAt, ...owned.map(conversation => stored.conversations[conversation.id]!.migration!.updatedAt)].sort().at(-1)!,
    requested: owned.slice(0, 3).map((conversation, index) => ({ conversationId: conversation.id, heldDeliveryId: held[index]!.id })),
    committedConversationId: committed.id,
    sourceConversationIds,
    targetConversationIds,
    otherEngineConversationIds,
    pinnedConversationIds,
  };
  imported.close();
  return fixture;
}

/** Every stored row and meta value, keyed and ordered, for a row-for-row comparison of two stops. */
export function registryRowsForComparison(filename: string): Record<string, unknown> {
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  try {
    const file = registry.snapshot() as unknown as Record<string, unknown>;
    return Object.fromEntries(Object.keys(file).sort().map(key => [key, file[key]]));
  } finally {
    registry.close();
  }
}
