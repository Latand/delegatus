import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { leaveSeatLessons } from "@/lib/memory/roleStore";
import { importCollection } from "@/lib/memory/importStore";
import { memorySource } from "@/lib/memory/source";
import { bridgeReportsEnabled, mergeOnReviewEnabled, setBridgeReports, setMergeOnReview } from "@/lib/projects/settings";
import { ensureLegacyCollectionsImported } from "@/lib/state/legacyCollections";

import { decodeBundle, encodeBundle } from "./bundle";
import { exportTransferBundle, TransferSecretError } from "./exporter";
import { applyTransferImport, previewTransferImport, readImportRecords, TransferImportError } from "./importer";
import type { BundleProject } from "./types";
import { installEnv, makeInstall, MOVED_FROM, NOW, readInstall, RELAY_CREDENTIAL, REPOSITORY, SECRET_SHAPED_VALUE, seedSource, treeDigest, within, type Install } from "./transfer.fixture";

/* The round trip between two isolated installs (docs/design/install-memory-transfer.md
   §7 slice 1): export from one, dry run and apply on the other, then every
   store's own reader on the target agrees with the source. Runs in one
   process, so `--preload ./src/lib/state/minimumSqlite.preload.ts` runs the
   whole path on the minimum macOS SQLite. */

let parent: string;
let source: Install;
let seeded: Awaited<ReturnType<typeof seedSource>>;
let bundle: Buffer;

const exportFrom = (install: Install, options: Parameters<typeof exportTransferBundle>[0] = {}) => within(install, async () => {
  const { projectAliasSnapshot, recordedProjectRemotes } = await import("@/lib/projects/aliases");
  const aliases = projectAliasSnapshot();
  return exportTransferBundle({
    now: new Date(NOW), exportId: "export-1", product: "test",
    env: { LLV_LANG: "uk", LLV_TOKEN: "access-key-value-never-exported", DELEGATUS_AGENT_CPU: "2-5", LLV_STATE_OWNER: "viewer", PATH: "/bin" },
    projects: { aliases: aliases.aliases, displayNames: aliases.displayNames, remotes: recordedProjectRemotes() },
    engineMemoryNotImported: async () => 3,
    ...options,
  });
});

async function freshTarget(name: string): Promise<Install> {
  const target = makeInstall(parent, name);
  fs.mkdirSync(path.join(target.root, "work", "beta-here"), { recursive: true });
  await within(target, () => ensureLegacyCollectionsImported(() => {}));
  return target;
}

const mappingFor = (target: Install) => ({ [seeded.folderKey]: path.join(target.root, "work", "beta-here") });

beforeAll(async () => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), "transfer-roundtrip-"));
  source = makeInstall(parent, "source");
  seeded = await seedSource(source);
  bundle = (await exportFrom(source)).bytes;
}, 120_000);

afterAll(() => { fs.rmSync(parent, { recursive: true, force: true }); });

describe("export", () => {
  test("carries the chosen sections with canonical project keys and no credential", async () => {
    const decoded = await decodeBundle(bundle);
    expect(decoded.header.sections.map(section => section.name)).toEqual([
      "memory.role", "memory.profile", "memory.settings", "memory.calls", "settings.seat", "settings.roles", "settings.limits",
      "settings.projects", "settings.operator", "settings.voice", "settings.forge", "settings.relay", "settings.telegram",
    ]);
    const plain = zlib.gunzipSync(bundle).toString("utf8");
    expect(plain).not.toContain(MOVED_FROM);
    expect(plain).not.toContain(RELAY_CREDENTIAL);
    expect(plain).not.toContain("access-key-value-never-exported");
    expect(plain).not.toContain(source.root);
    expect(decoded.records.some(record => record.k.startsWith("rows:role_memory|q:"))).toBe(false);
    const projects: BundleProject[] = [
      { key: seeded.folderKey, kind: "folder", displayName: "beta" },
      { key: REPOSITORY, kind: "repository", displayName: "alpha", remote: "forge.example.test/owner/alpha" },
    ];
    expect(decoded.header.projects).toEqual(projects.sort((a, b) => a.key.localeCompare(b.key)));
    expect(decoded.header.environment).toEqual([{ name: "LLV_AGENT_CPU", value: "2-5" }, { name: "LLV_LANG", value: "uk" }, { name: "LLV_TOKEN" }]);
    expect(decoded.header.notices).toEqual([{ code: "engine_memory_not_imported", files: 3 }]);
    const role = decoded.header.sections.find(section => section.name === "memory.role")!;
    expect(Object.keys(role.summary.scopes as object)).toContain("machine");
  });

  test("stops on a lesson that holds a secret-shaped string and names its section and key", async () => {
    const other = makeInstall(parent, "secret-source");
    const seededSecret = await seedSource(other, { secretLesson: true });
    const failure = await exportFrom(other).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(TransferSecretError);
    expect((failure as TransferSecretError).section).toBe("memory.role");
    expect((failure as TransferSecretError).key).toBe(`r:${seededSecret.ruleIds.at(-1)}`);
    expect((failure as Error).message).not.toContain(SECRET_SHAPED_VALUE);
    // Leaving the section out exports the rest.
    expect((await exportFrom(other, { sections: ["settings.operator"] })).sections).toEqual([{ name: "settings.operator", records: 6 }]);
  }, 60_000);
});

