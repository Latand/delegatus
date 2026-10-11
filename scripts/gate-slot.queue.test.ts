import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cpuAdmissionFile, CPU_QUEUE_MAX_WAIT_MS, CpuAdmissionQueue } from "../src/lib/runtime/cpuAdmission";
import { realExec } from "../src/lib/workflows/provision";
import { runSteps } from "./local-gate";

async function until(check: () => boolean) {
  const ends = Date.now() + 5_000;
  while (!check()) { if (Date.now() > ends) throw new Error("queue fixture did not reach its barrier"); await Bun.sleep(10); }
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-queue-"));
  const env = { ...process.env, LLV_GATE_LOCK_DIR: dir, LLV_GATE_PSI_FILE: path.join(dir, "pressure"), LLV_GATE_POLL_SECONDS: "0.02", DELEGATUS_AGENT_CPU: "off", DELEGATUS_CPU_PRESSURE: "on" };
  fs.writeFileSync(env.LLV_GATE_PSI_FILE, "some avg10=90.00 avg60=90.00 avg300=90.00 total=1\n");
  const file = path.join(dir, path.basename(cpuAdmissionFile()));
  new CpuAdmissionQueue(file).close();
  const db = new Database(file);
  db.exec("PRAGMA busy_timeout=5000");
  const command = (word: string) => ["bash", "scripts/gate-slot.sh", "bash", "-c", `echo ${word} >> "$CPU_QUEUE_OUTPUT"`];
  return { dir, env: { ...env, CPU_QUEUE_OUTPUT: path.join(dir, "output") }, db, command,
    count: () => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tickets").get()!.n,
    age: () => db.query("UPDATE tickets SET since = ?").run(Date.now() - CPU_QUEUE_MAX_WAIT_MS),
    close: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("gate-slot uses the ten-minute queue and preserves FIFO through slot acquisition", async () => {
  const f = fixture();
  const pending: Promise<unknown>[] = [];
  try {
    const one = realExec(f.command("one")[0]!, f.command("one").slice(1), process.cwd(), f.env, { timeoutMs: 1000 }); pending.push(Promise.resolve(one));
    await until(() => f.count() === 1);
    const two = realExec(f.command("two")[0]!, f.command("two").slice(1), process.cwd(), f.env, { timeoutMs: 1000 }); pending.push(Promise.resolve(two));
    await until(() => f.count() === 2);
    await Bun.sleep(1200); // longer than either caller's execution budget
    expect(fs.existsSync(f.env.CPU_QUEUE_OUTPUT)).toBe(false);
    f.age();
    const results = await Promise.all([one, two]);
    expect(results.map(r => r.code), JSON.stringify(results)).toEqual([0, 0]);
    expect(fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8")).toBe("one\ntwo\n");
    expect(results[1]!.stderr).toContain("2nd");
  } finally { fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, ""); f.age(); await Promise.allSettled(pending); f.close(); }
}, 20_000);

test("pre-push keeps completed admission waits outside its budget across later steps", async () => {
  const f = fixture();
  let waiting: Promise<unknown> | undefined;
  try {
    waiting = runSteps("pre-push", [{ name: "one", command: f.command("one") }, { name: "two", command: f.command("two") }], {
      root: process.cwd(), deadline: { startedAt: Date.now(), at: Date.now() + 1200 }, logDir: f.dir, say: () => {},
      prepare: (step) => ({ command: step.command, env: f.env }),
    });
    await until(() => f.count() === 1);
    await Bun.sleep(1300); f.age();
    await until(() => fs.existsSync(f.env.CPU_QUEUE_OUTPUT));
    await until(() => f.count() === 1); f.age();
    expect(await waiting).toEqual([]);
    expect(fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8")).toBe("one\ntwo\n");
  } finally { fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, ""); f.age(); await waiting?.catch(() => {}); f.close(); }
}, 20_000);

test("the owned runner keeps a nested queue wait outside its execution deadline", async () => {
  const f = fixture();
  let pending: ReturnType<typeof realExec> | undefined;
  try {
    fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, "");
    const script = 'import fs from "node:fs"; fs.writeFileSync(process.env.LLV_GATE_PSI_FILE!, "some avg10=90.00 total=1\\n"); const child = Bun.spawn(["bash", "scripts/gate-slot.sh", "bash", "-c", "echo nested > \\\"$CPU_QUEUE_OUTPUT\\\""], { stdio: ["ignore", "inherit", "inherit"] }); process.exit(await child.exited);';
    pending = realExec("bash", ["scripts/gate-slot.sh", process.execPath, "-e", script], process.cwd(), { ...f.env, LLV_OWNED_RUN_TIMEOUT_MS: "1200" }, { timeoutMs: 4000 });
    await until(() => f.count() === 1);
    await Bun.sleep(1600); f.age();
    const result = await pending;
    expect(result.code, result.stderr).toBe(0);
    expect(fs.readFileSync(f.env.CPU_QUEUE_OUTPUT, "utf8")).toBe("nested\n");
  } finally { fs.writeFileSync(f.env.LLV_GATE_PSI_FILE, ""); f.age(); await Promise.resolve(pending).catch(() => {}); f.close(); }
}, 20_000);
