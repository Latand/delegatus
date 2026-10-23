import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import shipped from "./swarmRules.json";
import { frozenSwarmRule, swarmRuleId, swarmRulesForRole, swarmScope, validateSwarmPack, type SwarmRule } from "./swarmPack";
import { canonicalScope, deleteRule, learnedRulesSnapshot, leaveLessons, projectView, recordLessonRequest, refreshLessonKnownValues, roleMemoryCollection, storedLessonTexts, withoutStoredLessonsIn } from "./roleStore";
import { learnedRulesForLaunchProfile } from "./roleLaunch";
import { memoryDeliveries, type MemoryEngineStart } from "./deliveryLedger";
import { CLEAN_ROLE_IDS } from "./eligibility";
import { renderLearnedRulesSelection } from "./roleRender";
import { scopeChars } from "./roleConsolidate";
import { scopeKind, scopeProject, scopeRole } from "./roleScopes";
import { updatePreferences, telemetryFile, preferences } from "@/lib/telemetry/store";
import { swarmRulesEnabled } from "./settings";
import type { RoleMemoryRule } from "./roleTypes";
import { ruleUsageCounts } from "./roleViewSource";
import { claimPass } from "./curation/store";
import { readCuration } from "./curation/read";
import { applyCuration } from "./curation/apply";
import { curatorBrief } from "./curation/brief";
import * as selector from "./roleSelect";
import { roleSelectionCollection } from "./roleSelection";

