"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

import {
  applyHand,
  beginsPan,
  clampView,
  DOUBLE_TAP_MS,
  fitScale,
  fitSwipe,
  fitView,
  handMove,
  isDoubleTap,
  isFit,
  swipeAxis,
  TAP_SLOP,
  wheelFactor,
  zoomAbout,
  type ImageView,
  type PictureSize,
  type Point,
  type Tap,
  type ViewLimits,
} from "@/lib/imageGesture";

interface Options {
  /** The picture's natural size, when the viewer lays it out at that size and
      the fit scale is the hook's to compute. Left out, the viewer's own CSS
      fits the picture and fit is a scale of 1. */
  natural?: PictureSize | null;
  /** Px kept clear around a picture at fit; only with `natural`. */
  margin?: number;
  maxScale: number;
  /** The scale a double click or a double tap at fit goes to. */
  zoomedScale: (fit: number) => number;
  /** What one finger does at fit, where a zoomed picture would pan: step to a
      neighbouring picture, or close. Left out, one finger at fit does nothing. */
  swipe?: { step: (direction: -1 | 1) => void; close: () => void };
}

interface Hand {
  start: Point;
  at: number;
  /** One pointer from its press to its release, and never a second. */
  single: boolean;
  travelled: boolean;
  pointerType: string;
}

const NO_SIZE: PictureSize = { width: 0, height: 0 };
/** A press on a control laid over the picture is that control's own. */
const onControl = (event: { target: EventTarget }) => event.target instanceof Element && event.target.closest("button") !== null;

/**
 * The hand on a picture, for both image viewers: wheel and trackpad pinch
 * zoom about the cursor, two fingers zoom about the point between them, the
 * primary button or one finger pans a zoomed picture, and a double click or
 * a double tap goes between fit and zoomed.
 *
 * A gesture lives only while its pointers are down. The release, a cancel, a
 * lost capture and the window losing focus each end it, and a mouse that
 * moves with no button held ends it too, so no press outlives the hand that
 * made it. A press that is not the primary button is never taken.
 */
