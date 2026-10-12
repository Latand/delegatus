import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-role-delivery-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { claudeStructuredHostOptions, defaultStartHost } = await import("@/lib/runtime/structuredSpawn");
const { AgentRegistry } = await import("@/lib/agent/registry");
const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
const { CodexAppServerHost } = await import("@/lib/runtime/codexAppServerHost");
const { ClaudeStreamBrokerHost } = await import("@/lib/runtime/claudeStreamBrokerHost");
const { leaveLessons, recordLessonRequest } = await import("./roleStore");
const { learnedRulesForLaunchProfile, sweepOldLearnedRulesFiles, LEARNED_RULES_MAX_BYTES } = await import("./roleLaunch");
const { renderLearnedRules } = await import("./roleRender");
const ownership = await import("@/lib/stateOwnership");
const text = "Validate the ownership of durable receipts before replaying their acknowledgement.";

test("the host renders its text-free launch marker into instructions without writing a rules file", () => {
  const source = { project: "delivery-trial", pipelineId: "delivery-trial", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_delivery_trial" };
  recordLessonRequest({ ...source, at: "2026-10-11T00:00:00.000Z" });
  leaveLessons({ request: source, source, none: null, lessons: [{ scope: "role", rule: text, why: "A stored receipt was replayed with a different owner." }] });
  const profile = emptyLaunchProfile({ cwd: sandbox, learnedRules: { project: source.project, roleId: source.roleId } });
  const options = claudeStructuredHostOptions({ spec: { cwd: sandbox, launchProfile: profile }, account: { home: sandbox, kind: "managed" } } as never, { env: {}, host: {} } as never);
  expect(options.appendSystemPrompt).toContain(text);
  expect(JSON.stringify(profile)).not.toContain(text);
  expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, "role-memory", "launch"))).toBe(false);
});

