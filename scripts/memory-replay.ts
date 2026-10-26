#!/usr/bin/env bun
/** Free, read-only historical replay assembly. No runtime or state-store imports. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { renderLearnedRules } from "../src/lib/memory/roleRender";
import { renderStagePrompt } from "../src/lib/pipelines/prompts";
import type { Pipeline } from "../src/lib/pipelines/types";
import type { RoleMemoryRow, RoleMemoryRule } from "../src/lib/memory/roleTypes";

const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const time = (text: string | null | undefined) => text ? Date.parse(text) : NaN;
const classes = {
  rendered: "viewport|width|theme|dark|light|locale|language|matrix|screenshot|frame|phone|ширин|тем[аиіуо]|темн|світл|мов[аиіуо]|кадр|скріншот|знімк|телефон",
  contract: "contract|shape|schema|validation|payload|контракт|схем|валідац|формат",
  seam: "restart|stale|identity|race|concurren|crash|recover|reload|resume|succession|replay|перезапуск|рестарт|застар|ідентичн|гонк|конкурен|збій|відновл|перезавантаж|поновл|наступн|повтор",
  tests: "test|тест", privacy: "privacy|private|приват|конфіденц",
  hotPath: "whole.store|per.tick|blocking|synchronous|cache|unbounded|event.loop|на.тик|блокув|синхрон|кеш|необмежен|цикл.подій",
};
const classify = (text: string) => Object.entries(classes).filter(([, terms]) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms})`, "iu").test(text)).map(([name]) => name);
const liveReference = /https?:\/\/\S+|\b(?:pull request|PR|issue)s?\s+#?\d+|\bgh\s+(?:pr|issue)\s+\w+/i;
const guidance = "Use the project's test command from its instruction files or package scripts, selecting test files by explicit path. Replay test guidance is frozen; use isolated state.";

function historicalRule(rules: RoleMemoryRule[], id: string, at: number) {
  const current = rules.find(r => r.id === id && !r.versionOf);
  if (!current || time(current.createdAt) > at) throw Error("rule text unavailable");
  const prior = rules.filter(r => r.versionOf === id && time(r.changedAt) > at)
    .sort((a, b) => time(a.changedAt) - time(b.changedAt))[0];
  return { id, text: (prior ?? current).rule };
}

export function assembleReplay(stateDir: string, output: string) {
  // Reject output inside a checkout or the source tree before writing anything.
  const destination = path.resolve(output);
  let ancestor = path.dirname(destination);
  while (true) {
    if (fs.existsSync(path.join(ancestor, ".git"))) throw Error("output must be outside a checkout");
    const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
  }
  const source = fs.realpathSync(stateDir);
  const existingParent = fs.realpathSync(path.dirname(destination));
  if (existingParent === source || existingParent.startsWith(source + path.sep)) throw Error("output must be outside source state");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "memory-replay-"));
  try {
    fs.chmodSync(scratch, 0o700);
    const snapshot = path.join(scratch, "state.sqlite");
    const live = new Database(path.join(source, "state.sqlite"), { readonly: true });
    try { live.run("VACUUM INTO ?", [snapshot]); } finally { live.close(); }
    const db = new Database(snapshot, { readonly: true });
    const rows = <T>(collection: string): T[] => db.query<{ value_json: string }, [string]>("SELECT value_json FROM state_rows WHERE collection = ? ORDER BY row_key").all(collection).map(r => JSON.parse(r.value_json) as T);
    let pipelines: Pipeline[], memory: RoleMemoryRow[];
    try {
      pipelines = [...new Map([...rows<Pipeline>("pipelines_archive"), ...rows<Pipeline>("pipelines")].map(p => [p.id, p])).values()];
      memory = rows<RoleMemoryRow>("role_memory");
    } finally { db.close(); }
    const rules = memory.filter(r => r.kind === "rule");
    const scopes = memory.filter(r => r.kind === "scope");
    const requests = memory.filter(r => r.kind === "request");
    fs.mkdirSync(destination, { mode: 0o700 });
    const write = (name: string, value: unknown) => fs.writeFileSync(path.join(destination, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    fs.mkdirSync(path.join(destination, "items"), { mode: 0o700 }); fs.mkdirSync(path.join(destination, "oracle"), { mode: 0o700 });
    fs.copyFileSync(snapshot, path.join(destination, "source.sqlite")); fs.chmodSync(path.join(destination, "source.sqlite"), 0o600);
    const items: { id: string; stratum: string; digest: string }[] = [], dropped: { id: string; reason: string }[] = [];
    for (const p of pipelines.sort((a, b) => hash(a.id).localeCompare(hash(b.id)))) {
      if (!/^[a-zA-Z0-9_-]+$/.test(p.id)) {
        dropped.push({ id: p.id, reason: "unsafe item id" });
        continue;
      }
      const attempts = p.runs.flatMap(run => run.attempts.map(a => ({ ...a, stage: p.stages.find(s => s.id === run.stageId)! }))).filter(a => a.stage);
      const role = (a: typeof attempts[number]) => a.effectiveRole?.roleId ?? a.stage.role?.roleId;
      const first = attempts.filter(a => role(a) === "builder" && !a.stage.onFail && !a.activatedBy && Number.isFinite(time(a.startedAt))).sort((a, b) => time(a.startedAt) - time(b.startedAt))[0];
      if (!first) continue;
      const review = attempts.filter(a => role(a) === "reviewer" && a.verdict && time(a.startedAt) >= time(first.completedAt)).sort((a, b) => time(a.startedAt) - time(b.startedAt))[0];
      if (review?.verdict?.status !== "fail") continue;
      const judged = attempts.filter(a => role(a) === "builder" && time(a.completedAt) <= time(review.startedAt))
        .sort((a, b) => time(b.completedAt) - time(a.completedAt))[0];
      if (judged !== first) continue;
      const fix = attempts.filter(a => role(a) === "builder" && a.activatedBy?.edge === "fail" && a.activatedBy.stageId === review.stage.id && a.activatedBy.attempt === review.n).sort((a, b) => time(a.startedAt) - time(b.startedAt))[0];
      const request = fix && requests.find(r => r.pipelineId === p.id && r.stageId === fix.stage.id && r.attempt === fix.n);
      if (!request || !(request.ruleIds.length || request.rewrote)) continue;
      let createdFolder: string | undefined;
      try {
        if (!first.definition?.prompt || !p.task || !p.spec || !first.effectiveRole?.promptScaffold) throw Error("frozen input missing");
        if (!Number.isFinite(time(request.at)) || time(request.at) <= time(review.completedAt)) throw Error("lesson chronology unavailable");
        const matchesSource = (source: RoleMemoryRule["source"] | undefined) => source && "pipelineId" in source && source.pipelineId === p.id && source.stageId === fix!.stage.id && source.attempt === fix!.n;
        const after = [...new Set([...request.ruleIds, ...(request.rewrote ? [request.rewrote] : [])])].map(id => {
          const current = rules.find(r => r.id === id && !r.versionOf);
          const writtenAt = request.rewrote === id
            ? rules.filter(r => r.id === id || r.versionOf === id).map(r => r.revisedBy)
              .filter(r => r?.by === "agent" && matchesSource(r.source) && time(r.at) >= time(request.at))
              .sort((a, b) => time(a!.at) - time(b!.at))[0]?.at
            : current && matchesSource(current.source) ? current.createdAt : undefined;
          if (!writtenAt || time(writtenAt) < time(request.at)) throw Error("lesson write provenance unavailable");
          return { ...historicalRule(rules, id, time(writtenAt)), writtenAt };
        });
        const findings = ((review.verdict.findings ?? []) as Array<string | { text: string }>).map(f => ({ text: typeof f === "string" ? f : f.text, reproduction: typeof f === "string" ? f : f.text }));
        const matching = findings.filter(f => classify(f.text).some(c => after.some(r => classify(r.text).includes(c))));
        if (!matching.length) throw Error("no finding class matches written rule");
        const at = time(first.startedAt);
        const scopeKeys = [`role:${p.project}:builder`, "role:*:builder", `project:${p.project}`, "machine"];
        const delivered = scopeKeys.flatMap(scope => {
          const row = scopes.find(s => s.scope === scope);
          // An absent scope with surviving rules is not proof of an empty block.
          if (!row) { if (rules.some(r => r.scope === scope && time(r.createdAt) <= at)) throw Error("scope history unavailable"); return []; }
          const history = [...row.history].sort((a, b) => time(a.at) - time(b.at));
          if (!history.some(h => !h.pass && time(h.at) <= at)) throw Error("outside retained history");
          if (history.some(h => h.by === "succession" || h.moved?.length)) throw Error("scope succession requires delivery ledger");
          let active = [...row.active];
          for (const h of history.reverse()) {
            if (time(h.at) <= at) break;
            if (h.before) { active = [...h.before]; continue; }
            active = active.filter(id => !h.added.includes(id) && !h.restored?.includes(id));
            for (const id of h.archived) if (!active.includes(id)) active.unshift(id);
          }
          return active.reverse().map(id => ({ scope, ...historicalRule(rules, id, at) }));
        });
        const template = first.definition.prompt;
        if ((template + first.effectiveRole.promptScaffold).includes("{{prev.output}}") && !first.input?.trim()) throw Error("relay missing");
        const baseCommit = execFileSync("git", ["-C", p.repoDir, "rev-parse", "--verify", `${p.baseRef}^{commit}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        const stage = { ...first.stage, ...first.definition, role: first.definition.role ?? undefined, sandbox: first.definition.sandbox ?? undefined, outputs: first.definition.outputs ?? undefined, effectiveRole: first.effectiveRole };
        const message = renderStagePrompt({ ...p, baseRef: baseCommit }, stage, first.effectiveRole, first.input ?? "", 30, guidance);
        if (/\{\{[^}]*\}\}/.test(message)) throw Error("unresolved placeholder");
        if (liveReference.test(message)) throw Error("unfrozen live reference");
        const tags = matching.flatMap(f => classify(f.text));
        const stratum = tags.includes("rendered") ? "rendered-state" : tags.some(c => c === "seam" || c === "contract") ? "contract-or-seam" : "evidence-or-claim";
        const learnedRuleLines = delivered.map(r => `- [${r.id}] ${r.text}`).join("\n");
        const learnedRuleBlock = renderLearnedRules(scopeKeys.map(scope => ({ scope, rules: delivered.filter(r => r.scope === scope).map(r => ({ ...rules.find(row => row.id === r.id)!, rule: r.text })) })));
        const input = { id: p.id, stage: first.stage.id, attempt: first.n, baseCommit, brief: p.task, spec: p.spec,
          scaffold: first.effectiveRole.promptScaffold.split("{{task}}").join(p.task).split("{{prev.output}}").join(first.input ?? ""),
          message, messageBytes: Buffer.byteLength(message), messageDigest: hash(message), exceedsInlineLimit: Buffer.byteLength(message) > 32_000,
          rules: delivered, learnedRuleBlock, learnedRuleLines,
          ruleDigest: hash(learnedRuleLines), blockDigest: hash(learnedRuleBlock), testGuidance: guidance,
          engineMemory: "off in every replay arm; historical files unavailable", rendering: "current renderer, frozen role and definition; inline replay" };
        const folder = path.join(destination, "items", p.id); fs.mkdirSync(folder, { mode: 0o700 });
        createdFolder = folder;
        // A temporary bare repository supplies a named ref without modifying the source repository.
        const bare = path.join(scratch, "base");
        fs.rmSync(bare, { recursive: true, force: true });
        const git = (args: string[]) => execFileSync("git", args, { stdio: "ignore" });
        git(["init", "--bare", "-q", bare]);
        git(["-C", bare, "fetch", "--no-tags", p.repoDir, `${baseCommit}:refs/heads/replay-base`]);
        const bundle = path.join(folder, "base.bundle");
        git(["-C", bare, "bundle", "create", bundle, "refs/heads/replay-base"]); fs.chmodSync(bundle, 0o600);
        const frozenInput = { ...input, baseBundleDigest: hash(fs.readFileSync(bundle)) };
        write(`items/${p.id}/input.json`, frozenInput);
        write(`oracle/${p.id}.json`, { findings: matching, rules: after, review: { stage: review.stage.id, attempt: review.n }, reproductionFormat: "verbatim finding; not executed or inferred" });
        items.push({ id: p.id, stratum, digest: hash(JSON.stringify(frozenInput)) });
      } catch (error) {
        if (createdFolder) fs.rmSync(createdFolder, { recursive: true, force: true });
        const reason = error instanceof Error && /^(unsafe|frozen|lesson|no finding|rule text|scope|outside|relay|unresolved|unfrozen)/.test(error.message) ? error.message : "base commit or bundle unavailable";
        dropped.push({ id: p.id, reason });
      }
    }
    const quotas = { "rendered-state": 4, "contract-or-seam": 3, "evidence-or-claim": 3 };
    const pilot = Object.entries(quotas).flatMap(([stratum, count]) => items.filter(i => i.stratum === stratum).slice(0, count).map(i => i.id));
    const manifest = { version: 1, sourceDigest: hash(fs.readFileSync(snapshot)), items, dropped, pilot, pilotDigest: hash([...pilot].sort().join("\n")), reconstruction: "historical four-scope rule lines; no engine launch", rendererGuidance: guidance };
    write("manifest.json", manifest);
    return { eligible: items.length, dropped: dropped.length, pilot: pilot.length };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== "--state-dir" || args[2] !== "--output") throw Error("usage");
    console.log(JSON.stringify(assembleReplay(args[1], args[3])));
  } catch { console.error("Replay assembly failed. Use --state-dir STATE --output NEW_PRIVATE_DIRECTORY outside any checkout; inspect inputs locally."); process.exitCode = 1; }
}
