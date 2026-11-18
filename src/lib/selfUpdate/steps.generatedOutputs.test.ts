import { afterEach, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareExistingRelease, realPorts } from "./steps";
import { runGit } from "./git";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "release-inventory-")); roots.push(root);
  const git = (args: string[], cwd = root) => {
    const result = childProcess.spawnSync("git", ["-c", "user.name=Fixture", "-c", `user.email=${"noreply"}@example.invalid`, ...args], {
      cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" },
    });
    expect(result.status).toBe(0); return result.stdout.trim();
  };
  git(["init", "-q", "-b", "main"]);
  fs.writeFileSync(join(root, ".gitignore"), "node_modules/\n.next/\n");
  git(["add", ".gitignore"]); git(["commit", "-qm", "fixture"]);
  const sha = git(["rev-parse", "HEAD"]), release = join(root, "release");
  git(["worktree", "add", "--detach", release, sha]);
  const admin = git(["rev-parse", "--absolute-git-dir"], release);
  const marker = join(admin, "delegatus-release-outputs.json");
  const generate = async () => {
    fs.mkdirSync(join(release, "node_modules"), { recursive: true });
    fs.writeFileSync(join(release, "node_modules/asset.png"), "generated");
    return 0;
  };
  return { root, release, sha, admin, marker, generate, git };
}

// Inject at the real worker's terminal event, before its caller resumes.
function afterInventory(effect: () => void) {
  const original = childProcess.spawn;
  return spyOn(childProcess, "spawn").mockImplementation(((command: string, args: readonly string[] = [], options: childProcess.SpawnOptions = {}) => {
    const child = original(command, args, options);
    if (command === process.execPath && args?.includes("--eval")) child.once("close", effect);
    return child;
  }) as typeof childProcess.spawn);
}

test("the receipt writer's real output is accepted by a fresh process and checked again after a later edit", async () => {
  const h = fixture();
  await realPorts(() => {}).withGeneratedOutputs!(h.release, h.sha, h.generate, h.root);
  const record = JSON.parse(fs.readFileSync(h.marker, "utf8"));
  expect(record).toMatchObject({ version: 1, sha: h.sha, directory: h.release });
  expect(record.outputs["node_modules/"]).toMatch(/^[a-f0-9]{64}$/);
  const script = `import { prepareExistingRelease } from ${JSON.stringify(join(import.meta.dir, "steps.ts"))};
    console.log(JSON.stringify(await prepareExistingRelease(process.argv[1], process.argv[2])));`;
  const read = () => {
    const result = childProcess.spawnSync(process.execPath, ["--no-env-file", "--eval", script, h.release, h.root], { env: process.env, encoding: "utf8" });
    expect(result.status).toBe(0); return JSON.parse(result.stdout);
  };
  expect(read()).toBeNull();
  fs.writeFileSync(join(h.release, "node_modules/asset.png"), "foreign");
  expect(read()).toContain("cannot be proven generated");
});

for (const field of ["sha", "directory", "device", "inode"]) {
  test(`refuses a receipt with a changed ${field} binding`, async () => {
    const h = fixture();
    await realPorts(() => {}).withGeneratedOutputs!(h.release, h.sha, h.generate, h.root);
    const record = JSON.parse(fs.readFileSync(h.marker, "utf8")); record[field] += "changed";
    fs.writeFileSync(h.marker, JSON.stringify(record));
    expect(await prepareExistingRelease(h.release, h.root)).toContain("cannot be proven generated");
  });
}

for (const change of ["sha", "directory", "backlink"]) {
  test(`refuses a ${change} substitution after the writer's walk`, async () => {
    const h = fixture();
    const intercept = afterInventory(() => {
      if (change === "sha") fs.writeFileSync(join(h.admin, "HEAD"), `${"b".repeat(40)}\n`);
      if (change === "backlink") fs.writeFileSync(join(h.admin, "gitdir"), join(h.root, "foreign", ".git"));
      if (change === "directory") {
        const moved = join(h.root, "moved"); fs.renameSync(h.release, moved); fs.mkdirSync(h.release);
        fs.copyFileSync(join(moved, ".git"), join(h.release, ".git"));
      }
    });
    try { await expect(realPorts(() => {}).withGeneratedOutputs!(h.release, h.sha, h.generate, h.root)).rejects.toThrow(); }
    finally { intercept.mockRestore(); }
    expect(fs.existsSync(h.marker)).toBe(false);
  });
}

