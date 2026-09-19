import type { RoleConfig } from "./types";

/**
 * Shipped variant configs for the builder role's two special param
 * combinations. They override the base builder config, and the install's
 * agent mapping (#1876) overrides them per variant through `variants` in
 * role-presets.json. Client-safe (no node:* imports) so the draft pane can
 * mirror the registry's `configForParams` without drifting from it.
 */
export const BUILDER_FRONTEND_CONFIG: RoleConfig = { engine: "claude", model: "opus", effort: "high" };
export const BUILDER_APPLY_FIXES_CONFIG: RoleConfig = { engine: "codex", model: "gpt-5.6-terra", effort: "low" };