const NOW = "2026-10-23T00:00:00.000Z";
const PROJECT = "swarm-fixture";
// Invented fixtures; the release pack starts empty and no local lessons enter it.
const TEXT = "Read the project instruction files before changing code.";
const WHY = "An earlier fixture missed a required instruction file.";
const PRIVATE = "Exercise the rejected input before recording the fixture result.";
const entry = (rule = TEXT, role = "builder"): SwarmRule => ({ id: swarmRuleId(role, rule), role, rule, since: "2026-10-23" });
const originalPack = [...shipped.rules] as SwarmRule[];
const packRules = shipped.rules as SwarmRule[];
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
let root: string;
const priorEnv = Object.fromEntries(["LLV_STATE_DIR", "LLV_ROLE_MEMORY", "OPENROUTER_API_KEY", "DO_NOT_TRACK", "DELEGATUS_TELEMETRY"].map(key => [key, process.env[key]]));
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-test-"));
  process.env.LLV_STATE_DIR = path.join(root, "state");
  for (const key of ["LLV_ROLE_MEMORY", "OPENROUTER_API_KEY", "DO_NOT_TRACK", "DELEGATUS_TELEMETRY"]) delete process.env[key];
  setSystemTime(new Date(NOW));
  packRules.splice(0, packRules.length, entry());
});
afterEach(() => {
  setSystemTime();
  packRules.splice(0, packRules.length, ...originalPack);
  for (const [key, value] of Object.entries(priorEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(root, { recursive: true, force: true });
});
const start = (attempt = 1): MemoryEngineStart => ({ engine: "codex", conversationId: "swarm-conversation", cwd: root, home: path.join(root, "native-home"), nativeMemoryEnabled: false, attempt: { pipelineId: "swarm-pipeline", stageId: "build", attempt } });
const profile = { learnedRules: { project: PROJECT, roleId: "builder" } };
const source = { project: PROJECT, pipelineId: "swarm-pipeline", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "swarm-conversation" };
function seed(rule = PRIVATE, why = WHY, id = "r_0000000000000001") {
  const scope = `role:${PROJECT}:builder`;
  const row: RoleMemoryRule = { kind: "rule", id, scope, rule, why, state: "active", hints: [], source, createdAt: NOW, changedAt: NOW };
  roleMemoryCollection(true)!.boundedPatch(2, tx => { tx.put(row); tx.put({ kind: "scope", scope, revision: 1, active: [id], history: [] }); });
  return row;
}
async function child(script: string) {
  const owned = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => owned.kill("SIGKILL"), 20_000);
  try {
    const [exit, out, err] = await Promise.all([owned.exited, new Response(owned.stdout).text(), new Response(owned.stderr).text()]);
    expect({ exit, err }).toEqual({ exit: 0, err: "" });
    return out;
  } finally { clearTimeout(timer); if (owned.exitCode === null) { owned.kill("SIGKILL"); await owned.exited; } }
}

test("the shipped release pack validates; eligible content is addressed by role and exact text", () => {
  expect(validateSwarmPack({ ...shipped, rules: originalPack })).toBeTruthy();
  expect(validateSwarmPack({ schemaVersion: 1, rules: [entry()] }).rules).toHaveLength(1);
  expect(entry(TEXT, "architect").id).not.toBe(entry().id);
  expect(scopeKind(swarmScope("builder"))).toBe("swarm");
  expect(scopeRole(swarmScope("builder"))).toBe("builder");
  expect(scopeProject(swarmScope("builder"))).toBeNull();
  expect(canonicalScope(swarmScope("builder"))).toBe("swarm:builder");
});

test("pack schema, duplicate ids, changed text, unknown and clean roles are refused", () => {
  for (const invalid of [null, {}, { schemaVersion: 2, rules: [] }, { schemaVersion: 1, rules: [], extra: true },
    ...[...CLEAN_ROLE_IDS, "unknown"].map(role => ({ schemaVersion: 1, rules: [entry(TEXT, role)] })),
    { schemaVersion: 1, rules: [entry(), entry()] }, { schemaVersion: 1, rules: [{ ...entry(), rule: PRIVATE }] },
    { schemaVersion: 1, rules: [{ ...entry(), rule: 42 }] }, { schemaVersion: 1, rules: [entry("a".repeat(301))] },
    { schemaVersion: 1, rules: [entry("Перевірити текст перед публікацією.")] },
    { schemaVersion: 1, rules: [{ ...entry(), since: "later" }] },
    { schemaVersion: 1, rules: [{ ...entry(), since: "2026-02-31" }] },
    { schemaVersion: 1, rules: [{ ...entry(), replaces: entry().id }] }]) expect(() => validateSwarmPack(invalid)).toThrow();
});

test("the role cap counts rendered ids, separators and Unicode code points", () => {
  const rules = Array.from({ length: 13 }, (_, index) => entry(`Check ${index} ${"a".repeat(292 - String(index).length)}`));
  expect(rules.every(rule => [...rule.rule].length <= 300)).toBe(true);
  expect(() => validateSwarmPack({ schemaVersion: 1, rules })).toThrow("bound");
  const unicode = entry(`Check ${"🙂".repeat(290)}`);
  expect(validateSwarmPack({ schemaVersion: 1, rules: [unicode] }).rules).toHaveLength(1);
  const accepted = rules.slice(0, 12);
  expect(validateSwarmPack({ schemaVersion: 1, rules: accepted }).rules).toHaveLength(12);
  expect(scopeChars(accepted.map(rule => ({ ...rule, why: "" })))).toBeLessThanOrEqual(4000);
});

test("off preserves the exact four-scope block; on inserts the fifth scope after role everywhere", async () => {
  seed();
  const off = learnedRulesSnapshot(PROJECT, "builder");
  expect(off.scopes.map(entry => entry.scope)).toEqual([`role:${PROJECT}:builder`, "role:*:builder", `project:${PROJECT}`, "machine"]);
  expect(off.block).toBe(renderLearnedRulesSelection(off.candidates).block);
  expect(off.block).not.toContain("Swarm rules");
  updatePreferences({ swarmRules: true });
  const on = learnedRulesSnapshot(PROJECT, "builder");
  expect(on.scopes.map(entry => entry.scope)).toEqual([`role:${PROJECT}:builder`, "role:*:builder", "swarm:builder", `project:${PROJECT}`, "machine"]);
  expect(on.block).toContain("1 role · 1 swarm · 0 project · 0 machine");
  expect(on.block).toContain("Swarm rules · Builder on every install");
  expect(on.block).toContain("are public");
  expect(scopeChars(on.candidates[2].rules)).toBeLessThanOrEqual(4000);
  const block = await learnedRulesForLaunchProfile(profile, start());
  expect(block).toBe(on.block);
  expect(memoryDeliveries()[0].delivery.rules).toContainEqual({ id: entry().id, hash: digest(TEXT) });
  const clipped = learnedRulesSnapshot(PROJECT, "builder", Buffer.byteLength(on.block) - 1);
  expect(Buffer.byteLength(clipped.block)).toBeLessThan(Buffer.byteLength(on.block));
  expect(clipped.entries.length).toBeLessThan(on.entries.length);
});

test("an empty opted-in pack still has a separate scope; opting out removes it from the window cache", () => {
  packRules.length = 0;
  expect(preferences().swarmRules).toBe(false);
  expect(projectView(PROJECT).scopes.some(scope => scope.kind === "swarm")).toBe(false);
  updatePreferences({ swarmRules: true });
  expect(learnedRulesSnapshot(PROJECT, "builder").block).toContain("Swarm rules · Builder");
  expect(projectView(PROJECT).scopes.find(scope => scope.scope === "swarm:builder")).toMatchObject({ kind: "swarm", bound: 4000, active: [] });
  updatePreferences({ swarmRules: false });
  expect(projectView(PROJECT).scopes.some(scope => scope.kind === "swarm")).toBe(false);
});

test("delivered swarm usage is accepted and a different attempt's swarm id is refused", async () => {
  updatePreferences({ swarmRules: true });
  await learnedRulesForLaunchProfile(profile, start());
  recordLessonRequest({ ...source, at: NOW });
  expect(leaveLessons({ source, request: source, lessons: [], none: "No new lesson.", applied: [entry().id], now: NOW }).none).toBe("No new lesson.");
  expect(ruleUsageCounts([entry().id])).toEqual({ [entry().id]: { applied: 1, misled: 0 } });
  const other = { ...source, attempt: 2 };
  recordLessonRequest({ ...other, at: NOW });
  expect(() => leaveLessons({ source: other, request: other, lessons: [], none: "No new lesson.", misled: [entry().id], now: NOW })).toThrow(expect.objectContaining({ code: "RULE_NOT_DELIVERED" }));
});

test.each([...CLEAN_ROLE_IDS])("%s starts without swarm or local rules", async roleId => {
  updatePreferences({ swarmRules: true });
  expect(await learnedRulesForLaunchProfile({ learnedRules: { project: PROJECT, roleId } }, start())).toBeUndefined();
  expect(memoryDeliveries()[0].delivery.rules).toEqual([]);
});

test("existing memory off-switches remove the whole block; ping privacy overrides leave receiving available", async () => {
  updatePreferences({ swarmRules: true });
  for (const key of ["DO_NOT_TRACK", "DELEGATUS_TELEMETRY"]) {
    process.env[key] = key === "DO_NOT_TRACK" ? "1" : "0";
    expect(swarmRulesEnabled()).toBe(true);
  }
  process.env.LLV_ROLE_MEMORY = "off";
  expect(await learnedRulesForLaunchProfile(profile, start())).toBeUndefined();
  delete process.env.LLV_ROLE_MEMORY;
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "memory-source.json"), JSON.stringify({ schemaVersion: 1, source: "engines", changedAt: NOW }));
  expect(await learnedRulesForLaunchProfile(profile, start(2))).toBeUndefined();
});

