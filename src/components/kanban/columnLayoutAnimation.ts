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
  layers?: { node: HTMLElement; first: Keyframe; left: number; top: number; width: number; height: number }[];
}
interface Snapshot {
  key: string;
  shots: Shot[];
  scroll: { node: HTMLElement; top: number; left: number }[];
  copyScroll: { node: HTMLElement; top: number; left: number }[];
}

const keyOf = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(COLUMN)].map((node) => `${node.dataset.status}:${node.dataset.wide}`).join("|");

interface ScrollOffset { index: number; top: number; left: number }
function readScrollOffsets(node: HTMLElement): ScrollOffset[] {
  return [node, ...node.querySelectorAll<HTMLElement>("*")].flatMap((element, index) => {
    const top = element.scrollTop ?? 0;
    const left = element.scrollLeft ?? 0;
    return top || left ? [{ index, top, left }] : [];
  });
}

function cloneWithScroll(node: HTMLElement, deep: boolean, scroll: Snapshot["copyScroll"], sourceScroll?: Snapshot["scroll"], offsets = deep ? readScrollOffsets(node) : []): HTMLElement {
  const copy = node.cloneNode(deep) as HTMLElement;
  if (offsets.length) {
    const originals = sourceScroll ? [node, ...node.querySelectorAll<HTMLElement>("*")] : [];
    const clones = [copy, ...copy.querySelectorAll<HTMLElement>("*")];
    offsets.forEach(({ index, top, left }) => {
      scroll.push({ node: clones[index]!, top, left });
      sourceScroll?.push({ node: originals[index]!, top, left });
    });
  }
  return copy;
}

