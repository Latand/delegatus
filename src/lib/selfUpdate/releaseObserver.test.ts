import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { observePrivilegedReleases, RELEASE_OBSERVER } from "./releaseObserver.worker";
import { retentionScanWithObserver } from "./retentionInspection";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-observer-")); roots.push(root);
  const proc = path.join(root, "proc"), releases = path.join(root, "releases");
  fs.mkdirSync(path.join(proc, "self/ns"), { recursive: true }); fs.symlinkSync("mnt:[fixture]", path.join(proc, "self/ns/mnt"));
  fs.mkdirSync(releases);
  return { root, proc, releases };
}
function processFixture(proc: string, pid: number, target: string, namespace = "mnt:[fixture]") {
  const directory = path.join(proc, String(pid)); fs.mkdirSync(path.join(directory, "ns"), { recursive: true }); fs.mkdirSync(path.join(directory, "fd"));
  fs.symlinkSync(namespace, path.join(directory, "ns/mnt"));
  const fields = Array(52).fill("0"); fields[0] = "S"; fields[19] = "123";
  fs.writeFileSync(path.join(directory, "stat"), `${pid} (fixture) ${fields.join(" ")}`);
  for (const file of ["cwd", "exe", "root"]) fs.symlinkSync(file === "cwd" ? target : "/", path.join(directory, file));
  for (const file of ["cmdline", "maps", "environ"]) fs.writeFileSync(path.join(directory, file), "");
  return directory;
}
test.each(["complete", "refused", "malformed"])("the fixed sudo observer %s retains uncertainty or supplies a complete read", mode => {
  const f = fixture(); const process = processFixture(f.proc, 100001, "/elsewhere"); fs.unlinkSync(path.join(process, "maps"));
  const sudo = path.join(f.root, "sudo"), calls = path.join(f.root, "calls.json");
  fs.writeFileSync(sudo, `#!/usr/bin/python3 -I\nimport sys,json\nrequest=json.loads(sys.stdin.read())\nopen(${JSON.stringify(calls)},'w').write(json.dumps([sys.argv[1:],request]))\n`
    + (mode === "refused" ? "sys.exit(1)\n" : mode === "malformed" ? "print('invalid')\n" : "print(json.dumps({'complete':True,'ownNamespace':'mnt:[fixture]','processes':[],'uncertain':[]}))\n"), { mode: 0o700 });
  {
    const invoke: typeof spawnSync = ((command: string, args: string[], options: object) => {
      expect(command).toBe("/usr/bin/sudo"); return spawnSync(sudo, args, options);
    }) as typeof spawnSync;
    const result = retentionScanWithObserver(f.releases, () => observePrivilegedReleases(f.releases, invoke), f.proc);
    expect(result.uncertain).toHaveLength(mode === "complete" ? 0 : 1);
    expect(JSON.parse(fs.readFileSync(calls, "utf8"))).toEqual([["-n", "--", RELEASE_OBSERVER], { directory: f.releases }]);
  }
});

function pythonScan(proc: string, releases: string) {
  const observer = path.resolve(import.meta.dir, "../../..", "scripts/delegatus-release-holders.py");
  return spawnSync("/usr/bin/python3", ["-I", "-c", `import importlib.util,json,sys
s=importlib.util.spec_from_file_location('observer',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
print(json.dumps(m.scan(sys.argv[2],sys.argv[3])))`, observer, releases, proc], { encoding: "utf8" });
}
test("the installed observer finds holders without returning unrelated argv or environment", () => {
  const f = fixture(), held = path.join(f.releases, "old"); fs.mkdirSync(held);
  const directory = processFixture(f.proc, 100001, held);
  fs.writeFileSync(path.join(directory, "environ"), "UNRELATED=private-value\0");
  const result = pythonScan(f.proc, f.releases); expect(result.status, result.stderr).toBe(0);
  const scan = JSON.parse(result.stdout); expect(scan.uncertain).toEqual([]); expect(scan.processes[0].paths).toEqual([held]);
  expect(result.stdout).not.toContain("private-value");
});
test("an unreadable process with no release in its command remains uncertain", () => {
  const f = fixture(), directory = processFixture(f.proc, 100002, "/elsewhere"); fs.unlinkSync(path.join(directory, "maps"));
  const result = pythonScan(f.proc, f.releases); expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).uncertain).toEqual([{ pid: 100002, reason: "maps:unavailable", roots: [f.releases] }]);
});
test("embedded command and colon-separated environment references keep their release scope", () => {
  const f = fixture(), directory = processFixture(f.proc, 100004, "/elsewhere");
  fs.writeFileSync(path.join(directory, "cmdline"), `fixture\0--script=${f.releases}/old/main\0`);
  fs.writeFileSync(path.join(directory, "environ"), `PATH=/elsewhere:${f.releases}/second/bin\0UNRELATED=private-value\0`);
  const result = pythonScan(f.proc, f.releases); expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).processes[0].references).toEqual([path.join(f.releases, "old"), path.join(f.releases, "second")]);
  expect(result.stdout).not.toContain("private-value");
});
test("a bind-mounted release in another namespace is still a holder", () => {
  const f = fixture(), directory = processFixture(f.proc, 100003, "/app/main", "mnt:[other]");
  fs.writeFileSync(path.join(f.proc, "self/mountinfo"), "1 0 8:1 / / rw - ext4 disk rw\n");
  fs.writeFileSync(path.join(directory, "mountinfo"), `1 0 8:1 / / rw - ext4 disk rw\n2 1 8:1 ${f.releases}/old /app rw - ext4 disk rw\n`);
  const result = pythonScan(f.proc, f.releases); expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).processes[0].paths).toContain(path.join(f.releases, "old/main"));
});
