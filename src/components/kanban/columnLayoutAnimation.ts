/** Real columns and cards resize and move through compositor transforms.
 * Source and destination reads are batched; text is counter-scaled on real nodes.
 * Short-lived layers are warmed before the width commit and released afterward.
 * No DOM is copied and intentional navigation scrolling is never rewound. */
export const COLUMN_LAYOUT_MS = 240;
export const COLUMN_LAYOUT_END = "columnlayoutend";
// A soft ease-out caps travel even when a throttled paint spans two RAFs.
const EASING = "cubic-bezier(0, 0, 0.9, 1)";
const COLUMN = ".board > .column[data-wide]";
const CONTENT_SURFACE = ".card, .col-head, .divider, .empty, .remote-unbound";
interface Shot {
  node: HTMLElement; column: HTMLElement; rect: DOMRect;
  width: string; height: string; widthAsNumber: number; visible: boolean; opacity: number;
  contents: { node: HTMLElement; opacity: number; scaleX: number; scaleY: number }[];
  glyphs?: { node: HTMLElement; rect: DOMRect }[];
  paint?: { backgroundColor: string; backgroundImage: string; borderColor: string };
}
interface Snapshot { key: string; shots: Shot[]; navigation?: boolean }
interface Pose { rect: DOMRect; next: DOMRect }
const keyOf = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(COLUMN)].map((node) => `${node.dataset.status}:${node.dataset.wide}`).join("|");
/** The same ease as the compositor, for its inverse font-size keyframes. */
function ease(t: number): number {
  let u = t;
  for (let i = 0; i < 6; i++) {
    const x = 3 * (1 - u) * u ** 2 * 0.9 + u ** 3;
    const dx = 6 * (1 - u) * u * 0.9 + 3 * u ** 2 * 0.1;
    if (dx < 0.0001) break;
    u = Math.max(0, Math.min(1, u - (x - t) / dx));
  }
  return 3 * (1 - u) * u ** 2 + u ** 3;
}
// Reuse the same curve across content effects instead of solving the cubic
// separately for every glyph layer during activation.
const CONTENT_CURVE = Array.from({ length: 13 }, (_, i) => {
  const offset = (i / 12) ** 2;
  return { offset, q: ease(offset) };
});
const widthChanges = new WeakMap<HTMLElement, (update: () => void, allowed?: () => boolean, status?: string) => void>();
/** Align source capture and the width commit with the start of a frame. */
export function changeColumnWidth(node: HTMLElement, update: () => void): void {
  const root = node.closest<HTMLElement>(".kb");
  const change = root && widthChanges.get(root);
  if (change) change(update, undefined, node.closest<HTMLElement>(".column")?.dataset.status);
  else update();
}
export function installColumnLayoutAnimation(root: HTMLElement): { prepare(): void; warm(status: string): void; cancelWarm(): void; change(update: () => void, allowed?: () => boolean, status?: string): void; dispose(): void } {
  let pending: Snapshot | null = null;
  let expiry: ReturnType<typeof setTimeout> | null = null;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  let paintFrame = 0;
  const changeFrames = new Set<number>();
  const warmFrames = new Set<number>();
  let warmPrepared = false;
  let sourceDirty = false;
  let started = 0;
  let motionDeadline = 0;
  let active: Snapshot | null = null;
  const animations = new Map<HTMLElement, Animation>();
  const marked = new Set<HTMLElement>();
  const frozen = new Map<HTMLElement, { width: string; height: string; margin: string }>();
  const frozenPaint = new Map<HTMLElement, { backgroundColor: string; backgroundImage: string; borderColor: string }>();
  const contentBase = new Map<HTMLElement, string>();
  // A neutral slot wrapper preserves React's light-DOM parents and gives
  // each surface one text layer. Its layout exists before source capture.
  const groups = new WeakMap<HTMLElement, HTMLElement>();
  const textGroups = new WeakSet<HTMLElement>();
  const groupHosts = new WeakMap<HTMLElement, HTMLElement>();
  const groupText = typeof window.CSSAnimation === "function" && typeof root.attachShadow === "function";
  const groupFor = (node: HTMLElement) => {
    if (!groupText || !node.matches(CONTENT_SURFACE)) return null;
    // Forms (including + Task) cannot host Shadow DOM. Keep their existing
    // real child layers rather than aborting the board mutation observer.
    if (!/^(article|aside|blockquote|div|footer|h[1-6]|header|main|nav|p|section|span)$/.test(node.localName) && !node.localName.includes("-")) return null;
    let group = groups.get(node) ?? node.shadowRoot?.querySelector<HTMLElement>("[data-column-text-group]");
    if (!group) {
      if (node.shadowRoot) return null;
      const shadow = node.attachShadow({ mode: "open" });
      group = document.createElement("div"); group.dataset.columnTextGroup = "";
      group.style.cssText = `display:inherit;flex-direction:inherit;flex-wrap:inherit;align-items:inherit;align-content:inherit;justify-content:inherit;gap:inherit;min-width:0;min-height:0;flex:${node.matches(".divider") ? "0 1 auto" : "1 1 auto"};transform-origin:top left`;
      group.append(document.createElement("slot"));
      const overlays = document.createElement("slot"); overlays.name = "column-layout-overlay";
      shadow.append(overlays, group);
    }
    for (const child of node.children) if (child.matches(".label, .saving") && child.getAttribute("slot") !== "column-layout-overlay") child.setAttribute("slot", "column-layout-overlay");
    groups.set(node, group); textGroups.add(group); groupHosts.set(group, node);
    return group;
  };
  const groupSurfaces = () => {
    for (const column of root.querySelectorAll<HTMLElement>(COLUMN)) column.querySelectorAll<HTMLElement>(".col-head, .col-body > .card, .col-body > .divider, .col-body > .empty, .col-body > .remote-unbound").forEach(groupFor);
  };
  groupSurfaces();
  const mark = (node: HTMLElement, role: string) => {
    if (node.dataset.layoutAnimating !== role) node.dataset.layoutAnimating = role;
    if (textGroups.has(node)) {
      if (node.style.willChange !== "transform") node.style.willChange = "transform";
      const host = groupHosts.get(node);
      if (host && !host.hasAttribute("data-column-text-held")) host.setAttribute("data-column-text-held", "");
    }
    marked.add(node);
  };
  const unmark = (node: HTMLElement) => {
    node.removeAttribute("data-layout-animating");
    if (textGroups.has(node)) {
      node.style.willChange = "";
      groupHosts.get(node)?.removeAttribute("data-column-text-held");
    }
  };
  let frozenGrid: { node: HTMLElement; template: string } | null = null;
  const thawGrid = () => {
    if (frozenGrid) frozenGrid.node.style.gridTemplateColumns = frozenGrid.template;
    frozenGrid = null;
  };

  const scrollPositions = new Map<HTMLElement, { top: number; left: number }>();
  const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const scrollContainers = () => {
    const nodes = new Set<HTMLElement>();
    for (const column of root.querySelectorAll<HTMLElement>(COLUMN)) {
      for (const node of column.querySelectorAll<HTMLElement>(".col-body, [data-log-feed-scroller]")) nodes.add(node);
      for (let node: HTMLElement | null = column.parentElement; node; node = node.parentElement) nodes.add(node);
    }
    return nodes;
  };
  const recordScroll = () => {
    for (const node of scrollContainers()) scrollPositions.set(node, { top: node.scrollTop, left: node.scrollLeft });
  };
  const thaw = (node: HTMLElement) => {
    const style = frozen.get(node);
    if (!style) return;
    node.style.width = style.width; node.style.height = style.height; node.style.marginRight = style.margin;
    frozen.delete(node);
  };
  const restorePaint = (node: HTMLElement) => {
    const paint = frozenPaint.get(node);
    if (paint) { Object.assign(node.style, paint); frozenPaint.delete(node); }
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
    finishTimer = null; motionDeadline = 0;
  };
  const clearAnimations = (keepPromotion = false) => {
    animations.forEach((animation) => animation.cancel()); animations.clear();
    if (!keepPromotion) { marked.forEach(unmark); marked.clear(); }
  };
  const finish = () => {
    warmFrames.forEach((frame) => window.cancelAnimationFrame(frame)); warmFrames.clear();
    changeFrames.forEach((frame) => window.cancelAnimationFrame(frame)); changeFrames.clear();
    warmPrepared = false;
    clearPending(); stopClock(); clearAnimations(); plans.length = 0;
    active = null;
    thawGrid(); [...frozen.keys()].forEach(thaw); contentBase.clear(); scrollPositions.clear();
    [...frozenPaint.keys()].forEach(restorePaint);
    const wasActive = root.hasAttribute("data-column-layout");
    root.removeAttribute("data-column-layout");
    root.removeAttribute("data-column-layout-active");
    if (wasActive) root.dispatchEvent(new window.Event(COLUMN_LAYOUT_END));
  };
  const settle = () => {
    // Retargeting gives every effect its own complete motion window.
    if (finishTimer) clearTimeout(finishTimer);
    finishTimer = null;
    const remaining = motionDeadline - performance.now();
    if (remaining > 0) { finishTimer = setTimeout(settle, remaining); return; }
    // Every effect has reached its final pose. Release the temporary layers
    // in bounded batches too; destroying all text layers stalled cleanup.
    stopClock();
    root.dataset.columnLayout = "settling";
    const queue = [...marked];
    const paints = [...frozenPaint.keys()];
    const release = () => {
      paintFrame = window.requestAnimationFrame(() => {
        paintFrame = 0;
        // A wide shelf's dotted background needs its own raster. Keep that
        // paint out of the frame that reflows all of its card contents.
        if (paints.length) { restorePaint(paints.shift()!); release(); return; }
        for (const node of queue.splice(0, 4)) {
          animations.get(node)?.cancel(); animations.delete(node);
          unmark(node); marked.delete(node);
        }
        if (queue.length) release();
        else finish();
      });
    };
    release();
  };
  const plans: { node: HTMLElement; frames: Keyframe[] | (() => Keyframe[]); duration: number; role: string; paused: boolean }[] = [];
  const play = (node: HTMLElement, frames: Keyframe[] | (() => Keyframe[]), duration: number, role: string, paused = false) => {
    plans.push({ node, frames, duration, role, paused });
  };
  const flush = () => {
    // Setting promotion and creating an effect alternately makes animate()
    // resolve the preceding style write on every node. Promote in one batch.
    for (const { node } of plans) animations.get(node)?.cancel();
    for (const { node, role } of plans) mark(node, role);
    for (const { node, frames, duration, role, paused } of plans) {
      const keyframes = typeof frames === "function" ? frames() : frames;
      const options: KeyframeAnimationOptions = { duration, fill: "both", easing: role === "content" ? "linear" : EASING };
      let animation: Animation;
      if (typeof window.KeyframeEffect === "function" && typeof window.Animation === "function") {
        animation = new window.Animation(new window.KeyframeEffect(node, keyframes, options), document.timeline);
        animation.currentTime = 0;
        if (!paused) animation.play();
      } else {
        animation = node.animate(keyframes, options);
        if (paused) animation.pause();
      }
      animations.set(node, animation);
    }
    plans.length = 0;
  };
  const inverse = (rect: DOMRect, next: DOMRect, parent?: Pose) => {
    const px = parent ? parent.rect.width / parent.next.width : 1;
    const py = parent ? parent.rect.height / parent.next.height : 1;
    const dx = parent ? (rect.left - parent.rect.left) / px - (next.left - parent.next.left) : rect.left - next.left;
    const dy = parent ? (rect.top - parent.rect.top) / py - (next.top - parent.next.top) : rect.top - next.top;
    return { dx, dy, sx: rect.width / next.width / px, sy: rect.height / next.height / py, px, py };
  };
  const transform = (dx: number, dy: number, sx: number, sy: number) => `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
  const contentFrames = (node: HTMLElement, sx: number, sy: number, ex: number, ey: number, px: number, py: number, parentEnd = 1, sourceX = 1, sourceY = 1, count = 13): Keyframe[] => {
    const base = contentBase.get(node) ?? "";
    return (count === 1 ? CONTENT_CURVE.slice(0, 1) : CONTENT_CURVE).map(({ offset, q }) => {
      const x = (px + (parentEnd - px) * q) * (sx + (ex - sx) * q);
      const y = (py + (1 - py) * q) * (sy + (ey - sy) * q);
      return { offset, transform: `scale(${(sourceX + (1 - sourceX) * q) / x}, ${(sourceY + (1 - sourceY) * q) / y}) ${base}`.trim() };
    });
  };
  const applyCard = (shot: Shot, next: DOMRect, parent: Pose, duration: number, rewrapped: boolean, endWidth = next.width, paused = false, parentEnd = 1) => {
    const pose = inverse(shot.rect, next, parent);
    const ex = endWidth / next.width;
    const opacity = shot.visible ? shot.opacity : 0;
    if (Math.abs(pose.dx) + Math.abs(pose.dy) + Math.abs(pose.sx - 1) + Math.abs(pose.sy - 1) + Math.abs(ex - 1) > 0.001 || opacity < 1) {
      play(shot.node, [ { transform: transform(pose.dx, pose.dy, pose.sx, pose.sy), opacity }, { transform: transform(0, 0, ex, 1), opacity: 1 } ], duration, "card", paused);
    }
    // Sibling text layers share the same inverse pose. Reuse their frame
    // definitions lazily, so activation still stays in bounded batches.
    const contentCache = new Map<string, Keyframe[]>();
    for (const content of shot.contents) {
      const { node } = content;
      const frames = (count?: number) => {
        const key = `${count ?? "full"}|${content.scaleX}|${content.scaleY}|${contentBase.get(node) ?? ""}`;
        let frames = contentCache.get(key);
        if (!frames) {
          frames = contentFrames(node, pose.sx, pose.sy, ex, 1, pose.px, pose.py, parentEnd, rewrapped ? 1 : content.scaleX, rewrapped ? 1 : content.scaleY, count);
          contentCache.set(key, frames);
        }
        return frames;
      };
      play(node, () => frames(), duration, "content", paused);
    }
  };
  const start = (snapshot: Snapshot, retargeting = active !== null) => {
    clearAnimations(true);
    plans.length = 0;
    root.dataset.columnLayout = "inverted";
    thawGrid();
    [...frozen.keys()].forEach(thaw);
    recordScroll();
    const destinations = snapshot.shots.filter(({ node }) => node.isConnected).map((shot) => ({ shot, next: shot.node.getBoundingClientRect() }));
    const widths = new Map(destinations.filter(({ shot }) => shot.node === shot.column).map(({ shot, next }) => [shot.node, next.width]));
    const targetWidth = (node: HTMLElement) => widths.get(node)!;
    const viewports = new Map([...widths.keys()].map((node) => [node, node.querySelector(".col-body")?.getBoundingClientRect()]));
    const visibleAtDestination = (shot: Shot, next: DOMRect) => {
      const viewport = viewports.get(shot.column);
      return viewport && next.bottom > Math.max(viewport.top, 0) && next.top < Math.min(viewport.bottom, window.innerHeight);
    };
    // An offscreen source can enter the viewport after the single final reflow.
    // Read its text base alongside the destination boxes, before inverse writes.
    for (const { shot, next } of destinations) if (visibleAtDestination(shot, next)) for (const content of shot.contents) if (!contentBase.has(content.node)) {
      const style = window.getComputedStyle(content.node);
      content.opacity = Number(style.opacity || "1");
      contentBase.set(content.node, style.transform === "none" ? "" : style.transform);
    }
    // A retarget can return to the same painted width while its natural
    // wrapping changes. Its cards and glyphs still need their inverse poses.
    const columns = new Map(destinations.filter(({ shot, next }) => shot.node === shot.column && (
      Math.abs(shot.rect.left - next.left) + Math.abs(shot.rect.top - next.top) + Math.abs(shot.rect.width - targetWidth(shot.node)) + Math.abs(shot.rect.height - next.height) > 0.5 ||
      retargeting && Math.abs(shot.widthAsNumber - targetWidth(shot.node)) > 0.5
    )).map(({ shot, next }) => [shot.node, next]));
    // A column that only translates carries its cards in one wrapper layer.
    // Its wrapping and glyph size are unchanged, so it needs no text effects.
    const resizing = new Map([...columns].filter(([node]) => {
      const source = snapshot.shots.find((shot) => shot.node === node)!;
      return retargeting || Math.abs(source.rect.width - targetWidth(node)) > 0.5;
    }));
    const parents = new Map(snapshot.shots.filter(({ node, column }) => node === column).map((shot) => [shot.node, { rect: shot.rect, next: columns.get(shot.node)! }]));
    // Retargeted text fields retain their leading glyph position while their
    // final wrapping changes. Read all field destinations before inverse writes.
    const glyphTargets = new Map(destinations.filter(({ shot }) => shot.glyphs?.length).map(({ shot }) => [shot.node, {
      origin: groups.get(shot.node)!.getBoundingClientRect(),
      glyphs: shot.glyphs!.map((glyph) => ({ ...glyph, next: glyphBox(glyph.node) })),
    }]));
    const duration = COLUMN_LAYOUT_MS;
    for (const { shot, next } of destinations) {
      if (!next.width || !next.height || (!shot.visible && !visibleAtDestination(shot, next))) continue;
      const parent = parents.get(shot.column);
      if (!parent?.next?.width) { thaw(shot.node); continue; }
      if (shot.node === shot.column) {
        const pose = inverse(shot.rect, next);
        play(shot.node, [{ transform: transform(pose.dx, pose.dy, pose.sx, pose.sy) }, { transform: transform(0, 0, targetWidth(shot.node) / next.width, 1) }], duration, "frame", true);
      } else if (resizing.has(shot.column)) {
        applyCard(shot, next, parent, duration, true, next.width, true);
        const targets = glyphTargets.get(shot.node);
        if (targets) for (const glyph of targets.glyphs) {
          const sx = shot.rect.width / next.width, sy = shot.rect.height / next.height;
          const dx = glyph.rect.left - (shot.rect.left + (targets.origin.left - next.left) * sx + glyph.next.left - targets.origin.left);
          const dy = glyph.rect.top - (shot.rect.top + (targets.origin.top - next.top) * sy + glyph.next.top - targets.origin.top);
          const base = contentBase.get(glyph.node) ?? "";
          play(glyph.node, CONTENT_CURVE.map(({ offset, q }) => ({ offset, transform: `translate(${dx * (1 - q)}px, ${dy * (1 - q)}px) ${base}`.trim() })), duration, "content", true);
        }
      }
    }
    active = snapshot;
    // Paint the inverse before starting the clock. Backdating to the commit's
    // timeline time skips the motion consumed by its style/layout work.
    // Prime paused effects with the inverse, so the next frame can release
    // already-ready compositor layers without another activation frame.
    flush();
    const release = (frameTime: number) => {
      paintFrame = 0;
      animations.forEach((animation) => animation.play());
      const timelineTime = document.timeline?.currentTime;
      const startTime = typeof timelineTime === "number" ? timelineTime + Math.max(0, performance.now() - frameTime) : performance.now();
      if (typeof timelineTime === "number") animations.forEach((animation) => { animation.startTime = startTime; });
      started = startTime; root.dataset.columnLayout = "running";
      motionDeadline = started + duration;
      finishTimer = setTimeout(settle, Math.max(0, motionDeadline - performance.now()));
    };
    paintFrame = window.requestAnimationFrame(release);
  };

  const glyphBox = (node: HTMLElement) => {
    const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let text: Node | null;
    while ((text = walk.nextNode())) if (text.textContent?.trim()) {
      const start = text.textContent.length - text.textContent.trimStart().length;
      const range = document.createRange();
      range.setStart(text, start); range.setEnd(text, start + text.textContent.trimStart().split(/\s/)[0]!.length);
      return range.getBoundingClientRect();
    }
    return node.getBoundingClientRect();
  };
  const capture = () => {
    const shots: Shot[] = [];
    for (const column of root.querySelectorAll<HTMLElement>(COLUMN)) {
      const viewport = column.querySelector(".col-body")?.getBoundingClientRect();
      for (const node of [column, ...column.querySelectorAll<HTMLElement>(".col-head, .col-body > .card, .col-body > .divider, .col-body > .empty, .col-body > .remote-unbound")]) {
        const rect = node.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const visible = node === column || node.matches(".col-head") || !(rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth || (viewport && (rect.bottom < viewport.top || rect.top > viewport.bottom)));
        const style = visible ? window.getComputedStyle(node) : null;
        const group = groups.get(node);
        const contents = group ? [group] : node.matches(CONTENT_SURFACE) ? [...node.children].filter((node): node is HTMLElement => node instanceof window.HTMLElement && !node.matches(".label, .saving, .spacer")) : [];
        const scale = (transform: string) => {
          const values = transform.match(/^matrix(3d)?\((.+)\)$/);
          if (!values) return { x: 1, y: 1 };
          const matrix = values[2]!.split(",").map(Number);
          return { x: matrix[0] || 1, y: matrix[values[1] ? 5 : 3] || 1 };
        };
        // Idle surfaces have no FLIP scale: their border-box rect is already
        // the used size. Resolving width/height again wakes skipped card
        // contents (content-visibility:auto) during the activation frame.
        const width = active && style ? parseFloat(style.width) || rect.width : rect.width;
        const height = active && style ? parseFloat(style.height) || rect.height : rect.height;
        const children = contents.map((node) => {
          // The neutral wrapper is ours: idle opacity/transform are known.
          // Resolving its transform can wake skipped slotted card contents.
          if (textGroups.has(node) && (!active || !contentBase.has(node))) {
            contentBase.set(node, "");
            return { node, opacity: 1, scaleX: 1, scaleY: 1 };
          }
          if (!visible) return { node, opacity: 1, scaleX: 1, scaleY: 1 };
          const current = window.getComputedStyle(node);
          const known = contentBase.has(node);
          if (!known) contentBase.set(node, current.transform === "none" ? "" : current.transform);
          if (!active || !known) return { node, opacity: Number(current.opacity || "1"), scaleX: 1, scaleY: 1 };
          const own = scale(current.transform), base = scale(contentBase.get(node)!);
          return { node, opacity: Number(current.opacity || "1"), scaleX: active ? rect.width / width * own.x / base.x : 1, scaleY: active ? rect.height / height * own.y / base.y : 1 };
        });
        const glyphs = active && visible && node.matches(".card") && group ? [...node.children].filter((child): child is HTMLElement => child instanceof window.HTMLElement && !child.matches(".label, .saving, .spacer")).map((child) => {
          if (!contentBase.has(child)) { const transform = window.getComputedStyle(child).transform; contentBase.set(child, transform === "none" ? "" : transform); }
          return { node: child, rect: glyphBox(child) };
        }) : undefined;
        shots.push({ node, column, rect, visible, glyphs, opacity: Number(style?.opacity || "1"), widthAsNumber: width, width: `${width}px`, height: `${height}px`, contents: children, paint: node === column && style ? { backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage, borderColor: style.borderColor } : undefined });
      }
    }
    return shots;
  };
  const prepare = (status?: string, navigation = false) => {
    warmPrepared = false;
    clearPending();
    if (motion?.matches || typeof root.animate !== "function") { finish(); return; }
    stopClock(); animations.forEach((animation) => animation.pause());
    const shots = capture();
    recordScroll();
    const board = root.querySelector<HTMLElement>(".board");
    const grid = board && !board.classList.contains("scroll") && !board.classList.contains("tabs") ? window.getComputedStyle(board).gridTemplateColumns : null;
    // Hold the grid through React's commit, so its mutation observer need not
    // force final layout in the same task. The next frame reads all targets.
    if (board && grid && !frozenGrid) {
      frozenGrid = { node: board, template: board.style.gridTemplateColumns };
      board.style.gridTemplateColumns = grid;
    }
    // Source rects/styles are complete before any width/height write.
    for (const shot of shots) if (shot.node === shot.column && (!status || shot.column.dataset.status === status || shot.column.dataset.wide === "1" || shot.column.dataset.status === "assigned")) {
      if (!frozen.has(shot.node)) frozen.set(shot.node, { width: shot.node.style.width, height: shot.node.style.height, margin: shot.node.style.marginRight });
      if (shot.node.style.width !== shot.width) shot.node.style.width = shot.width;
      if (shot.paint && !frozenPaint.has(shot.node)) {
        frozenPaint.set(shot.node, { backgroundColor: shot.node.style.backgroundColor, backgroundImage: shot.node.style.backgroundImage, borderColor: shot.node.style.borderColor });
        Object.assign(shot.node.style, shot.paint);
      }
    }
    pending = { key: keyOf(root), shots, navigation };
    sourceDirty = false;
    // Keep the styling marker stable while diagnostic phases change. A CSS
    // selector on that attribute invalidated descendant styles at every phase.
    if (!root.hasAttribute("data-column-layout-active")) root.setAttribute("data-column-layout-active", "");
    root.dataset.columnLayout = "pending";
    expiry = setTimeout(finish, 1000);
    paintFrame = window.requestAnimationFrame(() => {
      paintFrame = 0;
      if (!pending || pending.key !== keyOf(root)) return;
      if (active) { const snapshot = pending; clearPending(); start(snapshot); }
      else {
        // Let an asynchronous no-op control commit before releasing its claim.
        paintFrame = window.requestAnimationFrame(() => { paintFrame = 0; if (pending?.key === keyOf(root) && !active) finish(); });
      }
    });
  };
  const promotions = (shots: Shot[]) => shots.flatMap((shot) => [
    { node: shot.node, role: shot.node === shot.column ? "frame" : "card" },
    ...shot.contents.map(({ node }) => ({ node, role: "content" })),
  ]);
  const startPending = () => {
    if (!pending || pending.key === keyOf(root)) return;
    // Navigation reveals a reader during React's layout effects, before its
    // scroll event arrives. An inverse must not put it back offscreen.
    if (pending.navigation && [...scrollPositions].some(([node, position]) => node.scrollTop !== position.top || node.scrollLeft !== position.left)) {
      finish(); return;
    }
    const snapshot = pending; clearPending(); stopClock();
    const retargeting = active !== null;
    // A committed width owns its inverse, including the queued release.
    // A moving pointer may cancel warm-up, but cannot retire this motion.
    active = snapshot;
    if (retargeting) {
      paintFrame = window.requestAnimationFrame(() => { paintFrame = 0; start(snapshot); });
    } else start(snapshot, false);
  };
  const change = (update: () => void, allowed = () => true, status?: string) => {
    // A later control owns the pending width. Different card counts make
    // promotion queues finish out of order unless the earlier one is retired.
    changeFrames.forEach((frame) => window.cancelAnimationFrame(frame)); changeFrames.clear();
    // Once a control takes over, queued warm frames must not recapture the
    // committed layout or replace its inverse-release frame.
    warmFrames.forEach((frame) => window.cancelAnimationFrame(frame)); warmFrames.clear();
    onMutations(observer.takeRecords());
    const apply = () => {
      if (!allowed()) return;
      if (warmPrepared && pending && !sourceDirty) {
        // Frozen tracks keep the cards' relative layout stable, but an ancestor
        // can move the whole board without a mutation inside it. Refresh the
        // four column origins in one batch instead of waking every card again.
        const origins = new Map(pending.shots.filter(({ node, column }) => node === column).map((shot) => [shot.column, { before: shot.rect, now: shot.node.getBoundingClientRect() }]));
        for (const shot of pending.shots) {
          const origin = origins.get(shot.column)!;
          shot.rect = shot.node === shot.column ? origin.now : new window.DOMRect(shot.rect.left + origin.now.left - origin.before.left, shot.rect.top + origin.now.top - origin.before.top, shot.rect.width, shot.rect.height);
        }
        warmPrepared = false;
      } else prepare(status);
      update();
      // The synchronous width commit also replaces header controls. Their
      // slotted content is already covered by this FLIP; do not treat them
      // as an arriving card and immediately run a second destination reflow.
      onMutations(observer.takeRecords());
      if (pending && !active && !paintFrame) {
        paintFrame = window.requestAnimationFrame(() => { paintFrame = 0; if (pending?.key === keyOf(root) && !active) finish(); });
      }
    };
    if (warmPrepared || active || motion?.matches || typeof root.animate !== "function") { apply(); return; }
    const frame = window.requestAnimationFrame(() => {
      changeFrames.delete(frame);
      if (!allowed()) return;
      warmPrepared = false;
      prepare(status);
      // A button owns its promotion queue. The idle preparation watchdog
      // must not discard an authorized width change while layers are warming.
      if (expiry) clearTimeout(expiry);
      expiry = null;
      if (paintFrame) window.cancelAnimationFrame(paintFrame);
      paintFrame = 0;
      const layers = promotions(pending?.shots.filter((shot) => shot.visible && (!status || shot.column.dataset.wide === "1" || shot.column.dataset.status === status || shot.column.dataset.status === "assigned")) ?? []).filter(({ node }) => !marked.has(node));
      const commitWidth = () => {
        if (!allowed()) { finish(); return; }
        update();
        onMutations(observer.takeRecords());
        if (pending) paintFrame = window.requestAnimationFrame(() => { paintFrame = 0; if (pending && pending.key === keyOf(root)) finish(); });
      };
      const promote = () => {
        if (!allowed()) { finish(); return; }
        if (!layers.length) { commitWidth(); return; }
        for (const { node, role } of layers.splice(0, 4)) mark(node, role);
        const promotion = window.requestAnimationFrame(() => { changeFrames.delete(promotion); promote(); });
        changeFrames.add(promotion);
      };
      promote();
    });
    changeFrames.add(frame);
  };
  widthChanges.set(root, change);
  const cancelWarm = () => {
    warmFrames.forEach((frame) => window.cancelAnimationFrame(frame)); warmFrames.clear();
    if (warmPrepared || (!active && !pending)) finish();
  };
  const warm = (status: string) => {
    if (active || pending || motion?.matches || typeof root.animate !== "function") return;
    onMutations(observer.takeRecords());
    // Retain the source before promotion starts. A dwell deadline can precede
    // its last batch; recapturing then repeats layout in the activation task.
    prepare(status); warmPrepared = true;
    if (paintFrame) window.cancelAnimationFrame(paintFrame);
    paintFrame = 0;
    const shots = pending!.shots.filter((shot) => shot.visible && (shot.column.dataset.status === status || shot.column.dataset.wide === "1" || shot.column.dataset.status === "assigned"));
    const layers = promotions(shots);
    if (!layers.length) { finish(); return; }
    root.dataset.columnLayout = "warming";
    const next = () => {
      const frame = window.requestAnimationFrame(() => {
        warmFrames.delete(frame);
        for (const { node, role } of layers.splice(0, 4)) mark(node, role);
        if (layers.length) next();
        else root.dataset.columnLayout = "pending";
      });
      warmFrames.add(frame);
    };
    next();
  };
  function onMutations(records: MutationRecord[]) {
    if (warmPrepared && records.some((record) => {
      const target = record.target instanceof window.Element ? record.target : record.target.parentElement;
      return record.attributeName !== "data-wide" && (!!target?.closest(CONTENT_SURFACE) || !!target?.matches(".col-body"));
    })) sourceDirty = true;
    // Width buttons replace their icons and pin control at commit. Revisit
    // only those hosts; scanning every card here consumed the paint budget.
    const changedHosts = new Set<HTMLElement>();
    for (const record of records) if (record.type === "childList") {
      const host = record.target instanceof window.Element ? record.target.closest<HTMLElement>(CONTENT_SURFACE) : null;
      if (host) changedHosts.add(host);
      for (const node of record.addedNodes) if (node instanceof window.HTMLElement) {
        if (node.matches(CONTENT_SURFACE)) changedHosts.add(node);
        node.querySelectorAll<HTMLElement>(CONTENT_SURFACE).forEach((host) => changedHosts.add(host));
      }
    }
    changedHosts.forEach(groupFor);
    // New real cards or direct content layers must join the FLIP before
    // paint. Retarget from the current boxes so their text never inherits
    // an untreated wrapper scale or reflows in plain sight.
    const newSurfaces = records.some((record) => record.type === "childList" && record.target instanceof window.Element && (
      record.target.matches(".col-body") && [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof window.Element && node.matches(CONTENT_SURFACE)) ||
      record.target.matches(CONTENT_SURFACE) && [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof window.HTMLElement)
    ));
    if (active && newSurfaces && !pending) {
      prepare();
      const snapshot = pending as Snapshot | null;
      clearPending();
      if (snapshot) start(snapshot);
      return;
    }
    startPending();
  }
  const observer = new window.MutationObserver(onMutations);
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["data-wide", "class", "style"] });
  const onClick = (event: Event) => {
    const target = event.target as Element | null;
    if (target?.closest?.("[data-open-agent-jump]")) prepare(undefined, true);
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
    prepare(undefined, true);
  };
  root.addEventListener("click", onClick, true);
  root.addEventListener("pointerdown", onWork, true);
  root.addEventListener("focusin", onWork, true);
  document.addEventListener("keydown", onKey, true);
  /* A scroll interaction reveals the current layout immediately. Restoration
     events from our own width change leave the transition alone. */
  const interrupted = () => { clearPending(); finish(); };
  const onScroll = (event: Event) => {
    const target = event.target;
    const node = target === document ? document.scrollingElement as HTMLElement | null : target as HTMLElement | null;
    if (!node || (!scrollContainers().has(node) && !(root.contains(node) && node.closest('[data-layout-animating]')))) return;
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
    warm,
    cancelWarm,
    change,
    dispose() {
      warmFrames.forEach((frame) => window.cancelAnimationFrame(frame)); warmFrames.clear();
      changeFrames.forEach((frame) => window.cancelAnimationFrame(frame)); changeFrames.clear();
      widthChanges.delete(root);
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