describe("round trip into an empty install", () => {
  test("dry run counts every record and writes nothing; apply makes the target read like the source", async () => {
    const target = await freshTarget("empty-target");
    const before = treeDigest(target.root);
    const plan = await within(target, () => previewTransferImport(bundle, { mappings: mappingFor(target) }));
    // The dry run writes only the staged bundle.
    expect(Object.keys(treeDigest(target.root)).filter(file => !(file in before))).toEqual([expect.stringMatching(/transfer\/staged\/[0-9a-f]{64}\.dlgt$/)]);
    for (const section of plan.sections) expect(section.new + section.same + section.conflict + section.skipped).toBe(section.records);
    expect(plan.sections.flatMap(section => section.conflicts)).toEqual([]);
    // Read once and never handed to an asymmetric matcher, which can rewrite the fields it matched.
    const mappedFolder = { ...plan.projects.find(project => project.key === seeded.folderKey)! };
    expect(mappedFolder.state).toBe("mapped");
    expect(mappedFolder.target).toMatch(/^dir-[0-9a-f]{32}$/);
    expect(mappedFolder.target).not.toBe(seeded.folderKey);
    expect(plan.redo.map(item => item.code)).toEqual(expect.arrayContaining(["api_keys", "relay_pairing", "subscription_consent", "machine_worker_limit", "environment", "forge_app_credential"]));

    const { report } = await within(target, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions, mappings: mappingFor(target) }));
    expect(report.complete).toBe(true);
    expect(report.sections.every(section => section.balanced)).toBe(true);
    expect(report.scopes.length).toBeGreaterThanOrEqual(4);
    for (const scope of report.scopes) expect(scope.target).toEqual(scope.source);

    const targetFolderKey = mappedFolder.target!;
    const sourceView = await readInstall(source, seeded);
    const targetView = await readInstall(target, seeded);
    const folderScopes = (view: typeof sourceView, key: string) => Object.fromEntries(Object.entries(view.scopes).map(([scope, figures]) => [scope.replace(key, "FOLDER"), figures]));
    expect(folderScopes(targetView, targetFolderKey)).toEqual(folderScopes(sourceView, seeded.folderKey));
    expect(targetView.rules).toBe(sourceView.rules);
    expect(targetView.requests).toBe(0);
    expect(targetView.folderCanonical).toBe(targetFolderKey);
    expect(targetView.curationLastAt).toBe(NOW);
    expect(targetView.profile).toBe("model-a");
    expect(targetView.shared).toBe(true);
    expect(targetView.seat).toBe("Watch the merge queue.");
    expect(targetView.workerLimits.projects[REPOSITORY]?.value).toBe(5);
    expect(targetView.workerLimits.machine).toBeNull();
    expect(targetView.mergeOnReview).toBe(true);
    expect(targetView.manual).toEqual([{ project: targetFolderKey, displayName: "beta" }]);
    expect(targetView.operator.locale?.value).toBe("uk");
    expect(targetView.operator.timeZone?.value).toBe("Europe/Kyiv");
    expect(targetView.asks).toMatchObject({ enabled: true, capUsd: 3 });
    expect(targetView.tts).toBe("elevenlabs");
    expect(targetView.transcribe).toBe("soniox");
    expect(targetView.forge).toEqual(["owner/alpha"]);
    // Charges stay with the source; the subscription consent is confirmed here.
    const companion = JSON.parse(fs.readFileSync(path.join(target.state, "voice-companion.json"), "utf8"));
    expect(companion.settings).toEqual({ enabled: true, monthlyCapUsd: 12, backend: "codex", callMemory: true });
    expect(companion.charges).toEqual({});
    expect(fs.existsSync(path.join(target.state, "subscription-api-consent.json"))).toBe(false);
    // Machine-scope rules arrive uncurated, first for the next curation pass (Q2).
    const machine = await within(target, async () => (await import("@/lib/memory/roleStore")).activeRules("machine"));
    expect(machine.every(rule => rule.curatedAt === undefined)).toBe(true);
    // The import record keeps the pending relay target and the confirmed alias.
    const [record] = await within(target, () => readImportRecords());
    expect(record!.pending.map(item => item.part)).toEqual(expect.arrayContaining(["pending:relay-targets", "pending:subscription-consent", "pending:machine-worker-limit"]));
    expect(record!.aliases).toEqual([{ source: seeded.folderKey, target: targetFolderKey, origin: "transfer" }]);
    expect(fs.readFileSync(path.join(target.state, "role-memory", "known-values.txt"), "utf8")).toContain("Keep public text free of identities.");

    // The same bundle again: recognised, and everything already there.
    const again = await within(target, () => previewTransferImport(bundle, {}));
    expect(again.previousImport?.importId).toBe(record!.importId);
    const remembered = again.projects.find(project => project.key === seeded.folderKey)!;
    expect([remembered.state, remembered.target]).toEqual(["remembered", targetFolderKey]);
    for (const section of again.sections) expect(section.new).toBe(0);
  }, 120_000);
});

