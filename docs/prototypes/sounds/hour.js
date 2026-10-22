/* The busiest observed tool hour, 2026-10-15 14:00 UTC, rebuilt from its
 * twelve five-minute bins (docs/design/sound-redesign.md §13).
 *
 * Every count is the real one. What the record does not keep is where inside
 * its five minutes each event fell, and which conversation made each tool
 * call: events land uniformly at random inside their bin from a fixed seed,
 * and tool calls are shared evenly by the live sessions. */
(() => {
  const DS = window.DelegatusSounds;

  const BIN_SECONDS = 300;
  const HOUR_LABEL = "2026-10-15 14:00 UTC";

  /** Per five-minute bin, 14:00–14:05 first. */
  const BINS = {
    // docs/design/sound-events-audit.md, «Busiest observed tool hour».
    ordinaryTools: [319, 418, 327, 265, 314, 312, 265, 242, 245, 277, 181, 223],
    viewerMcp: [9, 24, 20, 33, 11, 20, 7, 27, 25, 21, 14, 15],
    stageStarts: [2, 6, 5, 3, 3, 6, 1, 3, 4, 4, 4, 11],
    stagePasses: [1, 2, 2, 4, 3, 2, 2, 5, 2, 3, 0, 3],
    stageFails: [0, 1, 0, 0, 1, 3, 1, 0, 0, 0, 2, 8],
    needsDecision: [0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0],
    formsRaised: [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0],
    mergeConfirms: [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0],
    deploySucceeded: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    // docs/design/sound-redesign.md §13, the recount of §10.
    completionsWithoutMerge: [1, 0, 0, 0, 2, 0, 1, 1, 0, 1, 0, 0],
    attentionRequests: [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0],
    inferredAsks: [0, 2, 0, 1, 0, 3, 1, 3, 0, 0, 0, 0],
  };

  const sum = (bins) => bins.reduce((a, b) => a + b, 0);

  /** Each count of `bins`, scattered uniformly inside its five minutes. */
  function scatter(bins, random) {
    const times = [];
    bins.forEach((count, bin) => {
      for (let i = 0; i < count; i++) times.push(bin * BIN_SECONDS + random() * BIN_SECONDS);
    });
    return times.sort((a, b) => a - b);
  }

  // ── Events → requests for the planner ──────────────────────────────────

  function eventRequests(random, { inferredAsks }) {
    const requests = [];
    const add = (bins, sound, label, extra = () => ({})) =>
      scatter(bins, random).forEach((t, i) =>
        requests.push({ t, sound, key: `${label}-${i}`, source: label, ...extra(i) }));

    add(BINS.stagePasses, "step", "stage-pass", (i) => ({ pipeline: `lane-p${i}` }));
    add(BINS.mergeConfirms, "landed", "merge", (i) => ({ pipeline: `lane-m${i}` }));
    add(BINS.completionsWithoutMerge, "landed", "completion", (i) => ({ pipeline: `lane-c${i}` }));
    add(BINS.deploySucceeded, "released", "deploy");
    add(BINS.needsDecision, "your-move", "needs-decision", (i) => ({ obligation: `task-d${i}` }));
    add(BINS.formsRaised, "your-move", "form", (i) => ({ obligation: `task-f${i}` }));
    add(BINS.attentionRequests, "your-move", "attention-request");
    if (inferredAsks) add(BINS.inferredAsks, "your-move", "inferred-ask");
    return requests.sort((a, b) => a.t - b.t);
  }

  // ── Tool calls → S1 for the panes on screen, S2 for the rest ───────────

  /** Calls found in one parse are staggered by this much (src/lib/audio/toolCues.ts). */
  const STAGGER = 0.22;
  const TYPING_VOICES = 3;
  /** S2 stays quiet right after S1: the near layer already said it. */
  const NEAR_MASKS_DISTANT = 1;
  const ON_SCREEN_PANS = [-0.35, 0.35];

  function typing(random, { liveSessions }) {
    const onScreen = ON_SCREEN_PANS.length;
    const offScreen = Math.max(0, liveSessions - onScreen);
    const interval = DS.typing.distantInterval(offScreen);
    const calls = scatter(BINS.ordinaryTools.map((n, i) => n + BINS.viewerMcp[i]), random)
      .map((t) => ({ t, session: Math.floor(random() * liveSessions) }));

    const near = [];
    const distant = [];
    const voiceEnds = [];
    const lastNear = ON_SCREEN_PANS.map(() => -Infinity);
    let lastDistant = -Infinity;
    let dropped = 0;

    for (const call of calls) {
      if (call.session < onScreen) {
        const at = Math.max(call.t, lastNear[call.session] + STAGGER);
        const busy = voiceEnds.filter((end) => end > at);
        if (busy.length >= TYPING_VOICES) { dropped++; continue; }
        voiceEnds.splice(0, voiceEnds.length, ...busy, at + DS.typing.SLICE_SECONDS);
        lastNear[call.session] = at;
        near.push({ t: at, pan: ON_SCREEN_PANS[call.session] });
      } else if (call.t >= lastDistant + interval) {
        const heardNear = near.length && call.t - near[near.length - 1].t < NEAR_MASKS_DISTANT;
        if (heardNear) continue;
        lastDistant = call.t;
        distant.push({ t: call.t });
      }
    }
    return { calls: calls.length, near, distant, dropped, offScreen, interval };
  }

  // ── The hour ───────────────────────────────────────────────────────────

  const SEED = 20261015;

  /** The whole simulated hour; the same options always give the same hour. */
  function simulate({ liveSessions = 12, inferredAsks = false, seed = SEED } = {}) {
    const random = DS.rng(seed);
    const requests = eventRequests(random, { inferredAsks });
    const events = DS.lane.plan(requests);
    const tools = typing(random, { liveSessions });
    const silent = {
      stageStarts: sum(BINS.stageStarts),
      stageFails: sum(BINS.stageFails),
      inferredAsks: inferredAsks ? 0 : sum(BINS.inferredAsks),
    };
    return { label: HOUR_LABEL, seed, liveSessions, inferredAsks, requests, events, tools, silent };
  }

  /**
   * Start (s) of the `span`-second window holding the most event plays; of
   * equally busy windows, the one with the most different sounds, then the
   * earliest.
   */
  function busiestMinute(hour, span = 60) {
    let best = { start: 0, plays: -1, kinds: -1 };
    for (let start = 0; start <= 3600 - span; start++) {
      const inside = hour.events.plays.filter((p) => p.start >= start && p.start < start + span);
      const kinds = new Set(inside.map((p) => p.sound)).size;
      if (inside.length > best.plays || (inside.length === best.plays && kinds > best.kinds)) {
        best = { start, plays: inside.length, kinds };
      }
    }
    return best;
  }

  DS.hour = { BINS, BIN_SECONDS, HOUR_LABEL, SEED, simulate, busiestMinute };
})();
