import fs from "node:fs";
import path from "node:path";

/** A real foreign writer. Arm only after caller setup, so the short hold
 * overlaps admission rather than module loading. Every child is joined. */
export async function foreignAccountHolder(state = process.env.LLV_STATE_DIR!) {
  fs.mkdirSync(state, { recursive: true });
  const ready = path.join(state, `holder-ready-${crypto.randomUUID()}`);
  const release = `${ready}-release`;
  const modulePath = path.join(import.meta.dir, "accountMutation.ts");
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", `
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