describe("into a populated install", () => {
  test("keeps the target's values, stores a differing rule text as a version, and appends with a transfer entry", async () => {
    const target = await freshTarget("populated-target");
    const first = await within(target, () => previewTransferImport(bundle, { mappings: mappingFor(target) }));
    await within(target, () => applyTransferImport({ bundleSha256: first.bundleSha256, revisions: first.revisions, mappings: mappingFor(target) }));
    // The target changes after the first import: a setting and a new lesson.
    await within(target, () => {
      setMergeOnReview(REPOSITORY, false, "operator", "2026-10-23T00:00:00.000Z");
      leaveSeatLessons({ source: { origin: "seat", project: REPOSITORY, roleId: "orchestrator", fixRound: false, conversationId: "c-target" }, now: "2026-10-23T00:00:00.000Z",
        lessons: [{ scope: "project", rule: "A rule only the target learned.", why: "Target side." }] });
    });
    // The source rewrites one of the rules both share, and learns a new one.
    const sourceAgain = makeInstall(parent, "source-again");
    fs.cpSync(source.root, sourceAgain.root, { recursive: true });
    const rewriteId = seeded.ruleIds[0]!;
    await within(sourceAgain, () => {
      leaveSeatLessons({ source: { origin: "seat", project: REPOSITORY, roleId: "orchestrator", fixRound: false, conversationId: "c2" }, now: "2026-10-24T00:00:00.000Z",
        lessons: [], rewrite: { id: seeded.ruleIds[2]!, rule: "Read the newest answer before every action.", why: "Later answers replace earlier ones." } });
      leaveSeatLessons({ source: { origin: "seat", project: REPOSITORY, roleId: "orchestrator", fixRound: false, conversationId: "c2" }, now: "2026-10-24T00:00:00.000Z",
        lessons: [{ scope: "project", rule: "A second source lesson.", why: "Source side." }] });
    });
    void rewriteId;
    const second = (await exportFrom(sourceAgain, { exportId: "export-2" })).bytes;
    const plan = await within(target, () => previewTransferImport(second, {}));
    const settings = plan.sections.find(section => section.name === "settings.projects")!;
    expect(settings.conflicts).toEqual(expect.arrayContaining([{ key: `map:project-settings|${REPOSITORY}`, action: "kept-target" }]));
    const role = plan.sections.find(section => section.name === "memory.role")!;
    expect(role.conflicts).toEqual(expect.arrayContaining([{ key: `rows:role_memory|r:${seeded.ruleIds[2]}`, action: "stored-as-version" }]));
    const { report, ledger } = await within(target, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions }));
    expect(report.sections.every(section => section.balanced)).toBe(true);
    expect(report.scopes.filter(scope => !scope.ok)).toEqual([]);
    const view = await within(target, async () => {
      const store = await import("@/lib/memory/roleStore");
      const projectScope = store.projectScope(REPOSITORY);
      const { mergeOnReviewEnabled } = await import("@/lib/projects/settings");
      const collection = store.roleMemoryCollection()!;
      const scope = collection.get(`s:${projectScope}`);
      const rule = collection.get(`r:${seeded.ruleIds[2]}`);
      return { merge: mergeOnReviewEnabled(REPOSITORY), scope, rule, active: store.activeRules(projectScope).map(entry => entry.rule) };
    });
    expect(view.merge).toBe(false);
    expect(view.active).toEqual(expect.arrayContaining(["A rule only the target learned.", "A second source lesson."]));
    expect(view.scope?.kind === "scope" && view.scope.history.at(-1)?.by).toBe("transfer");
    expect(view.rule?.kind === "rule" && view.rule.rule).toBe("Read the newest operator answer before acting.");
    const version = Object.keys(ledger.versions)[0]!;
    expect(ledger.versions[version]).toBe(seeded.ruleIds[2]);
    expect(view.rule?.kind === "rule" && view.rule.versions).toContain(version);
  }, 120_000);
});

