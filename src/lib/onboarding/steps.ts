/**
 * The setup guide's step ids (#1876), free of any server module so the dialog
 * can import them. Since #2166 the guide is numbered steps, Engines, Project
 * and Orchestrator, that end on a running orchestrator; the other four stay
 * one click away under "Later, any time" and are never part of Back or
 * Continue. "Reports to Telegram" (docs/design/orchestrator-reports.md §5.6)
 * is numbered in the guide's order, before Orchestrator so the new seat's first
 * report already knows its destination, and is optional: a skipped optional
 * step is settled, so the guide never reopens on it. A marker written before a
 * step existed reads it as null, the "not visited" state; the retired Tour id
 * is ignored on read.
 */
export const ONBOARDING_GUIDE_STEP_IDS = ["engines", "project", "telegram", "orchestrator"] as const;
export const ONBOARDING_OPTIONAL_STEP_IDS = ["telegram"] as const;
export const ONBOARDING_LATER_STEP_IDS = ["agents", "phone", "voice", "check"] as const;
export const ONBOARDING_STEP_IDS = [...ONBOARDING_GUIDE_STEP_IDS, ...ONBOARDING_LATER_STEP_IDS] as const;
export type OnboardingStepId = typeof ONBOARDING_STEP_IDS[number];
export type OnboardingGuideStepId = typeof ONBOARDING_GUIDE_STEP_IDS[number];
export type OnboardingStepState = "done" | "skipped" | null;

/** The interface walk (#2166 §3.8): null until it has run once. */
export type OnboardingWalkState = "done" | "skipped" | null;
