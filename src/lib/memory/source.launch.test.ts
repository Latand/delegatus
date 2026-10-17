import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyClaudeSpawnPolicy } from "@/lib/agent/spawnPolicy";
import { freshSpecFor, resumeSpecForSession, withSpawnCapability } from "@/lib/agent/cli";
import { reviewerCommand } from "@/lib/agent/headless";
import { buildEphemeralCommand } from "@/lib/agent/ephemeral";
import { parseCodexFeatures, setCodexFeatureReaderForTest, codexNativeMemoryEnabled } from "@/lib/agent/codexSpawnPolicy";
import { accountTerminalCommand } from "@/lib/accounts/terminalLaunch";
import { createManagedClaudeAccount } from "@/lib/accounts/claude";
import { headlessCodexThreadConfig } from "@/lib/codexHeadlessConfig";
import { SOURCE_STATES, chooseSource, sourceTurnsEnginesOff } from "./fixtures/source";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { stageMemoryForLaunch } from "./roleStage";
import { learnedRulesForLaunchProfile } from "./roleLaunch";
import { leaveLessons, recordLessonRequest } from "./roleStore";

const previous = process.env.LLV_STATE_DIR;
const SID = "00000000-0000-0000-0000-000000000000";
let root: string;
let restoreFeatures: () => void;
let uuid: ReturnType<typeof spyOn>;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "source-launch-")); process.env.LLV_STATE_DIR = path.join(root, "state");
  restoreFeatures = setCodexFeatureReaderForTest(() => parseCodexFeatures("memories stable true\nmulti_agent stable true"));
  uuid = spyOn(crypto, "randomUUID").mockReturnValue(SID);
});
afterEach(() => {
  uuid.mockRestore(); restoreFeatures();
  if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
function settings(command: string) {
  const arg = command.match(/'--settings' '([^']+)'|--settings '([^']+)'/);
  if (!arg) throw Error("Claude settings missing");
  const value = arg[1] ?? arg[2];
  return JSON.parse(value.startsWith("{") ? value : fs.readFileSync(value, "utf8"));
}
function assertClaude(value: Record<string, unknown>, off: boolean) {
  expect(value.autoMemoryEnabled).toBe(off ? false : undefined);
  expect((value.env as Record<string, unknown>).CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe(off ? "1" : undefined);
}

test.each([...SOURCE_STATES])("%s: Claude policy, terminal specs, account terminals and reviewers", state => {
  const home = path.join(root, "claude"); fs.mkdirSync(home);
  chooseSource("unchosen");
  const policyOptions = { allowSubagents: true, profileId: "fixed", cwd: root };
  const original = fs.readFileSync(applyClaudeSpawnPolicy(home, policyOptions).settingsPath, "utf8");
  const baselineFresh = freshSpecFor("claude", root, { claudeConfigDir: home }).command;
  const baselineResume = resumeSpecForSession("claude", SID, root, home)!.command;
  chooseSource(state);
  const off = sourceTurnsEnginesOff(state);
  const value = fs.readFileSync(applyClaudeSpawnPolicy(home, policyOptions).settingsPath, "utf8");
  assertClaude(JSON.parse(value), off);
  if (!off) expect(value).toBe(original);
  for (const cleanMemory of [false, true]) {
    const fresh = freshSpecFor("claude", root, { claudeConfigDir: home, cleanMemory });
    const resume = resumeSpecForSession("claude", SID, root, home, { cleanMemory })!;
    expect(fresh.launchProfile?.cleanMemory).toBe(cleanMemory);
    expect(resume.launchProfile?.cleanMemory).toBe(cleanMemory);
    assertClaude(settings(fresh.command), off || cleanMemory);
    assertClaude(settings(resume.command), off || cleanMemory);
    const inline = freshSpecFor("claude", root, { cleanMemory });
    assertClaude(settings(inline.command), off || cleanMemory);
    withSpawnCapability(resume, "A".repeat(43));
    assertClaude(settings(resume.command), off || cleanMemory);
    if (!off && !cleanMemory) { expect(fresh.command).toBe(baselineFresh); expect(resume.command).toBe(baselineResume); }
  }
  for (const kind of ["legacy", "managed"] as const) {
    const command = accountTerminalCommand("claude", { kind, home });
    expect(command.includes("CLAUDE_CODE_DISABLE_AUTO_MEMORY=1")).toBe(off);
  }
  const provider = createManagedClaudeAccount("Fixture provider", { config: { baseUrl: "http://127.0.0.1:9", model: "fixture", smallFastModel: null }, token: "fixture-provider-token" });
  assertClaude(settings(accountTerminalCommand("claude", provider)), off);
  const review = reviewerCommand({ engine: "claude", model: "sonnet", effort: "high" } as never, "Review fixture", path.join(root, "review.txt"), root,
    null, { home, managed: false } as never);
  const reviewPath = review.args[review.args.indexOf("--settings") + 1];
  assertClaude(JSON.parse(fs.readFileSync(reviewPath, "utf8")), true);
  expect(review.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
});

test.each([...SOURCE_STATES])("%s: Codex fresh/resume terminals, accounts, thread config and ephemeral runs", async state => {
  const home = path.join(root, "codex"); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, "config.toml"), "[features]\nmemories = true\n[mcp_servers]\n");
  fs.writeFileSync(path.join(home, "auth.json"), "{}");
  fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "fixture" }] }));
  chooseSource("unchosen");
  const options = { codexHome: home, allowSubagents: true };
  const baseline = freshSpecFor("codex", root, options).command;
  const resumeBaseline = resumeSpecForSession("codex", SID, root, home, options)!.command;
  chooseSource(state);
  const off = sourceTurnsEnginesOff(state);
  for (const cleanMemory of [false, true]) {
    const command = freshSpecFor("codex", root, { ...options, cleanMemory }).command;
    const resume = resumeSpecForSession("codex", SID, root, home, { ...options, cleanMemory })!.command;
    expect(command.includes("features.memories=false")).toBe(off || cleanMemory);
    expect(resume.includes("features.memories=false")).toBe(off || cleanMemory);
    if (!off && !cleanMemory) { expect(command).toBe(baseline); expect(resume).toBe(resumeBaseline); }
    expect((headlessCodexThreadConfig({ config: { mcp_servers: {} } }, true, [], [], "stdio", [], cleanMemory).features as Record<string, unknown>).memories).toBe(off || cleanMemory ? false : undefined);
    expect(await codexNativeMemoryEnabled(home, true, cleanMemory)).toBe(!(off || cleanMemory));
  }
  for (const kind of ["legacy", "managed"] as const) expect(accountTerminalCommand("codex", { kind, home }).includes("features.memories=false")).toBe(off);
  const runDir = path.join(root, "run"); fs.mkdirSync(runDir);
  const run = buildEphemeralCommand({ key: "fixture", engine: "codex", model: "fixture", effort: "low", account: { engine: "codex", accountId: "fixture", home, env: { NODE_ENV: "test" } } as never,
    ["prompt"]: "Fixture", schema: { type: "object" }, runDir, hardCapMs: 60_000 });
  expect(run.args.slice(run.args.indexOf("memories") - 1, run.args.indexOf("memories") + 1)).toEqual(["--disable", "memories"]);
  const reviewer = reviewerCommand({ engine: "codex", model: "fixture", effort: "high" } as never, "Review fixture", path.join(root, "review.txt"), root, { home, managed: false });
  expect(reviewer.args.slice(reviewer.args.indexOf("memories") - 1, reviewer.args.indexOf("memories") + 1)).toEqual(["--disable", "memories"]);
});

