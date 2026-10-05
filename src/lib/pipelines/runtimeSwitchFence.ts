import crypto from "node:crypto";
import { allowedAccountIdsForProject } from "@/lib/accounts/projectBindings";
import { loadPipelines } from "./store";
import type { PipelineRuntimeSwitch } from "./types";

/*
 * A stage's runtime switch is admitted under the pipeline lease and carried
 * out later by the conversation's reconfigure executor, which knows only the
 * conversation. This is what that executor reads: the switch record behind an
 * operation, straight from the pipeline registry, so the project's allowed
 * accounts are asked again right before a successor is created or published,
 * and the speed the record names is the one written into the launch profile.
 * The record is durable, so the same answer holds after a restart.
 */

const SWITCH_OPERATION = /^pswitch-[0-9a-f]{40}-/;

export const switchOperationKey = (record: Pick<PipelineRuntimeSwitch, "id">, action: string) =>
  `pswitch-${crypto.createHash("sha256").update(record.id).digest("hex").slice(0, 40)}-${action}`;

export interface PipelineSwitchFence {
  /** The exact service tier the target seat names for a Codex conversation; undefined leaves the tier to the speed. */
  serviceTier?: string | null;
  /** Throws when the project no longer allows the target account, or its record cannot be read.
      Given an account, asks about that one: the account a host is about to start on. */
  authorize(accountId?: string | null): void;
}

/** Null for an operation no pipeline switch issued. */
export function pipelineSwitchFence(operationId: string): PipelineSwitchFence | null {
  if (!SWITCH_OPERATION.test(operationId)) return null;
  const find = () => {
    for (const pipeline of loadPipelines()) {
      for (const run of pipeline.runs) {
        for (const attempt of run.attempts) {
          const record = attempt.runtimeSwitches?.find((item) => switchOperationKey(item, "reconfigure") === operationId);
          if (record) return { project: pipeline.project, to: record.to };
        }
      }
    }
    return null;
  };
  const found = find();
  const tier = found?.to.serviceTier ?? null;
  return {
    ...(found?.to.engine === "codex" ? { serviceTier: tier === "priority" ? "priority" : null } : {}),
    authorize(accountId) {
      // Read again on every call: the registry and the bindings may both have moved since admission.
      const current = find();
      if (!current) throw new Error("target account is no longer allowed: the stage's runtime switch record is gone");
      const pool = allowedAccountIdsForProject(current.project, current.to.engine);
      if (accountId !== undefined) {
        if (pool && (!accountId || !pool.includes(accountId))) {
          throw new Error("the conversation's account is no longer allowed on this project; no host starts on it");
        }
        return;
      }
      if (pool && (!current.to.accountId || !pool.includes(current.to.accountId))) {
        throw new Error("target account is no longer allowed on this project; the stage stays on its runtime");
      }
    },
  };
}
