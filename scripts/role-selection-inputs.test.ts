import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { assembleInputs } from "./role-selection-inputs";
import { buildPipeline } from "../src/lib/pipelines/store";
import type { EvalCase } from "./role-selection-eval";
import type { RoleMemoryRule } from "../src/lib/memory/roleTypes";

test("recorded duplicate text resolves by delivered identity and digest, with missing versions rejected", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "selection-inputs-"));
  const source = new Database(path.join(root, "state.sqlite"));
  const ledger = new Database(path.join(root, "delivery.sqlite"));
  try {
    const at = "2026-10-01T00:00:00Z", text = "Check receipt ownership before replay.";
    const pipeline = buildPipeline({ id: "fixture", task: "Repair receipts", spec: "Keep replay idempotent", project: "fixture", repoDir: "/repo", srcPath: null, srcConversationId: null, now: at,
      stages: [{ id: "build", kind: "run", prompt: "Repair receipt recovery", next: null,
        effectiveRole: { roleId: "builder", engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: "Build and verify the task." } }] });
    source.exec("CREATE TABLE state_rows(collection TEXT,row_key TEXT,value_json TEXT)");
    const put = (collection: string, id: string, row: unknown) => source.query("INSERT INTO state_rows VALUES(?,?,?)").run(collection, id, JSON.stringify(row));
    put("pipelines", pipeline.id, pipeline);
    const make = (id: string, scope: string): RoleMemoryRule => ({ kind: "rule", id, scope, rule: text, why: "Earlier replay missed proof.", state: "active", hints: [], createdAt: at, changedAt: at,
      source: { origin: "conversation", project: "fixture", roleId: "builder", fixRound: false, conversationId: "fixture-conversation" } });
    put("role_memory", "a", make("r_a", "machine"));
    put("role_memory", "b", make("r_b", "role:fixture:builder"));
    put("role_memory", "request", { kind: "request", pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", applied: ["r_a"], misled: [] });
    ledger.exec("CREATE TABLE deliveries(sequence INTEGER,body TEXT)");
    const hash = createHash("sha256").update(text).digest("hex");
    const delivery = { at, attempt: { pipelineId: "fixture", stageId: "build", attempt: 1 }, rules: [{ id: "r_a", hash }] };
    ledger.query("INSERT INTO deliveries VALUES(?,?)").run(1, JSON.stringify(delivery));
    expect(assembleInputs(path.join(root, "state.sqlite"), path.join(root, "delivery.sqlite"), root)).toMatchObject({ cases: 1, applied: 1, dropped: 0 });
    const cases: EvalCase[] = JSON.parse(fs.readFileSync(path.join(root, "corpus.json"), "utf8"));
    expect(cases[0].scopes[0].scope).toBe("machine");
    const first = fs.readFileSync(path.join(root, "corpus.json"), "utf8");
    assembleInputs(path.join(root, "state.sqlite"), path.join(root, "delivery.sqlite"), root);
    expect(fs.readFileSync(path.join(root, "corpus.json"), "utf8")).toBe(first);
    source.query("DELETE FROM state_rows WHERE row_key=?").run("a");
    expect(assembleInputs(path.join(root, "state.sqlite"), path.join(root, "delivery.sqlite"), root)).toMatchObject({ cases: 0, dropped: 1 });
  } finally { source.close(); ledger.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