test("resume reads the new setting rather than the original launch profile", () => {
  const home = path.join(root, "resume"); fs.mkdirSync(home);
  for (const engine of ["claude", "codex"] as const) {
    chooseSource("unchosen");
    const options = { claudeConfigDir: home, codexHome: home, allowSubagents: true };
    const original = freshSpecFor(engine, root, options);
    for (const state of ["active", "engines"] as const) {
      chooseSource(state);
      const resume = resumeSpecForSession(engine, SID, root, home, options)!;
      if (engine === "claude") assertClaude(settings(resume.command), state === "active");
      else expect(resume.command.includes("features.memories=false")).toBe(state === "active");
    }
    expect(original.launchProfile).not.toHaveProperty("memorySource");
  }
});

test.each(["claude", "codex"] as const)("%s resumes a stage's saved role selector after leaving engines mode", async engine => {
  const project = `saved-selector-${engine}`;
  const rule = "Check the current pipeline stage before deciding which memory to load.";
  const source = { project, pipelineId: `${project}-pipeline`, stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: `${project}-writer` };
  recordLessonRequest({ ...source, at: "2026-10-17T00:00:00.000Z" });
  leaveLessons({ request: source, source, none: null, lessons: [{ scope: "role", rule, why: "A resumed stage lost its role selector." }] });

  chooseSource("engines");
  const selected = stageMemoryForLaunch({ id: "pipeline", project }, { id: "build", kind: "run", onFail: null }, "builder");
  const savedProfile = JSON.parse(JSON.stringify(emptyLaunchProfile({ cwd: root, cleanMemory: selected.cleanMemory, learnedRules: selected.learnedRules ?? undefined })));
  expect(savedProfile.learnedRules).toEqual({ project, roleId: "builder" });
  expect(await learnedRulesForLaunchProfile(savedProfile)).toBeUndefined();

  chooseSource("active");
  const resumedProfile = JSON.parse(JSON.stringify(savedProfile));
  expect(await learnedRulesForLaunchProfile(resumedProfile)).toContain(rule);

  const clean = stageMemoryForLaunch({ id: "pipeline", project }, { id: "review", kind: "run", onFail: { to: "build", maxRounds: 1 } }, "builder");
  expect(clean).toEqual({ cleanMemory: true, learnedRules: null });
});
