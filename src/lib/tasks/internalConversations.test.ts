import { expect, test } from "bun:test";

import { DIGEST_INSTRUCTIONS } from "@/lib/orchestrator/handoffDigest";

import { HANDOFF_DIGEST_TITLE_PREFIX, internalConversationKind, isProbePrompt } from "./internalConversations";

/**
 * The transcripts that mint no board task of their own: a seat rotation's
 * summarizer and a one-line "reply with ok" probe. Each is recognised from the
 * transcript alone, so a deleted helper directory changes nothing.
 */

test("a rotation's handoff digest is recognised by the directory it runs in, live or deleted", () => {
  expect(internalConversationKind({ cwd: "/home/operator/.config/agent-log-viewer/state/orchestrator/handoff-digests/seat7-rotate-to-8/cwd", title: "Digest", spawnOrigin: undefined })).toBe("handoff-digest");
  expect(internalConversationKind({ cwd: "/data/delegatus/state/orchestrator/handoff-digests/request-1/cwd", title: "", spawnOrigin: undefined })).toBe("handoff-digest");
  /* A project that merely has an orchestrator folder is no digest. */
  expect(internalConversationKind({ cwd: "/work/app/src/orchestrator", title: "Fix the orchestrator panel", spawnOrigin: undefined })).toBeNull();
});

test("a handoff digest whose directory is not recorded is recognised by the summarizer's own instructions", () => {
  expect(DIGEST_INSTRUCTIONS.startsWith(HANDOFF_DIGEST_TITLE_PREFIX)).toBeTrue();
  expect(internalConversationKind({ cwd: null, title: DIGEST_INSTRUCTIONS.split("\n", 1)[0]!, spawnOrigin: undefined })).toBe("handoff-digest");
});

test("a one-line reply-with-ok probe is recognised; real work that mentions replying is not", () => {
  for (const prompt of ["Reply with exactly: ok", "Reply with the single word ok.", "Reply with exactly: OK", "respond with just PONG", "Say ok"]) {
    expect(isProbePrompt(prompt)).toBeTrue();
    expect(internalConversationKind({ cwd: "/var/tmp/probe", title: prompt, spawnOrigin: undefined })).toBe("probe");
  }
  for (const prompt of ["Reply with exactly: ok\nthen run the tests", "Reply to the reviewer with the fix", "Say hello to the new onboarding flow in the README", "ok"]) {
    expect(isProbePrompt(prompt)).toBeFalse();
  }
  /* A Viewer launch keeps the membership its reservation recorded. */
  expect(internalConversationKind({ cwd: "/var/tmp/probe", title: "Reply with exactly: ok", spawnOrigin: "viewer" })).toBeNull();
});
