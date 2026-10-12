import { expect, test } from "bun:test";
import { DEFAULT_SEAT_TICK_POLICY, seatTickDecision, seatTickWakeCommit, seatTickWakeCommitPlan } from "@/lib/monitor/seatTick";
import { defaultSeatTickSettings, effectiveSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { emptySeatTickState, type SeatTickCheckInput } from "@/lib/monitor/types";
test.each(["release-settled", "release-blocked"] as const)("%s is delivered once per run or blocker episode", kind => {
  const now = Date.parse("2026-10-12T00:00:00Z");
  const input: SeatTickCheckInput = { project: "release", now,
    seat: { conversationId: "seat", seatEpoch: 1, path: null, designatedAt: null, turn: "idle", activity: null },
    pipelines: [], tasks: [], events: [], pullRequests: [], pullRequestsUnavailable: null, ownLanes: [], signals: [], children: [], childrenUnavailable: null,
    state: emptySeatTickState(), changeFingerprint: "unchanged", policy: DEFAULT_SEAT_TICK_POLICY,
    settings: effectiveSeatTickSettings(defaultSeatTickSettings("release"), now, 60_000),
    releaseAlerts: [{ kind, id: `${kind}:episode-one`, label: "Release needs attention" }] };
  const first = seatTickDecision(input);
  expect(first.verdict.kind).toBe("wake");
  if (first.verdict.kind !== "wake") return;
  expect(first.verdict.reasons.map(r => r.kind)).toContain(kind);
  const commit = seatTickWakeCommitPlan(first.verdict, { fingerprint: input.changeFingerprint, eventsThrough: 0 });
  const state = seatTickWakeCommit(first.state, commit!, now);
  const second = seatTickDecision({ ...input, now: now + 24 * 3_600_000, state });
  expect(second.verdict.kind).not.toBe("wake");
});
