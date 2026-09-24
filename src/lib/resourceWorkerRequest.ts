import type { ResourceWorkerFileObservation, StructuredHostRecord } from "./resources";
import { RESOURCE_STRUCTURED_HOST_LIMIT } from "./types";

/**
 * The one request the Viewer hands the contained resource collector. Both ends
 * read it through this module: the worker refuses anything else, and the Viewer
 * checks its own request before it spawns, so a producer that drifts from the
 * contract (a new engine, a projection that grew a key) is named in the
 * Viewer's log the first time a collection fails on it (#2110).
 */
export type ResourceWorkerRequest = {
  type: "collect";
  fresh: boolean;
  files: ResourceWorkerFileObservation[];
  /** Process-identity epoch of the Viewer that observed the host PIDs. */
  identityEpoch: string | null;
  /** Structured-host records the viewer read out of the registry for us. The
      worker runs contained and opens no registry of its own. */
  hosts: StructuredHostRecord[];
};

export const RESOURCE_WORKER_MAX_FILES = 10_000;

const FILE_KEYS = ["path", "parent", "title", "project", "activity", "mtime", "engine", "pid", "proc", "conversationId"];
const HOST_KEYS = [
  "id", "engine", "sessionId", "pid", "startIdentity", "bootEpoch", "cwd", "path", "conversationId",
  "title", "role", "model", "stage", "seat", "turnBusy", "owned",
];
const FILE_ENGINES = new Set(["claude", "codex", "copilot", "shell", "openclaw"]);
const HOST_ENGINES = new Set(["claude", "codex", "copilot"]);
const ACTIVITIES = new Set(["live", "recent", "stalled", "idle"]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function nullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean";
}

function keyProblem(value: Record<string, unknown>, keys: readonly string[]): string | null {
  const unexpected = Object.keys(value).find((key) => !keys.includes(key));
  if (unexpected !== undefined) return `unexpected key ${unexpected}`;
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  return missing === undefined ? null : `missing key ${missing}`;
}

function fileProblem(value: unknown): string | null {
  if (!record(value)) return "not an object";
  const keys = keyProblem(value, FILE_KEYS);
  if (keys) return keys;
  if (typeof value.path !== "string" || value.path.length === 0) return "path";
  if (!nullableString(value.parent)) return "parent";
  if (typeof value.title !== "string") return "title";
  if (typeof value.project !== "string") return "project";
  if (!ACTIVITIES.has(value.activity as string)) return `activity ${String(value.activity)}`;
  if (typeof value.mtime !== "number" || !Number.isFinite(value.mtime) || value.mtime < 0) return "mtime";
  if (!FILE_ENGINES.has(value.engine as string)) return `engine ${String(value.engine)}`;
  if (value.pid !== null && !(Number.isSafeInteger(value.pid) && (value.pid as number) > 0)) return "pid";
  if (value.proc !== null && value.proc !== "running" && value.proc !== "done" && value.proc !== "killed") return `proc ${String(value.proc)}`;
  if (!nullableString(value.conversationId)) return "conversationId";
  return null;
}

function hostProblem(value: unknown): string | null {
  if (!record(value)) return "not an object";
  const keys = keyProblem(value, HOST_KEYS);
  if (keys) return keys;
  if (typeof value.id !== "string" || value.id.length === 0) return "id";
  if (!HOST_ENGINES.has(value.engine as string)) return `engine ${String(value.engine)}`;
  if (!nullableString(value.sessionId)) return "sessionId";
  if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 1) return "pid";
  for (const key of ["startIdentity", "bootEpoch", "path", "conversationId", "title", "role", "model", "stage"]) {
    if (!nullableString(value[key])) return key;
  }
  if (typeof value.cwd !== "string") return "cwd";
  if (!nullableBoolean(value.seat)) return "seat";
  if (!nullableBoolean(value.turnBusy)) return "turnBusy";
  if (typeof value.owned !== "boolean") return "owned";
  return null;
}

/** What is wrong with a collector request, naming the first field refused;
    null for a request the worker accepts. */
export function resourceWorkerRequestProblem(value: unknown): string | null {
  if (!record(value)) return "request is not an object";
  const keys = keyProblem(value, ["type", "fresh", "files", "identityEpoch", "hosts"]);
  if (keys) return `request has ${keys}`;
  if (value.type !== "collect") return "request type is not collect";
  if (typeof value.fresh !== "boolean") return "request fresh is not a boolean";
  if (!nullableString(value.identityEpoch)) return "request identityEpoch is not a string";
  if (!Array.isArray(value.files)) return "request files is not a list";
  if (value.files.length > RESOURCE_WORKER_MAX_FILES) return `request carries ${value.files.length} files, over ${RESOURCE_WORKER_MAX_FILES}`;
  for (let index = 0; index < value.files.length; index += 1) {
    const problem = fileProblem(value.files[index]);
    if (problem) return `files[${index}] ${problem}`;
  }
  if (!Array.isArray(value.hosts)) return "request hosts is not a list";
  if (value.hosts.length > RESOURCE_STRUCTURED_HOST_LIMIT) return `request carries ${value.hosts.length} hosts, over ${RESOURCE_STRUCTURED_HOST_LIMIT}`;
  for (let index = 0; index < value.hosts.length; index += 1) {
    const problem = hostProblem(value.hosts[index]);
    if (problem) return `hosts[${index}] ${problem}`;
  }
  return null;
}
