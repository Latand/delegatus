/** A per-read cache. Reading a skipped descendant's computed style can force the
 * browser to resolve its whole card before content-visibility has settled.
 * Resolve ancestors first and stop at an offscreen paint-containing box. */
export function createPageVisibilityGuard(): (element: Element) => boolean {
  const visible = new Map<Element, boolean>();
  const styles = new Map<Element, CSSStyleDeclaration>();
  const boxes = new Map<Element, DOMRect>();
  const styleOf = (element: Element) => {
    let style = styles.get(element);
    if (!style) { style = getComputedStyle(element); styles.set(element, style); }
    return style;
  };
  const boxOf = (element: Element) => {
    let box = boxes.get(element);
    if (!box) { box = element.getBoundingClientRect(); boxes.set(element, box); }
    return box;
  };
  const intersectsView = (element: Element) => {
    const box = boxOf(element);
    let left = Math.max(0, box.left), top = Math.max(0, box.top);
    let right = Math.min(innerWidth, box.right), bottom = Math.min(innerHeight, box.bottom);
    for (let parent = element.parentElement; parent && right > left && bottom > top; parent = parent.parentElement) {
      const style = styleOf(parent);
      if (style.display === "contents" || (style.overflowX === "visible" && style.overflowY === "visible")) continue;
      const clip = boxOf(parent);
      left = Math.max(left, clip.left); right = Math.min(right, clip.right);
      top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom);
    }
    return right > left && bottom > top;
  };
  const read = (element: Element): boolean => {
    const cached = visible.get(element);
    if (cached !== undefined) return cached;
    let shown = !element.parentElement || read(element.parentElement);
    if (shown) {
      const style = styleOf(element);
      shown = style.display !== "none" && style.contentVisibility !== "hidden";
      // These boxes apply the paint containment implied by content-visibility.
      // Contents/inline/table-internal wrappers can have descendants outside their own box.
      if (shown && style.contentVisibility === "auto" && /^(block|flow-root|flex|grid|inline-block|inline-flex|inline-grid|list-item)$/.test(style.display)) {
        shown = intersectsView(element);
      }
    }
    visible.set(element, shown);
    return shown;
  };
  return read;
}
