/* #2761: the event loop of the production server the browser views are
   opened on, watched from inside that server.

   The gate bounds each release's event loop from inside the release, but the
   browser half serves the board from a separate `next start`, and Chromium's
   main-thread delay says nothing about that server: a route or a background
   tick that holds it for most of a second passed every browser bound. This
   file is preloaded into that server (`bun --preload`), where it samples how
   late a 10 ms timer fires, each sample stamped with the wall clock, and
   answers the gate through files beside `LLV_CANDIDATE_SERVER_LOOP`:

   - `<prefix>.pid`: written once, the process being watched;
   - `<prefix>.ask` holding `{ id, from, to }`: answered by `<prefix>.<id>.json`
     with the samples whose wall clock lies in that window;
   - `<prefix>.stall` holding a number of milliseconds: the loop is held that
     long, once, so the gate's own tests can prove such a server is refused.

   It imports nothing of the application and does nothing without the
   variable, in a worker thread or outside the gate. */

import fs from "node:fs";
import { isMainThread } from "node:worker_threads";

const INTERVAL_MS = 10;
/** A late tick worth naming in a refusal. */
const STALL_MS = 100;
const KEPT_SAMPLES = 200_000;

export interface ServerLoopWindow {
  pid: number;
  samples: number;
  p95Ms: number;
  maxMs: number;
  stalls: Array<{ at: number; ms: number }>;
}

const prefix = process.env.LLV_CANDIDATE_SERVER_LOOP;
if (prefix && isMainThread) {
  let at: number[] = [];
  let late: number[] = [];
  let expected = performance.now() + INTERVAL_MS;
  let ticks = 0;
  const answer = () => {
    let ask: { id?: unknown; from?: unknown; to?: unknown };
    try { ask = JSON.parse(fs.readFileSync(`${prefix}.ask`, "utf8")) as typeof ask; } catch { return; }
    fs.rmSync(`${prefix}.ask`, { force: true });
    if (typeof ask.id !== "string" || !/^[a-z0-9-]+$/.test(ask.id) || typeof ask.from !== "number" || typeof ask.to !== "number") return;
    const inside: number[] = [];
    const stalls: ServerLoopWindow["stalls"] = [];
    for (let index = 0; index < at.length; index += 1) {
      if (at[index]! < ask.from || at[index]! > ask.to) continue;
      inside.push(late[index]!);
      if (late[index]! >= STALL_MS && stalls.length < 20) stalls.push({ at: at[index]!, ms: Math.round(late[index]!) });
    }
    inside.sort((left, right) => left - right);
    const window: ServerLoopWindow = {
      pid: process.pid,
      samples: inside.length,
      p95Ms: inside.length ? Math.round(inside[Math.min(inside.length - 1, Math.ceil(inside.length * 0.95) - 1)]! * 10) / 10 : 0,
      maxMs: Math.round((inside.at(-1) ?? 0) * 10) / 10,
      stalls,
    };
    fs.writeFileSync(`${prefix}.${ask.id}.tmp`, JSON.stringify(window));
    fs.renameSync(`${prefix}.${ask.id}.tmp`, `${prefix}.${ask.id}.json`);
  };
  const induced = () => {
    let ms: number;
    try { ms = Number(fs.readFileSync(`${prefix}.stall`, "utf8")); } catch { return; }
    fs.rmSync(`${prefix}.stall`, { force: true });
    if (!Number.isFinite(ms) || ms <= 0 || ms > 60_000) return;
    for (const until = performance.now() + ms; performance.now() < until;) { /* a deliberately held server */ }
  };
  const tick = () => {
    const now = performance.now();
    at.push(Date.now());
    late.push(Math.max(0, now - expected));
    if (at.length > KEPT_SAMPLES) { at = at.slice(KEPT_SAMPLES / 2); late = late.slice(KEPT_SAMPLES / 2); }
    ticks += 1;
    /* Set before the work below, so an induced hold makes the next tick late
       as any other synchronous work would. */
    expected = now + INTERVAL_MS;
    if (ticks % 10 === 0) {
      try { answer(); induced(); } catch { /* the gate reads a missing answer as no measurement */ }
    }
    setTimeout(tick, INTERVAL_MS).unref();
  };
  try { fs.writeFileSync(`${prefix}.pid`, String(process.pid)); } catch { /* the gate reads a missing pid as no probe */ }
  setTimeout(tick, INTERVAL_MS).unref();
}
