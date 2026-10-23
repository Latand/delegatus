import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

import { usesLinkedLegacyState } from "./legacyState";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-linked-state-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

test("only a link to the active earlier state is reported, without changing data", () => {
  const root = path.join(sandbox, "linked");
  const legacy = path.join(root, "agent-log-viewer");
  const active = path.join(legacy, "state");
  fs.mkdirSync(active, { recursive: true });
  fs.writeFileSync(path.join(active, "fixture.json"), "preserved");
  expect(usesLinkedLegacyState(root, active)).toBe(false);
  fs.symlinkSync("agent-log-viewer", path.join(root, "delegatus"), "dir");
  expect(usesLinkedLegacyState(root, active)).toBe(true);
  expect(usesLinkedLegacyState(root, path.join(root, "delegatus", "state"))).toBe(true);
  const isolated = path.join(sandbox, "isolated");
  fs.mkdirSync(isolated);
  expect(usesLinkedLegacyState(root, isolated)).toBe(false);
  expect(usesLinkedLegacyState(root, path.join(legacy, "state-staging"))).toBe(false);
  expect(fs.readlinkSync(path.join(root, "delegatus"))).toBe("agent-log-viewer");
  expect(fs.readFileSync(path.join(active, "fixture.json"), "utf8")).toBe("preserved");
});

test("a separate new install, missing paths and unrelated links are not inherited state", () => {
  const root = path.join(sandbox, "separate");
  const active = path.join(root, "agent-log-viewer", "state");
  fs.mkdirSync(active, { recursive: true });
  fs.mkdirSync(path.join(root, "delegatus"));
  expect(usesLinkedLegacyState(root, active)).toBe(false);
  fs.rmdirSync(path.join(root, "delegatus"));
  fs.symlinkSync("missing", path.join(root, "delegatus"), "dir");
  expect(usesLinkedLegacyState(root, active)).toBe(false);
  fs.unlinkSync(path.join(root, "delegatus"));
  fs.mkdirSync(path.join(root, "other"));
  fs.symlinkSync("other", path.join(root, "delegatus"), "dir");
  expect(usesLinkedLegacyState(root, active)).toBe(false);
});

/* The clean-start instructions, rehearsed. Every startup source they name is
   seeded with earlier state, a Viewer-shaped start imports it into the linked
   install, the instructions are followed, and the next start must come up
   empty while the backup and the folders moved aside keep everything. The
   starts run in a child whose HOME is the sandbox, since `os.homedir()` is
   fixed at launch and the legacy sources live under it. */
const repoRoot = path.resolve(import.meta.dir, "../../..");
const startupScript = `
const { openStateMutationActivation } = await import(${JSON.stringify(path.join(repoRoot, "src/lib/state/stateMutationBarrier.ts"))});
const { configFilePath, inboxDir, stateDir } = await import(${JSON.stringify(path.join(repoRoot, "src/lib/configDir.ts"))});
const { usesLinkedLegacyState } = await import(${JSON.stringify(path.join(repoRoot, "src/lib/onboarding/legacyState.ts"))});
openStateMutationActivation();
const state = stateDir();
console.log(JSON.stringify({ state, inbox: inboxDir(), setting: configFilePath("tts-backend"), linked: usesLinkedLegacyState() }));
`;

