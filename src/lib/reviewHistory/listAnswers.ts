import type { Flow } from "./types";

const firstLine = (value: string, max = 160) => value.split("\n", 1)[0]!.slice(0, max);

export function compactFlow(flow: Flow) {
  return {
    id: flow.id, project: flow.project, state: flow.state, revision: flow.revision ?? 0,
    createdAt: flow.createdAt, closedAt: flow.closedAt, mode: flow.mode,
    title: firstLine(flow.spec ?? ""), specLength: flow.spec?.length ?? 0,
    stateDetail: flow.stateDetail ? firstLine(flow.stateDetail) : null,
    stateDetailLength: flow.stateDetail?.length ?? 0,
    roundCount: flow.rounds?.length ?? 0, roundLimit: flow.roundLimit,
  };
}

