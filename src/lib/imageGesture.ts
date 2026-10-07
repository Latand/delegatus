/*
 * The gesture arithmetic of the image viewers: the file preview's image pane
 * and the fullscreen viewer read the same hand the same way through
 * `useImageGesture`, and everything that can be decided without a DOM is
 * decided here.
 *
 * A picture is drawn with `translate(tx, ty) scale(scale)` about its own
 * centre, which rests on the centre of the frame that clips it. Every point
 * is measured from that centre.
 */

export interface Point {
  x: number;
  y: number;
}

export interface ImageView {
  scale: number;
  tx: number;
  ty: number;
}

/** `fit` is the scale at which the whole picture rests in its frame, and the
    smallest a viewer shows; `max` is the largest. */
export interface ViewLimits {
  fit: number;
  max: number;
}

/** The picture's size as laid out, before its transform. Zero when it has not
    been measured, and an unmeasured picture is never clamped. */
export interface PictureSize {
  width: number;
  height: number;
}

export interface PointerPress {
  pointerType: string;
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Finger travel, in px, past which a press is a drag and never a tap. */
export const TAP_SLOP = 10;
/** Two taps this close in time and place are a double tap. */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_PX = 32;
/** Travel at fit that steps to a neighbouring picture, and that closes. */
export const SWIPE_STEP_PX = 56;
export const SWIPE_CLOSE_PX = 96;

const EPSILON = 1e-6;
const within = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export function fitView(limits: ViewLimits): ImageView {
  return { scale: limits.fit, tx: 0, ty: 0 };
}

export function isFit(view: ImageView, limits: ViewLimits): boolean {
  return view.scale <= limits.fit * (1 + EPSILON);
}

/** The scale at which a picture of its natural size rests whole inside a
    frame with `margin` px kept clear on every side. A picture smaller than
    the frame rests at its own size. */
export function fitScale(natural: PictureSize, frame: PictureSize, margin: number): number {
  if (natural.width <= 0 || natural.height <= 0 || frame.width <= 0 || frame.height <= 0) return 1;
  const scale = Math.min(1, (frame.width - margin * 2) / natural.width, (frame.height - margin * 2) / natural.height);
  return scale > 0 ? scale : 1;
}

/** Only the primary button with no modifier held moves a picture. Every other
    press belongs to the browser: its menu on the picture, its autoscroll, its
    own modified click. A finger is always primary. */
export function beginsPan(press: PointerPress): boolean {
  if (press.button !== 0) return false;
  if (press.pointerType !== "mouse") return true;
  return !(press.ctrlKey || press.metaKey || press.shiftKey || press.altKey);
}

/** A view inside its limits: at fit or under it, exactly fit; zoomed, panned
    no further than leaves the picture across the centre of its frame, so no
    drag throws it out of sight. */
export function clampView(view: ImageView, picture: PictureSize, limits: ViewLimits): ImageView {
  const scale = Math.min(limits.max, view.scale);
  if (scale <= limits.fit * (1 + EPSILON)) return fitView(limits);
  if (picture.width <= 0 || picture.height <= 0) return { scale, tx: view.tx, ty: view.ty };
  const reachX = (picture.width * scale) / 2;
  const reachY = (picture.height * scale) / 2;
  return { scale, tx: within(view.tx, -reachX, reachX), ty: within(view.ty, -reachY, reachY) };
}

/** Scale by `factor` keeping the picture's point under `about` where it is. */
export function zoomAbout(view: ImageView, factor: number, about: Point, picture: PictureSize, limits: ViewLimits): ImageView {
  const scale = within(view.scale * factor, limits.fit, limits.max);
  const ratio = scale / view.scale;
  return clampView({ scale, tx: about.x - (about.x - view.tx) * ratio, ty: about.y - (about.y - view.ty) * ratio }, picture, limits);
}

export interface HandMove {
  /** Where the hand was: one pointer, or the midpoint between two. */
  about: Point;
  dx: number;
  dy: number;
  /** How far the two pointers spread, as a ratio; 1 for one pointer. */
  factor: number;
}

/**
 * What the hand did between two readings of its pointers. Only pointers that
 * are down in both readings count, the first two of them, so a finger that
 * lands or lifts between the readings moves nothing: the next reading starts
 * from wherever the remaining fingers are.
 */
export function handMove(before: ReadonlyMap<number, Point>, after: ReadonlyMap<number, Point>): HandMove | null {
  const held = [...before.keys()].filter((id) => after.has(id)).slice(0, 2);
  if (held.length === 0) return null;
  const a0 = before.get(held[0]!)!;
  const a1 = after.get(held[0]!)!;
  if (held.length === 1) return { about: a0, dx: a1.x - a0.x, dy: a1.y - a0.y, factor: 1 };
  const b0 = before.get(held[1]!)!;
  const b1 = after.get(held[1]!)!;
  const about = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
  const spread0 = Math.hypot(a0.x - b0.x, a0.y - b0.y);
  const spread1 = Math.hypot(a1.x - b1.x, a1.y - b1.y);
  return {
    about,
    dx: (a1.x + b1.x) / 2 - about.x,
    dy: (a1.y + b1.y) / 2 - about.y,
    factor: spread0 < 1 || spread1 < 1 ? 1 : spread1 / spread0,
  };
}

/** The view after the hand's move: scaled about where the hand was, then
    carried by how far the hand travelled. */
export function applyHand(view: ImageView, move: HandMove, picture: PictureSize, limits: ViewLimits): ImageView {
  const zoomed = zoomAbout(view, move.factor, move.about, picture, limits);
  if (isFit(zoomed, limits)) return zoomed;
  return clampView({ scale: zoomed.scale, tx: zoomed.tx + move.dx, ty: zoomed.ty + move.dy }, picture, limits);
}

/** The factor one wheel event zooms by. A trackpad pinch arrives as a wheel
    with ctrl held and small deltas; a wheel notch is capped so one turn of a
    fast wheel is one step. */
export function wheelFactor(wheel: { deltaY: number; deltaMode: number; ctrlKey: boolean }): number {
  const px = wheel.deltaY * (wheel.deltaMode === 1 ? 16 : wheel.deltaMode === 2 ? 100 : 1);
  return Math.exp(-within(px, -100, 100) * (wheel.ctrlKey ? 0.01 : 0.0016));
}

/** The axis a one-finger drag at fit has taken, once it has left the slop. */
export function swipeAxis(dx: number, dy: number): "x" | "y" | null {
  if (Math.hypot(dx, dy) < TAP_SLOP) return null;
  return Math.abs(dx) > Math.abs(dy) ? "x" : "y";
}

/** What a one-finger drag at fit asks for when the finger lifts: the next
    picture for a drag to the left, the previous one to the right, closing for
    a drag up or down, nothing for a short one. */
export function fitSwipe(dx: number, dy: number): "next" | "previous" | "close" | null {
  const axis = swipeAxis(dx, dy);
  if (axis === "x" && Math.abs(dx) >= SWIPE_STEP_PX) return dx < 0 ? "next" : "previous";
  if (axis === "y" && Math.abs(dy) >= SWIPE_CLOSE_PX) return "close";
  return null;
}

export interface Tap extends Point {
  at: number;
}

export function isDoubleTap(previous: Tap | null, tap: Tap): boolean {
  if (!previous) return false;
  return tap.at - previous.at <= DOUBLE_TAP_MS && Math.hypot(tap.x - previous.x, tap.y - previous.y) <= DOUBLE_TAP_PX;
}
