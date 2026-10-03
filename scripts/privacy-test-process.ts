import { availableParallelism } from "node:os";

// Keep real CLI coverage while overlapping process startup and I/O on runners.
// A small cap also bounds memory and leaves capacity for the parent test runner.
const capacity = Math.min(4, availableParallelism());
let active = 0;
const waiting: Array<() => void> = [];

export async function runPrivacyTestProcess(options: {
  cmd: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  stderr: "pipe";
  stdout: "pipe";
}) {
  if (active >= capacity) await new Promise<void>((resolve) => waiting.push(resolve));
  else active += 1;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const process = Bun.spawn(options);
    child = process;
    // A stuck child fails independently of the workflow's outer 90-second cap.
    timer = setTimeout(() => process.kill("SIGKILL"), 20_000);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).arrayBuffer(),
      new Response(process.stderr).arrayBuffer(),
      process.exited,
    ]);
    return { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), exitCode };
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    const next = waiting.shift();
    if (next) next(); else active -= 1;
  }
}
