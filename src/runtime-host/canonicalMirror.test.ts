import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureCanonicalMirror, resolveCanonicalRevision } from "./canonicalMirror";

const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

test("restart replaces an interrupted initial clone with a validated mirror", async () => {
  const deploymentDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-canonical-mirror-"));
  sandboxes.push(deploymentDir);
  const mirrorDir = path.join(deploymentDir, "canonical.git");
  const incomingDir = `${mirrorDir}.incoming`;
  const validMirrors = new Set<string>();
  const calls: string[][] = [];
  let cloneAttempts = 0;
  const run = async (argv: string[]): Promise<string> => {
    calls.push(argv);
    if (argv[0] === "git" && argv[1] === "clone") {
      cloneAttempts += 1;
      const destination = argv.at(-1)!;
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, cloneAttempts === 1 ? "partial" : "HEAD"), "fixture");
      if (cloneAttempts === 1) throw new Error("clone interrupted");
      validMirrors.add(destination);
      return "";
    }
    if (argv.includes("rev-parse")) {
      const gitDir = argv[argv.indexOf("--git-dir") + 1]!;
      if (!validMirrors.has(gitDir)) throw new Error("invalid bare repository");
      return "true";
    }
    return "";
  };

  await expect(ensureCanonicalMirror({ deploymentDir, mirrorDir, remote: "ssh://canonical" }, { run })).rejects.toThrow("clone interrupted");
  expect(fs.existsSync(mirrorDir)).toBe(false);
  expect(fs.existsSync(path.join(incomingDir, "partial"))).toBe(true);

  await ensureCanonicalMirror({ deploymentDir, mirrorDir, remote: "ssh://canonical" }, { run });

  expect(cloneAttempts).toBe(2);
  expect(fs.existsSync(path.join(mirrorDir, "HEAD"))).toBe(true);
  expect(fs.existsSync(incomingDir)).toBe(false);
  expect(calls.some((argv) => argv.includes("set-url"))).toBe(true);
  expect(calls.some((argv) => argv.includes("fetch"))).toBe(true);
});

function resolver(objects: Record<string, string>) {
  const queries: string[] = [];
  let ensured = 0;
  const run = async (argv: string[]): Promise<string> => {
    const query = argv.at(-1)!;
    queries.push(query);
    const resolved = objects[query];
    if (resolved === undefined) throw new Error("fatal: Needed a single revision");
    return resolved;
  };
  return { queries, run, ensureMirror: async () => { ensured += 1; }, ensuredCount: () => ensured };
}

test("a canonical branch ref resolves to the tip commit the mirror holds", async () => {
  const tip = "a".repeat(40);
  const fixture = resolver({ "refs/heads/main^{commit}": tip, "refs/heads/agent/lane^{commit}": "b".repeat(40) });

  await expect(resolveCanonicalRevision("origin/main", { mirrorDir: "/mirror", remote: "ssh://canonical" }, fixture)).resolves.toBe(tip);
  await expect(resolveCanonicalRevision("refs/heads/main", { mirrorDir: "/mirror", remote: "ssh://canonical" }, fixture)).resolves.toBe(tip);
  await expect(resolveCanonicalRevision("refs/heads/agent/lane", { mirrorDir: "/mirror", remote: "ssh://canonical" }, fixture)).resolves.toBe("b".repeat(40));
  expect(fixture.ensuredCount()).toBe(3);
});

test("an exact revision is peeled to a commit, so a well-formed SHA the mirror lacks is a miss (#1032)", async () => {
  const present = "c".repeat(40);
  const absent = "d".repeat(40);
  const fixture = resolver({ [`${present}^{commit}`]: present });

  await expect(resolveCanonicalRevision(present, { mirrorDir: "/mirror", remote: "ssh://canonical" }, fixture)).resolves.toBe(present);
  await expect(resolveCanonicalRevision(absent, { mirrorDir: "/mirror", remote: "ssh://canonical" }, fixture))
    .rejects.toThrow(`revision ${absent} not found in the canonical repository (fetched from ssh://canonical)`);
  expect(fixture.queries).toEqual([`${present}^{commit}`, `${absent}^{commit}`]);
});

