import { afterAll, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* A repository renamed on the forge keeps its board (rename-delegatus.md
   §2.3), and a checkout re-pointed at another repository does not merge into
   it (#2035). Every forge answer here comes from a stub; nothing leaves the
   machine. */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-forge-rename-"));
const RESTORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, LLV_STATE_DIR: process.env.LLV_STATE_DIR };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });

const { globalCache } = await import("@/lib/scanner/caches");
const { canonicalProject, recordedProjectRemote } = await import("@/lib/projects/aliases");
const {
  forgeRenameCandidateFor,
  forgeRenamesSettledForTests,
  recordForgeRenames,
  resetForgeRenameDecisionsForTests,
  setForgeLookupForTests,
} = await import("@/lib/projects/forgeRename");
const { projectCatalogSnapshotFromRaw } = await import("@/lib/scanner/projectCatalog");
const { projectForCwd } = await import("@/lib/scanner/describe");
const { readLifecycleJournal } = await import("@/lib/lifecycle/journal");
const { boardFor, patchBoard } = await import("@/lib/board/store");
const { createTask } = await import("@/lib/tasks/commands");
const { loadTasks, mutateTasks } = await import("@/lib/tasks/store");
const { executeOrchestratorSeatRequest } = await import("@/lib/orchestrator/seatCommand");
const { orchestratorSeatFor } = await import("@/lib/orchestrator/seats");
import type { ForgeLookup, ForgeRepositoryLookup } from "./forgeRename";
import type { SeatCommandDependencies } from "@/lib/orchestrator/seatCommand";
import type { RawEntry } from "@/lib/scanner/discover";

afterAll(() => {
  setForgeLookupForTests(null);
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  resetForgeRenameDecisionsForTests();
});

/* Every git change is followed by what ten seconds do in production: the cwd
   resolution cache expires, so the next read sees the folder as it now is. */
function git(...args: string[]): void {
  execFileSync("git", args, { stdio: "ignore" });
  globalCache("project-info-cwd-v2").clear();
}

function repositoryAt(name: string, remoteName: string): string {
  const repo = path.join(SANDBOX, name);
  fs.mkdirSync(repo);
  git("init", "-q", "-b", "main", repo);
  git("-C", repo, "-c", "user.email=builder@example.invalid", "-c", "user.name=builder", "commit", "-q", "--allow-empty", "-m", "init");
  git("-C", repo, "remote", "add", "origin", `https://github.com/acme/${remoteName}.git`);
  return repo;
}

const repoint = (repo: string, remoteName: string) => git("-C", repo, "remote", "set-url", "origin", `https://github.com/acme/${remoteName}.git`);