describe("apply refusals", () => {
  test("refuses when the target changed after the dry run, and writes nothing", async () => {
    const target = await freshTarget("moved-target");
    const plan = await within(target, () => previewTransferImport(bundle, { mappings: mappingFor(target) }));
    await within(target, () => setMergeOnReview(REPOSITORY, false, "operator", NOW));
    const before = treeDigest(target.state);
    const failure = await within(target, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions, mappings: mappingFor(target) })).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(TransferImportError);
    expect((failure as TransferImportError).code).toBe("target_changed");
    expect(treeDigest(target.state)).toEqual(before);
    expect(await within(target, () => readImportRecords())).toEqual([]);
  }, 60_000);

  test("never replaces a settings file that is there and does not parse", async () => {
    const target = await freshTarget("damaged-target");
    const damaged = path.join(target.state, "project-settings.json");
    fs.writeFileSync(damaged, "{ half a file");
    const plan = await within(target, () => previewTransferImport(bundle, { mappings: mappingFor(target) }));
    expect(plan.sections.find(section => section.name === "settings.projects")!.skippedReasons["target-file-unreadable"]).toBe(1);
    await within(target, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions, mappings: mappingFor(target) }));
    expect(fs.readFileSync(damaged, "utf8")).toBe("{ half a file");
  }, 60_000);

  test("refuses a bundle that was never previewed here and a mapping to a missing folder", async () => {
    const target = await freshTarget("unstaged-target");
    const unstaged = await within(target, () => applyTransferImport({ bundleSha256: "0".repeat(64), revisions: {} })).then(() => null, (error: unknown) => error);
    expect((unstaged as TransferImportError).code).toBe("not_staged");
    const badMapping = await within(target, () => previewTransferImport(bundle, { mappings: { [seeded.folderKey]: path.join(target.root, "absent") } })).then(() => null, (error: unknown) => error);
    expect((badMapping as TransferImportError).code).toBe("bad_mapping");
  }, 60_000);
});