test("a request that names neither a branch of the canonical repository nor a SHA never reaches git", async () => {
  const fixture = resolver({});

  for (const requested of ["refs/tags/v1", "main", "HEAD", "refs/heads/main~1", "--upload-pack=touch"]) {
    await expect(resolveCanonicalRevision(requested, { mirrorDir: "/mirror", remote: "ssh://canonical" }, fixture))
      .rejects.toThrow("deployment revision must be origin/main, a canonical branch ref, or a full commit SHA");
  }
  expect(fixture.queries).toEqual([]);
  expect(fixture.ensuredCount()).toBe(0);
});

/* #2220: a flaky resolver refused two deploy_exact_sha calls at once with
   "Could not resolve host: github.com". The mirror is real here, fetched from
   a local canonical repository, and only the resolver's answer is injected. */
function canonicalFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-canonical-dns-"));
  sandboxes.push(root);
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString() || `git ${args[0]} failed`);
    return result.stdout.toString().trim();
  };
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  git(source, "init", "--initial-branch=main");
  git(source, "-c", "user.name=Fixture", "-c", "user.email=noreply@example.com", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "release");
  const head = git(source, "rev-parse", "HEAD");
  const deploymentDir = path.join(root, "deployments");
  const mirrorDir = path.join(deploymentDir, "canonical.git");
  const run = async (argv: string[]): Promise<string> => {
    const [command, ...args] = argv;
    if (command !== "git") throw new Error(`unexpected command ${command}`);
    return git(root, ...args);
  };
  return { root, source, head, deploymentDir, mirrorDir, run };
}

const DNS_REFUSAL = "fatal: unable to access 'https://github.com/example/delegatus.git/': Could not resolve host: github.com";

test("a fetch the resolver failed once is retried and the deploy resolves its revision (#2220)", async () => {
  const fixture = canonicalFixture();
  const options = { deploymentDir: fixture.deploymentDir, mirrorDir: fixture.mirrorDir, remote: fixture.source };
  let fetches = 0;
  const retries: string[] = [];
  const sleeps: number[] = [];
  const run = async (argv: string[]) => {
    if (argv.includes("fetch") && ++fetches === 1) throw new Error(DNS_REFUSAL);
    return fixture.run(argv);
  };
  const dependencies = {
    run,
    sleep: async (ms: number) => { sleeps.push(ms); },
    onRetry: (detail: string) => { retries.push(detail); },
  };
  const revision = await resolveCanonicalRevision("origin/main", options, {
    ...dependencies,
    ensureMirror: () => ensureCanonicalMirror(options, dependencies),
  });
  expect(revision).toBe(fixture.head);
  expect(fetches).toBe(2);
  expect(sleeps).toEqual([2_000]);
  expect(retries).toHaveLength(1);
  expect(retries[0]).toContain("DNS lookup of github.com failed");
});

test("a resolver that never answers fails the deploy naming the host, the attempts and the fix (#2220)", async () => {
  const fixture = canonicalFixture();
  const options = { deploymentDir: fixture.deploymentDir, mirrorDir: fixture.mirrorDir, remote: fixture.source };
  let fetches = 0;
  const sleeps: number[] = [];
  const run = async (argv: string[]) => {
    if (argv.includes("fetch")) { fetches += 1; throw new Error(DNS_REFUSAL); }
    return fixture.run(argv);
  };
  const failure = ensureCanonicalMirror(options, { run, sleep: async (ms: number) => { sleeps.push(ms); } });
  await expect(failure).rejects.toThrow(/DNS lookup of github\.com failed on 3 attempts/);
  await expect(failure).rejects.toThrow(/Could not resolve host: github\.com/);
  await expect(failure).rejects.toThrow(/retry the deploy once the network resolves the host/);
  expect(fetches).toBe(3);
  expect(sleeps).toEqual([2_000, 4_000]);
});

test("a refused login or a missing repository fails the fetch at once, never retried (#2220)", async () => {
  for (const refusal of [
    "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/example/delegatus.git/'",
    "remote: Repository not found.\nfatal: repository 'https://github.com/example/missing.git/' not found",
  ]) {
    const fixture = canonicalFixture();
    const options = { deploymentDir: fixture.deploymentDir, mirrorDir: fixture.mirrorDir, remote: fixture.source };
    let fetches = 0;
    const run = async (argv: string[]) => {
      if (argv.includes("fetch")) { fetches += 1; throw new Error(refusal); }
      return fixture.run(argv);
    };
    await expect(ensureCanonicalMirror(options, { run, sleep: async () => {} })).rejects.toThrow(refusal);
    expect(fetches).toBe(1);
  }
});
