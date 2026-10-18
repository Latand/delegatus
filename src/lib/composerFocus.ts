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

/* One watch per document: the composer can sit in the opener's document and in
   the floating PiP window at once, and a focus event only reaches the document
   it happened in. The animations run on the one main thread both documents
   share, so a field focused in either holds the motion in all of them. */
interface Watch { users: number; focused: boolean; detach: () => void }
const watches = new Map<Document, Watch>();

function applyMark(): void {
  const on = [...watches.values()].some((watch) => watch.focused);
  for (const document of watches.keys()) {
    if (on) document.documentElement.setAttribute(COMPOSER_FOCUS_ATTRIBUTE, "");
    else document.documentElement.removeAttribute(COMPOSER_FOCUS_ATTRIBUTE);
  }
}

export function watchComposerFocus(root: Document = document): () => void {
  let watch = watches.get(root);
  if (!watch) {
    const created: Watch = { users: 0, focused: false, detach: () => {} };
    const onIn = (event: Event) => { if (isComposerField(event.target)) { created.focused = true; applyMark(); } };
    const onOut = (event: Event) => { if (isComposerField(event.target)) { created.focused = false; applyMark(); } };
    root.addEventListener("focusin", onIn);
    root.addEventListener("focusout", onOut);
    created.detach = () => {
      root.removeEventListener("focusin", onIn);
      root.removeEventListener("focusout", onOut);
    };
    watches.set(root, created);
    watch = created;
  }
  watch.users += 1;
  if (isComposerField(root.activeElement)) watch.focused = true;
  applyMark();
  const mine = watch;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mine.users -= 1;
    if (mine.users > 0) return;
    mine.detach();
    watches.delete(root);
    root.documentElement.removeAttribute(COMPOSER_FOCUS_ATTRIBUTE);
    applyMark();
  };
}
