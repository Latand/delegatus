import fs from "node:fs";
import path from "node:path";

/** An isolated peer for voice read/write contention tests; starts no controllers. */
export async function readLockPeer(root: string, filename: string, kind: "sqlite" | "file") {
  const ready = path.join(root, `${kind}-ready`), go = path.join(root, `${kind}-go`);
  const child = Bun.spawn([process.execPath, import.meta.path, kind, filename, ready, go], {
    env: { ...process.env, NODE_ENV: "test", LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" }, stdout: "ignore", stderr: "pipe",
  });
  const release = async () => { fs.writeFileSync(go, "release"); await child.exited; };
  try {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(ready)) {
      if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
      if (Date.now() > deadline) throw new Error("Voice lock peer readiness expired");
      await Bun.sleep(1);
    }
    return { release, pid: child.pid };
  } catch (error) { await release(); throw error; }
}

export async function threeTimerTicks() {
  await new Promise<void>(resolve => {
    let ticks = 0;
    const timer = setInterval(() => { if (++ticks === 3) { clearInterval(timer); resolve(); } }, 5);
  });
}

if (import.meta.main) {
  const [kind, filename, ready, go] = process.argv.slice(2);
  const hold = async () => {
    fs.writeFileSync(ready!, "ready");
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(go!)) {
      if (Date.now() > deadline) throw new Error("Voice lock peer release expired");
      await Bun.sleep(1);
    }
  };
  if (kind === "file") {
    const { withFileTransaction } = await import("@/lib/state/fileTransaction");
    await withFileTransaction(filename!, "peer lock busy", hold);
  } else {
    const { Database } = await import("bun:sqlite");
    const db = new Database(filename!);
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN EXCLUSIVE");
    try { await hold(); } finally { db.exec("ROLLBACK"); db.close(); }
  }
}
