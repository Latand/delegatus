/*
 * The checks route as the evidence fixtures answer it (the kanban board's and
 * the phone's): the project default, each lane's choice and each stage's,
 * resolved the way scripts/cloud-check-settings.ts resolves them. `mode`
 * holds a read open, refuses it, or refuses every write, so the drivers can
 * frame each state the menu has.
 */
type Execution = "cloud" | "local";
export type ChecksFixtureMode = "ok" | "pending" | "refused" | "save-refused";

export function createChecksFixtureRoute(mode: ChecksFixtureMode = "ok", initial: { project?: Execution; lanes?: Record<string, Execution>; stages?: Record<string, Execution> } = {}) {
  let project: Execution = initial.project ?? "cloud";
  const lanes = new Map<string, Execution>(Object.entries(initial.lanes ?? {}));
  /* Keyed `lane stage`. */
  const stages = new Map<string, Execution>(Object.entries(initial.stages ?? {}));
  const posts: Array<{ lane: string; scope: string; execution: Execution | null; stageId?: string }> = [];
  const view = (lane: string, stage: string | null) => {
    const override = lanes.get(lane) ?? null;
    const stageOverride = stage ? stages.get(`${lane} ${stage}`) ?? null : null;
    return { project, override, ...(stage ? { stageOverride } : {}), effective: stageOverride ?? override ?? project };
  };
  return {
    posts,
    async answer(lane: string, method: string, search: URLSearchParams, body: string | null): Promise<{ status: number; body: unknown }> {
      if (method === "POST") {
        if (mode === "save-refused") return { status: 409, body: { error: "refused by the evidence fixture" } };
        const request = JSON.parse(body ?? "{}") as { scope: string; execution: Execution | null; stageId?: string };
        posts.push({ lane, ...request });
        const set = <K>(map: Map<K, Execution>, key: K) => (request.execution === null ? map.delete(key) : map.set(key, request.execution));
        if (request.scope === "project") project = request.execution ?? "cloud";
        else if (request.scope === "stage") set(stages, `${lane} ${request.stageId}`);
        else set(lanes, lane);
        return { status: 200, body: view(lane, request.stageId ?? null) };
      }
      if (mode === "pending") return new Promise(() => {});
      if (mode === "refused") return { status: 503, body: { error: "refused by the evidence fixture" } };
      return { status: 200, body: view(lane, search.get("stageId")) };
    },
  };
}
