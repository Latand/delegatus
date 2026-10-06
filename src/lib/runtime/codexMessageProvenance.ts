import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { statePath } from "@/lib/configDir";
import { recordValue, stringValue } from "@/lib/scanner/json";
import { sameMessageOrigin, type MessageOrigin } from "./messageOrigin";
import { RECOVERY_NOTICE_ORIGIN } from "./recoveryNotices";

type RecordLike = Record<string, unknown>;
interface ProvenRow {
  offset: number;
  length: number;
  digest: string;
  family?: string;
}
interface DeliveryProof {
  version: 1 | 2 | 3;
  fileIdentity: string | null;
  turnId: string;
  rows: ProvenRow[];
  clientId?: string;
  scanOffset?: number;
  bindingId?: string;
  dispatchOffset?: number;
  prefixDigest?: string;
  contentDigest?: string;
  closed?: boolean;
  extensionClosed?: boolean;
  blockedFamilies?: string[];
}
const MAX_PROOF_READ_BYTES = 32 * 1024 * 1024;
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const identity = (stat: fs.Stats) => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
const ledgerPath = (transcript: string) => statePath("codex-prompt-deliveries", `${hash(path.resolve(transcript))}.jsonl`);

// Bind the dispatch boundary to the bytes already present, including files
// whose prefix is larger than the scanner tail. Read in bounded chunks.
function prefixHash(fd: number, length: number): string | null {
  if (!Number.isSafeInteger(length) || length < 0) return null;
  const digest = createHash("sha256");
  const bytes = Buffer.alloc(Math.min(length, 1_048_576));
  for (let offset = 0; offset < length;) {
    const size = Math.min(bytes.length, length - offset);
    if (fs.readSync(fd, bytes, 0, size, offset) !== size) return null;
    digest.update(bytes.subarray(0, size));
    offset += size;
  }
  return digest.digest("hex");
}

function nativeIdentity(...sources: RecordLike[]) {
  const values = (camel: string, snake: string) => sources.flatMap(source =>
    [stringValue(source[camel]), stringValue(source[snake])].filter((value): value is string => value !== null));
  const clients = values("clientId", "client_id");
  const turns = values("turnId", "turn_id");
  return { clientId: clients[0], turnId: turns[0],
    identityConflict: new Set(clients).size > 1 || new Set(turns).size > 1 };
}

/** The three native representations of a prompt. Text and marker attributes
 * are payload checks only; none of them establish who sent the prompt. */
export function codexNativeUserPrompt(record: RecordLike) {
  const payload = recordValue(record.payload);
  if (!payload) return null;
  const item = recordValue(payload.item);
  const family = payload.type === "user_message" ? "event"
    : payload.type === "message" && payload.role === "user" ? "response"
    : payload.type === "item_completed" && (item?.type === "UserMessage" || item?.type === "userMessage") ? "item" : null;
  if (!family) return null;
  const user = family === "item" ? item! : payload;
  const text = stringValue(user.message) ?? stringValue(user.text) ?? stringValue(user.content)
    ?? (Array.isArray(user.content) ? user.content.map(part => typeof part === "string" ? part
      : stringValue(recordValue(part)?.text) ?? stringValue(recordValue(part)?.content) ?? "").join("") : "");
  return { family, text, itemId: stringValue(user.id), ...nativeIdentity(payload, user) };
}

export interface CodexPromptDispatch {
  dispatchId: string;
  origin: MessageOrigin;
  nativeTurnId?: string;
  transcriptPath: string;
  fileIdentity: string | null;
  offset: number;
  wireText: string;
  clientId: string;
  prefixDigest: string;
}

/** Capture before the actual RPC, using the admitted origin, never wire hints.
 * A missing/partial transcript cannot grant authority to an older prompt. */
