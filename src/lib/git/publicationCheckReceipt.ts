import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

/** One publication owns one handoff. No credential is written here. */
export const PUBLICATION_TRANSPORT_MS = 60_000;
const MAX_RECEIPT_BYTES = 4096;

/** Read a declaration without executing an older gate's unknown arguments. */
export function publicationPreparationVersion(root: string): 1 | 2 | 3 | undefined {
  try {
    const file = path.join(root, "scripts/local-gate-capabilities.json");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 1024) return;
    const version = JSON.parse(fs.readFileSync(file, "utf8"))?.publicationPrepare;
    if (version === 1 || version === 2 || version === 3) return version;
  } catch { /* Use the ordinary gated push for an unknown capability. */ }
}
export interface PublicationCheckReceipt {
  version: 1;
  binding: string;
  inputs: string;
  completedAt: number;
  /** Hashes only, retained to name drift without exposing inputs. */
  components?: Record<string, string>;
  /** Wall time spent executing the planned checks, excluding gate setup. */
  checksMs?: number;
  /** Sampled peak of the local preparation process tree, in bytes. */
  peakRssBytes?: number;
}

function validPeakRss(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value > 0);
}

function validateComponents(value: unknown): void {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value)
    || Object.entries(value).some(([name, digest]) => !/^[a-z][a-z ]{0,63}$/.test(name) || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)))) {
    throw new Error("publication check receipt components are invalid");
  }
}

export function publicationCheckBinding(env: Partial<NodeJS.ProcessEnv>): string {
  const names = ["LLV_GATE_PUBLICATION_ID", "LLV_GATE_PUBLICATION_EPOCH", "LLV_GATE_PUBLICATION_FENCE",
    "LLV_GATE_PUSH_HEAD", "LLV_GATE_PUBLICATION_REF", "LLV_GATE_PUBLICATION_REMOTE_HEAD"];
  if (names.some(name => !env[name])) throw new Error("publication check custody is incomplete");
  if (!/^[1-9][0-9]*$/.test(env.LLV_GATE_PUBLICATION_EPOCH!) || !Number.isSafeInteger(Number(env.LLV_GATE_PUBLICATION_EPOCH))
    || !/^[a-f0-9]{40}$/.test(env.LLV_GATE_PUSH_HEAD!) || !/^[a-f0-9]{40}$/.test(env.LLV_GATE_PUBLICATION_REMOTE_HEAD!)) {
    throw new Error("publication check custody is invalid");
  }
  return crypto.createHash("sha256").update(JSON.stringify(names.map(name => env[name]))).digest("hex");
}

export function readPublicationCheckReceipt(file: string, binding: string, now = Date.now()): PublicationCheckReceipt {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_RECEIPT_BYTES || (stat.mode & 0o077)) throw new Error("publication check receipt is unavailable");
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as PublicationCheckReceipt;
  if (value.version !== 1 || value.binding !== binding || !/^[a-f0-9]{64}$/.test(value.inputs)
    || !Number.isFinite(value.completedAt) || value.completedAt > now || now - value.completedAt >= PUBLICATION_TRANSPORT_MS
    || (value.checksMs !== undefined && (!Number.isSafeInteger(value.checksMs) || value.checksMs < 0))) {
    throw new Error("publication check receipt is stale or belongs to another operation");
  }
  validateComponents(value.components);
  if (!validPeakRss(value.peakRssBytes)) throw new Error("publication check receipt peak RSS is invalid");
  return value;
}

export function writePublicationCheckReceipt(file: string, binding: string, inputs: string, components?: Record<string, string>, checksMs?: number, peakRssBytes?: number): void {
  validateComponents(components);
  if (checksMs !== undefined && (!Number.isSafeInteger(checksMs) || checksMs < 0)) throw new Error("publication check receipt timing is invalid");
  if (!validPeakRss(peakRssBytes)) throw new Error("publication check receipt peak RSS is invalid");
  const value: PublicationCheckReceipt = { version: 1, binding, inputs, completedAt: Date.now(), components, checksMs, peakRssBytes };
  const contents = JSON.stringify(value);
  if (Buffer.byteLength(contents) > MAX_RECEIPT_BYTES) throw new Error("publication check receipt exceeds size limit");
  fs.writeFileSync(file, contents, { flag: "wx", mode: 0o600 });
}

export function consumePublicationCheckReceipt(file: string, binding: string): PublicationCheckReceipt {
  const claimed = `${file}.consuming`;
  fs.renameSync(file, claimed);
  try { return readPublicationCheckReceipt(claimed, binding); }
  finally { fs.rmSync(claimed, { force: true }); }
}
