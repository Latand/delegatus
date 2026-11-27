import { z } from "zod";

import { TASK_DETAILS_LIMIT, TASK_TEXT_LIMIT } from "@/lib/tasks/types";

const root = z.string().min(1).max(4096);
const folder = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("by_name") }),
  z.strictObject({ mode: z.literal("create"), root }),
  z.strictObject({ mode: z.literal("reuse"), root }),
]);

export const startProjectInput = z.strictObject({
  clientRequestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  recoveryOnly: z.boolean().optional(),
  operatorRequest: z.string().trim().min(1).max(TASK_TEXT_LIMIT),
  target: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("existing_project"), project: z.string().min(1).max(128) }),
    z.strictObject({ kind: z.literal("new_project"), name: z.string().trim().min(1).max(80), folder }),
  ]),
  workspaceId: z.string().min(1).max(128).optional(),
  task: z.strictObject({
    text: z.string().trim().min(1).max(TASK_TEXT_LIMIT),
    details: z.string().max(TASK_DETAILS_LIMIT).optional(),
    dueAt: z.string().min(1).max(80),
    dueTz: z.string().min(1).max(128).optional(),
  }),
});

const directoryIdentity = z.strictObject({ dev: z.number(), ino: z.number() });
const nativeIdentity = z.strictObject({
  conversationId: z.string().startsWith("conversation_"),
  generation: z.string().min(1),
  owner: z.string().min(1),
  epoch: z.number().int().positive(),
  process: z.string().min(1),
});

export const projectStartSource = nativeIdentity.extend({
  project: z.string(),
  seatEpoch: z.number().int().positive(),
  workspace: z.strictObject({ memberId: z.string(), workspaceId: z.string() }).nullable(),
});

const effect = z.enum(["not-started", "dispatching", "observed", "reused", "refused", "unknown"]);
export const projectStartCheckpoint = z.strictObject({
  version: z.literal(1),
  operationId: z.string().regex(/^[a-f0-9]{64}$/),
  input: startProjectInput.omit({ recoveryOnly: true }),
  source: projectStartSource,
  root,
  parent: z.strictObject({ path: root, identity: directoryIdentity }),
  directory: directoryIdentity.nullable(),
  folderToken: z.uuid(),
  repositoryPresent: z.boolean(),
  placement: effect,
  prepared: z.strictObject({ directory: directoryIdentity, digest: z.string().regex(/^[a-f0-9]{64}$/) }).nullable(),
  originalProject: z.string(),
  project: z.string().nullable(),
  reservedTaskId: z.uuid(),
  taskId: z.string().nullable(),
  seat: nativeIdentity.extend({ seatEpoch: z.number().int().positive(), reused: z.boolean() }).nullable(),
  launchId: z.string().nullable(),
  messageOperationId: z.string().nullable(),
  relay: z.strictObject({
    text: z.string(),
    origin: z.strictObject({
      kind: z.literal("agent"), role: z.literal("orchestrator"), project: z.string(), conversationId: z.string(),
    }),
  }),
  phase: z.enum(["admission", "folder", "registration", "repository", "identity", "task", "seat", "mandate", "delivery", "work", "settled"]),
  effects: z.strictObject({ folder: effect, repository: effect, registration: effect, task: effect, seat: effect, delivery: effect }),
  arrival: z.enum(["pending", "confirmed", "unknown"]),
  arrivedAt: z.string().nullable(),
  work: z.strictObject({ state: z.enum(["pending", "admitted", "unknown"]), pipelineIds: z.array(z.string()), launchIds: z.array(z.string()) }),
  disposition: z.enum(["accepted", "in-progress", "started", "partial", "unknown"]),
  cause: z.strictObject({ code: z.string(), field: z.string().optional(), status: z.number().optional(), retryable: z.boolean() }).nullable(),
  dueTimeZone: z.string().nullable(),
  mandate: z.string(),
  mandateVersion: z.number().int(),
  runtimeDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  nextAt: z.number().nonnegative().nullable(),
  deadline: z.number().nonnegative(),
});

export type StartProjectInput = z.infer<typeof startProjectInput>;
export type ProjectStartCheckpoint = z.infer<typeof projectStartCheckpoint>;
export type ProjectStartSource = z.infer<typeof projectStartSource>;
export type ProjectStartNative = z.infer<typeof nativeIdentity>;

export const PROJECT_START_ROLE = { mode: "standard" } as const;
export const projectStartKey = (kind: "seat" | "task" | "message", id: string) => `project-start-${kind}-${id}`;
export const projectStartSeatOperation = (key: string | null | undefined) => /^project-start-seat-([a-f0-9]{64})$/.exec(key ?? "")?.[1];