test("restart with an empty serving pack retains a frozen public line byte for byte", async () => {
  updatePreferences({ swarmRules: true });
  const first = await learnedRulesForLaunchProfile(profile, start());
  expect(await child(`import { learnedRulesForLaunchProfile } from ${JSON.stringify(path.join(import.meta.dir, "roleLaunch.ts"))};
const result = await learnedRulesForLaunchProfile(${JSON.stringify(profile)}, ${JSON.stringify(start())});
process.stdout.write(result ?? '');`)).toBe(first!);
  expect(memoryDeliveries().at(-1)!.delivery.reason).toBe("frozen");
});

test("withdrawal re-render retains a removed pack entry and rejects a forged frozen line", async () => {
  const local = seed();
  updatePreferences({ swarmRules: true });
  const first = await learnedRulesForLaunchProfile(profile, start());
  packRules.length = 0;
  expect(await learnedRulesForLaunchProfile(profile, start())).toBe(first);
  deleteRule(local.id, NOW);
  const rerender = await learnedRulesForLaunchProfile(profile, start());
  expect(rerender).toContain(TEXT);
  expect(rerender).not.toContain(PRIVATE);
  expect(memoryDeliveries().at(-1)!.delivery.removed).toEqual([{ id: local.id, reason: "deleted", at: NOW }]);
  expect(frozenSwarmRule("swarm:builder", entry().id, digest(TEXT), `- [${entry().id}] ${PRIVATE}`)).toBeNull();
  expect(frozenSwarmRule("swarm:builder", entry().id, digest(PRIVATE), `- [${entry().id}] ${TEXT}`)).toBeNull();
});