test.each(["codex", "claude"] as const)("%s fresh and resumed starts reload the latest rule from their marker", async engine => {
  for (const resumed of [false, true]) {
    const cwd = fs.mkdtempSync(path.join(sandbox, "host-"));
    const project = `delivery-${engine}-${resumed}`;
    const source = { project, pipelineId: project, stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_delivery_replay" };
    recordLessonRequest({ ...source, at: "2026-10-11T00:00:00.000Z" });
    const rule = leaveLessons({ request: source, source, none: null, lessons: [{ scope: "role", rule: text, why: "A stored receipt was replayed with a different owner." }] }).left[0]!;
    const launchProfile = emptyLaunchProfile({ cwd, learnedRules: { project, roleId: "builder" } });
    const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    const sessionId = crypto.randomUUID();
    const transcript = resumed ? path.join(cwd, `${sessionId}.jsonl`) : null;
    if (transcript) fs.writeFileSync(transcript, JSON.stringify(engine === "codex" ? { type: "session_meta", payload: { id: sessionId } } : { sessionId }) + "\n");
    const conversation = transcript ? registry.ensureConversation(engine, transcript, "account-a") : null;
    if (transcript) registry.upsert({ key: { engine, sessionId }, artifactPath: transcript, cwd, accountId: "account-a", launchProfile, status: "dead", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
    const begun = beginLegacySpawnFixture(registry, { engine, cwd, transport: "structured", launchProfile, ...(transcript ? { purpose: "resume-successor", expectedArtifactPath: transcript, conversationId: conversation!.id } : {}) });
    if (begun.kind !== "created") throw new Error("delivery fixture receipt missing");
    const Host = engine === "codex" ? CodexAppServerHost : ClaudeStreamBrokerHost;
    const seen: unknown[] = [];
    const capture = async (options: unknown) => { seen.push(options); throw new Error("captured delivery options"); };
    const start = spyOn(Host, "start").mockImplementation(capture);
    const adopt = spyOn(Host, "adopt").mockImplementation(async (_id: string, options: unknown) => capture(options));
    const input = { engine, registry, receipt: begun.receipt, spec: { command: engine, engine, cwd, windowName: "delivery", transcript: transcript ?? undefined, launchProfile }, account: { engine, accountId: "account-a", kind: "managed" as const, home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" as const } }, prompt: "Stage prompt only", client: {} as import("@/lib/runtime/client").RuntimeHostClient };
    try {
      await expect(defaultStartHost(input, "fixture-capability")).rejects.toThrow("captured delivery options");
      const rewritten = "Check the current owner of durable acknowledgements before replaying any persisted receipt.";
      const next = { ...source, attempt: 2 };
      recordLessonRequest({ ...next, at: "2026-10-11T00:01:00.000Z" });
      leaveLessons({ request: next, source: next, none: null, lessons: [], rewrite: { id: rule.id, rule: rewritten, why: "The general rule now covers receipts from changed owners." } });
      await expect(defaultStartHost(input, "fixture-capability")).rejects.toThrow("captured delivery options");
      const channel = engine === "codex" ? "developerInstructions" : "appendSystemPrompt";
      expect((seen[0] as Record<string, string>)[channel]).toContain(text);
      expect((seen[1] as Record<string, string>)[channel]).toContain(rewritten);
      expect((seen[1] as Record<string, string>)[channel]).not.toContain(text);
      expect(resumed ? adopt.mock.calls.length : start.mock.calls.length).toBe(2);
      expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, "role-memory", "launch"))).toBe(false);
    } finally { start.mockRestore(); adopt.mockRestore(); }
  }
});

test.each(["codex", "claude"] as const)("%s receives a seat-written rule on fresh and resumed engine starts from another account", async engine => {
  const { leaveLessonForSeat } = await import("./roleStage");
  for (const resumed of [false, true]) {
    const cwd = fs.mkdtempSync(path.join(sandbox, "seat-host-"));
    const project = `seat-delivery-${engine}-${resumed}`;
    const rule = "Inspect recent transcript activity before reporting an agent as stalled.";
    leaveLessonForSeat({ project, conversationId: "writer-seat" }, { lesson: { scope: "role", rule, why: "An activity signal missed ongoing transcript work." } });
    leaveLessonForSeat({ project, conversationId: "writer-seat" }, { lesson: { scope: "project", rule: "Check the pinned acceptance criteria before reporting completed work.", why: "A brief omitted a required acceptance criterion." } });
    const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    const sessionId = crypto.randomUUID();
    const transcript = resumed ? path.join(cwd, `${sessionId}.jsonl`) : null;
    if (transcript) fs.writeFileSync(transcript, JSON.stringify(engine === "codex" ? { type: "session_meta", payload: { id: sessionId } } : { sessionId }) + "\n");
    let conversationId: import("@/lib/accounts/migration/contracts").ViewerConversationId | undefined;
    if (transcript) {
      const original = beginLegacySpawnFixture(registry, { engine, cwd, role: "orchestrator", explicitProject: project, transport: "structured" });
      if (original.kind !== "created") throw new Error("original seat admission failed");
      registry.completeSpawn(original.receipt.launchId, { key: { engine, sessionId }, artifactPath: transcript, cwd, accountId: "writer-account", status: "dead", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
      conversationId = original.receipt.conversationId;
    }
    const begun = beginLegacySpawnFixture(registry, { engine, cwd, role: "orchestrator", explicitProject: project, transport: "structured", ...(transcript ? { purpose: "resume-successor", expectedArtifactPath: transcript, conversationId } : {}) });
    if (begun.kind !== "created") throw new Error("seat delivery admission failed");
    const launchProfile = begun.receipt.launchProfile;
    expect(JSON.stringify(begun.receipt)).not.toContain(rule);
    const Host = engine === "codex" ? CodexAppServerHost : ClaudeStreamBrokerHost;
    let delivered: Record<string, string> = {};
    const capture = async (options: unknown) => { delivered = options as Record<string, string>; throw new Error("captured seat start"); };
    const start = spyOn(Host, "start").mockImplementation(capture);
    const adopt = spyOn(Host, "adopt").mockImplementation(async (_id: string, options: unknown) => capture(options));
    try {
      await expect(defaultStartHost({ engine, registry, receipt: begun.receipt, spec: { command: engine, engine, cwd, windowName: "seat", transcript: transcript ?? undefined, launchProfile }, account: { engine, accountId: "reader-account", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } }, prompt: "Seat mandate", client: {} as import("@/lib/runtime/client").RuntimeHostClient }, "fixture-capability")).rejects.toThrow("captured seat start");
      const channel = engine === "codex" ? "developerInstructions" : "appendSystemPrompt";
      expect(delivered[channel]).toContain(rule);
      expect(delivered[channel]).toContain("Earlier seats and stage agents");
      expect(delivered[channel]).toContain("create_task");
      expect(delivered[channel]).not.toContain("When you report with stage_report");
      const builder = learnedRulesForLaunchProfile({ learnedRules: { project, roleId: "builder" } })!;
      expect(builder).not.toContain(rule);
      expect(builder).toContain("Check the pinned acceptance criteria");
    } finally { start.mockRestore(); adopt.mockRestore(); }
  }
});

test("clean profiles and the kill switch exclude rules on every engine start", () => {
  const profile = { learnedRules: { project: "delivery-trial", roleId: "builder" } };
  expect(learnedRulesForLaunchProfile(undefined)).toBeUndefined();
  expect(learnedRulesForLaunchProfile({ ...profile, cleanMemory: true })).toBeUndefined();
  expect(learnedRulesForLaunchProfile({ learnedRules: { project: "delivery-trial", roleId: "reviewer" } })).toBeUndefined();
  process.env.LLV_ROLE_MEMORY = "off";
  try { expect(learnedRulesForLaunchProfile(profile)).toBeUndefined(); }
  finally { delete process.env.LLV_ROLE_MEMORY; }
});

test("an unreadable store logs the failure and starts without rules", () => {
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(sandbox, "unreadable");
  fs.mkdirSync(process.env.LLV_STATE_DIR);
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR, "state.sqlite"), "broken fixture database");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(learnedRulesForLaunchProfile({ learnedRules: { project: "delivery-trial", roleId: "builder" } })).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  } finally { process.env.LLV_STATE_DIR = previous; warn.mockRestore(); }
});

