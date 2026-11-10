import type { SnapshotRequestV1, ViewerSnapshotV1 } from "./types";

/** Siblings were the agents hosted in terminal panes of the caller's working
    directory. No release hosts an agent in a pane any more, so a caller that
    names itself is answered `unmatched` with no agents, which is what every
    structured host already received. */
export async function resolveSiblings(caller: SnapshotRequestV1["caller"]): Promise<ViewerSnapshotV1["siblings"]> {
  return { selfResolution: caller ? "unmatched" : "omitted", agents: [] };
}
