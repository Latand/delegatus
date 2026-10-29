import fs from "node:fs";
import crypto from "node:crypto";

/** One publication owns one handoff. No credential is written here. */
export const PUBLICATION_TRANSPORT_MS = 60_000;
export interface PublicationCheckReceipt {
  version: 1;
  binding: string;
  inputs: string;
  completedAt: number;
}

export function publicationCheckBinding(env: NodeJS.ProcessEnv): string {
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
  if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077)) throw new Error("publication check receipt is unavailable");
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as PublicationCheckReceipt;
  if (value.version !== 1 || value.binding !== binding || !/^[a-f0-9]{64}$/.test(value.inputs)
    || !Number.isFinite(value.completedAt) || value.completedAt > now || now - value.completedAt >= PUBLICATION_TRANSPORT_MS) {
    throw new Error("publication check receipt is stale or belongs to another operation");
  }
  return value;
}

export function writePublicationCheckReceipt(file: string, binding: string, inputs: string): void {
  const value: PublicationCheckReceipt = { version: 1, binding, inputs, completedAt: Date.now() };
  fs.writeFileSync(file, JSON.stringify(value), { flag: "wx", mode: 0o600 });
}

export function consumePublicationCheckReceipt(file: string, binding: string): PublicationCheckReceipt {
  const claimed = `${file}.consuming`;
  fs.renameSync(file, claimed);
  try { return readPublicationCheckReceipt(claimed, binding); }
  finally { fs.rmSync(claimed, { force: true }); }
}
