import { AsyncLocalStorage } from "node:async_hooks";

/** Request-local restriction carried to asynchronous write admission. No cache
 * of authority lives here: the callback reads the current durable grant. */
const execution = new AsyncLocalStorage<(project?: string) => void>();
export function assertWorkspaceExecution(project?: string): void { execution.getStore()?.(project); }
export function runWithWorkspaceExecution<T>(assert: (project?: string) => void, run: () => T): T {
  return execution.run(assert, run);
}
