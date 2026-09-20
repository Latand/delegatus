/** Temporary legacy contracts and compatibility exports during flow retirement. */
import type { RuntimeRoleConfig as RoleConfig } from "@/lib/agent/runtimeConfig";
import type { FlowRoleKey } from "@/lib/reviewHistory/types";
export type { RuntimeEngine as FlowEngine, RuntimeRoleConfig as RoleConfig } from "@/lib/agent/runtimeConfig";
export type { ReviewVerdict } from "@/lib/review/types";
export type * from "@/lib/reviewHistory/types";

export type CreateFlowRequest = {
  implementerPath: string;
  /** Stable Viewer identity supplied by durable controllers when the current
      scanner slice does not contain the implementer transcript. */
  implementerConversationId?: string;
  /** Live implement-review flows deliver their kickoff to the implementer.
      Terminal pipeline stages start review directly through advance. */
  deliverKickoff?: boolean;
  preset?: string; // preset name; mutually exclusive with roles
  roles?: Record<FlowRoleKey, RoleConfig>;
  baseMode: "head" | "merge-base";
  /** Explicit review base (a resolved sha). The workflow engine passes the
      workflow branch start here so every round reviews the whole workflow
      diff; when absent the base resolves from baseMode in the session cwd. */
  baseRef?: string;
  /** Branch supplied by durable branch-owning controllers. */
  headRef?: string;
  /** Also fence each review head on `origin/<headRef>` (#1692). */
  requireRemoteHead?: boolean;
  /** Expected clean HEAD for the first reviewer launch, supplied by durable controllers. */
  targetSha?: string;
  /** Optional pinned task specification and acceptance criteria for the flow. */
  spec?: string;
  mode: "auto" | "manual";
  reviewerMode: "headless" | "pane";
  reviewerSandbox?: "full" | "restricted";
  roundLimit: number;
};

export type FlowAction =
  | "agent-decision"
  | "pause"
  | "resume"
  | "set-mode"
  | "advance"
  | "retry-round"
  | "cancel-round"
  | "set-round-limit"
  | "extend"
  | "another-round"
  | "set-roles"
  | "close";

export type PatchFlowRequest = {
  action: FlowAction;
  /** for set-mode */
  mode?: "auto" | "manual";
  /** for extend: how many rounds to add (default 1);
      for set-round-limit: the absolute limit, 0 = unlimited */
  rounds?: number;
  /** for advance/retry-round: a user note the next reviewer sees as the
      round's ready note */
  note?: string;
  /** for set-roles: a partial override of the REVIEWER role config, applied to
      the next round without recreating the flow (issue #118). Only the provided
      fields change, and a round already in flight keeps the role it froze at
      spawn (see Round.reviewerRole). The implementer is intentionally not
      overridable: it is an already-attached live session whose engine/account
      cannot be reseated in place, so accepting an implementer override would be a
      no-op reported as success. Reseating the implementer is a separate feature. */
  roles?: { reviewer?: Partial<RoleConfig> };
};