export function useImageGesture(options: Options) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [frame, setFrame] = useState<PictureSize>(NO_SIZE);
  /* Null at fit: a fitted picture follows its frame, a zoomed one stays put. */
  const [zoomed, setZoomed] = useState<ImageView | null>(null);
  const [drag, setDrag] = useState<Point | null>(null);
  const [moving, setMoving] = useState(false);

  const natural = options.natural ?? null;
  const limits: ViewLimits = {
    fit: natural ? fitScale(natural, frame, options.margin ?? 0) : 1,
    max: Math.max(options.maxScale, 1),
  };
  const held = zoomed && !isFit(zoomed, limits) ? zoomed : null;
  const view: ImageView = held ?? { ...fitView(limits), tx: drag?.x ?? 0, ty: drag?.y ?? 0 };

  /* What the handlers read: events arrive faster than renders, and each one
     continues from the view the last one left. */
  const live = useRef({ options, limits, view: held ?? fitView(limits), drag });
  useLayoutEffect(() => {
    live.current = { options, limits, view: held ?? fitView(limits), drag };
  });
  const pointers = useRef(new Map<number, Point>());
  const hand = useRef<Hand | null>(null);
  const lastTap = useRef<Tap | null>(null);
  const lastPointerType = useRef("mouse");

  useLayoutEffect(() => {
    const node = frameRef.current;
    if (!node) return;
    const measure = () => setFrame((previous) => (previous.width === node.clientWidth && previous.height === node.clientHeight ? previous : { width: node.clientWidth, height: node.clientHeight }));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const picture = (): PictureSize => {
    const image = imageRef.current;
    return image ? { width: image.offsetWidth, height: image.offsetHeight } : NO_SIZE;
  };
  /** A pointer's place, measured from the centre of the frame. */
  const place = (event: { clientX: number; clientY: number }): Point => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
  };
  const commit = (next: ImageView) => {
    const state = live.current;
    const settled = clampView(next, picture(), state.limits);
    const fit = isFit(settled, state.limits);
    state.view = fit ? fitView(state.limits) : settled;
    setZoomed(fit ? null : settled);
  };
  const carry = (next: Point | null) => {
    live.current.drag = next;
    setDrag(next);
  };

  const reset = useCallback(() => {
    live.current.view = fitView(live.current.limits);
    live.current.drag = null;
    setZoomed(null);
    setDrag(null);
  }, []);

  const zoomBy = (factor: number, about: Point = { x: 0, y: 0 }) => {
    const state = live.current;
    commit(zoomAbout(state.view, factor, about, picture(), state.limits));
  };

  const toggle = (about: Point) => {
    const state = live.current;
    if (!isFit(state.view, state.limits)) return reset();
    zoomBy(state.options.zoomedScale(state.limits.fit) / state.limits.fit, about);
  };

  /** Every pointer is up, or the gesture was taken away. */
  const drop = () => {
    pointers.current.clear();
    hand.current = null;
    setMoving(false);
    if (live.current.drag) carry(null);
  };

  const release = (event: ReactPointerEvent<HTMLElement>, lifted: boolean) => {
    if (!pointers.current.delete(event.pointerId)) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (pointers.current.size > 0) return;
    const ended = hand.current;
    const offset = live.current.drag;
    const { options: current } = live.current;
    drop();
    if (!lifted || !ended?.single || ended.pointerType === "mouse") return;
    if (offset) {
      const asked = fitSwipe(offset.x, offset.y);
      if (asked === "close") current.swipe?.close();
      else if (asked) current.swipe?.step(asked === "next" ? 1 : -1);
      return;
    }
    if (ended.travelled || event.timeStamp - ended.at > DOUBLE_TAP_MS) return;
    const tap = { ...place(event), at: event.timeStamp };
    if (isDoubleTap(lastTap.current, tap)) {
      lastTap.current = null;
      toggle(tap);
    } else {
      lastTap.current = tap;
    }
  };

  const bind = {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      lastPointerType.current = event.pointerType;
      if (!beginsPan(event)) return;
      /* A second finger counts wherever it lands: a pinch that starts wide
         reaches the controls at the picture's edges. */
      if (pointers.current.size === 0 && onControl(event)) return;
      const state = live.current;
      const mouse = event.pointerType === "mouse";
      if (mouse) {
        /* A mouse at fit has nothing to pan; its click and double click stay the page's. */
        if (isFit(state.view, state.limits)) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }
      if (pointers.current.size >= 2) return;
      const at = place(event);
      pointers.current.set(event.pointerId, at);
      if (pointers.current.size === 1) hand.current = { start: at, at: event.timeStamp, single: true, travelled: false, pointerType: event.pointerType };
      else if (hand.current) hand.current.single = false;
      if (state.drag) carry(null);
      setMoving(true);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      if (!pointers.current.has(event.pointerId)) return;
      /* The release went somewhere this frame never heard of. */
      if (event.pointerType === "mouse" && (event.buttons & 1) === 0) return release(event, false);
      const before = new Map(pointers.current);
      const at = place(event);
      pointers.current.set(event.pointerId, at);
      const state = live.current;
      const pressed = hand.current;
      if (pressed && Math.hypot(at.x - pressed.start.x, at.y - pressed.start.y) > TAP_SLOP) pressed.travelled = true;
      const move = handMove(before, pointers.current);
      if (!move) return;
      if (pointers.current.size > 1 || !isFit(state.view, state.limits)) {
        commit(applyHand(state.view, move, picture(), state.limits));
        return;
      }
      if (!state.options.swipe || !pressed?.single || pressed.pointerType === "mouse") return;
      const dx = at.x - pressed.start.x;
      const dy = at.y - pressed.start.y;
      const axis = swipeAxis(dx, dy);
      if (axis) carry(axis === "x" ? { x: dx, y: 0 } : { x: 0, y: dy });
    },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => release(event, true),
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => release(event, false),
    onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => release(event, false),
    onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => {
      /* A finger's double tap is read from its own pointers above. */
      if (lastPointerType.current !== "mouse" || event.button !== 0 || onControl(event)) return;
      toggle(place(event));
    },
  };

  useEffect(() => {
    const node = frameRef.current;
    if (!node) return;
    /* Listened to outside React, which registers `wheel` passive: a trackpad
       pinch is a ctrl+wheel, and left alone it zooms the whole page. */
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const state = live.current;
      commit(zoomAbout(state.view, wheelFactor(event), place(event), picture(), state.limits));
    };
    const onBlur = () => drop();
    node.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("blur", onBlur);
    return () => {
      node.removeEventListener("wheel", onWheel);
      window.removeEventListener("blur", onBlur);
    };
    // The listeners read `live`, so they are attached once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { frameRef, imageRef, view, fit: held === null, moving, measured: frame.width > 0 && frame.height > 0, zoomBy, reset, bind };
}