let transcriptClock = 1_700_000_000;
async function transcript(name: string, cwd: string): Promise<RawEntry> {
  const root = path.join(SANDBOX, "sessions");
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, `${name}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { cwd } }) + "\n");
  transcriptClock += 100;
  fs.utimesSync(file, transcriptClock, transcriptClock);
  return { rootName: "codex-sessions", root, path: file, st: fs.statSync(file) } as RawEntry;
}

/** A forge that knows the repositories in `ids` (full name → numeric id);
    a name it does not know is answered with a 404. */
function forge(ids: Record<string, number | "unreachable">): ForgeLookup & { asked: string[] } {
  const asked: string[] = [];
  const lookup = async (fullName: string): Promise<ForgeRepositoryLookup> => {
    asked.push(fullName);
    const id = ids[fullName];
    if (id === "unreachable") return { status: "unreachable" };
    return id === undefined ? { status: "missing" } : { status: "found", id };
  };
  return Object.assign(lookup, { asked });
}

async function scan(entries: RawEntry[]) {
  const snapshot = await projectCatalogSnapshotFromRaw(entries);
  await forgeRenamesSettledForTests();
  return snapshot;
}

const moved = (project: string) => readLifecycleJournal().events
  .filter((event) => event.type === "project_moved" && event.project === project);

const SEAT = ["conversation", ["44444444", "4444", "4444", "8444", "444444444444"].join("-")].join("_");

function seatDependencies(): SeatCommandDependencies {
  return {
    spawn: async () => ({ status: 200, body: { ok: true, state: "settled", conversationId: SEAT, path: path.join(SANDBOX, "seat.jsonl"), launchId: "launch_seat" } }),
    deliver: async () => ({ ok: true, outcome: "delivered" }),
    conversationTarget: () => null,
    stampRegistryIdentity: () => {},
    projectTasks: () => [],
    summarizeHandoffs: async () => ({ kind: "fallback", reason: "unavailable" }),
    launchSettlement: () => ({ kind: "unknown" }),
    runtimeIdentity: () => ({ engine: null, model: null }),
    resolvedConversation: () => null,
    now: () => new Date().toISOString(),
  };
}

test("a renamed repository keeps its board", async () => {
  const repo = repositoryAt("widgets", "old-widgets");
  const old = projectForCwd(repo)!;
  const forgeAnswers = forge({ "acme/old-widgets": 4242, "acme/delegated-widgets": 4242 });
  setForgeLookupForTests(forgeAnswers);

  /* Everything the project holds, written under the old key. */
  const designated = await executeOrchestratorSeatRequest(
    { project: old, cwd: repo, mandate: "run the board", clientRequestId: "forge-rename-designate" },
    seatDependencies(),
  );
  expect(designated.status).toBe(200);
  const created = mutateTasks((tasks) => {
    const result = createTask(tasks, { project: old, text: "Keep the widgets moving", placement: "unplaced" });
    return { tasks: result.ok ? result.tasks : undefined, result };
  });
  expect(created.ok).toBe(true);
  expect(patchBoard(old, 0, { manual: ["/widgets/first"] })).toMatchObject({ ok: true });

  /* The first scan fills the ledger with the remote behind the old key. */
  const before = await transcript("widgets-before", repo);
  await scan([before]);
  expect(recordedProjectRemote(old)).toBe("github.com/acme/old-widgets");

  /* The repository is renamed on the forge and the checkout's origin follows. */
  repoint(repo, "delegated-widgets");
  const renamed = projectForCwd(repo)!;
  expect(renamed).not.toBe(old);
  const after = await transcript("widgets-after", repo);
  await scan([before, after]);

  expect(canonicalProject(old)).toBe(renamed);
  expect(orchestratorSeatFor(renamed).active?.conversationId).toBe(SEAT);
  expect(loadTasks().filter((task) => task.text === "Keep the widgets moving").map((task) => task.project)).toEqual([renamed]);
  expect(boardFor(renamed).prefs.manual).toEqual(["/widgets/first"]);
  expect(moved(renamed)).toHaveLength(1);
  expect(moved(renamed)[0]!.summary).toContain(old);

  /* A replay records nothing and asks nobody. */
  const asked = forgeAnswers.asked.length;
  await scan([before, after]);
  expect(await recordForgeRenames([forgeRenameCandidateFor(old, repo)], forgeAnswers)).toEqual([]);
  expect(moved(renamed)).toHaveLength(1);
  expect(forgeAnswers.asked).toHaveLength(asked);

  /* The next scan groups both conversations under the one project. */
  const joined = await scan([before, after]);
  expect(joined.projectCatalog.map((entry) => entry.project)).toEqual([renamed]);
});

test("a re-pointed fork does not merge", async () => {
  const repo = repositoryAt("gadgets", "gadgets");
  const original = projectForCwd(repo)!;
  const forgeAnswers = forge({ "acme/gadgets": 5100, "acme/gadgets-fork": 5200 });
  setForgeLookupForTests(forgeAnswers);
  const before = await transcript("gadgets-before", repo);
  await scan([before]);

  repoint(repo, "gadgets-fork");
  const fork = projectForCwd(repo)!;
  const after = await transcript("gadgets-after", repo);
  /* The conversation from before the re-point keeps going, and the Viewer
     restarted in between (its in-memory head caches are gone), so the scan
     re-describes the file under the fork's key: the catalog evidence that
     merged a fork into the repository it replaced (#2035). */
  for (const cache of ["meta-transcript-v7", "project-overlay-v2", "title-v5"]) globalCache(cache).clear();
  fs.appendFileSync(before.path, JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "still here" } }) + "\n");
  fs.utimesSync(before.path, transcriptClock + 50, transcriptClock + 50);
  const grown = { ...before, st: fs.statSync(before.path) } as RawEntry;
  const split = await scan([grown, after]);

  expect(forgeAnswers.asked.sort()).toEqual(["acme/gadgets", "acme/gadgets-fork"]);
  expect(canonicalProject(original)).toBe(original);
  expect(moved(fork)).toEqual([]);
  expect(split.projectCatalog.map((entry) => entry.project)).toEqual([fork]);
});

test("a re-pointed fork whose old key predates the ledger does not merge, and nobody is asked", async () => {
  /* The upgrade path: the ledger is new, so a key recorded before it has no
     remote behind it. A re-pointed checkout's grown conversation is still
     re-described under the fork's key, and that alone must not alias. */
  const repo = repositoryAt("gizmos", "gizmos");
  const original = projectForCwd(repo)!;
  const forgeAnswers = forge({ "acme/gizmos": 6100, "acme/gizmos-fork": 6200 });
  setForgeLookupForTests(forgeAnswers);
  const before = await transcript("gizmos-before", repo);
  await scan([before]);
  fs.rmSync(path.join(process.env.LLV_STATE_DIR!, "project-remotes.json"), { force: true });
  expect(recordedProjectRemote(original)).toBeNull();

  repoint(repo, "gizmos-fork");
  const fork = projectForCwd(repo)!;
  for (const cache of ["meta-transcript-v7", "project-overlay-v2", "title-v5"]) globalCache(cache).clear();
  fs.appendFileSync(before.path, JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "still here" } }) + "\n");
  fs.utimesSync(before.path, transcriptClock + 50, transcriptClock + 50);
  const grown = { ...before, st: fs.statSync(before.path) } as RawEntry;
  const scanned = await scan([grown]);

  /* The catalog did re-describe the file under the fork's key... */
  expect(scanned.projectCatalog.map((entry) => entry.project)).toEqual([fork]);
  /* ...and still joined nothing, asked nobody and wrote no history line. */
  expect(canonicalProject(original)).toBe(original);
  expect(forgeAnswers.asked).toEqual([]);
  expect(moved(fork)).toEqual([]);
});

test("through the same re-description, a repository that gained its origin still moves its local key", async () => {
  const repo = repositoryAt("doohickeys", "doohickeys");
  git("-C", repo, "remote", "remove", "origin");
  const local = projectForCwd(repo)!;
  const forgeAnswers = forge({});
  setForgeLookupForTests(forgeAnswers);
  const before = await transcript("doohickeys-before", repo);
  await scan([before]);

  git("-C", repo, "remote", "add", "origin", "https://github.com/acme/doohickeys.git");
  const remote = projectForCwd(repo)!;
  expect(remote).not.toBe(local);
  for (const cache of ["meta-transcript-v7", "project-overlay-v2", "title-v5"]) globalCache(cache).clear();
  fs.appendFileSync(before.path, JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "still here" } }) + "\n");
  fs.utimesSync(before.path, transcriptClock + 50, transcriptClock + 50);
  const grown = { ...before, st: fs.statSync(before.path) } as RawEntry;
  const scanned = await scan([grown]);

  expect(scanned.projectCatalog.map((entry) => entry.project)).toEqual([remote]);
  expect(canonicalProject(local)).toBe(remote);
  expect(forgeAnswers.asked).toEqual([]);
});

test("an unreachable forge records nothing, and the next scan asks again", async () => {
  const repo = repositoryAt("sprockets", "sprockets");
  const old = projectForCwd(repo)!;
  const offline = forge({ "acme/sprockets": "unreachable", "acme/delegated-sprockets": "unreachable" });
  setForgeLookupForTests(offline);
  const before = await transcript("sprockets-before", repo);
  await scan([before]);

  repoint(repo, "delegated-sprockets");
  const renamed = projectForCwd(repo)!;
  const after = await transcript("sprockets-after", repo);
  await scan([before, after]);
  expect(offline.asked.length).toBeGreaterThan(0);
  expect(canonicalProject(old)).toBe(old);
  expect(moved(renamed)).toEqual([]);

  setForgeLookupForTests(forge({ "acme/sprockets": 7300, "acme/delegated-sprockets": 7300 }));
  await scan([before, after]);
  expect(canonicalProject(old)).toBe(renamed);
  expect(moved(renamed)).toHaveLength(1);
});

test("a key with no ledger entry is never aliased, and the forge is not asked", async () => {
  const repo = repositoryAt("cogs", "delegated-cogs");
  const forgeAnswers = forge({ "acme/cogs": 8800, "acme/delegated-cogs": 8800 });
  setForgeLookupForTests(forgeAnswers);
  /* The old key of a repository this machine never saw under its old name:
     its hash cannot be reversed, so there is nothing to ask the forge about. */
  const unseen = "repo-0123456789abcdef0123456789abcdef";
  expect(recordedProjectRemote(unseen)).toBeNull();
  expect(forgeRenameCandidateFor(unseen, repo)).toBeNull();
  expect(await recordForgeRenames([forgeRenameCandidateFor(unseen, repo)], forgeAnswers)).toEqual([]);
  expect(forgeAnswers.asked).toEqual([]);
  expect(canonicalProject(unseen)).toBe(unseen);
});
