import { afterAll, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { boardFor, patchBoard } from "@/lib/board/store";
import { appendLifecycleEvents, readLifecycleJournal } from "@/lib/lifecycle/journal";
import { discoverFilesWithProjectCatalog } from "@/lib/scanner/discover";
import { projectInfoFromCwd } from "@/lib/scanner/describe";
import { projectCatalogSnapshotFromRaw } from "@/lib/scanner/projectCatalog";
import { stateDatabaseSignature } from "@/lib/state/sqliteStateStore";
import { checkpointLegacyCollectionMirrorsForDemotion } from "@/lib/state/legacyCollections";
import { closeStateMutationActivationForTests, withStateMutationActivation } from "@/lib/state/stateMutationBarrier";
import { completeViewerRuntimeActivation } from "@/lib/viewerInstrumentation";
import { canonicalProject, resetProjectAliasesForTests } from "./aliases";
import { directoryProjectId, projectIdentityFromRepositoryRoot } from "./identity";
import { backfillWorktreeProjects, recoverWorktreeProjects, runWorktreeRecoveryAtStartup } from "./worktreeBackfill";
import { checkpointWorktreeRecoveryForDemotion, readWorktreeRecoveries } from "./worktreeRecoveryStore";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "automatic-worktree-recovery-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let serial = 0;
const longRepositoryName = "automatic-worktree-project-recovery-for-legacy-transcripts-and-preserved-board-preference-regression";
function fixture(defaultState = false, repositoryName = "widgets") {
  const disk = path.join(root, String(++serial));
  const state = defaultState ? path.join(disk, "config", "delegatus", "state") : path.join(disk, "state");
  const sessions = path.join(disk, "sessions");
  const repo = path.join(disk, repositoryName);
  const remote = `https://example.invalid/team/${repositoryName}.git`;
  fs.mkdirSync(path.join(repo, ".git", "refs", "heads"), { recursive: true });
  fs.mkdirSync(state, { recursive: true }); fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(repo, ".git", "config"), `[remote "origin"]\nurl = ${remote}\n`);
  fs.writeFileSync(path.join(repo, ".git", "refs", "heads", "confirmed"), "a".repeat(40));
  process.env.LLV_STATE_DIR = state;
  resetProjectAliasesForTests();
  const identity = projectIdentityFromRepositoryRoot(repo)!;
  const files: Record<string, { project: string; cwd: string; projectRoot: string | null }> = {};
  const transcript = (cwd: string, git: Record<string, unknown> = {}) => {
    const filename = path.join(sessions, `session-${Object.keys(files).length}.jsonl`);
    fs.writeFileSync(filename, JSON.stringify({ type: "session_meta", payload: { cwd, git } }) + "\n");
    files[filename] = { cwd, project: cwd === repo ? identity.project : directoryProjectId(cwd), projectRoot: cwd === repo ? repo : null };
    return filename;
  };
  transcript(repo);
  const write = () => fs.writeFileSync(path.join(state, "project-catalog.json"), JSON.stringify({ version: 2, files }));
  const raw = () => Object.keys(files).map(filename => ({ rootName: "codex-sessions" as const, root: sessions, path: filename, st: fs.statSync(filename) }));
  const scan = () => discoverFilesWithProjectCatalog([["codex-sessions", sessions]]);
  return { state, repo, remote, identity, transcript, write, files, raw, scan };
}

function bytes(directory: string) {
  return Object.fromEntries(fs.readdirSync(directory).filter(name => fs.statSync(path.join(directory, name)).isFile())
    .map(name => [name, fs.readFileSync(path.join(directory, name))]));
}

