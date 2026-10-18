/**
 * Marks the document while a composer field has the focus, so motion that can
 * only run on the main thread stands still for as long as the operator types.
 *
 * Most of the attention cues were moved onto the compositor (the pane ring turns
 * by `transform`). A halo that grows a `box-shadow` cannot be: the cue sits on a
 * clipped badge or an arbitrary element, and every frame of it is a main-thread
 * paint beside the textarea that has to answer the key. Those pause
 * (`animation-play-state`, globals.css) while `data-composer-focused` is on the
 * root, and resume the moment the field loses focus. Reduced-motion users never
 * had them moving.
 */
export const COMPOSER_FOCUS_ATTRIBUTE = "data-composer-focused";

function isComposerField(target: EventTarget | null): boolean {
  /* Not `instanceof Element`: the field can live in another document (the PiP window) and its realm's Element is not this one. */
  return typeof (target as Element | null)?.hasAttribute === "function" && (target as Element).hasAttribute("data-composer-field");
}

let users = 0;
let detach: (() => void) | null = null;

export function watchComposerFocus(root: Document = document): () => void {
  users += 1;
  if (users === 1) {
    const element = root.documentElement;
    const onIn = (event: Event) => { if (isComposerField(event.target)) element.setAttribute(COMPOSER_FOCUS_ATTRIBUTE, ""); };
    const onOut = (event: Event) => { if (isComposerField(event.target)) element.removeAttribute(COMPOSER_FOCUS_ATTRIBUTE); };
    root.addEventListener("focusin", onIn);
    root.addEventListener("focusout", onOut);
    if (isComposerField(root.activeElement)) element.setAttribute(COMPOSER_FOCUS_ATTRIBUTE, "");
    detach = () => {
      root.removeEventListener("focusin", onIn);
      root.removeEventListener("focusout", onOut);
      element.removeAttribute(COMPOSER_FOCUS_ATTRIBUTE);
    };
  }
  return () => {
    users -= 1;
    if (users > 0) return;
    detach?.();
    detach = null;
  };
}
