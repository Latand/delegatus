import { AsyncLocalStorage } from "node:async_hooks";
import { pipelineAttemptMayBeWorking } from "./hostRetirement";
import type { Pipeline, PipelineStageHostRef } from "./types";
import type { PipelineAttemptReference } from "@/lib/state/pipelineControllerReferences";

type CloseBudget = { used: number; cancellations: number };
type Scope = { closes: Map<string, CloseBudget>; keys: readonly string[]; attempts?: ReadonlySet<string>; references?: ReadonlyMap<string, readonly PipelineAttemptReference[]> };
const host = globalThis as typeof globalThis & { __llvPipelineControllerScope?: AsyncLocalStorage<Scope> };
const scope = host.__llvPipelineControllerScope ??= new AsyncLocalStorage<Scope>();
export const controllerPipelineKeys = () => scope.getStore()?.keys;
export const controllerAttemptSelected = (pipeline: string, stage: string, attempt: number) =>
  !scope.getStore()?.attempts || scope.getStore()!.attempts!.has(JSON.stringify([pipeline, stage, attempt]));
export function controllerCloseBudget(id: string): CloseBudget | undefined {
  const current = scope.getStore();
  if (!current?.references) return undefined;
  let budget = current.closes.get(id);
  if (!budget) { budget = { used: 0, cancellations: 0 }; current.closes.set(id,budget); }
  return budget;
}
export const controllerReferences = (id: string) => scope.getStore()?.references?.get(id);

type GuardIndex = { activation: Set<number>; survivor: Set<number>; membership: Set<string>; settled: Set<string>; working: Map<string, number[]> };
type HostIdentity = Pick<PipelineStageHostRef, "conversationId" | "agentPath" | "paneId">;
const hostKeys = (host: HostIdentity) => [["conversation", host.conversationId], ["path", host.agentPath], ["pane", host.paneId]]
  .filter(([, value]) => value).map(key => JSON.stringify(key));
const guardHost = globalThis as typeof globalThis & { __llvPipelineGuardIndexes?: WeakMap<Pipeline, GuardIndex> };
const guardIndexes = guardHost.__llvPipelineGuardIndexes ??= new WeakMap<Pipeline, GuardIndex>();
/** Built once per immutable decoded revision, outside ordinary warmed phases. */
export function indexControllerGuards(pipeline: Pipeline): void {
  if (guardIndexes.has(pipeline)) return;
  const index: GuardIndex = { activation: new Set(), survivor: new Set(), membership: new Set(), settled: new Set(pipeline.terminalReap?.settledAttempts), working: new Map() };
  pipeline.runs.forEach((run, r) => run.attempts.forEach((attempt, a) => {
    const position = r * 4294967296 + a + 1;
    if (attempt.activation) index.activation.add(position);
    if (attempt.unresolvedTermination) index.survivor.add(position);
    if (pipelineAttemptMayBeWorking(attempt)) for (const key of hostKeys(attempt)) {
      const positions = index.working.get(key);
      if (positions) positions.push(position); else index.working.set(key, [position]);
    }
    if (attempt.conversationId) index.membership.add(JSON.stringify(["conversation",attempt.conversationId]));
    if (attempt.launchId) {
      index.membership.add(JSON.stringify(["launch",false,attempt.launchId]));
      if (!attempt.conversationId) index.membership.add(JSON.stringify(["launch",true,attempt.launchId]));
    }
    if (attempt.agentPath) for (const noConversation of [false,true]) for (const noLaunch of [false,true]) {
      if ((!noConversation || !attempt.conversationId) && (!noLaunch || !attempt.launchId)) {
        index.membership.add(JSON.stringify(["path",noConversation,noLaunch,attempt.agentPath]));
      }
    }
  }));
  guardIndexes.set(pipeline, index);
}
export function controllerSettledAttempt(pipeline: Pipeline, key: string): boolean | undefined {
  if (!controllerReferences(pipeline.id)) return undefined;
  indexControllerGuards(pipeline);
  return guardIndexes.get(pipeline)!.settled.has(key);
}
export function inheritControllerGuards(source: Pipeline, copy: Pipeline): void {
  indexControllerGuards(source);
  guardIndexes.set(copy, guardIndexes.get(source)!);
}
/** Off-window custody refuses progress until its fair window inspects it.
 * Selected mutable attempts are checked directly, including new evidence. */
