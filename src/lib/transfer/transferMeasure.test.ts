import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { roleMemoryCollection } from "@/lib/memory/roleStore";
import type { RoleMemoryRule, RoleMemoryScopeRow, ScopeHistoryEntry } from "@/lib/memory/roleTypes";
import { ensureLegacyCollectionsImported } from "@/lib/state/legacyCollections";

import { exportTransferBundle } from "./exporter";
import { previewTransferImport, readImportRecords } from "./importer";
import { applyBundle } from "./service";
import { makeInstall, within, type Install } from "./transfer.fixture";

/* The apply window (docs/design/install-memory-transfer.md §4.7, §7 slice 1)
   on learned rules shaped like the inventory of §1.10: 2,898 rules and 112
   scopes whose histories hold about 20 MB, the largest scope 4.7 MB. The
   design's target is under 10 s for the default sections. LLV_TRANSFER_MEASURE=1
   runs the full shape; by default a tenth of it runs. The apply runs in the
   real worker process and the budget is the Viewer's own deadline on it,
   enforced from this process: a worker past it is stopped and the apply
   fails. The times it reports are printed as diagnostics only. */

const FULL = process.env.LLV_TRANSFER_MEASURE === "1";
const SCALE = FULL ? 1 : 0.1;
/** The design's 10 s window, plus the worker's own start on a loaded runner for the scaled run. */
const BUDGET_MS = FULL ? 10_000 : 20_000;
const WORKER = path.join(import.meta.dir, "transfer.worker.ts");
const launch = { executable: process.execPath, workerPath: WORKER };
const parent = fs.mkdtempSync(path.join(os.tmpdir(), "transfer-measure-"));
afterAll(() => { fs.rmSync(parent, { recursive: true, force: true }); });

const workerEnv = (install: Install, extra: Record<string, string> = {}) => ({ HOME: install.home, NODE_ENV: "test", ...extra });

test(`applies role memory shaped like the live inventory${FULL ? "" : " (a tenth of it)"} inside the window`, async () => {
  const source = makeInstall(parent, "source");
  const target = makeInstall(parent, "target");
  const rules = Math.round(2_898 * SCALE);
  const scopes = Math.max(4, Math.round(112 * SCALE));
  const project = `repo-${"b".repeat(32)}`;
  await within(source, () => {
    const rows: (RoleMemoryRule | RoleMemoryScopeRow)[] = [];
    const scopeNames = Array.from({ length: scopes }, (_, index) => index === 0 ? "machine" : `role:${project}:role${index}`);
    const members = new Map(scopeNames.map(name => [name, [] as string[]]));
    for (let index = 0; index < rules; index += 1) {
      const scope = scopeNames[index % scopes]!;
      const id = `r_${index.toString(16).padStart(16, "0")}`;
      members.get(scope)!.push(id);
      rows.push({ kind: "rule", id, scope, rule: `Rule ${index}: ${"keep the evidence beside the claim. ".repeat(6)}`, why: "Measured.", state: index % 6 === 0 ? "active" : "archived", hints: [],
        source: { origin: "seat", project, roleId: "orchestrator", fixRound: false, conversationId: "c" }, createdAt: "2026-10-01T00:00:00.000Z", changedAt: "2026-10-01T00:00:00.000Z" });
    }
    const historyBytes = 20.2 * 1024 * 1024 * SCALE;
    for (const [position, name] of scopeNames.entries()) {
      const ids = members.get(name)!;
      // One scope carries a quarter of the history, as the largest live row does.
      const share = position === 1 ? historyBytes / 4 : (historyBytes * 3 / 4) / (scopes - 1);
      const entry = (revision: number): ScopeHistoryEntry => ({ revision, at: "2026-10-01T00:00:00.000Z", by: "agent", added: ids.slice(0, 20), merged: [], archived: ids.slice(20, 40) });
      const entryBytes = JSON.stringify(entry(1)).length;
      const history = Array.from({ length: Math.max(1, Math.round(share / entryBytes)) }, (_, index) => entry(index + 1));
      rows.push({ kind: "scope", scope: name, revision: history.length, active: ids.filter((_, index) => index % 6 === 0), history });
    }
    roleMemoryCollection(true)!.patchSync(() => ({ records: rows }));
  });
  await within(target, () => ensureLegacyCollectionsImported(() => {}));
  const exportStarted = performance.now();
  const bundle = (await within(source, () => exportTransferBundle({ sections: ["memory.role"], env: {}, product: "measure" }))).bytes;
  const exportMs = performance.now() - exportStarted;
  const previewStarted = performance.now();
  const plan = await within(target, () => previewTransferImport(bundle));
  const previewMs = performance.now() - previewStarted;
  const applyStarted = performance.now();
  const applied = await within(target, () => applyBundle({ bundleSha256: plan.bundleSha256, revisions: plan.revisions }, { launch, timeoutMs: BUDGET_MS, env: workerEnv(target) }));
  const wallMs = Math.round(performance.now() - applyStarted);
  const report = applied.ok ? applied.result as { complete: boolean; applyMs: number } : null;
  console.info(`[transfer measure] scale ${SCALE}: ${rules} rules, ${scopes} scopes, bundle ${(bundle.length / 1024 / 1024).toFixed(2)} MiB compressed; export ${Math.round(exportMs)} ms, dry run ${Math.round(previewMs)} ms, apply ${report?.applyMs ?? "-"} ms in the worker, ${wallMs} ms with its start (budget ${BUDGET_MS} ms)`);
  expect(applied).toMatchObject({ ok: true, result: { complete: true } });
}, 600_000);

