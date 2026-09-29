import fs from "node:fs";
import type { ChildProcess } from "node:child_process";

type OwnedChild = ReturnType<typeof Bun.spawn>;

const children = new Set<OwnedChild>();
const externalChildren = new Map<number, { child: ChildProcess; close: () => Promise<void>; closed: Promise<void> }>();
const recordedPids: number[] = [];

export function ownFixtureChild<T extends OwnedChild>(child: T): T {
  children.add(child);
  recordedPids.push(child.pid);
  return child;
}

export function ownExternalFixtureChild(child: ChildProcess, close: () => Promise<void>): void {
  if (child.pid === undefined) throw new Error("stdio fixture child has no PID");
  const closed = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once("close", () => resolve()));
  externalChildren.set(child.pid, { child, close, closed });
  recordedPids.push(child.pid);
}

export function ownedFixturePids(): number[] {
  return [...recordedPids];
}

export function fixturePidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // An adopted child can briefly remain a zombie until init collects it.
    return !/^\d+ \(.+\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch { return false; }
}

export async function reapFixtureChildren(): Promise<void> {
  const pending = [...children];
  await Promise.all(pending.map(async (child) => {
    if (child.exitCode === null) {
      try { child.kill(); } catch { /* It may have exited between checks. */ }
      await Promise.race([child.exited, Bun.sleep(1_000)]);
      if (child.exitCode === null) {
        try { child.kill(9); } catch { /* It may have exited between checks. */ }
      }
    }
    await child.exited;
    children.delete(child);
  }));
  await Promise.all([...externalChildren].map(async ([pid, { child, close, closed }]) => {
    try {
      await close();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.race([closed, Bun.sleep(1_000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
      externalChildren.delete(pid);
    }
  }));
}

let stopping = false;
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void reapFixtureChildren().finally(() => process.exit(code));
  });
}
