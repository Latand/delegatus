/** Width changes lay out once. Visible cards FLIP into that layout while a
 * frozen copy of their old wrapping fades away, so text never flashes between
 * line breaks. Column frames do the same independently of their contents.
 * Only an impending interaction measures/clones; pointer moves do neither. */
export const COLUMN_LAYOUT_MS = 240;
const EASING = "cubic-bezier(0.16, 1, 0.3, 1)";
const COLUMN = ".board > .column[data-wide]";

interface Shot {
  node: HTMLElement;
  rect: DOMRect;
  copy: HTMLElement | null;
  frame: boolean;
  viewport?: DOMRect;
}
interface Snapshot {
  key: string;
  shots: Shot[];
  scroll: { node: HTMLElement; top: number; left: number }[];
}

const keyOf = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(COLUMN)].map((node) => `${node.dataset.status}:${node.dataset.wide}`).join("|");

export function installColumnLayoutAnimation(root: HTMLElement): { prepare(): void; dispose(): void } {
  let pending: Snapshot | null = null;
  let expiry: ReturnType<typeof setTimeout> | null = null;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  let animations: Animation[] = [];
  let paintFrame = 0;
  let copies: HTMLElement[] = [];
  let marked: HTMLElement[] = [];
  const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");

  const clearPending = () => {
    pending = null;
    if (expiry) clearTimeout(expiry);
    expiry = null;
  };
  const finish = () => {
    if (paintFrame) window.cancelAnimationFrame(paintFrame);
    paintFrame = 0;
    if (finishTimer) clearTimeout(finishTimer);
    finishTimer = null;
    animations.forEach((animation) => animation.cancel());
    copies.forEach((copy) => copy.remove());
    marked.forEach((node) => node.removeAttribute("data-layout-animating"));
    animations = []; copies = []; marked = [];
  };
  const prepare = () => {
    clearPending();
    if (motion?.matches || typeof root.animate !== "function") { finish(); return; }
    const shots: Shot[] = [];
    const columns = [...root.querySelectorAll<HTMLElement>(COLUMN)];
    /* Read all geometry before any writes. Skip offscreen cards; their
       content-visibility remains intact on a busy board. */
    for (const column of columns) {
      const body = column.querySelector<HTMLElement>(".col-body");
      const viewport = body?.getBoundingClientRect();
      for (const node of [column, ...column.querySelectorAll<HTMLElement>(".col-head, .col-body > .card, .col-body > .divider, .col-body > .empty")]) {
        const rect = node.getBoundingClientRect();
        const frame = node === column;
        if (!rect.width || !rect.height) continue;
        if (rect.right < 0 || rect.left > window.innerWidth || rect.bottom < 0 || rect.top > window.innerHeight || (!frame && !node.matches(".col-head") && viewport && (rect.bottom < viewport.top || rect.top > viewport.bottom))) {
          shots.push({ node, rect, copy: null, frame, viewport });
          continue;
        }
        const copy = node.cloneNode(!frame) as HTMLElement;
        if (frame) {
          const style = window.getComputedStyle(node);
          copy.style.background = style.background;
          copy.style.border = style.border;
          copy.style.borderRadius = style.borderRadius;
        }
        /* Copies never join selectors, focus order, accessibility or live
           readers. They are disposable pixels during the transition. */
        copy.removeAttribute("data-status");
        copy.removeAttribute("data-wide");
        copy.removeAttribute("data-dwell");
        copy.removeAttribute("data-layout-animating");
        for (const element of [copy, ...copy.querySelectorAll("*")]) {
          element.removeAttribute("id");
          element.removeAttribute("data-id");
          element.removeAttribute("data-kanban-reader");
        }
        copy.setAttribute("aria-hidden", "true");
        copy.inert = true;
        copy.classList.add("kb-layout-copy");
        if (frame) copy.classList.add("kb-layout-frame");
        Object.assign(copy.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
        if (!frame && !node.matches(".col-head") && viewport) {
          copy.style.clipPath = `inset(${Math.max(0, viewport.top - rect.top)}px ${Math.max(0, rect.right - viewport.right)}px ${Math.max(0, rect.bottom - viewport.bottom)}px ${Math.max(0, viewport.left - rect.left)}px)`;
        }
        shots.push({ node, rect, copy, frame, viewport });
      }
    }
    const scroll = [...root.querySelectorAll<HTMLElement>(".board, .col-body")].map((node) => ({ node, top: node.scrollTop, left: node.scrollLeft }));
    const key = keyOf(root);
    finish();
    pending = { key, shots, scroll };
    expiry = setTimeout(clearPending, 1000);
  };
  const observer = new window.MutationObserver(() => {
    if (!pending || pending.key === keyOf(root)) return;
    const snapshot = pending;
    clearPending();
    if (motion?.matches) return finish();
    /* Anchoring must not move a neighbouring card when its wrapping changes. */
    for (const { node, top, left } of snapshot.scroll) { node.scrollTop = top; node.scrollLeft = left; }
    const destinations = snapshot.shots.filter(({ node }) => node.isConnected).map((shot) => ({ ...shot, next: shot.node.getBoundingClientRect(), nextViewport: shot.node.closest(".col-body")?.getBoundingClientRect(), background: shot.frame ? window.getComputedStyle(shot.node).background : "", border: shot.frame ? window.getComputedStyle(shot.node).border : "" }));
    const timing = { duration: COLUMN_LAYOUT_MS, easing: EASING, fill: "both" as const };
    const page = root.querySelector<HTMLElement>(".kb-page");
    if (page) { page.dataset.layoutAnimating = "page"; marked.push(page); }
    const fragment = document.createDocumentFragment();
    const plans: { node: HTMLElement; frames: Keyframe[] }[] = [];
    for (const { node, rect, next, copy, frame, viewport, nextViewport, background, border } of destinations) {
      if (!next.width || !next.height) continue;
      if (!copy && (next.right < 0 || next.left > window.innerWidth || next.bottom < 0 || next.top > window.innerHeight)) continue;
      const dx = rect.left - next.left;
      const dy = rect.top - next.top;
      const sx = rect.width / next.width;
      const sy = rect.height / next.height;
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(rect.width - next.width) + Math.abs(rect.height - next.height) < 0.5) continue;
      node.setAttribute("data-layout-animating", frame ? "frame" : "card");
      marked.push(node);
      const clip = (box: DOMRect, view: DOMRect | undefined, width: number, height: number, x = 1, y = 1) => `inset(${Math.max(0, (view?.top ?? box.top) - box.top) / y}px ${Math.max(0, width - box.width, box.left + width - (view?.right ?? box.left + width)) / x}px ${Math.max(0, height - box.height, box.top + height - (view?.bottom ?? box.top + height)) / y}px ${Math.max(0, (view?.left ?? box.left) - box.left) / x}px)`;
      if (copy) {
        if (!frame && !node.matches(".col-head")) {
          /* Stretch only the card's surface. Text keeps its natural font size
             and its captured wrapping while the two layouts crossfade. */
          const shell = copy.cloneNode(false) as HTMLElement;
          shell.classList.add("kb-layout-shell");
          fragment.append(shell); copies.push(shell);
          plans.push({ node: shell, frames: [
            { transform: "none", clipPath: clip(rect, viewport, rect.width, rect.height) },
            { transform: `translate(${-dx}px, ${-dy}px) scale(${1 / sx}, ${1 / sy})`, clipPath: clip(next, nextViewport, next.width, next.height, 1 / sx, 1 / sy) },
          ] });
          Object.assign(copy.style, { background: "transparent", borderColor: "transparent", boxShadow: "none" });
        }
        fragment.append(copy); copies.push(copy);
        plans.push({ node: copy, frames: frame ? [
          { transform: "none", opacity: 1 },
          { transform: `translate(${-dx}px, ${-dy}px) scale(${1 / sx}, ${1 / sy})`, opacity: 0 },
        ] : [
          { transform: "none", clipPath: clip(rect, viewport, rect.width, rect.height), opacity: 1 },
          { transform: `translate(${-dx}px, ${-dy}px)`, clipPath: clip(next, nextViewport, rect.width, rect.height), opacity: 0 },
        ] });
      }
      if (frame) {
        const destination = copy ? copy.cloneNode(false) as HTMLElement : document.createElement("div");
        destination.className = "column kb-layout-copy kb-layout-frame";
        destination.setAttribute("aria-hidden", "true");
        destination.inert = true;
        Object.assign(destination.style, { left: `${next.left}px`, top: `${next.top}px`, width: `${next.width}px`, height: `${next.height}px`, background, border });
        fragment.append(destination); copies.push(destination);
        plans.push({ node: destination, frames: [
          { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0 },
          { transform: "none", opacity: 1 },
        ] });
      } else {
        /* A destination snapshot stays outside the list's final clipping
           edge while it moves. The real card keeps its semantics and its
           FLIP geometry, underneath these two inert, opaque card surfaces. */
        if (!node.matches(".col-head")) {
          const destination = node.cloneNode(true) as HTMLElement;
          destination.classList.add("kb-layout-copy", "kb-layout-destination");
          destination.removeAttribute("data-layout-animating");
          for (const element of [destination, ...destination.querySelectorAll("*")]) {
            element.removeAttribute("id");
            element.removeAttribute("data-id");
            element.removeAttribute("data-kanban-reader");
          }
          destination.setAttribute("aria-hidden", "true");
          destination.inert = true;
          Object.assign(destination.style, { left: `${next.left}px`, top: `${next.top}px`, width: `${next.width}px`, height: `${next.height}px` });
          if (copy) Object.assign(destination.style, { background: "transparent", borderColor: "transparent", boxShadow: "none" });
          fragment.append(destination); copies.push(destination);
          plans.push({ node: destination, frames: [
            { transform: `translate(${dx}px, ${dy}px)`, clipPath: clip(rect, viewport, next.width, next.height), opacity: 0 },
            { transform: "none", clipPath: clip(next, nextViewport, next.width, next.height), opacity: 1 },
          ] });
        }
        plans.push({ node, frames: [
          { transform: node.matches(".col-head") ? `translate(${dx}px, ${dy}px)` : `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0 },
          { transform: "none", opacity: node.matches(".col-head") ? 1 : 0 },
        ] });
      }
    }
    root.append(fragment);
    animations = plans.map(({ node, frames }) => node.animate(frames, timing));
    animations.forEach((animation) => animation.pause());
    /* Finish the one-time wrapping and rasterization before the animation
       clock starts. Its first painted frame is the captured old layout. */
    paintFrame = window.requestAnimationFrame(() => {
      paintFrame = window.requestAnimationFrame(() => {
        paintFrame = 0;
        animations.forEach((animation) => animation.play());
        finishTimer = setTimeout(finish, COLUMN_LAYOUT_MS);
      });
    });
  });
  observer.observe(root, { subtree: true, attributes: true, attributeFilter: ["data-wide"] });
  const onClick = (event: Event) => {
    const target = event.target as Element | null;
    if (target?.closest?.("[data-col-width], [data-open-agent-jump]")) prepare();
  };
  const onWork = (event: Event) => {
    const target = event.target as Element | null;
    if (target?.closest?.('.column[data-status="assigned"] .card') && root.querySelector('.column[data-wide="1"]:not([data-status="assigned"])')) prepare();
  };
  root.addEventListener("click", onClick, true);
  root.addEventListener("pointerdown", onWork, true);
  root.addEventListener("focusin", onWork, true);
  /* Scrolling during motion follows the operator immediately; viewport-fixed
     snapshots must never linger over a list they have just scrolled. */
  const interrupted = () => { clearPending(); finish(); };
  root.addEventListener("wheel", interrupted, { passive: true });
  window.addEventListener("resize", interrupted);
  motion?.addEventListener("change", interrupted);
  return {
    prepare,
    dispose() {
      clearPending(); finish(); observer.disconnect();
      root.removeEventListener("click", onClick, true);
      root.removeEventListener("pointerdown", onWork, true);
      root.removeEventListener("focusin", onWork, true);
      root.removeEventListener("wheel", interrupted);
      window.removeEventListener("resize", interrupted);
      motion?.removeEventListener("change", interrupted);
    },
  };
}