test("an apply that hangs is stopped by the parent's budget, fails, and leaves nothing applied", async () => {
  const source = makeInstall(parent, "hang-source");
  const target = makeInstall(parent, "hang-target");
  await within(source, () => {
    const rule: RoleMemoryRule = { kind: "rule", id: "r_0000000000000001", scope: "machine", rule: "Keep the evidence beside the claim.", why: "Measured.", state: "active", hints: [],
      source: { origin: "seat", project: `repo-${"b".repeat(32)}`, roleId: "orchestrator", fixRound: false, conversationId: "c" }, createdAt: "2026-10-01T00:00:00.000Z", changedAt: "2026-10-01T00:00:00.000Z" };
    roleMemoryCollection(true)!.patchSync(() => ({ records: [rule, { kind: "scope", scope: "machine", revision: 1, active: [rule.id], history: [] } satisfies RoleMemoryScopeRow] }));
  });
  await within(target, () => ensureLegacyCollectionsImported(() => {}));
  const bundle = (await within(source, () => exportTransferBundle({ sections: ["memory.role"], env: {}, product: "measure" }))).bytes;
  const plan = await within(target, () => previewTransferImport(bundle));
  const budget = 15_000;
  const applied = await within(target, () => applyBundle({ bundleSha256: plan.bundleSha256, revisions: plan.revisions }, { launch, timeoutMs: budget, env: workerEnv(target, { LLV_TRANSFER_TEST_FAULT: "hang" }) }));
  expect(applied).toMatchObject({ ok: false, error: { code: "worker_stopped", message: `the transfer worker ran past ${budget} ms and was stopped` }, recovered: [{ outcome: "rolled-back" }] });
  // The worker reached the apply before it was stopped, and nothing of it stayed.
  const imports = path.join(target.state, "transfer", "imports");
  const [importId] = fs.readdirSync(imports);
  expect(fs.existsSync(path.join(imports, importId!, "hanging"))).toBe(true);
  expect(await within(target, () => ({ records: readImportRecords(), rules: roleMemoryCollection()?.snapshot().length ?? 0 }))).toEqual({ records: [], rules: 0 });
}, 120_000);