function start(home: string): { state: string; inbox: string; setting: string; linked: boolean } {
  /* The same temp root as this run, so the sandbox home is admitted as one. */
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), TMPDIR: os.tmpdir() };
  const child = Bun.spawnSync([process.execPath, "-e", startupScript], { cwd: repoRoot, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(`startup child failed: ${child.stderr.toString()}`);
  return JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
}

function seedEarlierInstall(home: string): void {
  const config = path.join(home, ".config");
  fs.mkdirSync(path.join(home, ".claude", "viewer-state"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "viewer-state", "tasks.json"), "[\"earlier task\"]\n");
  fs.mkdirSync(path.join(home, ".claude", "viewer-inbox"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "viewer-inbox", "pasted.png"), "earlier image");
  fs.mkdirSync(path.join(config, "live-log-viewer"), { recursive: true });
  fs.writeFileSync(path.join(config, "live-log-viewer", "tts-backend"), "openai\n");
  fs.mkdirSync(path.join(config, "agent-log-viewer"), { recursive: true });
}

/** Steps 2 and 3 of the instructions; `sources` is what the reader moved. */
function followInstructions(home: string, sources: readonly string[]): void {
  const config = path.join(home, ".config");
  for (const source of sources) fs.cpSync(path.join(home, source), path.join(home, "backup", source), { recursive: true, verbatimSymlinks: true });
  fs.unlinkSync(path.join(config, "delegatus"));
  for (const source of sources) {
    fs.mkdirSync(path.dirname(path.join(home, "aside", source)), { recursive: true });
    fs.renameSync(path.join(home, source), path.join(home, "aside", source));
  }
}

const CLEAN_START_SOURCES = [".config/agent-log-viewer", ".claude/viewer-state", ".claude/viewer-inbox", ".config/live-log-viewer"];

test("following the clean-start instructions leaves the next start empty and every earlier file recoverable", () => {
  const home = path.join(sandbox, "clean-start-home");
  seedEarlierInstall(home);
  const before = start(home);
  expect(before.linked).toBe(true);
  expect(fs.readFileSync(path.join(before.state, "tasks.json"), "utf8")).toBe("[\"earlier task\"]\n");
  expect(fs.readFileSync(path.join(before.inbox, "pasted.png"), "utf8")).toBe("earlier image");
  expect(fs.readFileSync(before.setting, "utf8")).toBe("openai\n");

  followInstructions(home, CLEAN_START_SOURCES);
  const after = start(home);
  expect(after.state).toBe(path.join(home, ".config", "delegatus", "state"));
  expect(after.linked).toBe(false);
  expect(fs.lstatSync(path.join(home, ".config", "delegatus")).isSymbolicLink()).toBe(false);
  expect(fs.existsSync(path.join(after.state, "tasks.json"))).toBe(false);
  expect(fs.existsSync(path.join(after.inbox, "pasted.png"))).toBe(false);
  expect(fs.existsSync(after.setting)).toBe(false);

  for (const root of ["backup", "aside"]) {
    expect(fs.readFileSync(path.join(home, root, ".config/agent-log-viewer/state/tasks.json"), "utf8")).toBe("[\"earlier task\"]\n");
    expect(fs.readFileSync(path.join(home, root, ".config/agent-log-viewer/inbox/pasted.png"), "utf8")).toBe("earlier image");
    expect(fs.readFileSync(path.join(home, root, ".claude/viewer-state/tasks.json"), "utf8")).toBe("[\"earlier task\"]\n");
    expect(fs.readFileSync(path.join(home, root, ".claude/viewer-inbox/pasted.png"), "utf8")).toBe("earlier image");
    expect(fs.readFileSync(path.join(home, root, ".config/live-log-viewer/tts-backend"), "utf8")).toBe("openai\n");
  }
});

test("moving only the agent-log-viewer directory aside, as the earlier instructions said, brings the earlier state back", () => {
  const home = path.join(sandbox, "partial-clean-start-home");
  seedEarlierInstall(home);
  start(home);
  followInstructions(home, [".config/agent-log-viewer"]);
  const after = start(home);
  expect(fs.existsSync(path.join(after.state, "tasks.json"))).toBe(true);
  expect(fs.existsSync(path.join(after.inbox, "pasted.png"))).toBe(true);
  expect(fs.readFileSync(after.setting, "utf8")).toBe("openai\n");
});

test("both translations of the clean-start instructions name every startup source", async () => {
  const { en } = await import("@/lib/i18n/en");
  const { uk } = await import("@/lib/i18n/uk");
  for (const text of [en["onboarding.legacy.instructions"], uk["onboarding.legacy.instructions"]]) {
    for (const source of ["agent-log-viewer", "~/.claude/viewer-state", "~/.claude/viewer-inbox", "live-log-viewer"]) expect(String(text)).toContain(source);
  }
});
