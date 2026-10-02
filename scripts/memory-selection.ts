/** Offline Phase 2 replay. Never imports the live index service or writes engine stores. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Database } from "bun:sqlite";
import {
  JEV_ENDPOINT, JEV_MODEL, JEV_INPUT_PRICE_USD, classifierText, redactForClassifier, classifyWithJev,
} from "../src/lib/asks/jev";
import { readOpenRouterApiKey } from "../src/lib/asks/settings";

export const CAP_USD = 2;
export const THRESHOLD = 0.7;
export const SEED = "memory-selection-v1";
const hash = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

export interface Message {
  transcript_path: string; message_index: number; body: string; engine: string;
  project: string; timestamp: number | null;
}
export interface Candidate {
  id: string; title: string; summary: string; body: string; engine: string;
  kind: string; scope: string; writtenAt: string;
}
export interface Case {
  id: string; prompt: string; engine: string; candidates: Candidate[];
  retrievalMs: number; strictCount: number;
}
export interface Sample {
  version: 1; seed: string; collectedAt: string; cases: Case[];
  counts: Record<string, number>;
}
export interface Labels {
  rule: string;
  cases: Array<{ id: string; prompt: string; candidates: Array<{ id: string; helpful: boolean; summary: string; reason: string }> }>;
}

export function cleanEnvelope(text: string): string {
  return text.replace(/<!-- llv:structured-user[\s\S]*?-->/g, "").trim();
}

export function isPreamble(text: string): boolean {
  return /^(# AGENTS\.md|<environment_context>|<permissions instructions>|<recommended_plugins>|<system)/.test(text.trim());
}

export function exclusion(text: string): string | null {
  if (text.length < 40) return "short";
  if (/Pinned task:|Role prompt scaffold:|You are (?:a |an |the )?(?:fresh-context|Builder|Verifier|Architect|Deployer|Prod-auditor|orchestrator|reviewer)|seat.tick|Relayed by the controller|<subagent_notification|\[Request interrupted|QA-RENDER|send_message_to_orchestrator/i.test(text)) return "machine";
  if (/<image\b|\[Image #|\[Attached/i.test(text)) return "attachment";
  if (/^(?:Read the agent conversation|Прочитай розмову агента|Тобі передали контекст іншого агента)/i.test(text)) return "continuation";
  return null;
}

/** Skip launch metadata, then take exactly one first request per transcript.
 * An excluded first request never promotes a later request into the sample. */
export function samplePrompts(messages: Message[], limit: number) {
  const first = new Map<string, Message>();
  for (const message of [...messages].sort((a, b) => a.message_index - b.message_index)) {
    if (!isPreamble(message.body) && !first.has(message.transcript_path)) first.set(message.transcript_path, message);
  }
  const counts: Record<string, number> = { messages: messages.length, conversations: first.size, duplicate: 0 };
  const seen = new Set<string>();
  const eligible: Message[] = [];
  for (const message of first.values()) {
    const body = cleanEnvelope(message.body);
    const reason = exclusion(body);
    if (reason) { counts[reason] = (counts[reason] ?? 0) + 1; continue; }
    const digest = hash(body);
    if (seen.has(digest)) { counts.duplicate++; continue; }
    seen.add(digest);
    eligible.push({ ...message, body });
  }
  eligible.sort((a, b) => hash(SEED + a.body).localeCompare(hash(SEED + b.body)));
  counts.eligible = eligible.length;
  counts.sampled = Math.min(limit, eligible.length);
  return { rows: eligible.slice(0, limit), counts };
}

/** Literal Phase 1 query is retained as a diagnostic. The experimental OR
 * query changes recall only; both ranking arms receive the same eight hits. */