export function beginCodexPromptDispatch(transcript: string | null, wireText: string, clientId: string,
  origin?: MessageOrigin | null): CodexPromptDispatch | null {
  if (!transcript || origin?.kind !== "agent"
    || origin.role !== "pipeline" && origin.role !== RECOVERY_NOTICE_ORIGIN.role) return null;
  const persist = (boundary: Omit<CodexPromptDispatch, "dispatchId" | "origin">) => {
    const dispatch = { ...boundary, dispatchId: randomUUID(), origin };
    appendProof(transcript, { version: 0, dispatch });
    return dispatch;
  };
  let fd: number;
  try { fd = fs.openSync(transcript, "r"); }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? persist({ transcriptPath: transcript, fileIdentity: null, offset: 0, wireText, clientId, prefixDigest: hash("") }) : null;
  }
  let boundary: Omit<CodexPromptDispatch, "dispatchId" | "origin">;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    if (stat.size) {
      const last = Buffer.alloc(1);
      if (fs.readSync(fd, last, 0, 1, stat.size - 1) !== 1 || last[0] !== 10) return null;
    }
    const prefixDigest = prefixHash(fd, stat.size);
    if (!prefixDigest || !stableTranscript(fd, transcript, stat)) return null;
    boundary = { transcriptPath: transcript, fileIdentity: identity(stat), offset: stat.size, wireText, clientId, prefixDigest };
  } catch { return null; }
  finally { fs.closeSync(fd); }
  // Persistence errors propagate before crossing the transport boundary.
  return persist(boundary);
}

/** The RPC reply identifies the native turn, but does not confirm delivery.
 * Keep it with the intent so legacy disk recovery need not invent a turn ID. */
export function recordCodexPromptDispatchTurn(dispatch: CodexPromptDispatch | null, turnId: string): void {
  if (!dispatch || !turnId) return;
  dispatch.nativeTurnId = turnId;
  appendProof(dispatch.transcriptPath, { version: 0, dispatch });
}

/** Reopen only the original server-admitted boundary. A marker or a native
 * copy with no private dispatch intent cannot manufacture this authority. */