export function controllerOffWindowGuard(pipeline: Pipeline, kind: "activation" | "survivor"): boolean {
  const refs = controllerReferences(pipeline.id);
  if (!refs) return false;
  indexControllerGuards(pipeline);
  const positions = guardIndexes.get(pipeline)![kind];
  let selected = 0;
  for (const ref of refs) if (positions.has(ref.position)) selected++;
  return positions.size > selected;
}
/** An off-window round sharing this conversation, path or pane may still own
 * a turn. Selected attempts are mutable in this tick and are checked directly. */
export function controllerOffWindowWorkingHost(pipeline: Pipeline, host: HostIdentity): boolean | undefined {
  const refs = controllerReferences(pipeline.id);
  if (!refs) return undefined;
  indexControllerGuards(pipeline);
  const working = guardIndexes.get(pipeline)!.working;
  const selected = new Set(refs.map(ref => ref.position));
  return hostKeys(host).some(key => working.get(key)?.some(position => !selected.has(position)));
}
/** The same conversation → launch → legacy path precedence as task membership. */
export function controllerAssignmentAttached(pipeline: Pipeline, assignment: { conversationId?: string | null; launchId?: string | null; path: string | null }): boolean | undefined {
  if (!controllerReferences(pipeline.id)) return undefined;
  indexControllerGuards(pipeline);
  const keys = guardIndexes.get(pipeline)!.membership;
  return Boolean(assignment.conversationId && keys.has(JSON.stringify(["conversation",assignment.conversationId])))
    || Boolean(assignment.launchId && keys.has(JSON.stringify(["launch",Boolean(assignment.conversationId),assignment.launchId])))
    || keys.has(JSON.stringify(["path",Boolean(assignment.conversationId),Boolean(assignment.launchId),assignment.path]));
}
export function controllerRuns(pipeline: Pipeline): Pipeline["runs"] {
  const refs = scope.getStore()?.references?.get(pipeline.id);
  if (!refs) return pipeline.runs;
  const runs: Pipeline["runs"] = [];
  for (const ref of refs) {
    const run = pipeline.runs[ref.run], attempt = run?.attempts[ref.attempt];
    if (run?.stageId !== ref.stageId || attempt?.n !== ref.n) continue;
    let selected = runs.find(item => item.stageId === ref.stageId);
    if (!selected) { selected = { ...run, attempts: [] }; runs.push(selected); }
    selected.attempts.push(attempt);
  }
  return runs;
}

/** Ordinary progression can change the selected attempts or append a new
 * tail. Compare those obligations and run headers without serializing the
 * retained history. Unscoped callers retain the complete comparison. */
export function controllerTickFingerprint(pipeline: Pipeline): string {
  const refs = controllerReferences(pipeline.id);
  if (!refs) return JSON.stringify(pipeline);
  return JSON.stringify({ ...pipeline,
    runs: pipeline.runs.map((run, index) => {
      const selected = refs.filter(ref => ref.run === index).map(ref => ref.attempt);
      const tail = run.attempts.length - 1;
      if (tail >= 0 && !selected.includes(tail)) selected.push(tail);
      return { ...run, attemptCount: run.attempts.length, attempts: selected.map(at => run.attempts[at]) };
    }),
    terminalReap: pipeline.terminalReap ? { ...pipeline.terminalReap,
      settledAttempts: { length: pipeline.terminalReap.settledAttempts?.length,
        selected: refs.map(ref => controllerSettledAttempt(pipeline, `${ref.stageId}:${ref.n}`)) } } : undefined,
  });
}

export function withControllerPipelineScope<T>(keys: readonly string[], run: () => Promise<T>, attempts?: ReadonlySet<string>, references?: Scope["references"]): Promise<T> {
  const parent = scope.getStore();
  // Jobs are async descendants of the selected pass. Retain its exact window
  // when narrowing to a lane; unrelated/global work still starts unscoped.
  if (!references && parent?.references && keys.every(key => parent.keys.includes(key))) {
    references = new Map(keys.flatMap(key => {
      const refs = parent.references!.get(key);
      return refs ? [[key, refs] as const] : [];
    }));
    attempts ??= parent.attempts;
  }
  return scope.run({ keys, attempts, references, closes: new Map() }, run);
}

/** Global work must not inherit the signalling lane's mutation window. Async
 * descendants stay unscoped; the caller retains its own scope on return. */
export function withoutControllerPipelineScope<T>(run: () => T): T {
  return scope.exit(run);
}
