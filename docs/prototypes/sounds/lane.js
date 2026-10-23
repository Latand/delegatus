/* The timing rules of docs/design/sound-redesign.md §6.1–§6.2, as a pure
 * planner: requests in, plays out, no audio. The busy hour, the rules check
 * and the renders all read the same plan.
 *
 *   requests ─ gate (identity, obligation key, window, gap, cap)
 *            ─ S4 supersedes S3 for the same pipeline
 *            ─ one event lane (priority, cut, queue)  ─ plays
 *
 * A request: { t (s), sound, key, obligation?, pipeline? }.
 * A play:    { sound, start, n, cutAt, replay }. */
(() => {
  const DS = window.DelegatusSounds;

  /** §6.1: coalescing window, minimum gap after a play, plays per minute. */
  const RULES = {
    "your-move": { window: 3, gap: 5, perMinute: 6 },
    fault: { window: 3, gap: 10, perMinute: 3 },
    reply: { window: 1.5 },
    released: {},
    landed: { window: 5, gap: 8 },
    step: { window: 2, gap: 6, perMinute: 6 },
    launched: { gap: 1 },
  };
  /** A decision already heard stays silent this long, whichever record it comes back as. */
  const OBLIGATION_MEMORY = 600;
  /** A lane landing makes its last step's sound redundant. */
  const STEP_SUPERSEDED_WITHIN = 10;
  /**
   * Only the two sounds that need the operator cut what is playing. §6.2's
   * general rule («a higher sound cuts») would let S5 cut S4, which its own
   * example and test list rule out («S5 arriving mid-S4 plays after it»), so
   * the results wait their turn by priority.
   */
  const CUTS = new Set(["your-move", "fault"]);
  /** Frequent or self-caused: a few seconds late they say nothing. */
  const DROPPED_WHEN_BUSY = new Set(["step", "launched"]);
  /** The lane's queue forgets a play older than this. */
  const QUEUE_BOUND = 15;
  /** Breath between one sound's end and the next queued one. */
  const QUEUE_PAUSE = 0.15;

  const rank = (sound) => DS.PRIORITY.length - DS.PRIORITY.indexOf(sound);
  const tally = (counts, key, by = 1) => { counts[key] = (counts[key] ?? 0) + by; };

  // ── Stage 1: each class's gate ─────────────────────────────────────────

  /**
   * Coalescing is trailing: a burst opens a window, and one play leaves when
   * it closes, carrying the burst's size (S4 needs it for its grace notes).
   * After a play, the class is quiet for its gap; everything inside the gap
   * becomes at most one more play at the gap's end. A class at its
   * per-minute cap waits for the minute to free up, except S3, which drops.
   */
  function gate(requests, stats) {
    const emits = [];
    const spent = new Set();
    const obligationHeard = new Map();
    const timers = [];
    const classes = Object.fromEntries(Object.keys(RULES).map((sound) =>
      [sound, { open: null, waiting: null, lastPlay: -Infinity, minute: [] }]));

    const later = (t, run) => {
      timers.push({ t, run });
      timers.sort((a, b) => a.t - b.t);
    };
    const batchOf = (r) => ({ n: 1, pipelines: r.pipeline ? [r.pipeline] : [], since: r.t });
    const join = (batch, r) => {
      batch.n += 1;
      if (r.pipeline) batch.pipelines.push(r.pipeline);
    };

    function request(r) {
      tally(stats.sources, r.sound);
      if (spent.has(r.key)) return tally(stats.dropped, "identity spent");
      spent.add(r.key);
      if (r.obligation) {
        const heard = obligationHeard.get(r.obligation);
        if (heard !== undefined && r.t - heard < OBLIGATION_MEMORY) return tally(stats.dropped, "obligation heard");
        obligationHeard.set(r.obligation, r.t);
      }

      const rule = RULES[r.sound];
      const state = classes[r.sound];
      if (state.open) return join(state.open, r);
      if (state.waiting) return join(state.waiting, r);
      if (r.t < state.lastPlay + (rule.gap ?? 0)) {
        state.waiting = batchOf(r);
        return later(state.lastPlay + rule.gap, (t) => release(r.sound, "waiting", t));
      }
      state.open = batchOf(r);
      later(r.t + (rule.window ?? 0), (t) => release(r.sound, "open", t));
    }

    function release(sound, slot, t) {
      const rule = RULES[sound];
      const state = classes[sound];
      const batch = state[slot];
      state[slot] = null;

      if (rule.perMinute) {
        state.minute = state.minute.filter((played) => played > t - 60);
        if (state.minute.length >= rule.perMinute) {
          if (sound === "step") return tally(stats.dropped, "per-minute cap", batch.n);
          if (state.waiting) {
            state.waiting.n += batch.n;
            state.waiting.pipelines.push(...batch.pipelines);
          } else {
            state.waiting = batch;
            later(state.minute[0] + 60, (free) => release(sound, "waiting", free));
          }
          return;
        }
        state.minute.push(t);
      }
      state.lastPlay = t;
      emits.push({ t, sound, n: batch.n, pipelines: batch.pipelines });
    }

    for (const r of [...requests].sort((a, b) => a.t - b.t)) {
      while (timers.length && timers[0].t <= r.t) {
        const timer = timers.shift();
        timer.run(timer.t);
      }
      request(r);
    }
    while (timers.length) {
      const timer = timers.shift();
      timer.run(timer.t);
    }
    return emits.sort((a, b) => a.t - b.t || rank(b.sound) - rank(a.sound));
  }

  /** S3 for a pipeline whose landing sounds within 10 s says nothing new. */
  function supersede(emits, stats) {
    const landings = emits.filter((e) => e.sound === "landed");
    return emits.filter((e) => {
      if (e.sound !== "step" || !e.pipelines.length) return true;
      const kept = e.pipelines.filter((pipeline) => !landings.some((l) =>
        Math.abs(l.t - e.t) <= STEP_SUPERSEDED_WITHIN && l.pipelines.includes(pipeline)));
      tally(stats.dropped, "superseded by S4", e.pipelines.length - kept.length);
      e.n -= e.pipelines.length - kept.length;
      e.pipelines = kept;
      return e.n > 0;
    });
  }

  // ── Stage 2: the one event lane ────────────────────────────────────────

  /**
   * S6 or S7 cuts a lower sound (40 ms fade) and starts at once; the cut
   * sound replays once afterwards, except S3. An equal or lower sound waits
   * in the queue, one pending play per class, except S3 and S9, which drop.
   * When a sound ends, the highest queued class starts 150 ms later.
   */
  function lane(emits, lengthOf, stats) {
    const plays = [];
    const queue = new Map();
    let playing = null;
    let resumeAt = -Infinity;

    function start(item, t) {
      const record = { sound: item.sound, start: t, n: item.n, cutAt: null, replay: Boolean(item.replay) };
      plays.push(record);
      playing = { ...item, end: t + lengthOf(item.sound), record };
    }

    function enqueue(item) {
      const pending = queue.get(item.sound);
      if (pending) pending.n += item.n;
      else queue.set(item.sound, { ...item, since: item.since ?? item.t });
    }

    function arrive(item) {
      if (!playing && !queue.size) return start(item, item.t);
      if (playing && CUTS.has(item.sound) && rank(item.sound) > rank(playing.sound)) {
        playing.record.cutAt = item.t;
        if (playing.sound === "step" || playing.replay) tally(stats.dropped, "cut");
        else enqueue({ sound: playing.sound, n: playing.n, since: item.t, replay: true });
        playing = null;
        return start(item, item.t);
      }
      if (playing && DROPPED_WHEN_BUSY.has(item.sound)) return tally(stats.dropped, "lane busy");
      enqueue(item);
    }

    function resume(t) {
      for (const [sound, item] of queue) {
        if (item.since < t - QUEUE_BOUND) {
          queue.delete(sound);
          tally(stats.dropped, "queued over 15 s");
        }
      }
      const next = [...queue.values()].sort((a, b) => rank(b.sound) - rank(a.sound))[0];
      if (!next) return;
      queue.delete(next.sound);
      start(next, t);
    }

    let i = 0;
    for (;;) {
      const arrival = i < emits.length ? emits[i].t : Infinity;
      const ends = playing ? playing.end : Infinity;
      const resumes = !playing && queue.size ? resumeAt : Infinity;
      if (Math.min(arrival, ends, resumes) === Infinity) break;
      if (ends <= arrival && ends <= resumes) {
        playing = null;
        resumeAt = ends + QUEUE_PAUSE;
      } else if (resumes <= arrival) {
        resume(resumes);
      } else {
        arrive(emits[i++]);
      }
    }
    return plays;
  }

  /** The whole pipeline of rules. */
  function plan(requests, lengthOf = (sound) => DS.SOUNDS[sound].length) {
    const stats = { sources: {}, dropped: {} };
    const emits = supersede(gate(requests, stats), stats);
    const plays = lane(emits, lengthOf, stats);
    return { plays, stats };
  }

  // ── The rules check: the planner cases §12 asks the implementation for ──

  function selfCheck() {
    const r = (t, sound, extra = {}) => ({ t, sound, key: `${sound}@${t}`, ...extra });
    const startsOf = (plays, sound) => plays.filter((p) => p.sound === sound).map((p) => +p.start.toFixed(2));
    const cases = [
      {
        name: { en: "S7 arriving mid-S6 plays right after it", uk: "S7 під час S6 звучить одразу після нього" },
        run: () => plan([r(0, "your-move"), r(0.5, "fault")]).plays,
        expect: (plays) => startsOf(plays, "fault")[0] === 4.75,
      },
      {
        name: { en: "S5 arriving mid-S4 plays after the landing", uk: "S5 під час S4 звучить після нього" },
        run: () => plan([r(0, "landed"), r(5.5, "released")]).plays,
        expect: (plays) => startsOf(plays, "released")[0] === 6.95,
      },
      {
        name: { en: "S6 arriving mid-S4 cuts it, and S4 replays once in full", uk: "S6 під час S4 обриває його, і S4 звучить ще раз повністю" },
        run: () => plan([r(0, "landed"), r(2.5, "your-move")]).plays,
        expect: (plays) => plays[0].cutAt === 5.5 && plays[2]?.sound === "landed" && plays[2].replay,
      },
      {
        name: { en: "S3 arriving mid-S6 is dropped", uk: "S3 під час S6 відкидається" },
        run: () => plan([r(0, "your-move"), r(1.5, "step")]).plays,
        expect: (plays) => plays.length === 1,
      },
      {
        name: { en: "A queued play older than 15 s is dropped", uk: "Звук, що чекає в черзі понад 15 с, відкидається" },
        run: () => plan([r(0, "your-move"), r(1, "landed")], (s) => (s === "your-move" ? 20 : 1.8)).plays,
        expect: (plays) => plays.length === 1,
      },
      {
        name: { en: "One obligation heard twice within 10 minutes sounds once", uk: "Одне зобов'язання двічі за 10 хвилин звучить один раз" },
        run: () => plan([r(0, "your-move", { obligation: "task-a" }), r(120, "your-move", { obligation: "task-a" })]).plays,
        expect: (plays) => plays.length === 1,
      },
      {
        name: { en: "Three lanes landing within 5 s are one S4 with two grace notes", uk: "Три лейни, злиті за 5 с, — один S4 із двома прикрасами" },
        run: () => plan([r(0, "landed"), r(1.2, "landed"), r(4.1, "landed")]).plays,
        expect: (plays) => plays.length === 1 && plays[0].n === 3,
      },
      {
        name: { en: "A lane's S3 is dropped when its S4 sounds within 10 s", uk: "S3 лейну відкидається, коли його S4 звучить у межах 10 с" },
        run: () => plan([r(0, "step", { pipeline: "p" }), r(1, "landed", { pipeline: "p" })]).plays,
        expect: (plays) => plays.length === 1 && plays[0].sound === "landed",
      },
      {
        name: { en: "Seven decisions in 10 s (the audit's burst) are three S6, not seven", uk: "Сім рішень за 10 с (сплеск з аудиту) — три S6, а не сім" },
        run: () => plan([0, 1.5, 2.5, 4, 6, 8.5, 9.5].map((t) => r(t, "your-move"))).plays,
        expect: (plays) => plays.length === 3,
      },
    ];
    return cases.map(({ name, run, expect }) => {
      const plays = run();
      return { name, pass: Boolean(expect(plays)), plays };
    });
  }

  DS.lane = { RULES, plan, selfCheck };
})();
