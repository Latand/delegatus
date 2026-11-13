import { expect, test } from "bun:test";
import { HOST_EVENT_WINDOW_IDLE_MS, releaseIdleHostEventWindow } from "./idleHostEventWindow";
import type { RuntimeEvent } from "./engineHost";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const event = (): RuntimeEvent => ({ seq: 1, kind: "delta", turnId: "idle-turn", text: "reply" });

for (const change of ["none", "busy", "owner-cleared", "owner-replaced", "voice-bound", "event", "subscriber", "transcript", "unreadable"] as const) {
  test(`idle release rechecks ${change} after transcript I/O`, async () => {
    const events = [event()];
    const owner = {};
    let current: object | null = owner;
    let busy = false, voice = false, lastEvent = 0, released = false;
    const result = await releaseIdleHostEventWindow({ events, now: () => NOW,
      revision: () => lastEvent, transcriptPath: "fixture.jsonl",
      eligible: () => current === owner && !busy && !voice,
      onRelease: () => { released = true; },
      transcriptMtime: async () => {
        await Promise.resolve();
        if (change === "busy") busy = true;
        if (change === "owner-cleared") current = null;
        if (change === "owner-replaced") current = {};
        if (change === "voice-bound") voice = true;
        if (change === "event") events.push({ ...event(), seq: 2 });
        if (change === "subscriber") lastEvent = NOW;
        if (change === "unreadable") throw new Error("unavailable");
        return change === "transcript" ? NOW : 0;
      },
    });
    expect(result).toBe(change === "none");
    expect(released).toBe(result);
    expect(events.length).toBe(change === "none" ? 0 : change === "event" ? 2 : 1);
  });
}

for (const age of [HOST_EVENT_WINDOW_IDLE_MS - 1, HOST_EVENT_WINDOW_IDLE_MS, HOST_EVENT_WINDOW_IDLE_MS + 1]) {
  test(`idle release requires strictly more than ten quiet minutes (${age})`, async () => {
    const events = [event()];
    expect(await releaseIdleHostEventWindow({ events, now: () => NOW,
      revision: () => NOW - age, transcriptPath: "fixture.jsonl", eligible: () => true,
      transcriptMtime: async () => NOW - age,
    })).toBe(age > HOST_EVENT_WINDOW_IDLE_MS);
  });
}

test("an active or bound host reads no transcript and retains its payloads", async () => {
  const events = [event()];
  expect(await releaseIdleHostEventWindow({ events, now: () => NOW, revision: () => 0,
    transcriptPath: "fixture.jsonl", eligible: () => false,
    transcriptMtime: async () => { throw new Error("must not read"); },
  })).toBeFalse();
  expect(events).toHaveLength(1);
});
