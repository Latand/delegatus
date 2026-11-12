/* A synthetic `orchestrator-seats.json` shaped like a busy installation's:
   twelve active seats with mandates of about 29 KB and role tables of about
   2.6 KB, 384 revocations, 393 lineage entries, and fifty history entries that
   each carry a whole seat snapshot, mandate included. About 2.3 MB, like the
   record that prompted the move. Every value is invented. Standalone on
   purpose: a measurement can run it against any release of the store. */

const AT = "2026-10-01T00:00:00.000Z";
export const SYNTHETIC_SEAT_PROJECTS = 12;

function words(seed: number, bytes: number): string {
  const vocabulary = ["board", "lane", "review", "merge", "deploy", "seat", "worker", "report", "task", "role", "budget", "evidence"];
  let text = "";
  let index = seed;
  while (text.length < bytes) {
    text += `${vocabulary[index % vocabulary.length]} ${index} `;
    index = (index * 31 + 7) % 100_003;
  }
  return text.slice(0, bytes);
}

export function syntheticSeatProject(index: number): string {
  return `repo-${index.toString(16).padStart(32, "0")}`;
}

function mandate(project: number, version: number): string {
  return `Mandate for project ${project}, version ${version}.\n${words(project * 97 + version, 29_000)}`;
}

function roleTable(version: number): string {
  return `| role | engine | model |\n${words(version * 13 + 5, 2_600)}`;
}

function seat(project: number, epoch: number, options: { state: "active" | "pending"; version: number; conversation: string | null; error?: string }) {
  return {
    project: syntheticSeatProject(project),
    seatEpoch: epoch,
    conversationId: options.conversation,
    path: options.conversation ? `/fixture/seats/${options.conversation}.jsonl` : null,
    engine: "claude",
    model: "model-a",
    runtimeIdentityFrozen: true,
    mandate: mandate(project, options.version),
    roleTable: roleTable(options.version % 2),
    promptVersion: 7,
    predecessorConversationId: epoch > 1 ? `conversation_seat_${project}_${epoch - 1}` : null,
    triggeredBy: { kind: "operator", conversationId: null, seatEpoch: null },
    state: options.state,
    intent: { clientRequestId: `request-${project}-${epoch}`, mode: "spawn", launchId: `launch-${project}-${epoch}`, error: options.error ?? null },
    designatedAt: AT,
    activatedAt: options.state === "active" ? AT : null,
  };
}

/** The legacy record, ready for `JSON.stringify`. */
export function productionShapedSeatRecord(): Record<string, unknown> {
  const seats: Record<string, unknown> = {};
  for (let project = 0; project < SYNTHETIC_SEAT_PROJECTS; project += 1) {
    const epoch = 1000 + project;
    seats[syntheticSeatProject(project)] = seat(project, epoch, { state: "active", version: 3, conversation: `conversation_seat_${project}_${epoch}` });
  }
  const pending = {
    [syntheticSeatProject(1)]: seat(1, 1100, { state: "pending", version: 4, conversation: null }),
  };
  const revocations = Array.from({ length: 384 }, (_, index) => ({
    project: syntheticSeatProject(index % SYNTHETIC_SEAT_PROJECTS),
    conversationId: `conversation_retired_${index}`,
    seatEpoch: index + 1,
    revokedAt: `2026-09-${String(1 + (index % 28)).padStart(2, "0")}T00:00:00.000Z`,
    successorConversationId: `conversation_retired_${index + 1}`,
    triggeredBy: { kind: "agent", conversationId: `conversation_retired_${index}`, seatEpoch: index + 1 },
    activatedAt: AT,
    path: `/fixture/seats/${words(index, 220).replace(/[^a-z0-9]+/g, "-")}/retired-${index}.jsonl`,
    engine: "claude",
  }));
  const seatLineage = Array.from({ length: 393 }, (_, index) => ({
    project: syntheticSeatProject(index % SYNTHETIC_SEAT_PROJECTS),
    conversationId: `conversation_lineage_${index}`,
    seatEpoch: index + 1,
  }));
  /* Most failed attempts carried the mandate their project still holds; a few
     carried an older version. Each one embeds the whole text. */
  const history = Array.from({ length: 50 }, (_, index) => ({
    seat: seat(index % SYNTHETIC_SEAT_PROJECTS, 500 + index, {
      state: "pending", version: index % 10 === 0 ? 2 : 3, conversation: null, error: "the launch failed",
    }),
    reason: "terminal_error",
    terminalizedAt: AT,
  }));
  return {
    schemaVersion: 1,
    nextSeatEpoch: 1200,
    seats,
    seatLineage,
    pending,
    revocations,
    history,
    rollbacks: {
      [syntheticSeatProject(2)]: seat(2, 990, { state: "active", version: 3, conversation: "conversation_seat_2_990" }),
    },
  };
}
