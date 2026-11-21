import { test } from "bun:test";
import { auditOwnedStageControlRestart, restartFixtureMs } from "./fixtures/ownedStageControlRestart";

test.each([
  [false, "none"], [true, "none"], [true, "stale"], [false, "legacy"], [false, "legacy-dead"],
] as const)(
  "a fresh process reconciles an owned withdrawal after its sender exits, admission still pending %s, refusal %s",
  (holdBeforeAdmission, refusal) => auditOwnedStageControlRestart("withdrawal", holdBeforeAdmission, refusal),
  restartFixtureMs,
);
