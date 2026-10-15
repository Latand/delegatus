import { AsyncLocalStorage } from "node:async_hooks";

type Scope = { keys: readonly string[]; attempts?: ReadonlySet<string> };
const host = globalThis as typeof globalThis & { __llvPipelineControllerScope?: AsyncLocalStorage<Scope> };
const scope = host.__llvPipelineControllerScope ??= new AsyncLocalStorage<Scope>();
export const controllerPipelineKeys = () => scope.getStore()?.keys;
export const controllerAttemptSelected = (pipeline: string, stage: string, attempt: number) =>
  !scope.getStore()?.attempts || scope.getStore()!.attempts!.has(JSON.stringify([pipeline, stage, attempt]));
export function withControllerPipelineScope<T>(keys: readonly string[], run: () => Promise<T>, attempts?: ReadonlySet<string>): Promise<T> {
  return scope.run({ keys, attempts }, run);
}
