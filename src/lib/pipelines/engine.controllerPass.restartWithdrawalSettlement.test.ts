import { test } from "bun:test";
import { auditOwnedStageControlRestart, restartFixtureMs } from "./fixtures/ownedStageControlRestart";

test.each(["unclassified", "dead", "unhosted"] as const)(
  "a fresh process reconciles an owned withdrawal after its sender exits, refusal %s",
  refusal => auditOwnedStageControlRestart("withdrawal", false, refusal),
  restartFixtureMs,
);
