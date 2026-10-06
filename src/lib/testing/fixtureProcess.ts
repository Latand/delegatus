import type { ChildProcess } from "node:child_process";

/** Report readiness only within a deadline. Callers register the child in the
 * same tick as spawn, then use this wait. Startup errors reap the real handle.
 */
export async function fixtureReport<Report>(child: ChildProcess, name: string, reports: Report[], timeoutMs = 10_000): Promise<Report> {
  const errors: string[] = [];
  child.stderr?.on("data", chunk => errors.push(String(chunk)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Report>((resolve, reject) => {
      let buffered = "";
      child.stdout?.on("data", chunk => {
        buffered += String(chunk);
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim().startsWith("{")) continue;
          try {
            const report = JSON.parse(line) as Report;
            reports.push(report);
            resolve(report);
          } catch (error) { reject(new Error(`${name} reported invalid JSON: ${String(error)}`)); }
        }
      });
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`${name} exited with ${code} before reporting:\n${errors.join("")}`)));
      timer = setTimeout(() => reject(new Error(`${name} did not report within ${timeoutMs}ms:\n${errors.join("")}`)), timeoutMs);
    });
  } catch (error) {
    await stopFixtureProcess(child);
    throw error;
  } finally { clearTimeout(timer); }
}

/** ChildProcess.kill targets its original handle, and refuses after exit. */
export async function stopFixtureProcess(child: ChildProcess, termMs = 500, timeoutMs = 2_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const forced = setTimeout(() => child.kill("SIGKILL"), termMs);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([exited, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error(`owned fixture ${child.pid} survived TERM and KILL`)), timeoutMs);
    })]);
  } finally { clearTimeout(forced); clearTimeout(deadline); }
}
