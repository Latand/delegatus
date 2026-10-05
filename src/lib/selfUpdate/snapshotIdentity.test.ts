import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { forgetStartIdentities, sameProcess } from "./pid";

/* The Update surface takes a snapshot every five seconds while any tab is
   open. On Windows each identity read starts PowerShell, and a snapshot read
   the launcher twice and web and the runtime host once each. */
const FILETIME = "133000000000000000";
const root = mkdtempSync("/var/tmp/self-update-snapshot-identity-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => forgetStartIdentities());

if (process.platform === "linux") test("a second snapshot inside the memory starts no PowerShell, and the first starts one", async () => {
  const bin = join(root, "bin"); const count = join(root, "starts"); mkdirSync(bin);
  // A powershell.exe on PATH that counts its starts and answers like the real one.
  writeFileSync(join(bin, "powershell.exe"), `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(count)}, "start\\n");
const script = Buffer.from(process.argv[process.argv.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
const list = /@\\(([0-9,]+)\\)/.exec(script);
if (list) process.stdout.write(list[1].split(",").map(pid => pid + ":${FILETIME}").join("\\r\\n") + "\\r\\n");
else process.stdout.write("${FILETIME}");
`);
  chmodSync(join(bin, "powershell.exe"), 0o755);
  const starts = () => existsSync(count) ? readFileSync(count, "utf8").trim().split("\n").length : 0;
  // The record names its own files; the service keeps its state wherever a test run resolves it.
  const directory = join(root, "self-update"); mkdirSync(directory, { recursive: true });
  const checkout = join(root, "checkout"); mkdirSync(checkout);
  const recordFile = join(directory, "launcher-fixture.json");
  const entry = (pid: number) => ({ state: "healthy", pid, startIdentity: `${pid}:${FILETIME}`, startedAt: new Date().toISOString(), revision: "aaaaaaa", error: null, requestId: null });
  // Three live processes of this test: the launcher, web and the runtime host.
  const sleepers = [0, 1].map(() => Bun.spawn(["sleep", "30"]));
  writeFileSync(recordFile, JSON.stringify({ version: 1, launcher: { pid: process.pid, startIdentity: `${process.pid}:${FILETIME}`, relaunch: 1, autoAdmission: 1, state: "healthy" },
    checkout, releasesDir: join(root, "releases"), releasePointer: join(directory, "release-fixture.json"), requestFile: join(directory, "request-fixture.json"),
    port: 0, socket: join(root, "host.sock"), web: entry(sleepers[0]!.pid), runtimeHost: entry(sleepers[1]!.pid), updatedAt: new Date().toISOString() }));
  const { SelfUpdateService } = await import("./service");
  const { productionDeps } = await import("./instance");
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const path = process.env.PATH;
  let service: InstanceType<typeof SelfUpdateService> | undefined;
  try {
    const plain = new SelfUpdateService(productionDeps({ ...process.env, LLV_SELF_UPDATE_RECORD: recordFile }));
    try { await plain.snapshot(); } finally { plain.stop(); }
    expect(starts()).toBe(0);
    process.env.PATH = `${bin}:${path}`;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    forgetStartIdentities();
    service = new SelfUpdateService(productionDeps({ ...process.env, LLV_SELF_UPDATE_RECORD: recordFile }));
    const first = await service.snapshot();
    expect(first.mode).toBe("checkout");
    expect(first.processes.web).toMatchObject({ state: "healthy", pid: sleepers[0]!.pid });
    expect(first.processes.runtimeHost.pid).toBe(sleepers[1]!.pid);
    expect(starts()).toBe(1);
    for (let again = 0; again < 3; again++) expect((await service.snapshot()).processes.web.pid).toBe(sleepers[0]!.pid);
    expect(starts()).toBe(1);
    // What is remembered is what a fresh read answers.
    expect(sameProcess({ pid: sleepers[0]!.pid, startIdentity: `${sleepers[0]!.pid}:${FILETIME}` })).toBe(true);
    expect(starts()).toBe(1);
  } finally {
    Object.defineProperty(process, "platform", platform);
    process.env.PATH = path;
    service?.stop();
    for (const sleeper of sleepers) { sleeper.kill(); await sleeper.exited; }
  }
}, 30_000);
