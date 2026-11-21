import { test } from "bun:test";
import { auditOwnedStageControlRestart, restartFixtureMs } from "./fixtures/ownedStageControlRestart";

test.each([false, true] as const)(
  "a fresh process reconciles an owned stop after its sender exits, admission still pending %s",
  holdBeforeAdmission => auditOwnedStageControlRestart("stop", holdBeforeAdmission, "none"),
  restartFixtureMs,
);
