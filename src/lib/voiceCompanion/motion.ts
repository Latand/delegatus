/**
 * How the voice companion's lane moves (#2519, design note §9). Pure numbers,
 * shared by the component and the tests.
 *
 * The lane moves as one sheet. When an element arrives or grows, everything in
 * the lane travels the same distance on the same curve, and the new part comes
 * out from the lane's end at the character, where the lane is clipped. No
 * element waits unseen for room, and no element steps.
 *
 * The limit the curves are held to: no frame of a rise carries more than
 * `RISE_FRAME_SHARE` of its path. The earlier curve, a steep ease-out over
 * 340 ms, gave 21 % of the path to its first 16.7 ms frame, which read as a
 * jump at a clean frame rate.
 */

export type Bezier = readonly [number, number, number, number];

/** How long a rise takes. */
export const RISE_MS = 480;
/** A rise that starts from rest: it eases in and out. */
export const RISE_FROM_REST: Bezier = [0.37, 0, 0.63, 1];
/** A rise that takes over one still in flight: it starts at speed and eases out. */
export const RISE_IN_FLIGHT: Bezier = [0.33, 0.4, 0.6, 1];
/** The most of its path a rise may cover in one frame. */
export const RISE_FRAME_SHARE = 0.12;

export const cssBezier = (curve: Bezier) => `cubic-bezier(${curve.join(", ")})`;

/** The progress of a cubic-bezier timing curve at time `t` (both 0..1). */
export function bezierProgress(curve: Bezier, t: number): number {
  const [x1, y1, x2, y2] = curve;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  let low = 0;
  let high = 1;
  for (let turn = 0; turn < 40; turn += 1) {
    const u = (low + high) / 2;
    const x = 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
    if (x < t) low = u; else high = u;
  }
  const u = (low + high) / 2;
  return 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
}

/** The largest share of its path a curve covers in any window of `frameMs` over `durationMs`. */
export function maxFrameShare(curve: Bezier, durationMs: number, frameMs: number): number {
  let most = 0;
  for (let at = 0; at <= durationMs; at += 0.5) most = Math.max(most, bezierProgress(curve, (at + frameMs) / durationMs) - bezierProgress(curve, at / durationMs));
  return most;
}

/** How fast a curve moves at time `t` (0..1), as a share of the path per share of the duration. */
export function bezierSlope(curve: Bezier, t: number): number {
  const from = Math.max(0, t - 0.002);
  const to = Math.min(1, t + 0.002);
  return (bezierProgress(curve, to) - bezierProgress(curve, from)) / (to - from);
}

/**
 * The curve for a rise of `travel` px when the lane already moves at `speed`
 * px/ms. The one that starts at speed is taken only when the lane moves at
 * half that speed or more; a rise that takes over the slow end of another
 * starts from rest, so it never sets off at a pace the lane did not have.
 */
export function riseCurve(speed: number, travel: number): Bezier {
  const atSpeed = (Math.abs(travel) * RISE_IN_FLIGHT[1]) / RISE_IN_FLIGHT[0] / RISE_MS;
  return atSpeed > 0 && Math.abs(speed) >= atSpeed / 2 ? RISE_IN_FLIGHT : RISE_FROM_REST;
}
