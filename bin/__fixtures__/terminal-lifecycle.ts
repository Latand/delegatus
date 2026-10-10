import type { ChildProcess } from "node:child_process";

// The real bootstrap allows 120 seconds for health. Its process exit is the
// completion event. Windows descendants may retain a shell's output handles
// until teardown, so pipe closure cannot stand in for process completion.
export function terminalExited(child: ChildProcess, budget = 150000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return waitFor(child, "exit", budget);
}

// Drain pipes only after recorded descendants have stopped.
export function terminalClosed(child: ChildProcess, budget = 150000): Promise<void> {
  if ((child.exitCode !== null || child.signalCode !== null)
    && child.stdout?.destroyed !== false && child.stderr?.destroyed !== false) return Promise.resolve();
  return waitFor(child, "close", budget);
}

function waitFor(child: ChildProcess, event: "exit" | "close", budget: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.removeListener(event, completed);
      child.removeListener("error", failed);
      if (error) reject(error); else resolve();
    };
    const completed = () => finish();
    const failed = (error: Error) => finish(error);
    const timer = setTimeout(() => finish(new Error(`Terminal process did not ${event} after its health budget`)), budget);
    child.once(event, completed);
    child.once("error", failed);
  });
}