test("a hostile bundle cannot name another file, a key outside its part, or a value its store would refuse", async () => {
  const target = await freshTarget("hostile-target");
  const hostile = encodeBundle({
    exportId: "hostile", createdAt: NOW, product: "test", projects: [], accounts: [], environment: [], notices: [],
    sections: [
      { name: "settings.voice", schema: 1, summary: {}, records: [
        { k: "text:voice-choices|token", v: "replaced-access-key" },
        { k: "text:voice-choices|../state/operator-spawn-capability", v: "x" },
        { k: "map:voice-settings|monthlyCapUsd", v: "lots" },
      ] },
      { name: "settings.operator", schema: 1, summary: {}, records: [{ k: "map:operator-settings|schemaVersion", v: 9 }] },
      { name: "settings.forge", schema: 1, summary: {}, records: [{ k: "set:forge-app-repositories|https://elsewhere", v: "https://elsewhere" }] },
      { name: "memory.settings", schema: 1, summary: {}, records: [{ k: "map:shared-memory-settings|not-a-project", v: "yes" }] },
      { name: "memory.role", schema: 1, summary: {}, records: [{ k: "rows:role_memory|r:forged", v: { kind: "rule", id: "other", rule: "x", scope: "machine" } }] },
    ],
  });
  const before = treeDigest(target.root);
  const plan = await within(target, () => previewTransferImport(hostile, {}));
  expect(plan.sections.map(section => [section.name, section.skipped, section.skippedReasons])).toEqual([
    ["settings.voice", 3, { "invalid-record": 3 }],
    ["settings.operator", 1, { "invalid-record": 1 }],
    ["settings.forge", 1, { "invalid-record": 1 }],
    ["memory.settings", 1, { "invalid-record": 1 }],
    ["memory.role", 1, { "invalid-record": 1 }],
  ]);
  await within(target, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions }));
  const changed = Object.entries(treeDigest(target.root)).filter(([file, hash]) => before[file] !== hash && !/\.sqlite(?:-wal|-shm)?$/.test(file) && !file.includes("/transfer/"));
  expect(changed).toEqual([]);
}, 60_000);