export function queryFor(text: string, mode: "strict" | "recall"): string | null {
  let terms = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (mode === "recall") {
    const stop = new Set("this that with from have your please read work task into will then what when where which about after before there their them they only need want should would could these those using agent project request current through under first just also code does more some than the and for are you how can our all any not but use run its мені треба будь ласка щоб що для або про як це так вже його вона він они это как для или что при без все уже ещё только нужно надо прочитай роботу зроби сделать".split(" "));
    terms = [...new Set(terms.map(term => term.toLowerCase()))].filter(term => term.length >= 4 && !stop.has(term));
  }
  terms = terms.slice(0, 16);
  return terms.length ? terms.map(term => `"${term}"`).join(mode === "strict" ? " AND " : " OR ") : null;
}

export function retrieve(db: Database, message: Message, mode: "strict" | "recall"): Candidate[] {
  const query = queryFor(message.body, mode);
  if (!query) return [];
  const hits = db.query<Candidate & { sourcePath: string; sourceKind: string }, [string, string, string]>(`
    SELECT e.id, e.title, e.summary, e.body, e.engine, e.kind, e.scope, e.writtenAt, e.sourcePath, e.sourceKind
    FROM memory_fts JOIN memory_entries e ON e.id = memory_fts.id
    WHERE memory_fts MATCH ? AND (e.project = ? OR e.scope = 'global')
      AND e.engine != ? AND e.kind != 'instruction'
    ORDER BY bm25(memory_fts, 0, 5, 2, 1), e.writtenAt DESC, e.id LIMIT 80
  `).all(query, message.project, message.engine);
  const seen = new Set<string>();
  return hits.filter(hit => {
    const target = hit.sourceKind === "claude_index" ? hit.body.match(/\]\(([^)]+\.md)\)/)?.[1] :
      hit.sourceKind === "claude_memory" ? hit.sourcePath : null;
    const key = target ? `claude:${path.basename(target).toLowerCase()}` : hit.title.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 8);
}

export function collect(transcripts: string, memories: string, limit = 32): Sample {
  const t = new Database(transcripts, { readonly: true });
  const m = new Database(memories, { readonly: true });
  try {
    // Transactions hold stable SQLite snapshots, including the live WAL.
    t.exec("BEGIN"); m.exec("BEGIN");
    const messages = t.query<Message, []>(`SELECT m.transcript_path, m.message_index, m.body,
      m.timestamp, f.engine, f.project FROM transcript_messages m
      JOIN transcript_files f ON f.path=m.transcript_path
      WHERE m.speaker='user' AND f.engine IN ('claude','codex')
      ORDER BY m.transcript_path, m.message_index`).all();
    const sampled = samplePrompts(messages, limit);
    sampled.counts.memoryEntries = (m.query("SELECT count(*) AS n FROM memory_entries").get() as { n: number }).n;
    const cases = sampled.rows.map((message, index) => {
      const started = performance.now();
      const hits = retrieve(m, message, "recall");
      const retrievalMs = performance.now() - started;
      return { id: `p${String(index + 1).padStart(2, "0")}`, prompt: message.body, engine: message.engine,
        retrievalMs, strictCount: retrieve(m, message, "strict").length,
        candidates: hits.map((hit, i) => ({ ...hit, id: `c${i + 1}` })),
        // Private provenance is never included in the public results.
        source: { transcript: message.transcript_path, messageIndex: message.message_index, timestamp: message.timestamp,
          memoryIds: hits.map(hit => hit.id), project: message.project },
      };
    });
    return { version: 1, seed: SEED, collectedAt: new Date().toISOString(), counts: sampled.counts, cases };
  } finally { t.close(); m.close(); }
}

