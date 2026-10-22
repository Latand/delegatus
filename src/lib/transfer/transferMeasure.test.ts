import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { roleMemoryCollection } from "@/lib/memory/roleStore";
import type { RoleMemoryRule, RoleMemoryScopeRow, ScopeHistoryEntry } from "@/lib/memory/roleTypes";
import { ensureLegacyCollectionsImported } from "@/lib/state/legacyCollections";

import { exportTransferBundle } from "./exporter";
import { applyTransferImport, previewTransferImport } from "./importer";
import { makeInstall, within } from "./transfer.fixture";

/* The apply window (docs/design/install-memory-transfer.md §4.7, §7 slice 1)
   on learned rules shaped like the inventory of §1.10: 2,898 rules and 112
   scopes whose histories hold about 20 MB, the largest scope 4.7 MB. The
   design's target is under 10 s for the default sections. LLV_TRANSFER_MEASURE=1
   runs the full shape and prints the timings; by default a tenth of it runs. */

const FULL = process.env.LLV_TRANSFER_MEASURE === "1";
const SCALE = FULL ? 1 : 0.1;
const parent = fs.mkdtempSync(path.join(os.tmpdir(), "transfer-measure-"));
afterAll(() => { fs.rmSync(parent, { recursive: true, force: true }); });

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
  const { report } = await within(target, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions }));
  console.info(`[transfer measure] scale ${SCALE}: ${rules} rules, ${scopes} scopes, bundle ${(bundle.length / 1024 / 1024).toFixed(2)} MiB compressed; export ${Math.round(exportMs)} ms, dry run ${Math.round(previewMs)} ms, apply ${report.applyMs} ms`);
  expect(report.complete).toBe(true);
  expect(report.applyMs).toBeLessThan(10_000);
}, 600_000);