for (const change of ["sha", "directory", "backlink"]) {
  test(`withdraws every proven output after a ${change} substitution during verification`, async () => {
    const h = fixture();
    await realPorts(() => {}).withGeneratedOutputs!(h.release, h.sha, h.generate, h.root);
    const intercept = afterInventory(() => {
      if (change === "sha") fs.writeFileSync(join(h.admin, "HEAD"), `${"b".repeat(40)}\n`);
      if (change === "backlink") fs.writeFileSync(join(h.admin, "gitdir"), join(h.root, "foreign", ".git"));
      if (change === "directory") {
        const moved = join(h.root, "moved"); fs.renameSync(h.release, moved); fs.mkdirSync(h.release);
        fs.copyFileSync(join(moved, ".git"), join(h.release, ".git"));
      }
    });
    try { expect(await prepareExistingRelease(h.release, h.root)).toContain("cannot be proven generated"); }
    finally { intercept.mockRestore(); }
  });
}

test("a failed later inventory clears earlier proven outputs", async () => {
  const h = fixture();
  await realPorts(() => {}).withGeneratedOutputs!(h.release, h.sha, async () => {
    await h.generate();
    fs.renameSync(join(h.release, "node_modules/asset.png"), join(h.release, "node_modules/asset.js"));
    fs.mkdirSync(join(h.release, ".next")); fs.writeFileSync(join(h.release, ".next/asset.png"), "generated"); return 0;
  }, h.root);
  const original = childProcess.spawn; let workers = 0;
  const intercept = spyOn(childProcess, "spawn").mockImplementation(((command: string, args: readonly string[] = [], options: childProcess.SpawnOptions = {}) => {
    if (command !== process.execPath || !args.includes("--eval")) return original(command, args, options);
    const argv = [...args]; const index = ++workers;
    if (index === 2) argv[3] = "process.exit(7)";
    const child = original(command, argv, options);
    if (index === 1) child.once("close", () => fs.writeFileSync(join(h.release, ".next/asset.png"), "foreign"));
    return child;
  }) as typeof childProcess.spawn);
  try { expect(await prepareExistingRelease(h.release, h.root)).toContain("cannot be proven generated"); }
  finally { intercept.mockRestore(); }
  expect(workers).toBe(2);
});

for (const phase of ["generate", "prepare"]) {
  test(`abort cancels the ${phase} inventory and never proceeds with an old receipt`, async () => {
    const h = fixture(), ports = realPorts(() => {});
    if (phase === "prepare") await ports.withGeneratedOutputs!(h.release, h.sha, h.generate, h.root);
    const original = childProcess.spawn;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let owned: childProcess.ChildProcess | undefined;
    const intercept = spyOn(childProcess, "spawn").mockImplementation(((command: string, args: readonly string[] = [], options: childProcess.SpawnOptions = {}) => {
      if (command === process.execPath && args?.includes("--eval")) {
        const argv = [...args];
        argv[3] = 'process.stderr.write("walking"); setInterval(() => {}, 1000)';
        owned = original(command, argv, options); owned.stderr!.once("data", started); return owned;
      }
      return original(command, args, options);
    }) as typeof childProcess.spawn);
    try {
      const done = phase === "prepare" ? ports.prepareExistingRelease!(h.release, h.root)
        : ports.withGeneratedOutputs!(h.release, h.sha, h.generate, h.root);
      const outcome = done.catch(error => error);
      await Promise.race([ready, outcome.then(() => { throw new Error("Inventory ended before its walk acknowledgement"); })]);
      await ports.abort();
      const error = await outcome;
      if (phase === "prepare") expect((error as Error)?.name).toBe("AbortError");
      else { expect(error).toBeInstanceOf(Error); expect(String(error)).toContain("cancelled"); }
      expect(owned!.signalCode).toBe("SIGKILL");
      expect(() => process.kill(owned!.pid!, 0)).toThrow();
      if (phase === "generate") expect(fs.existsSync(h.marker)).toBe(false);
    } finally { intercept.mockRestore(); await ports.abort(); }
  });
}

test("an abort after Git setup prevents the first worker from starting", async () => {
  const h = fixture(); await realPorts(() => {}).withGeneratedOutputs!(h.release, h.sha, h.generate, h.root);
  const controller = new AbortController();
  const git: typeof runGit = async (...args) => {
    const result = await runGit(...args);
    if (args[0].includes("status")) controller.abort();
    return result;
  };
  let workers = 0; const intercept = afterInventory(() => { workers++; });
  try { await expect(prepareExistingRelease(h.release, h.root, git, controller.signal)).rejects.toThrow(); }
  finally { intercept.mockRestore(); }
  expect(workers).toBe(0);
});