export function restoreCodexPromptDispatch(transcript: string | null, wireText: string, clientId: string,
  origin?: MessageOrigin): CodexPromptDispatch | null {
  if (!transcript || origin?.kind !== "agent") return null;
  try {
    const entries = fs.readFileSync(ledgerPath(transcript), "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
    const saved = entries.findLast(entry => entry.version === 0 && entry.dispatch?.clientId === clientId)?.dispatch;
    if (!saved || saved.transcriptPath !== transcript || saved.wireText !== wireText
      || !sameMessageOrigin(saved.origin, origin) || !saved.dispatchId || !saved.prefixDigest
      || !Number.isSafeInteger(saved.offset) || saved.offset < 0) return null;
    return saved;
  } catch { return null; }
}

/** Called only after the host's actual transport confirmation. Freeze native
 * row positions in that dispatch window: a future identical paste gets its
 * own position. A duplicate family makes the confirmation window ambiguous. */
export async function confirmCodexPromptDispatch(dispatch: CodexPromptDispatch | null, turnId: string): Promise<void> {
  if (!dispatch || !dispatch.clientId || !turnId) return;
  // Recovered receipts must not reopen an already frozen/closed window and
  // enroll human copies appended since the original confirmation.
  try {
    const entries = fs.readFileSync(ledgerPath(dispatch.transcriptPath), "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
    if (entries.some(entry => entry.version === 3 && entry.bindingId === dispatch.dispatchId)) return;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Transport authority survives the bounded writer wait and a host restart.
  // With no frozen row it admits only a native client+turn identity join.
  const binding: DeliveryProof = { version: 3, bindingId: dispatch.dispatchId,
    fileIdentity: dispatch.fileIdentity, clientId: dispatch.clientId, turnId,
    dispatchOffset: dispatch.offset, scanOffset: dispatch.offset,
    prefixDigest: dispatch.prefixDigest, contentDigest: hash(dispatch.wireText), rows: [] };
  appendProof(dispatch.transcriptPath, binding);
  const deadline = performance.now() + 1_000;
  while (!captureConfirmedRows(dispatch, binding) && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

// false means the native writer has yet to flush. An incompatible row closes
// the window permanently; waiting must never skip a human prompt to find a copy.
function captureConfirmedRows(dispatch: CodexPromptDispatch, binding: DeliveryProof): boolean {
  const turnId = binding.turnId;
  const close = () => {
    appendProof(dispatch.transcriptPath, { ...binding, closed: true, rows: [] });
    return true;
  };
  let fd: number;
  try { fd = fs.openSync(dispatch.transcriptPath, "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || binding.fileIdentity !== null && identity(stat) !== binding.fileIdentity
      || prefixHash(fd, dispatch.offset) !== dispatch.prefixDigest) return close();
    if (binding.fileIdentity === null) {
      if (!stableTranscript(fd, dispatch.transcriptPath, stat)) return false;
      binding.fileIdentity = identity(stat);
      appendProof(dispatch.transcriptPath, binding);
    }
    const length = stat.size - dispatch.offset;
    if (length <= 0) return false;
    if (length > MAX_PROOF_READ_BYTES) return close();
    const bytes = Buffer.alloc(length);
    if (fs.readSync(fd, bytes, 0, length, dispatch.offset) !== length || bytes.at(-1) !== 10) return false;
    const rows: ProvenRow[] = [];
    const families = new Set<string>();
    let offset = dispatch.offset;
    let closed = false;
    for (const line of new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\n")) {
      const size = Buffer.byteLength(line) + 1;
      if (!line) { offset += size; continue; }
      const record = JSON.parse(line) as RecordLike;
      const prompt = codexNativeUserPrompt(record);
      if (prompt) {
        if (prompt.identityConflict || prompt.text !== dispatch.wireText || families.has(prompt.family)
          || prompt.clientId && prompt.clientId !== dispatch.clientId
          || prompt.turnId && prompt.turnId !== turnId) { rows.length = 0; closed = true; break; }
        families.add(prompt.family);
        rows.push({ offset, length: size - 1, digest: hash(line), family: prompt.family });
      } else {
        const payload = recordValue(record.payload);
        if (payload?.type === "task_started" || payload?.type === "turn_started") {
          const native = nativeIdentity(payload);
          if (native.identityConflict || native.turnId && native.turnId !== turnId) {
            // Idless representations before a later native start may belong
            // to that human turn. An ambiguous dispatch window grants none.
            rows.length = 0;
            closed = true;
            break;
          }
        }
      }
      offset += size;
    }
    if (closed) return close();
    if (!rows.length) return false;
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) return false;
    if (identity(fs.statSync(dispatch.transcriptPath)) !== identity(stat)) return close();
    appendProof(dispatch.transcriptPath, { ...binding, fileIdentity: identity(stat), scanOffset: stat.size, rows });
    return true;
  } finally { fs.closeSync(fd); }
}

function appendProof(transcript: string, proof: DeliveryProof | { version: 0; dispatch: CodexPromptDispatch }): void {
  const filename = ledgerPath(transcript);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const ledger = fs.openSync(filename, "a", 0o600);
  try {
    fs.writeSync(ledger, `${JSON.stringify(proof)}\n`);
    fs.fsyncSync(ledger);
  } finally { fs.closeSync(ledger); }
}

// Native legacy fanout preserves UserMessageItem.client_id but its event
// schema has no turn field. That client key joins the already confirmed native
// turn binding. Response and ItemCompleted candidates still need both IDs.
// Source: protocol/src/legacy_events.rs in native Codex (01fc69f4).
function matchesConfirmedIdentity(prompt: NonNullable<ReturnType<typeof codexNativeUserPrompt>>, proof: DeliveryProof): boolean {
  return !prompt.identityConflict && prompt.clientId === proof.clientId
    && (prompt.turnId === proof.turnId || prompt.family === "event" && prompt.turnId === undefined);
}

/** A delayed representation needs native transport identity. Validate
 * every previously frozen physical row before using that delivery binding;
 * text only checks payload agreement. Idless rows never extend the window.
 * One position per family keeps subsequent exact copies external, including
 * copies in the same turn. Snapshots are appended durably after a stable join. */
function extendConfirmedProof(fd: number, stat: fs.Stats, proof: DeliveryProof, mayExtend: boolean): DeliveryProof | null {
  if (proof.version !== 2 && proof.version !== 3) return proof;
  if (proof.closed) return null;
  if (proof.version === 3 && (typeof proof.bindingId !== "string" || !proof.bindingId
    || typeof proof.contentDigest !== "string" || typeof proof.prefixDigest !== "string"
    || typeof proof.dispatchOffset !== "number" || proof.dispatchOffset > stat.size
    || prefixHash(fd, proof.dispatchOffset) !== proof.prefixDigest)) return null;
  const scanOffset = proof.scanOffset;
  if (!proof.clientId || !proof.turnId || proof.version === 2 && !proof.rows.length || typeof scanOffset !== "number"
    || !Number.isSafeInteger(scanOffset) || scanOffset < (proof.dispatchOffset ?? 0) || scanOffset > stat.size) return null;
  const families = new Set<string>();
  let text: string | undefined;
  for (const row of proof.rows) {
    if (!Number.isSafeInteger(row.offset) || row.offset < (proof.dispatchOffset ?? 0) || !Number.isSafeInteger(row.length)
      || row.length < 1 || row.length > MAX_PROOF_READ_BYTES || row.offset + row.length >= scanOffset) return null;
    const bytes = Buffer.alloc(row.length + 1);
    if (fs.readSync(fd, bytes, 0, bytes.length, row.offset) !== bytes.length || bytes.at(-1) !== 10
      || hash(bytes.subarray(0, -1)) !== row.digest) return null;
    const prompt = codexNativeUserPrompt(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (!prompt || prompt.identityConflict || prompt.family !== row.family || families.has(prompt.family)
      || prompt.clientId && prompt.clientId !== proof.clientId || prompt.turnId && prompt.turnId !== proof.turnId
      || text !== undefined && prompt.text !== text
      || proof.version === 3 && hash(prompt.text) !== proof.contentDigest) return null;
    text = prompt.text;
    families.add(prompt.family);
  }
  const length = stat.size - scanOffset;
  if (!mayExtend || proof.extensionClosed || length === 0 || length > MAX_PROOF_READ_BYTES || families.size === 3) {
    return proof.fileIdentity === null ? { ...proof, fileIdentity: identity(stat) } : proof;
  }
  const bytes = Buffer.alloc(length);
  if (fs.readSync(fd, bytes, 0, length, scanOffset) !== length || bytes.at(-1) !== 10) return proof;
  const blocked = new Set(proof.blockedFamilies ?? []);
  const additions = new Map<string, ProvenRow>();
  let extensionClosed = false;
  let offset = scanOffset;
  for (const line of new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\n")) {
    const size = Buffer.byteLength(line) + 1;
    if (line.trim()) {
      const record = JSON.parse(line) as RecordLike;
      const prompt = codexNativeUserPrompt(record);
      if (prompt) {
        if (prompt.identityConflict) blocked.add(prompt.family);
        else if (matchesConfirmedIdentity(prompt, proof) && !families.has(prompt.family)) {
          if (proof.version === 3 ? hash(prompt.text) !== proof.contentDigest : prompt.text !== text) blocked.add(prompt.family);
          // Validate the complete append window before choosing any position.
          // A second candidate in the same family makes both copies external.
          if (additions.has(prompt.family)) blocked.add(prompt.family);
          else additions.set(prompt.family, { offset, length: size - 1, digest: hash(line), family: prompt.family });
        } else if (prompt.family === "event" && !families.has(prompt.family)) {
          // The turn-less legacy join cannot cross an earlier human/idless
          // event and enroll a later canonical copy at its new position.
          blocked.add(prompt.family);
        }
      } else {
        const payload = recordValue(record.payload);
        if (payload?.type === "task_started" || payload?.type === "turn_started") {
          const native = nativeIdentity(payload);
          if (native.identityConflict || native.turnId && native.turnId !== proof.turnId) extensionClosed = true;
        }
      }
    }
    offset += size;
  }
  const rows = [...proof.rows, ...[...additions].flatMap(([family, row]) =>
    extensionClosed || blocked.has(family) ? [] : [row])];
  // Even a rejected family is durable, so a later identical copy cannot seed
  // authority after another family's successful extension moved the cursor.
  return { ...proof, fileIdentity: identity(stat), scanOffset: stat.size, rows,
    blockedFamilies: [...blocked], extensionClosed };
}

function stableTranscript(fd: number, transcript: string, stat: fs.Stats): boolean {
  const after = fs.fstatSync(fd);
  const current = fs.statSync(transcript);
  return after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs
    && identity(current) === identity(stat) && current.size === stat.size
    && current.mtimeMs === stat.mtimeMs && current.ctimeMs === stat.ctimeMs;
}

/** Join a scanner's verified suffix to physical native rows. A hash protects
 * the stored row at its offset; it never authenticates arbitrary prompt text.
 * A raced append or replacement refuses the join until the next stable read. */
export function codexAutomaticPromptRows(transcript: string, records: RecordLike[]): Set<number> {
  const automatic = new Set<number>();
  if (!records.length) return automatic;
  try {
    const snapshots: DeliveryProof[] = fs.readFileSync(ledgerPath(transcript), "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
    const proofs = new Map<string, DeliveryProof>();
    for (const proof of snapshots) {
      if ((proof.version !== 1 && proof.version !== 2 && proof.version !== 3) || !proof.turnId || !Array.isArray(proof.rows)) continue;
      // Each extension carries the original anchor and supersedes its earlier
      // snapshot. No process-local cache is needed after host/Viewer restart.
      const key = proof.version === 3 ? `binding:${proof.bindingId}`
        : JSON.stringify([proof.version, proof.fileIdentity, proof.turnId, proof.clientId, proof.rows[0]?.offset]);
      proofs.set(key, proof);
    }
    const fd = fs.openSync(transcript, "r");
    try {
      const stat = fs.fstatSync(fd);
      let length = Math.min(stat.size, Math.max(131_072, Buffer.byteLength(JSON.stringify(records)) + records.length));
      while (length <= MAX_PROOF_READ_BYTES) {
        const start = stat.size - length;
        const bytes = Buffer.alloc(length);
        if (fs.readSync(fd, bytes, 0, length, start) !== length) return automatic;
        let offset = start;
        // Discard a partial leading row as bytes. Decoding a cut UTF-8 code
        // point first would shift every proven physical offset in the suffix.
        const boundary = start > 0 ? bytes.indexOf(10) + 1 : 0;
        if (start > 0 && boundary === 0) return automatic;
        offset += boundary;
        const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(boundary)).split("\n");
        const rows: Array<{ offset: number; digest: string; record: RecordLike }> = [];
        for (const line of lines) {
          if (line.trim()) rows.push({ offset, digest: hash(line), record: JSON.parse(line) });
          offset += Buffer.byteLength(line) + 1;
        }
        if (rows.length >= records.length) {
          const suffix = rows.slice(-records.length);
          if (!isDeepStrictEqual(suffix.map(row => row.record), records)) return automatic;
          const candidates = suffix.flatMap(row => {
            const prompt = codexNativeUserPrompt(row.record);
            return prompt && !prompt.identityConflict && prompt.clientId
              && (prompt.turnId || prompt.family === "event") ? [prompt] : [];
          });
          const proven = new Map<number, string>();
          const extensions: DeliveryProof[] = [];
          for (const proof of proofs.values()) {
            if (proof.fileIdentity !== identity(stat) && !(proof.version === 3 && proof.fileIdentity === null && !proof.rows.length)) continue;
            // Only scan a delivery's append window if this suffix contains a
            // candidate from an unproven family. Historical sends otherwise
            // need only their frozen rows verified, not overlapping tail reads.
            const mayExtend = candidates.some(prompt => matchesConfirmedIdentity(prompt, proof)
              && !proof.rows.some(row => row.family === prompt.family));
            const extended = extendConfirmedProof(fd, stat, proof, mayExtend);
            if (!extended) continue;
            if (extended !== proof) extensions.push(extended);
            for (const row of extended.rows) proven.set(row.offset, row.digest);
          }
          if (!stableTranscript(fd, transcript, stat)) return automatic;
          for (const proof of extensions) appendProof(transcript, proof);
          if (extensions.length && !stableTranscript(fd, transcript, stat)) return automatic;
          suffix.forEach((row, index) => {
            const prompt = codexNativeUserPrompt(row.record);
            if (prompt && !prompt.identityConflict && proven.get(row.offset) === row.digest) automatic.add(index);
          });
          return automatic;
        }
        if (length === stat.size || length === MAX_PROOF_READ_BYTES) return automatic;
        length = Math.min(stat.size, MAX_PROOF_READ_BYTES, length * 2);
      }
    } finally { fs.closeSync(fd); }
  } catch { /* Missing, damaged or unconfirmed provenance grants no authority. */ }
  return automatic;
}
