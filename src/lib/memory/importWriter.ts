import fs from "node:fs/promises";
import type { RegistryConversation } from "@/lib/agent/registry";
import type { ImportWriter } from "./importTypes";

/** A session claim in a note is evidence only when a transcript and one
 * registry conversation agree. Historical seat designations survive rotation;
 * an orchestrator stage's role name alone never makes it a designated seat. */
export function importWriterResolver(conversations: readonly Pick<RegistryConversation, "id" | "engine" | "generations" | "agentRole">[], seats: ReadonlySet<string>, stages: ReadonlySet<string>) {
  return async (session: string): Promise<ImportWriter> => {
    const matches = conversations.filter(row => row.engine === "claude" && row.generations.some(generation => generation.id === session));
    const unknown: ImportWriter = { kind: "unknown", roleId: null };
    if (matches.length !== 1) return unknown;
    const owner = matches[0];
    const generation = owner.generations.find(item => item.id === session)!;
    try { if (!(await fs.stat(generation.path)).isFile()) return unknown; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return unknown; throw error; }
    if (seats.has(owner.id)) return { kind: "seat", roleId: "orchestrator" };
    if (stages.has(owner.id)) return { kind: "stage", roleId: owner.agentRole };
    return { kind: "operator", roleId: null };
  };
}

export async function productionImportWriter() {
  const [{ agentRegistry }, { readOrchestratorSeatFileOrNull, allSeatConversationsIn }] = await Promise.all([import("@/lib/agent/registry"), import("@/lib/orchestrator/seats")]);
  const snapshot = agentRegistry().readOnlySnapshot();
  const evidence = readOrchestratorSeatFileOrNull();
  const seats = allSeatConversationsIn(evidence);
  if (!seats) throw Error("memory import writer evidence unavailable");
  return importWriterResolver(Object.values(snapshot.conversations), new Set([...seats.conversationIds, ...seats.previous.conversationIds, ...(evidence?.seatLineage ?? []).map(seat => seat.conversationId)]), new Set(Object.entries(snapshot.memberships).filter(([, memberships]) => memberships.some(member => member.kind === "pipeline")).map(([id]) => id)));
}
