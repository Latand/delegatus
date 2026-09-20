import type { RoleEngine } from "@/lib/roles/types";

export type RuntimeEngine = RoleEngine;

/** Runtime overrides; null selects the engine default. */
export type RuntimeRoleConfig = {
  engine: RuntimeEngine;
  model: string | null;
  effort: string | null;
};
