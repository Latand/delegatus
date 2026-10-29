import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { checkEnvironment } from "../../../../scripts/gate-cache";
import { isolatedEnvironment } from "../../../../scripts/local-gate";
import { ownFixtureTree, stopFixtureTree } from "@/lib/testing/fixtureProcess";

const prefix = "cloud-deadline:";
export const deadlineChild = (name: string) => process.env.LLV_CLOUD_DEADLINE_CHILD === name;
export const deadlineReport = (event: string) => console.log(prefix + event);

/** The parent alone releases the acknowledgement, after measuring its hold. */
export function heldCloudAcknowledgement() {
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const onData = () => { process.stdin.pause(); release(); };
  process.stdin.once("data", onData);
  process.stdin.resume();
  return {
    hold(answer: () => void) { deadlineReport("held"); void released.then(answer); },
    close() { process.stdin.off("data", onData); process.stdin.pause(); },
  };
}

/** Run the real test in an owned process; no clock or timer callback is driven
 * by the parent. Even a child with all deadline timers removed must finish or
 * fail this independent wall-clock bound. */
export async function superviseCloudDeadline(file: string, name: string, expired: boolean, budgetMs: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-deadline-"));
  const env = isolatedEnvironment(root, checkEnvironment(process.env));
  const child = ownFixtureTree(spawn(process.execPath, ["test", file, "--test-name-pattern", `^${name}$`], {
    env: { ...env, LLV_CLOUD_DEADLINE_CHILD: name }, stdio: ["pipe", "pipe", "pipe"],
  }));
  let output = "", buffered = "";
  const events = new Map<string, number>();
  const listeners = new Set<() => void>();
  const changed = () => { for (const notify of listeners) notify(); };
  const collect = (chunk: Buffer) => { output = (output + String(chunk)).slice(-16000); };
  child.stderr!.on("data", collect);
  child.stdout!.on("data", (chunk: Buffer) => {
    collect(chunk); buffered += String(chunk);
    const lines = buffered.split("\n"); buffered = lines.pop()!;
    for (const line of lines) if (line.startsWith(prefix)) events.set(line.slice(prefix.length), performance.now());
    changed();
  });
  let exited = false, code: number | null = null, launchError: Error | undefined;
  child.stdin!.on("error", error => { launchError = error; changed(); });
  child.once("error", error => { launchError = error; exited = true; changed(); });
  child.once("exit", value => { code = value; exited = true; changed(); });
  const wait = (predicate: () => boolean, ms: number, reason: string) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`${reason}\n${output}`)), ms);
    const finish = (error?: Error) => { clearTimeout(timer); listeners.delete(check); if (error) reject(error); else resolve(); };
    const check = () => {
      if (launchError) finish(launchError);
      else if (predicate()) finish();
      else if (exited) finish(new Error(`deadline child exited ${code}: ${reason}\n${output}`));
    };
    listeners.add(check); check();
  });
  try {
    await wait(() => events.has("held"), 30_000, "acknowledgement was never held");
    const armed = events.get("armed"), held = events.get("held")!;
    if (armed === undefined || held - armed >= budgetMs - 500) throw new Error(`deadline was not armed before the held acknowledgement\n${output}`);
    if (!expired) {
      await delay(31_000);
      if (exited || events.has("done")) throw new Error(`submission ended inside the held acknowledgement window\n${output}`);
      child.stdin!.write("release\n");
    }
    await wait(() => events.has("done"), expired ? budgetMs + 10_000 : 15_000, "real deadline did not settle the submission");
    if (expired && events.get("done")! - armed < budgetMs - 200) throw new Error(`submission expired before its stage budget\n${output}`);
    await wait(() => exited, 20_000, "deadline child did not exit after settlement");
    if (code !== 0) throw new Error(`deadline child failed (${code})\n${output}`);
  } finally {
    await stopFixtureTree(child);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
