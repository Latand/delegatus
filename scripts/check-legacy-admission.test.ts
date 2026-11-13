import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { CheckAdmission } from "./check-admission";
import { onlineCpuCount } from "../src/lib/runtime/cpuPlacement";
import { stopFixtureProcess } from "../src/lib/testing/fixtureProcess";
import { withoutInheritedGate } from "../src/lib/testing/inheritedGateEnv";

async function until(check: () => boolean) {
  const deadline = performance.now() + 20_000;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("legacy admission barrier expired");
    await Bun.sleep(10);
  }
}
const quote = (arg: string) => "'" + arg.replaceAll("'", "'\\''") + "'";
for (const launch of ["direct", "shell", "package"] as const) test.skipIf(process.platform !== "linux")(`real older preload ${launch} waits at a saturated cap and completes`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-admission-"));
  const base = path.join(root, "base"); fs.mkdirSync(base);
  // The retained reproduction used this baseline's real preload and runner.
  // Export only: fixture Git never creates a branch or a commit.
  let source = process.env.LLV_LEGACY_TEST_ROOT;
  if (!source) {
    source = path.join(root,"retained-baseline"); fs.mkdirSync(source);
    const archive = path.join(root,"baseline.tar");
    const cwd = path.resolve(import.meta.dir,"..");
    // Shallow CI checkouts can lack the retained baseline. The startup
    // reentry path remains exercised there, with its side effect observed.
    const retained = spawnSync("git", ["cat-file", "-e", "ce7806df^{commit}"], {cwd});
    const exported = spawnSync("git", ["archive", "--format=tar", `--output=${archive}`, retained.status === 0 ? "ce7806df" : "HEAD"], { cwd,encoding:"utf8" });
    expect(exported.status,exported.stderr).toBe(0);
    const extracted = spawnSync("tar", ["-xf",archive,"-C",source],{encoding:"utf8"});
    expect(extracted.status,extracted.stderr).toBe(0);
  }
  fs.cpSync(source, base, { recursive: true, filter: file => !["node_modules", ".git"].includes(path.basename(file)) });
  const preload = path.join(base,"test-preload.ts");
  fs.writeFileSync(preload, `import osLegacy from "node:os"; import fsLegacy from "node:fs";
    if (process.env.LLV_TEST_STARTUP_HOME !== osLegacy.homedir()) fsLegacy.writeFileSync(${JSON.stringify(path.join(base,"reentered"))},"yes");\n` + fs.readFileSync(preload,"utf8"));
  fs.symlinkSync(path.resolve(import.meta.dir, "../node_modules"), path.join(base, "node_modules"));
  const env = withoutInheritedGate<NodeJS.ProcessEnv>({ ...process.env });
  for (const key of ["BUN_OPTIONS", "NODE_OPTIONS", "LLV_CHECK_BROKER", "DELEGATUS_CHECK_BROKER", "LLV_TEST_STARTUP_HOME"]) delete env[key];
  for (const key of ["HOME", "XDG_CONFIG_HOME", "TMPDIR", "LLV_STATE_DIR"]) {
    env[key] = path.join(root, key.toLowerCase()); fs.mkdirSync(env[key]!);
  }
  Object.assign(env, { LLV_CHECK_ADMISSION_FILE: path.join(root,"checks.sqlite"), NODE_ENV: "test",
    DELEGATUS_GATE_CPU_HEADROOM: String(onlineCpuCount()-1), LLV_OWNED_RUN_TIMEOUT_MS: "60000", LLV_VIEWER_CONTROL_URL:"http://127.0.0.1:1" });
  new CheckAdmission(env.LLV_CHECK_ADMISSION_FILE!).close();
  const db = new Database(env.LLV_CHECK_ADMISSION_FILE!);
  const rows = () => db.query<{held:number},[]>("SELECT held FROM checks ORDER BY seq").all();
  const holderRoot = path.join(root,"holder"); fs.mkdirSync(holderRoot);
  fs.writeFileSync(path.join(holderRoot,"bunfig.toml"),"[test]\n");
  fs.writeFileSync(path.join(holderRoot,"held.test.ts"),`import fs from "node:fs"; import { test } from "bun:test";
    test("holder", async () => { fs.writeFileSync("ready", "ready"); while (!fs.existsSync("release")) await Bun.sleep(10); }, 60000);`);
  fs.writeFileSync(path.join(base,"worker.test.ts"),`import fs from "node:fs"; import { test } from "bun:test";
    test("baseline worker", () => fs.writeFileSync("executed", "yes"));`);
  const command = [process.execPath,"test","./worker.test.ts"];
  fs.writeFileSync(path.join(base,"package.json"),JSON.stringify({scripts:{check:command.map(quote).join(" ")}}));
  const runner = path.join(import.meta.dir,"owned-runner.ts");
  function start(command: string[], cwd: string) {
    const child=spawn(process.execPath,[runner,"--portable",...command],{cwd,env,stdio:["ignore","pipe","pipe"]});
    let output="";child.stdout!.on("data",v=>output+=v);child.stderr!.on("data",v=>output+=v);
    const closed=new Promise<number|null>(resolve=>child.once("close",resolve));
    return { child,closed,output:()=>output };
  }
  const holder=start([process.execPath,"test","./held.test.ts"],holderRoot);
  let worker: ReturnType<typeof start> | undefined;
  try {
    await until(()=>fs.existsSync(path.join(holderRoot,"ready"))||holder.child.exitCode!==null);
    expect(holder.child.exitCode,holder.output()).toBeNull();
    worker=start(launch==="direct"?command:launch==="shell"?["bash","-c","exec "+command.map(quote).join(" ")]:[process.execPath,"run","check"],base);
    await until(()=>rows().length===2||worker!.child.exitCode!==null);
    expect(worker.child.exitCode,worker.output()).toBeNull();
    expect(rows().map(row=>row.held)).toEqual([1,0]);
    expect(fs.existsSync(path.join(base,"executed"))).toBe(false);
    fs.writeFileSync(path.join(holderRoot,"release"),"release");
    expect(await holder.closed,holder.output()).toBe(0);
    expect(await worker.closed,worker.output()).toBe(0);
    expect(worker.output()).toContain("1 pass");
    expect(fs.existsSync(path.join(base,"executed"))).toBe(true);
    expect(fs.existsSync(path.join(base,"reentered"))).toBe(false);
    await until(()=>rows().length===0);
  } finally {
    await stopFixtureProcess(holder.child);
    if(worker) await stopFixtureProcess(worker.child);
    db.close();fs.rmSync(root,{recursive:true,force:true});
  }
}, 90_000);