test("opt-out hides a frozen swarm selection without losing the original selection", async () => {
  seed(); updatePreferences({ swarmRules: true });
  const first = await learnedRulesForLaunchProfile(profile, start());
  updatePreferences({ swarmRules: false });
  const off = await learnedRulesForLaunchProfile(profile, start());
  expect(off).toBe(learnedRulesSnapshot(PROJECT, "builder").block);
  expect(memoryDeliveries().at(-1)!.delivery.rules.some(rule => rule.id === entry().id)).toBe(false);
  updatePreferences({ swarmRules: true });
  expect(await learnedRulesForLaunchProfile(profile, start())).toBe(first);
});

test("consent changed after asynchronous selection is checked again before delivery", async () => {
  updatePreferences({ swarmRules: true });
  const held = spyOn(selector, "selectRoleMemory").mockImplementation(async () => {
    updatePreferences({ swarmRules: false });
    return { selector: "whole", selectorVersion: "1", reason: "no-brief", scores: [], shadowIds: [] };
  });
  try {
    const block = await learnedRulesForLaunchProfile(profile, start());
    expect(held).toHaveBeenCalledTimes(1);
    expect(block).not.toContain("Swarm rules");
    expect(memoryDeliveries()[0].delivery.rules).toEqual([]);
  } finally { held.mockRestore(); }
});

test("a removed pack entry with an unprovable frozen text is withdrawn by the real resume path", async () => {
  updatePreferences({ swarmRules: true });
  await learnedRulesForLaunchProfile(profile, start());
  packRules.length = 0;
  const held = roleSelectionCollection()!;
  try {
    held.boundedPatch(2, tx => {
      const key = JSON.stringify(["swarm-pipeline", "build", 1]);
      const row = tx.get(key)!;
      tx.put({ ...row, block: row.block.replace(TEXT, PRIVATE) });
    });
  } finally { held.close(); }
  const block = await learnedRulesForLaunchProfile(profile, start());
  expect(block).not.toContain(TEXT);
  expect(block).not.toContain(PRIVATE);
  expect(memoryDeliveries().at(-1)!.delivery.removed).toEqual([{ id: entry().id, reason: "unresolved", at: NOW }]);
});

test("consent survives a restart and malformed preferences fail closed", async () => {
  updatePreferences({ swarmRules: true });
  expect(await child(`import { swarmRulesEnabled } from ${JSON.stringify(path.join(import.meta.dir, "settings.ts"))}; process.stdout.write(String(swarmRulesEnabled()));`)).toBe("true");
  fs.writeFileSync(telemetryFile("preferences/swarmRules"), "broken");
  expect(swarmRulesEnabled()).toBe(false);
  expect(await child(`import { swarmRulesEnabled } from ${JSON.stringify(path.join(import.meta.dir, "settings.ts"))}; process.stdout.write(String(swarmRulesEnabled()));`)).toBe("false");
});

test("only normalized shipped rule text is public; explanations, unrelated rules and lookalikes remain private", () => {
  const normalized = TEXT.toUpperCase().replaceAll(" ", " -- ");
  seed(normalized, WHY);
  seed(PRIVATE, TEXT, "r_0000000000000002");
  expect(storedLessonTexts()).not.toContain(normalized);
  expect(storedLessonTexts()).toContain(WHY);
  expect(storedLessonTexts()).toContain(TEXT); // Even a why equal to public text stays private.
  expect(storedLessonTexts()).toContain(PRIVATE);
  const known = fs.readFileSync(refreshLessonKnownValues(), "utf8");
  expect(known).not.toContain(normalized);
  expect(known).toContain(WHY);
});

