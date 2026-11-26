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
}

export interface SecretRequestView extends SecretRequestNotice {
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
