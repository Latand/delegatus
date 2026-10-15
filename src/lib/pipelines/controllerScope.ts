import { AsyncLocalStorage } from "node:async_hooks";
import type { Pipeline } from "./types";
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
export function withControllerPipelineScope<T>(keys: readonly string[], run: () => Promise<T>, attempts?: ReadonlySet<string>, references?: Scope["references"]): Promise<T> {
  return scope.run({ keys, attempts, references, closes: new Map() }, run);
}
