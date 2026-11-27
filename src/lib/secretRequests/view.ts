import type { ResolvedSecretDestination, SecretFormat, SecretRefusal } from "./types";

export const SECRET_REVISION_HEADER = "x-llv-secret-revision";
export const SECRET_BODY_TYPE = "application/octet-stream";
export const SECRET_BODY_LIMIT = 16 * 1024;

export function isSecretRequestId(value: string): boolean {
  return /^sr_[a-f0-9]{32}$/.test(value);
}

export interface SecretRequestNotice {
  id: string;
  project: string;
  createdAt: number;
  expiresAt: number;
  /** What the request writes to, as the operator reads it: the file name, and for a dotenv file the variable. */
  target: string;
}

export interface SecretRequestView extends Omit<SecretRequestNotice, "target"> {
  state: "pending" | "writing";
  requester: {
    title: string | null; role: string; engine: string; model?: string;
    stage?: { id: string; pipelineId: string }; seatTitle?: string;
  };
  task?: { id: string; title: string };
  purpose: string;
  destination: Pick<ResolvedSecretDestination, "kind" | "path" | "effect" | "git" | "previous"> & { key?: string };
  destinationRevision: string;
  format: SecretFormat;
  minLength?: number;
  lastSet?: { id: string; at: number };
  interrupted?: true;
}

export interface SecretActionAnswer {
  secretRequests?: SecretRequestView[];
  code?: SecretRefusal;
}

export function secretFilename(filename: string): string {
  return filename.slice(filename.lastIndexOf("/") + 1);
}

const SECRET_TARGET_ARROW = "\u00a0→\u00a0";

/** «file» or «KEY → file», which a line break never splits. */
export function secretTarget(path: string, key?: string): string {
  const filename = secretFilename(path);
  return key ? `${key}${SECRET_TARGET_ARROW}${filename}` : filename;
}

/** A target `secretTarget` wrote, split back into the variable and the file it goes to. */
export function secretTargetParts(target: string): { key?: string; filename: string } {
  const at = target.lastIndexOf(SECRET_TARGET_ARROW);
  return at < 0 ? { filename: target } : { key: target.slice(0, at), filename: target.slice(at + SECRET_TARGET_ARROW.length) };
}
