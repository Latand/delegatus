import { isFlow } from "@/lib/reviewHistory/decode";
import type { Flow, FlowPreset } from "./types";

export function isRoleConfig(value: unknown): value is FlowPreset["implementer"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const role = value as Partial<FlowPreset["implementer"]>;
  return (
    (role.engine === "claude" || role.engine === "codex") &&
    (role.model === null || typeof role.model === "string") &&
    (role.effort === null || typeof role.effort === "string")
  );
}

/** The shared history validator is deliberately permissive. A live store also
    validates the fields its decoder dereferences before admitting the row. */
export function isStoredFlow(value: unknown): value is Flow {
  try {
    return isFlow(value) && typeof value.project === "string"
      && Boolean(value.roles && isRoleConfig(value.roles.implementer) && isRoleConfig(value.roles.reviewer))
      && value.rounds.every((round) => round !== null && typeof round === "object" && !Array.isArray(round));
  } catch { return false; }
}