test.each(["widgets", longRepositoryName])("Viewer activation recovers %s after hot-state activation and before controllers, once without replay writes", async repositoryName => {
  const f = fixture(false, repositoryName);
  const cwd = f.repo + "-review";
  f.transcript(cwd, { repository_url: f.remote }); f.write();
  const source = directoryProjectId(cwd);
  const board = path.join(f.state, "board.json");
  expect(patchBoard(source, 0, { manual: ["conversation_old"] }, board).ok).toBe(true);
  const order: string[] = [];
  let scans = 0;
  const startup = () => runWorktreeRecoveryAtStartup(message => { throw Error(String(message)); }, async () => { scans++; await f.scan(); });
  await completeViewerRuntimeActivation({
    initializeOperatorCapability: async () => { order.push("capability"); },
    publishHotStateActivation: () => { order.push("fence"); },
    runWorktreeRecovery: async () => { order.push("recovery"); await startup(); },
    startStructuredHosts: null, startControllers: async () => {
      expect(canonicalProject(source)).toBe(f.identity.project); order.push("controllers");
    }, publishViewerReleaseReady: () => { order.push("ready"); },
  });
  expect(order).toEqual(["capability", "fence", "recovery", "controllers", "ready"]);
  expect(scans).toBe(1);
  expect(boardFor(f.identity.project, board).prefs.manual).toEqual(["conversation_old"]);
  expect(projectInfoFromCwd(cwd)?.project).toBe(f.identity.project);
  const journal = readLifecycleJournal();
  expect(journal.events).toHaveLength(1);
  expect(journal.events[0]?.summary).toContain("sibling-name-and-repository-hint");
  expect(journal.events[0]?.summary).toContain("startup");
  expect(journal.events[0]?.summary).toContain(source);
  expect(journal.events[0]?.summary).toContain(f.identity.project);
  expect(journal.events[0]!.summary.length).toBeLessThanOrEqual(200);
  const before = bytes(f.state);
  await startup();
  expect(scans).toBe(1);
  expect(bytes(f.state)).toEqual(before);
  expect(readLifecycleJournal()).toEqual(journal);
  // The next ordinary journal append preserves the recovery event and cursor.
  appendLifecycleEvents([{ key: "later", type: "project_moved", at: new Date().toISOString(), project: f.identity.project, summary: "Later move" }]);
  expect(readLifecycleJournal().events.map(event => event.seq)).toEqual([1, 2]);
  const resolver = path.resolve("src/lib/scanner/describe.ts");
  const history = path.resolve("src/lib/lifecycle/journal.ts");
  const child = Bun.spawnSync([process.execPath, "-e", `
    const { projectInfoFromCwd } = await import(${JSON.stringify(resolver)});
    const { readLifecycleJournal } = await import(${JSON.stringify(history)});
    console.log(JSON.stringify({ project: projectInfoFromCwd(${JSON.stringify(cwd)})?.project, events: readLifecycleJournal().events.length }));
  `], { cwd: process.cwd(), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual({ project: f.identity.project, events: 2 });
});

test.each(["widgets", longRepositoryName])("a full rescan recovers %s with new evidence and returns the folded catalog in that same scan", async repositoryName => {
  const f = fixture(false, repositoryName);
  const hinted = f.repo + "-review";
  const branch = f.repo + "-lane-7";
  f.transcript(hinted, { repository_url: f.remote });
  f.transcript(branch, { branch: "confirmed" });
  const first = await f.scan();
  expect(first.complete).toBe(true);
  expect(first.projectCatalog.map(entry => entry.project)).toEqual([f.identity.project]);
  expect(first.files.every(file => file.project === f.identity.project)).toBe(true);
  expect(readWorktreeRecoveries().map(row => row.event.summary).join("\n")).toContain("sibling-name-and-branch-hint");
  expect(readLifecycleJournal().events).toHaveLength(2);
  expect(readLifecycleJournal().events.every(event => event.summary.includes("rescan"))).toBe(true);
  expect(readLifecycleJournal().events[0]?.summary).toContain("sibling-name-and-repository-hint");
  for (const cwd of [hinted, branch]) {
    const summary = readLifecycleJournal().events.find(event => event.summary.includes(directoryProjectId(cwd)))!.summary;
    expect(summary).toContain(f.identity.project);
    expect(summary.length).toBeLessThanOrEqual(200);
  }
  const later = f.repo + "-pipeline-new";
  f.transcript(later, { branch: "confirmed" });
  await f.scan();
  expect(canonicalProject(directoryProjectId(later))).toBe(f.identity.project);
  expect(readLifecycleJournal().events).toHaveLength(3);
  const before = bytes(f.state);
  expect(recoverWorktreeProjects("rescan").folded).toEqual([]);
  expect(bytes(f.state)).toEqual(before);
});

test("no evidence and conflict stay alone at startup and full rescans without recovery writes", async () => {
  const f = fixture();
  const nameOnly = f.repo + "-review";
  const unproven = f.repo + "-lane-7";
  const conflicting = f.repo + "-lane-8";
  f.transcript(nameOnly); f.transcript(unproven, { branch: "missing" });
  f.transcript(conflicting, { repository_url: "https://example.invalid/team/foreign.git" });
  f.write();
  const before = bytes(f.state);
  const result = recoverWorktreeProjects("startup");
  expect(result.folded).toEqual([]);
  expect(result.leftAlone.map(item => item.reason)).toEqual(["missing-native-evidence", "unproven-branch-hint", "conflicting-repository-hint"]);
  expect(bytes(f.state)).toEqual(before);
  await f.scan();
  for (const cwd of [nameOnly, unproven, conflicting]) expect(projectInfoFromCwd(cwd)?.project).toBe(directoryProjectId(cwd));
  expect(readWorktreeRecoveries()).toEqual([]);
  expect(readLifecycleJournal().events).toEqual([]);
  const afterScan = bytes(f.state);
  expect(recoverWorktreeProjects("rescan").folded).toEqual([]);
  expect(bytes(f.state)).toEqual(afterScan);
});

test("partial and read-only catalog scans leave confirmed candidates for the next full rescan", async () => {
  const f = fixture(); const cwd = f.repo + "-review";
  f.transcript(cwd, { branch: "confirmed" });
  await projectCatalogSnapshotFromRaw(f.raw(), { complete: false });
  expect(readWorktreeRecoveries()).toEqual([]);
  await projectCatalogSnapshotFromRaw(f.raw(), { persist: false });
  expect(readWorktreeRecoveries()).toEqual([]);
  await f.scan();
  expect(canonicalProject(directoryProjectId(cwd))).toBe(f.identity.project);
});

test("a failed SQLite board commit rolls back mappings, aliases and journal together, then rescan retries", async () => {
  const f = fixture();
  const a = f.repo + "-review", b = f.repo + "-lane-7";
  for (const cwd of [a, b]) {
    f.transcript(cwd, { branch: "confirmed" });
    expect(patchBoard(directoryProjectId(cwd), 0, { manual: [path.basename(cwd)] }, path.join(f.state, "board.json")).ok).toBe(true);
  }
  f.write();
  const database = new Database(path.join(f.state, "state.sqlite"));
  database.exec("CREATE TRIGGER recovery_commit_failure BEFORE DELETE ON state_rows WHEN OLD.collection = 'board' BEGIN SELECT RAISE(ABORT, 'induced board failure'); END");
  try {
    expect(() => recoverWorktreeProjects("startup")).toThrow();
    expect(readWorktreeRecoveries()).toEqual([]);
    expect(readLifecycleJournal().events).toEqual([]);
    for (const cwd of [a, b]) {
      const source = directoryProjectId(cwd);
      expect(canonicalProject(source)).toBe(source);
      expect(projectInfoFromCwd(cwd)?.project).toBe(source);
      expect(boardFor(source, path.join(f.state, "board.json")).prefs.manual).toEqual([path.basename(cwd)]);
    }
    database.exec("DROP TRIGGER recovery_commit_failure");
  } finally { database.close(); }
  await f.scan();
  expect(readWorktreeRecoveries()).toHaveLength(2);
  expect(readLifecycleJournal().events).toHaveLength(2);
  expect(boardFor(f.identity.project, path.join(f.state, "board.json")).prefs.manual.sort()).toEqual([path.basename(a), path.basename(b)].sort());
});

test("startup failure is deferred and retried on the next startup with no lost audit reason", async () => {
  const f = fixture(); const cwd = f.repo + "-review";
  f.transcript(cwd, { branch: "confirmed" }); f.write();
  const journal = path.join(f.state, "lifecycle-journal.json");
  fs.writeFileSync(journal, "broken");
  const logs: unknown[] = [];
  await runWorktreeRecoveryAtStartup(message => logs.push(message), async () => {});
  expect(logs).toHaveLength(1);
  expect(readWorktreeRecoveries()).toEqual([]);
  expect(canonicalProject(directoryProjectId(cwd))).toBe(directoryProjectId(cwd));
  fs.writeFileSync(journal, JSON.stringify({ version: 1, lastSeq: 0, events: [], retired: [] }));
  await runWorktreeRecoveryAtStartup(message => logs.push(message), async () => {});
  expect(readLifecycleJournal().events[0]?.summary).toContain("sibling-name-and-branch-hint");
  expect(logs).toHaveLength(1);
});

test.each([undefined, "tool", "mcp", "launcher", "deploy-adapter"])("automatic recovery refuses operator state for owner %s before reading any file", owner => {
  const names = ["LLV_STATE_DIR", "LLV_STATE_OWNER", "HOME", "XDG_CONFIG_HOME", "NODE_ENV"] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  // An operator-shaped synthetic root; the fence must refuse before any I/O.
  process.env.HOME = "/srv/recovery-fence-fixture";
  process.env.XDG_CONFIG_HOME = "/srv/recovery-fence-fixture/config";
  Object.assign(process.env, { NODE_ENV: "production" });
  process.env.LLV_STATE_DIR = path.join(process.env.XDG_CONFIG_HOME, "delegatus", "state");
  if (owner) process.env.LLV_STATE_OWNER = owner; else delete process.env.LLV_STATE_OWNER;
  try { expect(() => recoverWorktreeProjects("startup")).toThrow('refusing to run the state startup step "worktree project recovery"'); }
  finally {
    for (const name of names) if (previous[name] === undefined) delete process.env[name]; else Object.assign(process.env, { [name]: previous[name] });
  }
});

test("missing startup catalog and repeated dry-run diagnostics initialize nothing", async () => {
  const f = fixture();
  const before = bytes(f.state);
  expect(recoverWorktreeProjects("startup").folded).toEqual([]);
  expect(bytes(f.state)).toEqual(before);
  f.transcript(f.repo + "-review", { branch: "confirmed" }); f.write();
  const signature = stateDatabaseSignature(path.join(f.state, "state.sqlite"));
  expect((await backfillWorktreeProjects()).folded).toHaveLength(1);
  expect((await backfillWorktreeProjects()).folded).toHaveLength(1);
  expect(stateDatabaseSignature(path.join(f.state, "state.sqlite"))).toBe(signature);
  expect(fs.readdirSync(f.state)).toEqual(["project-catalog.json"]);
});


test("startup folds an older directory project using only its agreeing durable mapping", async () => {
  const f = fixture(); const cwd = path.join(path.dirname(f.repo), "arbitrary-old-checkout");
  f.transcript(cwd); f.write();
  fs.writeFileSync(path.join(f.state, "worktree-map.json"), JSON.stringify({ [cwd]: { repo: f.repo, worktree: "arbitrary" } }));
  await runWorktreeRecoveryAtStartup(message => { throw Error(String(message)); }, async () => { await f.scan(); });
  expect(readLifecycleJournal().events[0]?.summary).toContain("recorded-worktree");
  expect(canonicalProject(directoryProjectId(cwd))).toBe(f.identity.project);
  expect(projectInfoFromCwd(path.join(cwd, "nested"))?.project).toBe(f.identity.project);
});


test("a failed startup catalog refresh retries on the next startup without repeating the fold", async () => {
  const f = fixture(); const cwd = f.repo + "-review";
  f.transcript(cwd, { branch: "confirmed" }); f.write();
  let scans = 0; const logs: unknown[] = [];
  await runWorktreeRecoveryAtStartup(message => logs.push(message), async () => { scans++; throw Error("induced rescan failure"); });
  expect(logs).toHaveLength(1);
  expect(readWorktreeRecoveries()).toHaveLength(1);
  expect(canonicalProject(directoryProjectId(cwd))).toBe(f.identity.project);
  await runWorktreeRecoveryAtStartup(message => logs.push(message), async () => { scans++; await f.scan(); });
  expect(scans).toBe(2);
  expect(readLifecycleJournal().events).toHaveLength(1);
  expect(logs).toHaveLength(1);
  const before = bytes(f.state);
  await runWorktreeRecoveryAtStartup(message => logs.push(message), async () => { throw Error("unneeded rescan"); });
  expect(bytes(f.state)).toEqual(before);
});


test("globally ambiguous repositories remain separate during automatic startup and a full rescan", async () => {
  const f = fixture(); const other = f.repo + "-v1";
  fs.mkdirSync(path.join(other, ".git", "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(other, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(other, ".git", "config"), '[remote "origin"]\nurl = https://example.invalid/team/other.git\n');
  fs.writeFileSync(path.join(other, ".git", "refs", "heads", "confirmed"), "a".repeat(40));
  const otherFile = f.transcript(other);
  f.files[otherFile] = { cwd: other, project: projectIdentityFromRepositoryRoot(other)!.project, projectRoot: other };
  const cwd = other + "-review";
  f.transcript(cwd, { branch: "confirmed" }); f.write();
  const before = bytes(f.state);
  expect(recoverWorktreeProjects("startup").leftAlone[0]?.reason).toBe("ambiguous-repository");
  expect(bytes(f.state)).toEqual(before);
  await f.scan();
  expect(canonicalProject(directoryProjectId(cwd))).toBe(directoryProjectId(cwd));
  expect(readWorktreeRecoveries()).toEqual([]);
});

test("a withdrawn release fence refuses the atomic recovery and the current release can retry", () => {
  const f = fixture(); const cwd = f.repo + "-review";
  f.transcript(cwd, { branch: "confirmed" }); f.write();
  const source = directoryProjectId(cwd);
  expect(patchBoard(source, 0, { manual: ["conversation_old"] }, path.join(f.state, "board.json")).ok).toBe(true);
  const previous = process.env.LLV_HOT_STATE_RELEASE_REVISION;
  const revision = "a".repeat(40);
  process.env.LLV_HOT_STATE_RELEASE_REVISION = revision;
  fs.writeFileSync(path.join(f.state, "viewer-release.json"), JSON.stringify({ endpoint: "http://127.0.0.1:1", revision, hotStateBackend: "sqlite-v1" }));
  const authority = path.join(f.state, "hot-state-authority.json");
  const writeAuthority = (mode: string) => fs.writeFileSync(authority, JSON.stringify({ schemaVersion: 1, epoch: 1, mode, releaseRevision: revision, updatedAt: new Date().toISOString() }));
  try {
    writeAuthority("fencing");
    expect(() => recoverWorktreeProjects("startup")).toThrow();
    expect(canonicalProject(source)).toBe(source);
    expect(readWorktreeRecoveries()).toEqual([]);
    expect(readLifecycleJournal().events).toEqual([]);
    expect(boardFor(source, path.join(f.state, "board.json")).prefs.manual).toEqual(["conversation_old"]);
    writeAuthority("sqlite");
    expect(recoverWorktreeProjects("startup").folded).toHaveLength(1);
    expect(canonicalProject(source)).toBe(f.identity.project);
  } finally {
    if (previous === undefined) delete process.env.LLV_HOT_STATE_RELEASE_REVISION; else process.env.LLV_HOT_STATE_RELEASE_REVISION = previous;
  }
});


test("a complete request index refresh recovers projects and returns their canonical grouping", async () => {
  const f = fixture(); const cwd = f.repo + "-review";
  f.transcript(cwd, { branch: "confirmed" });
  const sessions = path.dirname(Object.keys(f.files)[0]!);
  const snapshot = await discoverFilesWithProjectCatalog([["codex-sessions", sessions]], undefined, { persist: false, persistIndex: true });
  expect(snapshot.complete).toBe(true);
  expect(snapshot.projectCatalog.map(entry => entry.project)).toEqual([f.identity.project]);
  expect(snapshot.files.every(file => file.project === f.identity.project)).toBe(true);
  expect(readLifecycleJournal().events[0]?.summary).toContain("rescan");
});

test("demotion preserves long-name recovery through a preceding-release catalog scan and journal append", async () => {
  const f = fixture(false, longRepositoryName); const cwd = f.repo + "-review";
  f.transcript(cwd, { repository_url: f.remote }); f.write();
  const source = directoryProjectId(cwd);
  const boardFile = path.join(f.state, "board.json");
  expect(patchBoard(source, 0, { manual: ["conversation_old"] }, boardFile).ok).toBe(true);
  await runWorktreeRecoveryAtStartup(message => { throw Error(String(message)); }, async () => { await f.scan(); });
  const recovery = readLifecycleJournal().events[0]!;
  expect(f.identity.displayName).toHaveLength(100);
  expect(recovery.summary).toContain("sibling-name-and-repository-hint");
  expect(recovery.summary).toContain(source);
  expect(recovery.summary).toContain(f.identity.project);
  expect(recovery.summary.length).toBeLessThanOrEqual(200);
  // Preserve unrelated legacy entries as well as the newly committed rows.
  const mapFile = path.join(f.state, "worktree-map.json");
  fs.writeFileSync(mapFile, JSON.stringify({ unrelated: { repo: f.repo, worktree: "unrelated" } }));
  await checkpointLegacyCollectionMirrorsForDemotion();
  expect(JSON.parse(fs.readFileSync(mapFile, "utf8"))).toEqual({
    unrelated: { repo: f.repo, worktree: "unrelated" }, [cwd]: { repo: f.repo, worktree: `${longRepositoryName}-review` },
  });
  const projected = bytes(f.state);
  await checkpointWorktreeRecoveryForDemotion();
  expect(bytes(f.state)).toEqual(projected);

  // Run the retained release's actual readers, rather than a mock of their
  // formats. Export only its runtime sources into this test's private root.
  const retained = path.join(root, "retained-release");
  fs.mkdirSync(retained);
  const archive = Bun.spawnSync(["git", "archive", "39f654248666faa6e5deb01d59eeae305e64573f", "src", "bin", "tsconfig.json", "package.json"],
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  expect(archive.exitCode).toBe(0);
  const extract = Bun.spawnSync(["tar", "-x", "-C", retained], { stdin: archive.stdout, stdout: "pipe", stderr: "pipe" });
  expect(extract.exitCode).toBe(0);
  fs.symlinkSync(path.resolve("node_modules"), path.join(retained, "node_modules"), "junction");
  const child = Bun.spawnSync([process.execPath, "-e", `
    const { discoverFilesWithProjectCatalog } = await import("./src/lib/scanner/discover.ts");
    const { boardFor } = await import("./src/lib/board/store.ts");
    const { appendLifecycleEvents, readLifecycleJournal } = await import("./src/lib/lifecycle/journal.ts");
    const scan = await discoverFilesWithProjectCatalog([["codex-sessions", ${JSON.stringify(path.dirname(Object.keys(f.files)[0]!))}]]);
    const before = readLifecycleJournal();
    appendLifecycleEvents([{ key: "retained-release-event", type: "project_moved", at: new Date().toISOString(), summary: "Retained release event" }]);
    console.log(JSON.stringify({ complete: scan.complete, projects: scan.projectCatalog.map(row => row.project),
      sourceManual: boardFor(${JSON.stringify(source)}, ${JSON.stringify(boardFile)}).prefs.manual,
      targetManual: boardFor(${JSON.stringify(f.identity.project)}, ${JSON.stringify(boardFile)}).prefs.manual,
      before, after: readLifecycleJournal() }));
  `], { cwd: retained, env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  expect(child.stderr.toString()).toBe("");
  expect(child.exitCode).toBe(0);
  const old = JSON.parse(child.stdout.toString());
  expect(old.complete).toBe(true);
  expect(old.projects).toEqual([f.identity.project]);
  expect(old.sourceManual).toEqual(["conversation_old"]);
  expect(old.targetManual).toEqual(["conversation_old"]);
  expect(old.before.lastSeq).toBe(recovery.seq);
  expect(old.before.events).toEqual([recovery]);
  expect(old.after.events.map((event: { seq: number }) => event.seq)).toEqual([recovery.seq, recovery.seq + 1]);

  // Return to the candidate against the state the old release actually wrote.
  await f.scan();
  expect(canonicalProject(source)).toBe(f.identity.project);
  expect(projectInfoFromCwd(path.join(cwd, "nested"))?.project).toBe(f.identity.project);
  expect(boardFor(source, boardFile).prefs.manual).toEqual(["conversation_old"]);
  expect(boardFor(f.identity.project, boardFile).prefs.manual).toEqual(["conversation_old"]);
  expect(readLifecycleJournal()).toEqual(old.after);
  const beforeRetry = bytes(f.state);
  expect(recoverWorktreeProjects("startup").folded).toEqual([]);
  expect(bytes(f.state)).toEqual(beforeRetry);
}, 30_000);

test.each(["worktree-map.json", "project-aliases.json", "lifecycle-journal.json"])("demotion refuses unreadable %s before publishing recovery, then retries", async filename => {
  const f = fixture(); const cwd = f.repo + "-review";
  f.transcript(cwd, { branch: "confirmed" }); f.write();
  recoverWorktreeProjects("startup");
  readWorktreeRecoveries(); // Warm the read-only SQLite connection before the byte snapshot.
  const file = path.join(f.state, filename);
  fs.writeFileSync(file, "broken");
  const before = bytes(f.state);
  await expect(checkpointWorktreeRecoveryForDemotion()).rejects.toThrow();
  expect(bytes(f.state)).toEqual(before);
  fs.unlinkSync(file);
  await checkpointWorktreeRecoveryForDemotion();
  expect(readLifecycleJournal().events).toHaveLength(1);
  expect(canonicalProject(directoryProjectId(cwd))).toBe(f.identity.project);
});

test("demotion recovery projection is refused during a build and a no-recovery checkpoint initializes nothing", async () => {
  const f = fixture();
  const before = bytes(f.state);
  await checkpointWorktreeRecoveryForDemotion();
  expect(bytes(f.state)).toEqual(before);
  f.transcript(f.repo + "-review", { branch: "confirmed" }); f.write();
  recoverWorktreeProjects("startup");
  readWorktreeRecoveries();
  const recovered = bytes(f.state);
  const previous = process.env.NEXT_PHASE;
  process.env.NEXT_PHASE = "phase-production-build";
  try { await expect(checkpointWorktreeRecoveryForDemotion()).rejects.toThrow("build phase"); }
  finally {
    if (previous === undefined) delete process.env.NEXT_PHASE; else process.env.NEXT_PHASE = previous;
  }
  expect(bytes(f.state)).toEqual(recovered);
});

test("the adapter projects recovery only within its demotion activation scope", async () => {
  const f = fixture(true); const cwd = f.repo + "-review";
  f.transcript(cwd, { branch: "confirmed" }); f.write();
  recoverWorktreeProjects("startup");
  readWorktreeRecoveries();
  const before = bytes(f.state);
  const names = ["LLV_STATE_DIR", "XDG_CONFIG_HOME", "LLV_STATE_OWNER"] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  delete process.env.LLV_STATE_DIR;
  process.env.XDG_CONFIG_HOME = path.dirname(path.dirname(f.state));
  process.env.LLV_STATE_OWNER = "deploy-adapter";
  closeStateMutationActivationForTests();
  try {
    await expect(checkpointWorktreeRecoveryForDemotion()).rejects.toThrow("release activation");
    expect(bytes(f.state)).toEqual(before);
    await withStateMutationActivation(checkpointWorktreeRecoveryForDemotion);
    const projected = bytes(f.state);
    expect(JSON.parse(fs.readFileSync(path.join(f.state, "lifecycle-journal.json"), "utf8")).lastSeq).toBe(1);
    await expect(checkpointWorktreeRecoveryForDemotion()).rejects.toThrow("release activation");
    expect(bytes(f.state)).toEqual(projected);
  } finally {
    for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
  }
});

test("a failed mirror write blocks demotion and retries without losing or repeating the atomic recovery", async () => {
  const f = fixture(); const cwd = f.repo + "-review";
  f.transcript(cwd, { branch: "confirmed" }); f.write();
  const source = directoryProjectId(cwd), boardFile = path.join(f.state, "board.json");
  expect(patchBoard(source, 0, { manual: ["conversation_old"] }, boardFile).ok).toBe(true);
  recoverWorktreeProjects("startup");
  const rows = structuredClone(readWorktreeRecoveries());
  const rename = fs.renameSync;
  const fault = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to === path.join(f.state, "project-aliases.json")) throw Error("induced mirror write failure");
    rename(from, to);
  });
  try { await expect(checkpointLegacyCollectionMirrorsForDemotion()).rejects.toThrow("induced mirror write failure"); }
  finally { fault.mockRestore(); }
  expect(readWorktreeRecoveries()).toEqual(rows);
  expect(boardFor(f.identity.project, boardFile).prefs.manual).toEqual(["conversation_old"]);
  expect(canonicalProject(source)).toBe(f.identity.project);
  await checkpointLegacyCollectionMirrorsForDemotion();
  expect(readLifecycleJournal().events).toEqual(rows.map(row => row.event));
  expect(readWorktreeRecoveries()).toEqual(rows);
  expect(fs.readdirSync(f.state).some(name => name.endsWith(".tmp"))).toBe(false);
});
