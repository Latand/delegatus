/**
 * One-line failure text for happy-dom nodes (#2182).
 *
 * React keeps its fiber and props on every node it renders
 * (`__reactFiber$…`, `__reactProps$…`). When `expect(a).toBe(b)` failed on
 * such a node, Bun's failure formatter walked those properties through the
 * whole React tree: on a mounted board one comparison spent 40 s there and
 * then let the test pass. A node that describes itself in one line keeps the
 * failure, and the message names both elements.
 *
 * The test preload imports this module, which hooks happy-dom's own `Node`
 * module when a test loads it. happy-dom still loads exactly when a test asks
 * for it, and a test process that never does pays nothing.
 */
import type { Node } from "happy-dom";

const NAMED_ATTRIBUTES = new Set(["id", "class", "role", "aria-label", "name", "type"]);
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

export function describeNode(node: Node): string {
  if (node.nodeType === ELEMENT_NODE) {
    const element = node as unknown as { tagName: string; attributes: ArrayLike<{ name: string; value: string }> };
    const attributes = Array.from(element.attributes)
      .filter(({ name }) => NAMED_ATTRIBUTES.has(name) || name.startsWith("data-"))
      .slice(0, 4)
      .map(({ name, value }) => ` ${name}="${value.length > 40 ? `${value.slice(0, 40)}…` : value}"`);
    return `<${element.tagName.toLowerCase()}${attributes.join("")}>`;
  }
  if (node.nodeType === TEXT_NODE) return `#text ${JSON.stringify((node.textContent ?? "").slice(0, 40))}`;
  return node.nodeName;
}

/** Called from happy-dom's `Node` module once its class exists. */
export function installDomInspect(NodeClass: { prototype: object }): void {
  Object.defineProperty(NodeClass.prototype, Bun.inspect.custom, {
    configurable: true,
    writable: true,
    value(this: Node) {
      return describeNode(this);
    },
  });
}

Bun.plugin({
  name: "happy-dom node inspect",
  setup(build) {
    build.onLoad({ filter: /[\\/]happy-dom[\\/]lib[\\/]nodes[\\/]node[\\/]Node\.js$/ }, async ({ path }) => ({
      loader: "js",
      contents: `${await Bun.file(path).text()}\nimport { installDomInspect as __installDomInspect } from ${JSON.stringify(import.meta.path)};\n__installDomInspect(Node);\n`,
    }));
  },
});