export function validateLabels(sample: Sample, labels: Labels): void {
  if (sample.version !== 1 || sample.cases.length > 32 || new Set(sample.cases.map(c => c.id)).size !== sample.cases.length) throw new Error("Invalid replay sample");
  if (!labels.rule?.trim() || labels.cases.length !== sample.cases.length || !sample.cases.length) throw new Error("Incomplete labels");
  if (new Set(labels.cases.map(c => c.id)).size !== labels.cases.length) throw new Error("Duplicate labels");
  for (const c of sample.cases) {
    if (!/^p\d+$/.test(c.id) || !c.prompt?.trim() || !["claude", "codex"].includes(c.engine) ||
        !Number.isFinite(c.retrievalMs) || c.retrievalMs < 0 || !Number.isInteger(c.strictCount) || c.strictCount < 0 || c.strictCount > 8 ||
        c.candidates.length > 8 || new Set(c.candidates.map(m => m.id)).size !== c.candidates.length ||
        c.candidates.some(m => !/^c[1-8]$/.test(m.id) || typeof m.title !== "string" || typeof m.summary !== "string")) throw new Error("Invalid replay sample");
    const label = labels.cases.find(l => l.id === c.id);
    if (!label || label.candidates.length !== c.candidates.length || new Set(label.candidates.map(l => l.id)).size !== label.candidates.length) throw new Error("Candidate labels differ");
    for (const candidate of c.candidates) {
      const l = label.candidates.find(l => l.id === candidate.id);
      if (!l || typeof l.helpful !== "boolean" || !l.reason.trim()) throw new Error("Unlabelled candidate");
    }
  }
}

export function select(scores: Record<string, number>, candidates: Candidate[], threshold = THRESHOLD): string[] {
  return candidates.filter(c => scores[c.id] >= threshold)
    .sort((a, b) => scores[b.id] - scores[a.id] || candidates.indexOf(a) - candidates.indexOf(b))
    .slice(0, 3).map(c => c.id);
}

export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  return [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * q) - 1)];
}

export function metrics(cases: Sample["cases"], labels: Labels, selections: string[][], times: number[]) {
  let helpful = 0, offered = 0, available = 0;
  cases.forEach((c, i) => {
    const good = new Set(labels.cases.find(l => l.id === c.id)!.candidates.filter(l => l.helpful).map(l => l.id));
    available += good.size;
    const selected = selections[i];
    offered += selected.length;
    helpful += selected.filter(id => good.has(id)).length;
  });
  return { prompts: cases.length, offered, helpful, available, precisionAt3: helpful / (3 * cases.length),
    precisionWhenOffered: offered ? helpful / offered : null, recall: available ? helpful / available : null,
    promptCoverage: selections.filter(s => s.length).length / cases.length,
    latencyMs: { median: quantile(times, 0.5), p99: quantile(times, 0.99) } };
}

export function requestBody(c: Case) {
  return {
    model: JEV_MODEL,
    state: { prompt: classifierText(c.prompt), memories: c.candidates.map(m => ({ id: m.id,
      title: redactForClassifier(m.title).slice(0, 160), summary: redactForClassifier(m.summary).slice(0, 400) })) },
    questions: Object.fromEntries(c.candidates.map(m => [m.id, { type: "noul", instructions:
      `Memory ${m.id} contains a specific fact, rule or reference that should change how the agent carries out the prompt. It adds useful information beyond the prompt itself. A shared word or a general topic match alone is insufficient.` }])),
  };
}

/** Byte bound includes the entire variable schema plus 4096 fixed tokens.
 * Price is the same pinned model price as asks/jev.ts; never use an average
 * tokens/character estimate for admission. Minimum reserve is deliberately large. */
export function reservation(body: unknown): number {
  return Math.max(0.01, (4096 + Buffer.byteLength(JSON.stringify(body))) * JEV_INPUT_PRICE_USD);
}

export interface Receipt {
  id: string; reservedUsd: number; status: "reserved" | "complete";
  costUsd?: number; latencyMs?: number; scores?: Record<string, number>; inputTokens?: number;
}
interface Ledger { version: 1; sampleHash: string; labelsHash: string; receipts: Receipt[] }

export function charged(receipts: Receipt[]): number {
  return receipts.reduce((sum, r) => {
    const amount = r.status === "complete" ? r.costUsd : r.reservedUsd;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) throw new Error("Invalid cost ledger");
    return sum + amount;
  }, 0);
}

