/**
 * The setup guide's step ids (#1876), in order, free of any server module so
 * the dialog can import them. Slice 3 inserted phone, voice and tour. A
 * marker written before them reads the new ids as null, the "not visited"
 * state, so a returning user lands on the first of them.
 */
export const ONBOARDING_STEP_IDS = ["engines", "agents", "phone", "voice", "tour", "check"] as const;
export type OnboardingStepId = typeof ONBOARDING_STEP_IDS[number];
export type OnboardingStepState = "done" | "skipped" | null;