export function installColumnLayoutAnimation(root: HTMLElement): { prepare(): void; dispose(): void } {
  let pending: Snapshot | null = null;
  let expiry: ReturnType<typeof setTimeout> | null = null;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  let animations: Animation[] = [];
  let paintFrame = 0;
  let copies: HTMLElement[] = [];
  let marked: HTMLElement[] = [];
  const layers = new Map<HTMLElement, HTMLElement[]>();
  const scrollPositions = new Map<HTMLElement, { top: number; left: number }>();
  const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const scrollContainers = () => {
    const nodes = new Set<HTMLElement>();
    for (const column of root.querySelectorAll<HTMLElement>(COLUMN)) {
      const body = column.querySelector<HTMLElement>(".col-body");
      if (body) nodes.add(body);
      // Both internal wrappers and ancestors outside the board move its pixels.
      for (let node: HTMLElement | null = column.parentElement; node; node = node.parentElement) nodes.add(node);
    }
    return nodes;
  };

  const clearPending = () => {
    pending = null;
    if (expiry) clearTimeout(expiry);
    expiry = null;
  };
  const stopClock = () => {
    if (paintFrame) window.cancelAnimationFrame(paintFrame);
    paintFrame = 0;
    if (finishTimer) clearTimeout(finishTimer);
    finishTimer = null;
  };
  const finish = (retained = new Set<HTMLElement>()) => {
    stopClock();
    animations.forEach((animation) => animation.cancel());
    copies.forEach((copy) => { if (!retained.has(copy)) copy.remove(); });
    marked.forEach((node) => node.removeAttribute("data-layout-animating"));
    animations = []; copies = []; marked = [];
    layers.clear();
    scrollPositions.clear();
  };
  const prepare = () => {
    clearPending();
    if (motion?.matches || typeof root.animate !== "function") { finish(); return; }
    stopClock();
    animations.forEach((animation) => animation.pause());
    const shots: Shot[] = [];
    const copyScroll: Snapshot["copyScroll"] = [];
    const contentScroll: Snapshot["scroll"] = [];
    const columns = [...root.querySelectorAll<HTMLElement>(COLUMN)];
    /* Read all geometry before any writes. Skip offscreen cards; their
       content-visibility remains intact on a busy board. */
    for (const column of columns) {
      const body = column.querySelector<HTMLElement>(".col-body");
      let viewport = body?.getBoundingClientRect();
      const visibleFrame = layers.get(column)?.find((copy) => copy.matches(".kb-layout-frame"));
      if (viewport && visibleFrame) {
        const visible = visibleFrame.getBoundingClientRect();
        const layout = column.getBoundingClientRect();
        // The scroll box follows the painted frame, including on retarget.
        viewport = new window.DOMRect(visible.left + viewport.left - layout.left, visible.top + viewport.top - layout.top, Math.max(0, visible.width - layout.width + viewport.width), Math.max(0, visible.height - layout.height + viewport.height));
      }
      for (const node of [column, ...column.querySelectorAll<HTMLElement>(".col-head, .col-body > .card, .col-body > .divider, .col-body > .empty")]) {
        const frame = node === column;
        const previous = layers.get(node);
        const surface = previous?.find((copy) => copy.matches(".kb-layout-frame, .kb-layout-shell"));
        const rect = (surface ?? node).getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        if (previous?.length) {
          for (const element of [node, ...node.querySelectorAll<HTMLElement>("*")]) {
            const top = element.scrollTop ?? 0;
            const left = element.scrollLeft ?? 0;
            if (top || left) contentScroll.push({ node: element, top, left });
          }
          // Moving retained layers through a fragment can reset their feeds too.
          for (const layer of previous) for (const element of [layer, ...layer.querySelectorAll<HTMLElement>("*")]) {
            const top = element.scrollTop ?? 0;
            const left = element.scrollLeft ?? 0;
            if (top || left) copyScroll.push({ node: element, top, left });
          }
          shots.push({ node, rect, copy: null, frame, viewport, layers: previous.map((copy) => {
            const style = window.getComputedStyle(copy);
            return { node: copy, first: { transform: style.transform, opacity: style.opacity, clipPath: style.clipPath }, left: parseFloat(copy.style.left), top: parseFloat(copy.style.top), width: parseFloat(copy.style.width), height: parseFloat(copy.style.height) };
          }) });
          continue;
        }
        if (rect.right < 0 || rect.left > window.innerWidth || rect.bottom < 0 || rect.top > window.innerHeight || (!frame && !node.matches(".col-head") && viewport && (rect.bottom < viewport.top || rect.top > viewport.bottom))) {
          shots.push({ node, rect, copy: null, frame, viewport });
          continue;
        }
        const copy = cloneWithScroll(node, !frame, copyScroll, contentScroll);
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
    const scroll = [...[...scrollContainers()].map((node) => ({ node, top: node.scrollTop, left: node.scrollLeft })), ...contentScroll];
    const key = keyOf(root);
    pending = { key, shots, scroll, copyScroll };
    expiry = setTimeout(() => { clearPending(); finish(); }, 1000);
    if (animations.length) {
      /* A width/jump control may leave the layout unchanged. Release the
         captured pose before its next paint instead of freezing that motion. */
      paintFrame = window.requestAnimationFrame(() => {
        paintFrame = 0;
        if (!pending || pending.key !== keyOf(root)) return;
        clearPending();
        const remaining = Math.max(0, ...animations.map((animation) => COLUMN_LAYOUT_MS - Number(animation.currentTime ?? 0)));
        animations.forEach((animation) => animation.play());
        finishTimer = setTimeout(() => finish(), remaining);
      });
    }
  };
  const observer = new window.MutationObserver(() => {
    if (!pending || pending.key === keyOf(root)) return;
    const snapshot = pending;
    clearPending();
    if (motion?.matches) return finish();
    /* Keep every currently painted text/surface layer at its exact pose while
       the next layout is measured. Rebuilding from the live DOM here would
       expose its already-completed wrapping and width. */
    const retained = new Set<HTMLElement>();
    for (const shot of snapshot.shots) for (const layer of shot.layers ?? []) {
      Object.assign(layer.node.style, layer.first);
      retained.add(layer.node);
    }
    finish(retained);
    copies = [...retained];
    /* Anchoring must not move a neighbouring card when its wrapping changes. */
    for (const { node, top, left } of snapshot.scroll) { node.scrollTop = top; node.scrollLeft = left; }
    /* Restoration scroll events arrive asynchronously. Remember the actual
       (possibly clamped) positions, so only a subsequent movement interrupts. */
    for (const node of new Set([...scrollContainers(), ...snapshot.scroll.map(({ node }) => node)])) scrollPositions.set(node, { top: node.scrollTop, left: node.scrollLeft });
    const destinations = snapshot.shots.filter(({ node }) => node.isConnected).map((shot) => {
      const style = shot.frame ? window.getComputedStyle(shot.node) : null;
      return { ...shot, next: shot.node.getBoundingClientRect(), nextViewport: shot.node.closest(".col-body")?.getBoundingClientRect(), background: style?.background ?? "", border: style?.border ?? "", borderRadius: style?.borderRadius ?? "", scrollOffsets: shot.frame ? [] : readScrollOffsets(shot.node) };
    });
    const timing = { duration: COLUMN_LAYOUT_MS, easing: EASING, fill: "both" as const };
    const page = root.querySelector<HTMLElement>(".kb-page");
    if (page) { page.dataset.layoutAnimating = "page"; marked.push(page); }
    const fragment = document.createDocumentFragment();
    const plans: { node: HTMLElement; frames: Keyframe[] }[] = [];
    for (const { node, rect, next, copy, frame, viewport, nextViewport, background, border, borderRadius, scrollOffsets, layers: previous } of destinations) {
      if (!next.width || !next.height) continue;
      if (!copy && !previous && (next.right < 0 || next.left > window.innerWidth || next.bottom < 0 || next.top > window.innerHeight)) continue;
      const dx = rect.left - next.left;
      const dy = rect.top - next.top;
      const sx = rect.width / next.width;
      const sy = rect.height / next.height;
      if (!previous && Math.abs(dx) + Math.abs(dy) + Math.abs(rect.width - next.width) + Math.abs(rect.height - next.height) < 0.5) continue;
      node.setAttribute("data-layout-animating", frame ? "frame" : "card");
      marked.push(node);
      const clip = (box: DOMRect, view: DOMRect | undefined, width: number, height: number, x = 1, y = 1) => `inset(${Math.max(0, (view?.top ?? box.top) - box.top) / y}px ${Math.max(0, width - box.width, box.left + width - (view?.right ?? box.left + width)) / x}px ${Math.max(0, height - box.height, box.top + height - (view?.bottom ?? box.top + height)) / y}px ${Math.max(0, (view?.left ?? box.left) - box.left) / x}px)`;
      const addCopy = (copy: HTMLElement) => {
        fragment.append(copy);
        if (!retained.has(copy)) copies.push(copy);
        layers.set(node, [...(layers.get(node) ?? []), copy]);
      };
      for (const layer of previous ?? []) {
        const surface = layer.node.matches(".kb-layout-frame, .kb-layout-shell");
        const shell = layer.node.matches(".kb-layout-shell");
        addCopy(layer.node);
        plans.push({ node: layer.node, frames: [layer.first, {
          transform: `translate(${next.left - layer.left}px, ${next.top - layer.top}px)${surface ? ` scale(${next.width / layer.width}, ${next.height / layer.height})` : ""}`,
          opacity: shell ? layer.first.opacity : 0,
          clipPath: frame ? layer.first.clipPath : clip(next, nextViewport, surface ? next.width : layer.width, surface ? next.height : layer.height, surface ? next.width / layer.width : 1, surface ? next.height / layer.height : 1),
        }] });
      }
      if (copy) {
        if (!frame && !node.matches(".col-head")) {
          /* Stretch only the card's surface. Text keeps its natural font size
             and its captured wrapping while the two layouts crossfade. */
          const shell = copy.cloneNode(false) as HTMLElement;
          shell.classList.add("kb-layout-shell");
          addCopy(shell);
          plans.push({ node: shell, frames: [
            { transform: "none", clipPath: clip(rect, viewport, rect.width, rect.height) },
            { transform: `translate(${-dx}px, ${-dy}px) scale(${1 / sx}, ${1 / sy})`, clipPath: clip(next, nextViewport, next.width, next.height, 1 / sx, 1 / sy) },
          ] });
          Object.assign(copy.style, { background: "transparent", borderColor: "transparent", boxShadow: "none" });
        }
        addCopy(copy);
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
        Object.assign(destination.style, { left: `${next.left}px`, top: `${next.top}px`, width: `${next.width}px`, height: `${next.height}px`, background, border, borderRadius });
        addCopy(destination);
        plans.push({ node: destination, frames: [
          { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0 },
          { transform: "none", opacity: 1 },
        ] });
      } else {
        /* A destination snapshot stays outside the list's final clipping
           edge while it moves. The real card keeps its semantics and its
           FLIP geometry, underneath these two inert, opaque card surfaces. */
        if (!node.matches(".col-head")) {
          const destination = cloneWithScroll(node, true, snapshot.copyScroll, undefined, scrollOffsets);
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
          if (copy || previous) Object.assign(destination.style, { background: "transparent", borderColor: "transparent", boxShadow: "none" });
          addCopy(destination);
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
    /* Detached clones have no scroll range yet. Restore nested reader/feed
       offsets only after both wrapping snapshots have their real viewport. */
    for (const { node, top, left } of snapshot.copyScroll) { node.scrollTop = top; node.scrollLeft = left; }
    animations = plans.map(({ node, frames }) => node.animate(frames, timing));
    animations.forEach((animation) => animation.pause());
    /* Finish the one-time wrapping and rasterization before the animation
       clock starts. Its first painted frame is the captured old layout. */
    paintFrame = window.requestAnimationFrame(() => {
      paintFrame = window.requestAnimationFrame(() => {
        paintFrame = 0;
        animations.forEach((animation) => animation.play());
        finishTimer = setTimeout(() => finish(), COLUMN_LAYOUT_MS);
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
  const onKey = (event: KeyboardEvent) => {
    // Match the open-agent shortcuts before the board's document handler widens.
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) return;
    if (event.code !== "KeyJ" && event.code !== "KeyK") return;
    if (!root.isConnected || root.closest("[hidden], [inert]")) return;
    prepare();
  };
  root.addEventListener("click", onClick, true);
  root.addEventListener("pointerdown", onWork, true);
  root.addEventListener("focusin", onWork, true);
  document.addEventListener("keydown", onKey, true);
  /* Scrolling during motion follows the operator immediately; viewport-fixed
     snapshots must never linger over a list they have just scrolled. */
  const interrupted = () => { clearPending(); finish(); };
  const onScroll = (event: Event) => {
    const target = event.target;
    const node = target === document ? document.scrollingElement as HTMLElement | null : target as HTMLElement | null;
    if (!node || (!scrollContainers().has(node) && !(root.contains(node) && node.closest('[data-layout-animating="card"]')))) return;
    const position = scrollPositions.get(node);
    if (position && position.top === node.scrollTop && position.left === node.scrollLeft) return;
    interrupted();
  };
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
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
      document.removeEventListener("keydown", onKey, true);
      root.removeEventListener("wheel", interrupted);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", interrupted);
      motion?.removeEventListener("change", interrupted);
    },
  };
}