function durable(filename: string, value: unknown) {
  const temporary = filename + ".next";
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filename);
  const dir = fs.openSync(path.dirname(filename), "r");
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

export function parseAnswer(body: unknown, ids: string[]) {
  const record = body as { answers?: Record<string, { noul?: unknown }>; usage?: { cost?: unknown; input_tokens?: unknown } };
  const cost = record?.usage?.cost;
  const inputTokens = record?.usage?.input_tokens;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0 ||
      typeof inputTokens !== "number" || !Number.isInteger(inputTokens) || inputTokens < 0) throw new Error("Jev usage fields missing");
  const scores = Object.fromEntries(ids.map(id => {
    const value = record.answers?.[id]?.noul;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error("Jev probability missing");
    return [id, value];
  }));
  return { costUsd: cost, inputTokens, scores };
}

/** A durable reservation precedes every network call. An ambiguous outcome
 * blocks automatic retries, including after restart. One lock spans the run. */
export async function paidReplay(sample: Sample, labels: Labels, ledgerPath: string,
  probePath: string, request: typeof fetch = fetch): Promise<Ledger> {
  validateLabels(sample, labels);
  // Checking the environment first prevents the helper's file fallback.
  if (!process.env.OPENROUTER_API_KEY?.trim()) throw new Error("OPENROUTER_API_KEY required in process environment");
  const auth = readOpenRouterApiKey()!;
  const lock = ledgerPath + ".lock";
  fs.mkdirSync(lock, { mode: 0o700 });
  try {
    const sampleHash = hash(JSON.stringify(sample));
    const labelsHash = hash(JSON.stringify(labels));
    let ledger: Ledger;
    if (fs.existsSync(ledgerPath)) {
      ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
      if (ledger.version !== 1 || ledger.sampleHash !== sampleHash || ledger.labelsHash !== labelsHash) throw new Error("Frozen replay inputs changed");
    } else {
      const probe = JSON.parse(fs.readFileSync(probePath, "utf8"));
      if (probe.status !== "complete" || typeof probe.costUsd !== "number") throw new Error("Successful reachability probe with usage cost required");
      ledger = { version: 1, sampleHash, labelsHash, receipts: [{ id: "probe", status: "complete", reservedUsd: 0.01,
        costUsd: probe.costUsd, latencyMs: probe.latencyMs, inputTokens: probe.inputTokens }] };
      durable(ledgerPath, ledger);
    }
    if (ledger.receipts.some(r => r.status !== "complete")) throw new Error("Unsettled reservation; reconcile provider usage before retry");
    if (charged(ledger.receipts) > CAP_USD) throw new Error("Budget exhausted");
    for (const c of sample.cases) {
      if (!c.candidates.length || ledger.receipts.some(r => r.id === c.id)) continue;
      const body = requestBody(c);
      const reserve = reservation(body);
      if (charged(ledger.receipts) + reserve > CAP_USD) throw new Error("Budget refuses next request");
      const receipt: Receipt = { id: c.id, reservedUsd: reserve, status: "reserved" };
      ledger.receipts.push(receipt);
      durable(ledgerPath, ledger);
      const started = performance.now();
      // No retry. Do not print an error body: it can echo private request text.
      const response = await request(JEV_ENDPOINT, { method: "POST", signal: AbortSignal.timeout(1500),
        headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`Jev HTTP ${response.status}; reservation retained`);
      const result = parseAnswer(await response.json(), c.candidates.map(m => m.id));
      Object.assign(receipt, result, { status: "complete", latencyMs: performance.now() - started });
      durable(ledgerPath, ledger);
      if (result.costUsd > reserve) throw new Error("Provider exceeded pinned price bound; stop and reconcile");
    }
    return ledger;
  } finally { fs.rmdirSync(lock); }
}

export async function run(sample: Sample, labels: Labels, ledgerPath?: string, probePath?: string) {
  validateLabels(sample, labels);
  const fts = sample.cases.map(c => c.candidates.slice(0, 3).map(m => m.id));
  const empty = sample.cases.map(() => [] as string[]);
  const baselineTimes = sample.cases.map(c => c.retrievalMs);
  const noneTimes = sample.cases.map(() => { const t = performance.now(); void []; return performance.now() - t; });
  const ledger = ledgerPath && probePath ? await paidReplay(sample, labels, ledgerPath, probePath) : null;
  const selections = ledger ? sample.cases.map(c => {
    const receipt = ledger.receipts.find(r => r.id === c.id);
    return receipt?.scores ? select(receipt.scores, c.candidates) : [];
  }) : null;
  const jevTimes = ledger ? sample.cases.map(c => c.retrievalMs + (ledger.receipts.find(r => r.id === c.id)?.latencyMs ?? 0)) : [];
  return { version: 1, collectedAt: sample.collectedAt, counts: sample.counts,
    protocol: { seed: SEED, threshold: THRESHOLD, capUsd: CAP_USD, candidates: 8, slots: 3, model: JEV_MODEL },
    strictNonempty: sample.cases.filter(c => c.strictCount > 0).length,
    fts: metrics(sample.cases, labels, fts, baselineTimes), none: metrics(sample.cases, labels, empty, noneTimes),
    jev: selections ? metrics(sample.cases, labels, selections, jevTimes) : null,
    spendUsd: ledger ? charged(ledger.receipts) : 0,
    calls: ledger?.receipts ?? [],
    cases: sample.cases.map((c, i) => ({ id: c.id, engine: c.engine, candidates: c.candidates.length,
      strictCount: c.strictCount, retrievalMs: c.retrievalMs, fts: fts[i], jev: selections?.[i] ?? null })),
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "probe" && args.length === 1) {
    if (!process.env.OPENROUTER_API_KEY?.trim()) throw new Error("OPENROUTER_API_KEY required in process environment");
    // Exclusive creation makes this one attempt even if its reply is lost.
    const fd = fs.openSync(args[0], "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ status: "reserved", reservedUsd: 0.01 })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    const started = performance.now();
    const auth = readOpenRouterApiKey()!;
    const result = await classifyWithJev("The requested work is complete.", { apiKey: auth });
    const record = { status: "complete", costUsd: result.costUsd, inputTokens: result.inputTokens, latencyMs: performance.now() - started };
    durable(args[0], record);
    console.log(JSON.stringify(record));
  } else if (command === "collect" && args.length === 3) {
    const sample = collect(args[0], args[1]);
    fs.writeFileSync(args[2], JSON.stringify(sample, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify(sample.counts));
  } else if ((command === "local" && args.length === 3) || (command === "jev" && args.length === 5)) {
    const [samplePath, labelsPath, outputPath, ledgerPath, probePath] = args;
    const sample = JSON.parse(fs.readFileSync(samplePath, "utf8")) as Sample;
    const labels = JSON.parse(fs.readFileSync(labelsPath, "utf8")) as Labels;
    const result = await run(sample, labels, ledgerPath, probePath);
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ prompts: sample.cases.length, spendUsd: result.spendUsd, jev: result.jev !== null }));
  } else throw new Error("Usage: probe PROBE | collect TRANSCRIPT_DB MEMORY_DB PRIVATE_SAMPLE | local SAMPLE LABELS OUTPUT | jev SAMPLE LABELS OUTPUT LEDGER PROBE");
}

if (import.meta.main) main().catch(error => {
  // Fixed messages only; network errors may contain request details.
  console.error(error instanceof Error && /^(Usage:|Incomplete|Duplicate|Candidate|Unlabelled|OPENROUTER|Frozen|Successful|Unsettled|Budget|Provider|Jev )/.test(error.message)
    ? error.message : "Replay failed; private inputs and any cost reservation retained");
  process.exitCode = 1;
});
