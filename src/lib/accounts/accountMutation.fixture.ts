import fs from "node:fs";
import path from "node:path";
import { withAccountMutationLockAsync } from "./accountMutation";

/** A real foreign writer. Arm only after caller setup, so the short hold
 * overlaps admission rather than module loading. Every child is joined. */
export async function foreignAccountHolder(state = process.env.LLV_STATE_DIR!) {
  fs.mkdirSync(state, { recursive: true });
  const ready = path.join(state, `holder-ready-${crypto.randomUUID()}`);
  const release = `${ready}-release`;
  const modulePath = path.join(import.meta.dir, "accountMutation.ts");
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", `
      await import(${JSON.stringify(path.resolve(import.meta.dir, "../testing/fixtureLifetime.ts"))});
      const fs = await import("node:fs");
      const { withAccountMutationLockAsync } = await import(${JSON.stringify(modulePath)});
      await withAccountMutationLockAsync(async () => {
        fs.writeFileSync(${JSON.stringify(ready)}, "ready");
        while (!fs.existsSync(${JSON.stringify(release)})) await Bun.sleep(1);
        await Bun.sleep(Number(fs.readFileSync(${JSON.stringify(release)}, "utf8")));
      }, { holder: "foreign fixture writer" });
    `],
    env: { ...process.env, LLV_STATE_DIR: state },
    stdout: "ignore", stderr: "pipe",
  });
  const deadline = performance.now() + 5_000;
  while (!fs.existsSync(ready) && performance.now() < deadline && child.exitCode === null) await Bun.sleep(2);
  if (!fs.existsSync(ready)) {
    child.kill();
    await child.exited;
    throw new Error(`fixture holder failed: ${await new Response(child.stderr).text()}`);
  }
  return {
    releaseAfter(ms: number) { fs.writeFileSync(release, String(ms)); },
    async close() {
      if (!fs.existsSync(release)) fs.writeFileSync(release, "0");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finished = await Promise.race([child.exited.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 5_000); })]);
      clearTimeout(timer);
      if (!finished) child.kill();
      const code = await child.exited;
      const stderr = await new Response(child.stderr).text();
      fs.rmSync(ready, { force: true });
      fs.rmSync(release, { force: true });
      if (code !== 0) throw new Error(`fixture holder exited ${code}: ${stderr}`);
    },
  };
}

/** Exercise an async request from outside the holder's transaction context. */
export async function withAccountHolder<T>(kind: "local" | "foreign" | "timeout" | "queued", request: () => Promise<T>): Promise<T> {
  if (kind !== "local") {
    const holder = await foreignAccountHolder();
    const queued = kind === "queued" ? withAccountMutationLockAsync(() => undefined) : null;
    try {
      holder.releaseAfter(kind === "timeout" ? 2_150 : kind === "queued" ? 8 : 120);
      return await request();
    } finally { await holder.close(); await queued; }
  }
  let ready!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { ready = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = withAccountMutationLockAsync(async () => { ready(); await gate; });
  await entered;
  const timer = setTimeout(release, 8);
  try { return await request(); }
  finally { clearTimeout(timer); release(); await held; }
}
