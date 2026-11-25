export type SecretDestination =
  | { kind: "file"; path: string; replace?: boolean; trailingNewline?: boolean }
  | { kind: "env"; path: string; key: string };

export type ResolvedSecretDestination = {
  path: string;
  git: "outside-repository" | "ignored";
  previous?: { size: number; modifiedAt: number };
} & (
  | { kind: "file"; effect: "file-create" | "file-replace" }
  | { kind: "env"; key: string; effect: "env-add" | "env-replace" }
);

export type SecretFormat = "line" | "token";
export type SecretState = "pending" | "writing" | "entered" | "cancelled" | "expired";
export type SecretActor = "operator" | "owner" | "requester" | "expiry" | "recovery";

export type SecretRefusal =
  | "secret_caller_not_allowed"
  | "secret_destination_outside_roots" | "secret_destination_name" | "secret_destination_private"
  | "secret_destination_link" | "secret_destination_exists" | "secret_destination_not_replaceable"
  | "secret_destination_tracked" | "secret_destination_not_ignored" | "secret_destination_unavailable"
  | "secret_parent_missing" | "secret_destination_changed"
  | "secret_env_file_name" | "secret_env_key_invalid" | "secret_env_key_duplicated" | "secret_env_unparsed"
  | "secret_env_value_unquotable" | "secret_platform_unsupported"
  | "secret_too_many_open" | "secret_not_pending" | "secret_expired"
  | "secret_value_format" | "secret_value_too_long" | "secret_entry_interrupted"
  | "secret_request_input" | "secret_request_unavailable" | "staging" | "idempotency_conflict";

export class SecretRequestError extends Error {
  constructor(readonly code: SecretRefusal) {
    super(code === "secret_caller_not_allowed" ? "Ask this project's orchestrator to make the secret request." : code);
    this.name = "SecretRequestError";
  }
}

export function secretError(error: unknown, fallback: SecretRefusal): SecretRequestError {
  return error instanceof SecretRequestError ? error : new SecretRequestError(fallback);
}

export interface SecretRequester {
  conversationId: string;
  role: string;
  title: string | null;
  engine: string;
  model: string | null;
  seat: { conversationId: string; title: string | null };
  stage?: { pipelineId: string; stageId: string; taskId: string | null };
}

export type FileIdentity = { device: string; inode: string };

export interface SecretRequest {
  id: string;
  argumentDigest: string;
  project: string;
  taskId: string | null;
  requester: SecretRequester;
  purpose: string;
  createdAt: number;
  expiresAt: number;
  format: SecretFormat;
  minLength?: number;
  target: SecretDestination;
  destination: ResolvedSecretDestination;
  destinationRevision: string;
  transitions: { at: number; state: SecretState; actor: SecretActor }[];
  refusals: { at: number; code: SecretRefusal }[];
  telegramNotice?: "sent" | "failed";
  outcomeDelivery?: "sent" | "failed" | "uncertain";
}

export type SecretRequestRecord = SecretRequest & (
  | { state: "pending" | "cancelled" | "expired" }
  | { state: "writing"; write: { id: string; length: number; parent: FileIdentity; temporary?: FileIdentity } }
  | { state: "entered"; enteredAt: number; length: number; file: FileIdentity }
);
