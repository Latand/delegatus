"use client";

import { useEffect, useRef } from "react";

/* Open overlays, oldest first. One capture listener on the window hands
   Escape to the newest, so a menu opened over the preview closes before the
   preview does. */
const stack: { current: () => void; claims: { current: (() => boolean) | undefined } }[] = [];

function onKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  /* An overlay that is not on top of some other stack (a modal dialog opened
     above it) leaves the key unclaimed for that dialog. */
  if (top.claims.current && !top.claims.current()) return;
  event.preventDefault();
  event.stopPropagation();
  top.current();
}

/**
 * Escape closes this overlay and nothing under it. Portalled menus and the
 * image preview never take focus, so the key's target is the page body and a
 * surface below (the expanded conversation) would otherwise close on the same
 * press (#1858). The window's capture phase runs before any of their
 * listeners; the key is claimed there and marked handled.
 *
 * `canClaim` is read at the key press: when it answers false the press passes
 * on unclaimed, so a surface that also sits on another ordering (the modal
 * layer stack) can step aside while something newer owns the key.
 */
export function useOverlayEscape(onEscape: () => void, enabled = true, canClaim?: () => boolean): void {
  const handler = useRef(onEscape);
  const claims = useRef(canClaim);
  useEffect(() => {
    handler.current = onEscape;
    claims.current = canClaim;
  }, [onEscape, canClaim]);

  useEffect(() => {
    if (!enabled) return;
    const entry = { current: () => handler.current(), claims };
    stack.push(entry);
    if (stack.length === 1) window.addEventListener("keydown", onKeyDown, true);
    return () => {
      stack.splice(stack.indexOf(entry), 1);
      if (stack.length === 0) window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [enabled]);
}
