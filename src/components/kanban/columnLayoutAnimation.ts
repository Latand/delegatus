/** The real card keeps its old wrapping until its text has faded. Width and
 * position use compositor transforms; wrapping is staged one column per frame
 * while text is invisible. Counter-scales keep the glyphs at their own size.
 * No DOM is copied and intentional navigation scrolling is never rewound. */
export const COLUMN_LAYOUT_MS = 240;
export const COLUMN_LAYOUT_END = "columnlayoutend";
const EASING = "cubic-bezier(0.16, 1, 0.3, 1)";
const COLUMN = ".board > .column[data-wide]";
const FADE_MS = 80;
interface Shot {
  node: HTMLElement; column: HTMLElement; rect: DOMRect;
  width: string; height: string; widthAsNumber: number; visible: boolean; opacity: number;
  contents: { node: HTMLElement; opacity: number; scaleX: number; scaleY: number }[];
}
interface Snapshot { key: string; shots: Shot[] }
interface Pose { rect: DOMRect; next: DOMRect }
const keyOf = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(COLUMN)].map((node) => `${node.dataset.status}:${node.dataset.wide}`).join("|");
const box = (left: number, top: number, width: number, height: number) => new window.DOMRect(left, top, width, height);
/** The same ease as the compositor, for its inverse font-size keyframes. */
function ease(t: number): number {
  let u = t;
  for (let i = 0; i < 6; i++) {
    const x = 3 * (1 - u) ** 2 * u * 0.16 + 3 * (1 - u) * u ** 2 * 0.3 + u ** 3;
    const dx = 3 * (1 - u) ** 2 * 0.16 + 6 * (1 - u) * u * (0.3 - 0.16) + 3 * u ** 2 * 0.7;
    if (dx < 0.0001) break;
    u = Math.max(0, Math.min(1, u - (x - t) / dx));
  }
  return 1 - (1 - u) ** 3;
}
// Reuse the same curve across content effects instead of solving the cubic
// separately for every glyph layer during activation.
const CONTENT_CURVE = Array.from({ length: 17 }, (_, i) => {
  const offset = (i / 16) ** 2;
  return { offset, q: ease(offset), reveal: ease(Math.min(1, offset * 2)), fade: 1 - ease(Math.min(1, offset * COLUMN_LAYOUT_MS / FADE_MS)) };
});
export function installColumnLayoutAnimation(root: HTMLElement): { prepare(): void; dispose(): void } {
  let pending: Snapshot | null = null;
  let expiry: ReturnType<typeof setTimeout> | null = null;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  let wrapTimer: ReturnType<typeof setTimeout> | null = null;
  let paintFrame = 0;
  let started = 0;
  let active: Snapshot | null = null;
  let promoting: Snapshot | null = null;
  let released = false;
  const projected = new Map<HTMLElement, (q: number) => DOMRect>();
  const wrapped = new Set<HTMLElement>();
  const invalidated = new Set<HTMLElement>();
  const animations = new Map<HTMLElement, Animation>();
  const paintAnimations = new Set<Animation>();
  let activeColumns: HTMLElement[] = [];
  const marked = new Set<HTMLElement>();
  const inlinePose = new Map<HTMLElement, { transform: string; opacity: string; origin: string }>();
  const frozen = new Map<HTMLElement, { width: string; height: string; margin: string }>();
  const contentBase = new Map<HTMLElement, string>();
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
  const clearPending = () => {
    pending = null;
    if (expiry) clearTimeout(expiry);
    expiry = null;
  };
  const stopClock = () => {
    if (paintFrame) window.cancelAnimationFrame(paintFrame);
    paintFrame = 0;
    if (finishTimer) clearTimeout(finishTimer);
    if (wrapTimer) clearTimeout(wrapTimer);
    finishTimer = wrapTimer = null;
  };
  const clearAnimations = (keepPromotion = false) => {
    animations.forEach((animation) => animation.cancel()); animations.clear();
    if (!keepPromotion) { marked.forEach((node) => node.removeAttribute("data-layout-animating")); marked.clear(); }
  };
  const restoreInline = () => {
    inlinePose.forEach((style, node) => { node.style.transform = style.transform; node.style.opacity = style.opacity; node.style.transformOrigin = style.origin; }); inlinePose.clear();
  };
  const finish = () => {
    clearPending(); stopClock(); clearAnimations(); plans.length = 0;
    restoreInline();
    active = promoting = null; activeColumns = []; released = false; projected.clear(); wrapped.clear(); invalidated.clear();
    if (!motion?.matches) paintAnimations.forEach((animation) => animation.play());
    paintAnimations.clear();
    thawGrid(); [...frozen.keys()].forEach(thaw); contentBase.clear(); scrollPositions.clear();
    const wasActive = root.hasAttribute("data-column-layout");
    root.removeAttribute("data-column-layout");
    if (wasActive) root.dispatchEvent(new window.Event(COLUMN_LAYOUT_END));
  };
  const settle = () => {
    // Every effect has reached its final pose. Release the temporary layers
    // in bounded batches too; destroying all text layers stalled cleanup.
    stopClock();
    root.dataset.columnLayout = "settling";
    const queue = [...marked];
    const resumes = [...paintAnimations];
    const release = () => {
      paintFrame = window.requestAnimationFrame(() => {
        paintFrame = 0;
        for (const node of queue.splice(0, 8)) {
          animations.get(node)?.cancel(); animations.delete(node);
          node.removeAttribute("data-layout-animating"); marked.delete(node);
        }
        for (const animation of resumes.splice(0, 8)) {
          if (!motion?.matches) animation.play();
          paintAnimations.delete(animation);
        }
        if (queue.length || resumes.length) release();
        else finish();
      });
    };
    release();
  };
  const plans: { node: HTMLElement; frames: Keyframe[] | (() => Keyframe[]); first: Keyframe; duration: number; role: string; paused: boolean }[] = [];
  const play = (node: HTMLElement, frames: Keyframe[] | (() => Keyframe[]), duration: number, role: string, paused = false, first?: Keyframe) => {
    plans.push({ node, frames, first: first ?? (frames as Keyframe[])[0]!, duration, role, paused });
  };
  const flush = () => {
    // Setting promotion and creating an effect alternately makes animate()
    // resolve the preceding style write on every node. Promote in one batch.
    for (const { node } of plans) animations.get(node)?.cancel();
    for (const { node, role } of plans) { if (node.dataset.layoutAnimating !== role) node.dataset.layoutAnimating = role; marked.add(node); }
    for (const { node, frames, duration, role, paused } of plans) {
      const animation = node.animate(typeof frames === "function" ? frames() : frames, { duration, fill: "both", easing: role === "content" ? "linear" : EASING });
      if (paused) animation.pause();
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
  const contentFrames = (node: HTMLElement, startOpacity: number, sx: number, sy: number, ex: number, ey: number, px: number, py: number, reveal: boolean, parentEnd = 1, sourceX = 1, sourceY = 1, count = 17): Keyframe[] => {
    const base = contentBase.get(node) ?? "";
    return (count === 1 ? CONTENT_CURVE.slice(0, 1) : CONTENT_CURVE).map(({ offset, q, reveal: shown, fade }) => {
      const x = (px + (parentEnd - px) * q) * (sx + (ex - sx) * q);
      const y = (py + (1 - py) * q) * (sy + (ey - sy) * q);
      const opacity = reveal ? shown : startOpacity * fade;
      return { offset, transform: `scale(${(sourceX + (1 - sourceX) * q) / x}, ${(sourceY + (1 - sourceY) * q) / y}) ${base}`.trim(), opacity };
    });
  };
  const applyCard = (shot: Shot, next: DOMRect, parent: Pose, duration: number, reveal: boolean, endWidth = next.width, paused = false, parentEnd = 1) => {
    const pose = inverse(shot.rect, next, parent);
    const ex = endWidth / next.width;
    const opacity = shot.visible ? shot.opacity : 0;
    if (Math.abs(pose.dx) + Math.abs(pose.dy) + Math.abs(pose.sx - 1) + Math.abs(pose.sy - 1) + Math.abs(ex - 1) > 0.001 || opacity < 1) {
      play(shot.node, [ { transform: transform(pose.dx, pose.dy, pose.sx, pose.sy), opacity }, { transform: transform(0, 0, ex, 1), opacity: 1 } ], duration, "card", paused);
    }
    for (const content of shot.contents) {
      const { node } = content;
      const frames = (count?: number) => contentFrames(node, content.opacity, pose.sx, pose.sy, ex, 1, pose.px, pose.py, reveal, parentEnd, reveal ? 1 : content.scaleX, reveal ? 1 : content.scaleY, count);
      play(node, () => frames(), duration, "content", paused, frames(1)[0]);
    }
  };
  const wrapColumns = (snapshot: Snapshot, columns: Map<HTMLElement, DOMRect>) => {
    const queue = [...columns.keys()];
    const nextColumn = () => {
      const column = queue.shift();
      if (!column || !active) return;
      paintFrame = window.requestAnimationFrame(() => {
        paintFrame = 0;
        if (!column.isConnected) { nextColumn(); return; }
        const q = ease(Math.min(1, Number(animations.get(column)?.currentTime ?? 0) / COLUMN_LAYOUT_MS));
        const sourceRect = (node: HTMLElement) => !wrapped.has(column) && !invalidated.has(column) && projected.has(node) ? projected.get(node)!(q) : node.getBoundingClientRect();
        const columnRect = sourceRect(column);
        const shots = snapshot.shots.filter((shot) => shot.column === column && shot.node !== column && shot.node.isConnected);
        // The source is the cached FLIP geometry sampled at compositor time.
        // Reading live transformed overflow here forced a second board layout.
        const sources = shots.map((shot) => ({ ...shot, rect: sourceRect(shot.node) }));
        const scroll = [...scrollContainers()].map((node) => ({ node, top: node.scrollTop, left: node.scrollLeft }));
        wrapped.add(column);
        animations.get(column)?.cancel();
        thaw(column);
        for (const shot of shots) {
          animations.get(shot.node)?.cancel();
          for (const { node } of shot.contents) animations.get(node)?.cancel();
          thaw(shot.node);
        }
        // This preserves the viewport just observed, including navigation.
        for (const { node, top, left } of scroll) { node.scrollTop = top; node.scrollLeft = left; }
        recordScroll();
        const finalColumn = column.getBoundingClientRect();
        const viewport = column.querySelector(".col-body")?.getBoundingClientRect();
        const destinations = sources.map((shot) => {
          const visible = shot.node.getBoundingClientRect();
          return { shot, next: box(visible.left, visible.top, visible.width, visible.height) };
        }).filter(({ shot, next }) => shot.visible || (viewport && next.bottom > Math.max(viewport.top, 0) && next.top < Math.min(viewport.bottom, window.innerHeight)));
        // Entering cards were clipped at capture, so their natural text styles
        // have not needed promotion yet. Read their base before any inverse transform write.
        for (const { shot } of destinations) for (const content of shot.contents) if (!contentBase.has(content.node)) {
          const style = window.getComputedStyle(content.node);
          content.opacity = Number(style.opacity || "1");
          contentBase.set(content.node, style.transform === "none" ? "" : style.transform);
        }
        const duration = Math.max(1, COLUMN_LAYOUT_MS - (performance.now() - started));
        const parent = { rect: columnRect, next: finalColumn };
        const pose = inverse(columnRect, finalColumn);
        play(column, [{ transform: transform(pose.dx, pose.dy, pose.sx, pose.sy) }, { transform: "none" }], duration, "frame");
        for (const { shot, next } of destinations) applyCard(shot, next, parent, duration, true);
        // Hold the read source pose for this paint. Constructing every effect
        // in the same frame as wrapping made the frame miss its CPU budget.
        const batch = plans.splice(0);
        for (const { node, first, role } of batch) {
          if (node.dataset.layoutAnimating !== role) node.dataset.layoutAnimating = role;
          marked.add(node);
          if (!inlinePose.has(node)) inlinePose.set(node, { transform: node.style.transform, opacity: node.style.opacity, origin: node.style.transformOrigin });
          node.style.transformOrigin = "top left";
          node.style.transform = String(first.transform);
          if (first.opacity !== undefined) node.style.opacity = String(first.opacity);
        }
        paintFrame = window.requestAnimationFrame(() => {
          paintFrame = 0;
          const remaining = Math.max(1, COLUMN_LAYOUT_MS - (performance.now() - started));
          batch.forEach((plan) => { plan.duration = remaining; });
          plans.push(...batch); flush(); restoreInline();
          nextColumn();
        });
      });
    };
    nextColumn();
  };
  const start = (snapshot: Snapshot) => {
    // Updates painted during promotion become the source pose, before the
    // first transform write; frozen widths still preserve source wrapping.
    if (promoting === snapshot && invalidated.size) {
      const fresh = capture();
      snapshot = { ...snapshot, shots: [...snapshot.shots.filter((shot) => !invalidated.has(shot.column)), ...fresh.filter((shot) => invalidated.has(shot.column))] };
    }
    promoting = null;
    const retargeting = active !== null;
    clearAnimations(true); restoreInline();
    root.dataset.columnLayout = "inverted";
    thawGrid();
    recordScroll();
    let destinations = snapshot.shots.filter(({ node }) => node.isConnected).map((shot) => ({ shot, next: shot.node.getBoundingClientRect() }));
    const board = root.querySelector<HTMLElement>(".board")!;
    const tracks = window.getComputedStyle(board).gridTemplateColumns.split(" ").map(Number.parseFloat);
    const flexWidths = new Map<HTMLElement, number>();
    if (board.classList.contains("scroll")) {
      // A frozen width holds wrapping; margins reserve the final flex slots,
      // so thawing one column cannot move its neighbours during their FLIP.
      const slots = destinations.filter(({ shot }) => shot.node === shot.column).map(({ shot, next }) => {
        const style = window.getComputedStyle(shot.node);
        const width = parseFloat(style.getPropertyValue("--kb-column-width")) || next.width;
        flexWidths.set(shot.node, width);
        return { node: shot.node, margin: width - next.width + (parseFloat(frozen.get(shot.node)?.margin || "0") || 0) };
      });
      for (const { node, margin } of slots) node.style.marginRight = `${margin}px`;
      destinations = destinations.map(({ shot }) => ({ shot, next: shot.node.getBoundingClientRect() }));
    }
    const order = ["inbox", "assigned", "blocked", "done"];
    const targetWidth = (node: HTMLElement) => flexWidths.get(node) || tracks[order.indexOf(node.dataset.status!)] || node.getBoundingClientRect().width;
    const columns = new Map(destinations.filter(({ shot, next }) => shot.node === shot.column && Math.abs(shot.rect.left - next.left) + Math.abs(shot.rect.top - next.top) + Math.abs(shot.rect.width - targetWidth(shot.node)) + Math.abs(shot.rect.height - next.height) > 0.5).map(({ shot, next }) => [shot.node, next]));
    // A column that only translates carries its cards in one wrapper layer.
    // Its wrapping and glyph size are unchanged, so it needs no text effects.
    const resizing = new Map([...columns].filter(([node]) => {
      const source = snapshot.shots.find((shot) => shot.node === node)!;
      return retargeting || Math.abs(source.rect.width - targetWidth(node)) > 0.5;
    }));
    const parents = new Map(snapshot.shots.filter(({ node, column }) => node === column).map((shot) => [shot.node, { rect: shot.rect, next: columns.get(shot.node)! }]));
    projected.clear(); wrapped.clear(); invalidated.clear();
    for (const { shot, next } of destinations) if (shot.node === shot.column && columns.has(shot.node)) {
      const pose = inverse(shot.rect, next);
      const end = targetWidth(shot.node) / next.width;
      projected.set(shot.node, (q) => box(next.left + pose.dx * (1 - q), next.top + pose.dy * (1 - q), next.width * (pose.sx + (end - pose.sx) * q), next.height * (pose.sy + (1 - pose.sy) * q)));
    }
    for (const { shot, next } of destinations) if (shot.node !== shot.column) {
      const parent = parents.get(shot.column);
      const project = projected.get(shot.column);
      if (!parent?.next || !project) continue;
      const pose = shot.visible && resizing.has(shot.column) ? inverse(shot.rect, next, parent) : { dx: 0, dy: 0, sx: 1, sy: 1 };
      projected.set(shot.node, (q) => {
        const frame = project(q), px = frame.width / parent.next.width, py = frame.height / parent.next.height;
        return box(frame.left + (next.left - parent.next.left + pose.dx * (1 - q)) * px, frame.top + (next.top - parent.next.top + pose.dy * (1 - q)) * py, next.width * px * (pose.sx + (1 - pose.sx) * q), next.height * py * (pose.sy + (1 - pose.sy) * q));
      });
    }
    for (const { shot, next } of destinations) {
      if (!next.width || !next.height || !shot.visible) continue;
      const parent = parents.get(shot.column);
      if (!parent?.next?.width) { thaw(shot.node); continue; }
      if (shot.node === shot.column) {
        const pose = inverse(shot.rect, next);
        play(shot.node, [{ transform: transform(pose.dx, pose.dy, pose.sx, pose.sy) }, { transform: transform(0, 0, targetWidth(shot.node) / next.width, 1) }], COLUMN_LAYOUT_MS, "frame", true);
      } else if (resizing.has(shot.column)) {
        applyCard(shot, next, parent, COLUMN_LAYOUT_MS, false, next.width, true, targetWidth(shot.column) / parent.next.width);
      }
    }
    const initial = plans.splice(0);
    for (const { node, first, role } of initial) {
      if (role !== "content") { node.dataset.layoutAnimating = role; marked.add(node); }
      // Before the first release, the frozen column already preserves the
      // natural text pose. Identity transforms would create every text layer
      // together instead of letting the promotion batches prepare them.
      if (role === "content" && !retargeting) continue;
      if (!inlinePose.has(node)) inlinePose.set(node, { transform: node.style.transform, opacity: node.style.opacity, origin: node.style.transformOrigin });
      node.style.transformOrigin = "top left";
      node.style.transform = String(first.transform);
      if (first.opacity !== undefined) node.style.opacity = String(first.opacity);
    }
    active = snapshot; activeColumns = [...resizing.keys()]; released = false;
    // Text layers already own their raster before promoting the column.
    // Construct effects from cached source styles, then release on the next frame.
    const activate = () => {
      plans.push(...initial.splice(0, 8)); flush();
      paintFrame = window.requestAnimationFrame(() => {
        paintFrame = 0;
        if (initial.length) { activate(); return; }
        restoreInline();
        started = performance.now(); released = true; root.dataset.columnLayout = "running";
        animations.forEach((animation) => animation.play());
        wrapTimer = setTimeout(() => wrapColumns(snapshot, resizing), FADE_MS);
        finishTimer = setTimeout(settle, COLUMN_LAYOUT_MS);
      });
    };
    activate();
  };
  const capture = () => {
    const shots: Shot[] = [];
    for (const column of root.querySelectorAll<HTMLElement>(COLUMN)) {
      const viewport = column.querySelector(".col-body")?.getBoundingClientRect();
      for (const node of [column, ...column.querySelectorAll<HTMLElement>(".col-head, .col-body > .card, .col-body > .divider, .col-body > .empty")]) {
        const rect = node.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const visible = node === column || node.matches(".col-head") || !(rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth || (viewport && (rect.bottom < viewport.top || rect.top > viewport.bottom)));
        const style = window.getComputedStyle(node);
        const contents = node.matches(".card, .col-head, .divider, .empty") ? [...node.children].filter((node): node is HTMLElement => node instanceof window.HTMLElement && !node.matches(".label, .saving, .spacer")) : [];
        const scale = (transform: string) => {
          const values = transform.match(/^matrix(3d)?\((.+)\)$/);
          if (!values) return { x: 1, y: 1 };
          const matrix = values[2]!.split(",").map(Number);
          return { x: matrix[0] || 1, y: matrix[values[1] ? 5 : 3] || 1 };
        };
        const width = parseFloat(style.width) || rect.width, height = parseFloat(style.height) || rect.height;
        const children = contents.map((node) => {
          if (!active && !visible) return { node, opacity: 1, scaleX: 1, scaleY: 1 };
          const current = window.getComputedStyle(node);
          const known = contentBase.has(node);
          if (!known) contentBase.set(node, current.transform === "none" ? "" : current.transform);
          if (!active || !known) return { node, opacity: Number(current.opacity || "1"), scaleX: 1, scaleY: 1 };
          const own = scale(current.transform), base = scale(contentBase.get(node)!);
          return { node, opacity: Number(current.opacity || "1"), scaleX: active ? rect.width / width * own.x / base.x : 1, scaleY: active ? rect.height / height * own.y / base.y : 1 };
        });
        shots.push({ node, column, rect, visible, opacity: Number(style.opacity || "1"), widthAsNumber: width, width: style.width || `${rect.width}px`, height: style.height || `${rect.height}px`, contents: children });
      }
    }
    return shots;
  };
  const prepare = () => {
    clearPending();
    if (motion?.matches || typeof root.animate !== "function") { finish(); return; }
    stopClock(); animations.forEach((animation) => animation.pause());
    const shots = capture();
    recordScroll();
    const board = root.querySelector<HTMLElement>(".board");
    const grid = board && !board.classList.contains("scroll") && !board.classList.contains("tabs") ? window.getComputedStyle(board).gridTemplateColumns : null;
    // Live SVG glyphs also invalidate overflow/layout outside the viewport.
    // Hold their progress for the entire activation-through-cleanup window.
    for (const animation of root.getAnimations?.({ subtree: true }) ?? []) {
      const name = (animation as CSSAnimation).animationName;
      if ((name?.startsWith("mg-") || ["kb-edge-flow", "kb-node-pulse", "pb-live"].includes(name)) && animation.playState === "running") {
        paintAnimations.add(animation); animation.pause();
      }
    }
    // Hold the grid through React's commit, so its mutation observer need not
    // force final layout in the same task. The next frame reads all targets.
    if (board && grid && !frozenGrid) {
      frozenGrid = { node: board, template: board.style.gridTemplateColumns };
      board.style.gridTemplateColumns = grid;
    }
    // Source rects/styles are complete before any width/height write.
    for (const shot of shots) if (shot.node === shot.column) {
      if (!frozen.has(shot.node)) frozen.set(shot.node, { width: shot.node.style.width, height: shot.node.style.height, margin: shot.node.style.marginRight });
      shot.node.style.width = shot.width;
    }
    pending = { key: keyOf(root), shots }; root.dataset.columnLayout = "pending";
    expiry = setTimeout(finish, 1000);
    paintFrame = window.requestAnimationFrame(() => {
      paintFrame = 0;
      if (!pending || pending.key !== keyOf(root)) return;
      if (!released) {
        if (active) { const snapshot = pending; clearPending(); start(snapshot); }
        else {
          // Give React its commit frame, then release an idle no-op control.
          paintFrame = window.requestAnimationFrame(() => { paintFrame = 0; if (pending?.key === keyOf(root) && !active) finish(); });
        }
        return;
      }
      root.dataset.columnLayout = "running";
      animations.forEach((animation) => animation.play());
      const remaining = Math.max(1, COLUMN_LAYOUT_MS - Number(animations.values().next().value?.currentTime ?? 0));
      if (active) wrapTimer = setTimeout(() => wrapColumns(active!, new Map(activeColumns.map((node) => [node, node.getBoundingClientRect()]))), Math.min(FADE_MS, remaining));
      finishTimer = setTimeout(settle, remaining);
    });
  };
  const layoutStyle = (style: string | null) => (style ?? "").split(";").map((part) => part.trim()).filter((part) => part && !/^(transform(?:-origin)?|opacity)\s*:/.test(part)).sort().join(";");
  const observer = new window.MutationObserver((records) => {
    // Live content can change between capture and wrapping. Such a column
    // must use its current DOM pose rather than the original projection.
    if (active || promoting) for (const record of records) if (record.attributeName !== "data-wide") {
      const node = record.target instanceof window.Element ? record.target : record.target.parentElement;
      const column = node?.closest<HTMLElement>(COLUMN);
      if (!column) continue;
      // Our inverse writes change only transform/opacity/origin. Width,
      // height or other live styles still invalidate the captured geometry.
      if (record.attributeName === "style" && layoutStyle(record.oldValue) === layoutStyle(node!.getAttribute("style"))) continue;
      invalidated.add(column);
    }
    // New real cards or direct content layers must join the FLIP before
    // paint. Retarget from the current boxes so their text never inherits
    // an untreated wrapper scale or reflows in plain sight.
    const newSurfaces = records.some((record) => record.type === "childList" && record.target instanceof window.Element && (
      record.target.matches(".col-body") && [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof window.Element && node.matches(".card, .divider, .empty")) ||
      record.target.matches(".card, .col-head, .divider, .empty") && [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof window.HTMLElement)
    ));
    if (active && newSurfaces && !pending) {
      prepare();
      const snapshot = pending as Snapshot | null;
      clearPending();
      if (snapshot) start(snapshot);
      return;
    }
    if (!pending || pending.key === keyOf(root)) return;
    const snapshot = pending; clearPending(); stopClock();
    if (active) {
      paintFrame = window.requestAnimationFrame(() => { paintFrame = 0; start(snapshot); });
      return;
    }
    promoting = snapshot;
    // Promote text before transforming a wrapper: promoting the wrapper first
    // rasterizes all its live glyphs into that layer again.
    const changed = new Set(snapshot.key.split("|").filter((entry) => !keyOf(root).split("|").includes(entry)).map((entry) => entry.split(":")[0]));
    const contents = snapshot.shots.filter((shot) => shot.visible && changed.has(shot.column.dataset.status!)).flatMap((shot) => shot.contents.map(({ node }) => node));
    let firstPromotion = true;
    const promote = () => {
      paintFrame = window.requestAnimationFrame(() => {
        paintFrame = 0;
        // React has just changed the shelf paint; its first raster shares
        // this frame with promotion. Leave room for that one-time work.
        for (const node of contents.splice(0, firstPromotion ? 4 : 8)) { node.dataset.layoutAnimating = "content"; marked.add(node); }
        firstPromotion = false;
        if (contents.length) promote();
        else paintFrame = window.requestAnimationFrame(() => { paintFrame = 0; start(snapshot); });
      });
    };
    promote();
  });
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true, attributeFilter: ["data-wide", "class", "style"] });
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
