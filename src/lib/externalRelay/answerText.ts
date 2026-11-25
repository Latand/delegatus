/** Render the Markdown subset as readable text for a plain-only delivery.
 * Leave ordinary text alone, including whitespace and literal punctuation. */
export function relayPlainText(source: string, scrub?: (text: string) => string): string {
  let formatted = false;
  const format = (text: string) => { formatted = true; return text; };
  const text = Bun.markdown.render(source, {
    heading: children => format(children + "\n\n"),
    paragraph: children => children + "\n\n",
    blockquote: children => format(children),
    code: children => format(children + "\n\n"),
    codespan: format,
    strong: format,
    emphasis: format,
    strikethrough: format,
    link: (label, { href }) => format(/^https?:\/\//i.test(href) && label !== href ? `${label} ${href}` : label),
    image: format,
    list: (children, { depth }) => depth ? "\n" + children : children + "\n",
    listItem: (children, { depth, ordered, start, index, checked }) => {
      const marker = ordered ? `${(start ?? 1) + index}.` : "-";
      const task = checked === undefined ? "" : checked ? "[x] " : "[ ] ";
      return format(`${"  ".repeat(depth)}${marker} ${task}${children.trimEnd()}\n`);
    },
    table: children => format(children + "\n"),
    tr: children => children.trimEnd() + "\n",
    th: children => children + "  ",
    td: children => children + "  ",
    hr: () => format("\n"),
  }, { noIndentedCodeBlocks: true });
  const plain = formatted ? text.trimEnd() : source;
  // Removing formatting can join what used to be separate pieces of a secret.
  return scrub && plain !== source ? scrub(plain) : plain;
}