test("real publication gate and outgoing filter exempt public text while refusing why and private variants", () => {
  seed(TEXT.toUpperCase().replaceAll(" ", " -- "), WHY);
  seed(PRIVATE, WHY, "r_0000000000000002");
  const file = refreshLessonKnownValues();
  expect(withoutStoredLessonsIn(TEXT)).toBe(TEXT);
  for (const privateText of [WHY, PRIVATE.toUpperCase().replaceAll(" ", " -- ")]) expect(withoutStoredLessonsIn(privateText)).toBe("[learned rule].");
  const repository = path.join(root, "publication"); fs.mkdirSync(repository);
  const run = (text: string) => {
    fs.writeFileSync(path.join(repository, "pack.json"), JSON.stringify({ schemaVersion: 1, rules: [{ ...entry(), rule: text }] }));
    return spawnSync(process.execPath, [path.resolve(import.meta.dir, "../../../scripts/privacy-publication-gate.ts"), "--repository", repository, "--paths", "pack.json"], {
      cwd: repository, encoding: "utf8", timeout: 20_000, env: { ...process.env, LLV_PRIVACY_KNOWN_VALUES: "", LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: "", LLV_PRIVACY_KNOWN_VALUES_FILE: file, NO_COLOR: "1" },
    });
  };
  expect(run(TEXT).status).toBe(0);
  for (const privateText of [WHY, PRIVATE.toUpperCase().replaceAll(" ", " -- ")]) {
    const result = run(privateText);
    expect({ code: result.status, output: result.stdout }).toMatchObject({ code: 1, output: expect.stringContaining("known_value: 1") });
  }
  expect(swarmRulesForRole("builder")).toHaveLength(1);
}, 60_000);

test("a local lookalike gains no exemption and the read-only swarm scope refuses lesson writes", () => {
  const lookalike = `${TEXT} Check the fallback too.`;
  seed(lookalike);
  expect(storedLessonTexts()).toContain(lookalike);
  expect(withoutStoredLessonsIn(lookalike)).toBe("[learned rule].");
  recordLessonRequest({ ...source, at: NOW });
  expect(() => leaveLessons({ source, request: source, none: null, lessons: [{ scope: "swarm", rule: TEXT, why: WHY }] } as unknown as Parameters<typeof leaveLessons>[0])).toThrow(expect.objectContaining({ code: "LESSON_INVALID" }));
});

test("the curator sees usage even for no-lesson answers and can retire guidance already in the receiving pack", async () => {
  const local = seed(TEXT);
  updatePreferences({ swarmRules: true });
  roleMemoryCollection()!.boundedPatch(2, tx => {
    tx.put({ kind: "request", ...source, at: NOW, ruleIds: [], none: "No new lesson.", applied: [local.id] });
    tx.put({ kind: "request", ...source, attempt: 2, at: NOW, ruleIds: [], none: "No new lesson.", misled: [local.id] });
  });
  const pass = claimPass({ project: PROJECT, repoDir: process.cwd(), now: Date.parse(NOW) })!;
  const page = await readCuration(pass, local.scope, undefined, Date.parse(NOW));
  if (!("rules" in page)) throw Error("Expected a scope page");
  expect(page.rules.find(rule => rule.id === local.id)).toMatchObject({ applied: 1, misled: 1 });
  expect(page).toMatchObject({ swarmReceiving: true, swarm: [{ id: entry().id, rule: TEXT, readOnly: true }] });
  expect(curatorBrief(PROJECT)).toContain("src/lib/memory/swarmRules.json as where");
  expect(curatorBrief(PROJECT)).toContain("applied and misled counts");
  applyCuration(pass, { scopes: [{ scope: local.scope, revision: page.revision, order: [] }], archive: [{ id: local.id, reason: "in-instructions", where: "src/lib/memory/swarmRules.json", note: "The receiving pack holds the same action and conditions." }] }, NOW);
  expect(projectView(PROJECT).scopes.find(scope => scope.scope === local.scope)?.left[0]).toMatchObject({ id: local.id, reason: "in-instructions", where: "src/lib/memory/swarmRules.json" });
});