test("the byte ceiling omits whole lowest-ranked lines and creates no files", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const scopes = ["role:p:builder", "role:*:builder", "project:p", "machine"].map(scope => ({ scope, rules: Array.from({ length: 30 }, (_, n) => ({ kind: "rule" as const, id: `${scope}-${n}`, rule: "\u{10330}".repeat(300), why: "private provenance", scope, state: "active" as const, hints: [], source: {} as never, createdAt: "now", changedAt: "now" })) }));
    const block = renderLearnedRules(scopes, LEARNED_RULES_MAX_BYTES);
    expect(Buffer.byteLength(block)).toBeLessThanOrEqual(LEARNED_RULES_MAX_BYTES);
    expect(warn).toHaveBeenCalled();
    for (const scope of scopes) expect(block).toContain(`- [${scope.rules[0]!.id}] ${scope.rules[0]!.rule}`);
    expect(scopes.every(scope => scope.rules.length === 30)).toBe(true);
    expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, "role-memory", "launch"))).toBe(false);
  } finally { warn.mockRestore(); }
});

test("the renderer shared with browser fixtures works without the Node Buffer global", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Buffer")!;
  let block: string | undefined;
  let error: unknown;
  try {
    Reflect.deleteProperty(globalThis, "Buffer");
    block = renderLearnedRules([]);
    renderLearnedRules([], 2_000);
  } catch (cause) { error = cause; }
  finally { Object.defineProperty(globalThis, "Buffer", descriptor); }
  expect(error).toBeUndefined();
  expect(block).toContain("Learned rules (Delegatus role memory)");
});

test("old pointer files age out at activation while newer and unrelated files stay", () => {
  const directory = path.join(process.env.LLV_STATE_DIR!, "role-memory", "launch");
  fs.mkdirSync(directory, { recursive: true });
  const old = path.join(directory, `learned-rules-${"a".repeat(64)}.md`);
  const recent = path.join(directory, `learned-rules-${"b".repeat(64)}.md`);
  fs.writeFileSync(old, "old fixture"); fs.writeFileSync(recent, "recent fixture");
  fs.utimesSync(old, new Date(0), new Date(0));
  sweepOldLearnedRulesFiles();
  expect(fs.existsSync(old)).toBe(false);
  expect(fs.existsSync(recent)).toBe(true);
  fs.unlinkSync(recent);
  sweepOldLearnedRulesFiles();
  expect(fs.existsSync(directory)).toBe(false);
});

test("the activation sweep leaves files alone when startup mutation is refused", () => {
  const directory = path.join(process.env.LLV_STATE_DIR!, "role-memory", "launch");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `learned-rules-${"c".repeat(64)}.md`);
  fs.writeFileSync(file, "old fixture");
  fs.utimesSync(file, new Date(0), new Date(0));
  const guard = spyOn(ownership, "assertStateStartupMutation").mockImplementation(() => { throw new Error("startup mutation refused"); });
  try {
    expect(() => sweepOldLearnedRulesFiles()).toThrow("startup mutation refused");
    expect(fs.existsSync(file)).toBe(true);
  } finally { guard.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("all production host start sites go through the declared option builders", () => {
  const runtime = path.resolve(import.meta.dir, "../runtime");
  const declared = new Map([
    ["structuredSpawn.ts", 2], ["startup.ts", 2], ["../accounts/migration/provider.ts", 2],
  ]);
  for (const [file, count] of declared) expect((fs.readFileSync(path.join(runtime, file), "utf8").match(/(?:appendSystemPrompt|developerInstructions): learnedRulesForLaunchProfile\(/g) ?? []).length).toBe(count);
  const callers: { file: string; count: number }[] = [];
  const hostNames = new Set(["ClaudeStreamBrokerHost", "CodexAppServerHost"]);
  const wrapperNames = new Set(["startCodexStructuredHost", "startClaudeStructuredHost"]);
  const countStarts = (file: string): number => {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    let count = 0;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const called = node.expression;
        if (ts.isPropertyAccessExpression(called) && ts.isIdentifier(called.expression)
          && hostNames.has(called.expression.text) && ["start", "adopt"].includes(called.name.text)
          || ts.isIdentifier(called) && wrapperNames.has(called.text)) count += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return count;
  };
  const scan = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== "fixtures") scan(file);
      else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        const count = countStarts(file);
        if (count) callers.push({ file: path.relative(path.resolve(runtime, ".."), file), count });
      }
    }
  };
  scan(path.resolve(runtime, ".."));
  expect(callers.sort((a, b) => a.file.localeCompare(b.file))).toEqual([
    { file: "accounts/migration/provider.ts", count: 2 },
    { file: "runtime/registry.ts", count: 4 },
    { file: "runtime/structuredSpawn.ts", count: 4 },
  ]);
});