describe("settings and memory a target already has", () => {
  test("project settings merge per setting: a choice the target made stays, one it never made arrives", async () => {
    const other = makeInstall(parent, "fields-source");
    await within(other, async () => {
      await ensureLegacyCollectionsImported(() => {});
      setMergeOnReview(REPOSITORY, true, "operator", NOW);
      setBridgeReports(REPOSITORY, false, "operator", NOW);
    });
    const fields = (await exportFrom(other, { sections: ["settings.projects"], exportId: "fields" })).bytes;
    const target = await freshTarget("fields-target");
    await within(target, () => setMergeOnReview(REPOSITORY, false, "operator", NOW));
    const plan = await within(target, () => previewTransferImport(fields, {}));
    expect(plan.sections[0]!.conflicts).toEqual([{ key: `map:project-settings|${REPOSITORY}`, action: "merged" }]);
    await within(target, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions }));
    expect(await within(target, () => [mergeOnReviewEnabled(REPOSITORY), bridgeReportsEnabled(REPOSITORY)])).toEqual([false, false]);
    // «Take the source's» replaces the differing choice too, and only for that section.
    const again = await within(target, () => previewTransferImport(fields, { replace: ["settings.projects"] }));
    await within(target, () => applyTransferImport({ bundleSha256: again.bundleSha256, revisions: again.revisions, replace: ["settings.projects"] }));
    expect(await within(target, () => [mergeOnReviewEnabled(REPOSITORY), bridgeReportsEnabled(REPOSITORY)])).toEqual([true, false]);
  }, 60_000);

  test("a settled memory source reaches a target that never chose, without an engine import there; a target's own choice stays", async () => {
    const other = makeInstall(parent, "memory-source");
    await within(other, () => ensureLegacyCollectionsImported(() => {}));
    fs.writeFileSync(path.join(other.state, "memory-source.json"), JSON.stringify({ schemaVersion: 1, source: "delegatus", phase: "active", changedAt: NOW, importId: "import_source", importStartedAt: NOW, flippedAt: NOW, drainedAt: NOW }));
    const settled = (await exportFrom(other, { sections: ["memory.settings"], exportId: "memory-source" })).bytes;

    const unchosen = await freshTarget("memory-source-unchosen");
    const plan = await within(unchosen, () => previewTransferImport(settled, {}));
    expect(plan.redo.map(item => item.code)).not.toContain("memory_source");
    await within(unchosen, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions }));
    expect(await within(unchosen, () => ({ choice: memorySource(), imports: importCollection()?.snapshot().length ?? 0 }))).toEqual({ choice: { choice: "delegatus", phase: "active" }, imports: 0 });

    const chosen = await freshTarget("memory-source-chosen");
    const own = JSON.stringify({ schemaVersion: 1, source: "engines", changedAt: NOW });
    fs.writeFileSync(path.join(chosen.state, "memory-source.json"), own);
    const kept = await within(chosen, () => previewTransferImport(settled, { replace: ["memory.settings"] }));
    expect(kept.sections[0]!.conflicts).toEqual([{ key: "text:memory-source|memory-source.json", action: "kept-target" }]);
    await within(chosen, () => applyTransferImport({ bundleSha256: kept.bundleSha256, revisions: kept.revisions, replace: ["memory.settings"] }));
    expect(fs.readFileSync(path.join(chosen.state, "memory-source.json"), "utf8")).toBe(own);

    // A choice the source is still importing is the operator's to make here.
    fs.writeFileSync(path.join(other.state, "memory-source.json"), JSON.stringify({ schemaVersion: 1, source: "delegatus", phase: "importing", changedAt: NOW, importId: "import_source" }));
    const importing = (await exportFrom(other, { sections: ["memory.settings"], exportId: "memory-importing" })).bytes;
    const waiting = await freshTarget("memory-source-importing");
    const pending = await within(waiting, () => previewTransferImport(importing, {}));
    expect(pending.redo.find(item => item.code === "memory_source")?.detail).toBe("delegatus");
  }, 60_000);

  test("only the journals of closed calls travel: an ongoing call's and an uncited one stay", async () => {
    const other = makeInstall(parent, "calls-source");
    await within(other, () => ensureLegacyCollectionsImported(() => {}));
    const session = (id: string, closed: boolean) => ({ id, project: REPOSITORY, locale: "en", closed, generation: 1, createdAt: Date.parse(NOW), seq: 0, inputs: [], events: [], proposals: {} });
    fs.writeFileSync(path.join(other.state, "voice-companion.json"), JSON.stringify({ version: 1, settings: { enabled: true, monthlyCapUsd: 5, callMemory: true }, charges: {},
      sessions: { "call-closed": session("call-closed", true), "call-open": session("call-open", false) } }));
    const transcripts = path.join(other.state, "voice-companion", "transcripts");
    fs.mkdirSync(transcripts, { recursive: true });
    for (const name of ["call-closed", "call-open", "call-orphan"]) fs.writeFileSync(path.join(transcripts, `${name}.jsonl`), `{"text":"${name} journal"}\n`);
    const decoded = await decodeBundle((await exportFrom(other, { sections: ["memory.calls"], exportId: "calls" })).bytes);
    expect(decoded.records.map(record => record.k).sort()).toEqual(["map:voice-call-memory|callMemory", "map:voice-call-sessions|call-closed", "text:voice-call-journals|call-closed.jsonl"]);
    expect(JSON.stringify(decoded.records)).not.toMatch(/call-open journal|call-orphan journal/);
  }, 60_000);

  test("the header passes the same secret guard as the records, naming the field and never the value", async () => {
    const shaped = `${["api", "key"].join("_")} = ${SECRET_SHAPED_VALUE}`;
    const header = (options: Parameters<typeof exportTransferBundle>[0]) => exportFrom(source, { sections: ["settings.operator"], ...options }).then(() => null, (error: unknown) => error as TransferSecretError);
    const cases = [
      [{ env: { LLV_LANG: shaped } }, "environment LLV_LANG"],
      [{ projects: { aliases: {}, remotes: {}, displayNames: { [REPOSITORY]: shaped } }, sections: ["settings.projects"] as const }, `project ${REPOSITORY}`],
      [{ accounts: async () => ({ header: [{ engine: "codex" as const, id: "team", label: shaped, kind: "managed" as const, active: false, identity: null }], records: [] }), sections: ["accounts"] as const }, "account codex:team"],
    ] as const;
    for (const [options, field] of cases) {
      const failure = await header(options as Parameters<typeof exportTransferBundle>[0]);
      expect(failure).toBeInstanceOf(TransferSecretError);
      expect([failure!.section, failure!.key]).toEqual(["header", field]);
      expect(failure!.message).not.toContain(SECRET_SHAPED_VALUE);
    }
  }, 60_000);
});

void installEnv;
