/**
 * The setup guide's step ids (#1876), free of any server module so the dialog
 * can import them. Since #2166 the guide is numbered steps, Engines, Project
 * and Orchestrator, that end on a running orchestrator; the other four stay
 * one click away under "Later, any time" and are never part of Back or
 * Continue. "Reports to Telegram" (docs/design/orchestrator-reports.md §5.6)
 * is numbered in the guide's order only when a bot is already connected, before
 * Orchestrator so the new seat's first report already knows its destination,
 * and is optional: a skipped optional step is settled, so the guide never
 * reopens on it. Without a bot it lives under "Later" ({@link onboardingStepLists}). A marker written before a
 * step existed reads it as null, the "not visited" state; the retired Tour id
 * is ignored on read. "Answer for a relay service" (docs/design/relay.md §B.9)
 * is the last "Later" step: pairing with an outside service is never on the
 * way to a first orchestrator.
 */
export const ONBOARDING_GUIDE_STEP_IDS = ["engines", "project", "telegram", "orchestrator"] as const;
export const ONBOARDING_OPTIONAL_STEP_IDS = ["telegram"] as const;
export const ONBOARDING_LATER_STEP_IDS = ["agents", "memory", "phone", "voice", "check", "relay"] as const;
export const ONBOARDING_STEP_IDS = [...ONBOARDING_GUIDE_STEP_IDS, ...ONBOARDING_LATER_STEP_IDS] as const;
export type OnboardingStepId = typeof ONBOARDING_STEP_IDS[number];
export type OnboardingGuideStepId = typeof ONBOARDING_GUIDE_STEP_IDS[number];
export type OnboardingStepState = "done" | "skipped" | null;

/**
 * The two lists the dialog shows, by whether a Telegram bot is already
 * connected. The numbered Telegram step (before the orchestrator, so its first
 * report already knows where to go) exists only with a bot; without one the
 * same content sits under "Later" after Memory, beside Phone and Voice, with
 * a single way back. "Memory" is always under "Later": one memory in
 * Delegatus is optional and waits for an orchestrator to run its import.
 */
export function onboardingStepLists(botConnected: boolean): { guide: readonly OnboardingGuideStepId[]; later: readonly OnboardingStepId[] } {
  if (botConnected) return { guide: ONBOARDING_GUIDE_STEP_IDS, later: ONBOARDING_LATER_STEP_IDS };
  return {
    guide: ONBOARDING_GUIDE_STEP_IDS.filter((id) => id !== "telegram"),
    later: ["agents", "memory", "telegram", "phone", "voice", "check", "relay"],
  };
}

/** The interface walk (#2166 §3.8): null until it has run once. */
export type OnboardingWalkState = "done" | "skipped" | null;
