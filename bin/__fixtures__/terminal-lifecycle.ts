import type { ChildProcess } from "node:child_process";

// The real bootstrap allows 120 seconds for health. Its exit (and drained
// output) is the completion event; a test must let that contract finish.
export function terminalClosed(child: ChildProcess, budget = 150000): Promise<void> {
  if ((child.exitCode !== null || child.signalCode !== null)
    && child.stdout?.destroyed !== false && child.stderr?.destroyed !== false) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.removeListener("close", closed);
      child.removeListener("error", failed);
      if (error) reject(error); else resolve();
    };
    const closed = () => finish();
    const failed = (error: Error) => finish(error);
    const timer = setTimeout(() => finish(new Error("Terminal process did not close after its health budget")), budget);
    child.once("close", closed);
    child.once("error", failed);
  });
}
