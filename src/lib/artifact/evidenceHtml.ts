/**
 * Evidence reports are readable documents, not active web applications.
 * Keep their markup and local styling while removing every HTML navigation
 * primitive. The frame CSP separately blocks scripts, forms and child frames.
 */
export function containEvidenceHtml(source: string, baseHref?: string): string {
  let output = "";
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("<", cursor);
    if (start < 0) return output + source.slice(cursor);
    output += source.slice(cursor, start);

    if (source.startsWith("<!--", start)) {
      const end = source.indexOf("-->", start + 4);
      const stop = end < 0 ? source.length : end + 3;
      output += source.slice(start, stop);
      cursor = stop;
      continue;
    }

    let quote = "";
    let end = start + 1;
    for (; end < source.length; end++) {
      const char = source[end]!;
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === "\"" || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (end === source.length) return output + source.slice(start);

    const token = source.slice(start, end + 1);
    const match = /^<\s*([a-z][\w:-]*)\b/i.exec(token);
    if (!match) {
      output += token;
      cursor = end + 1;
      continue;
    }
    const tag = match[1]!.toLowerCase();
    if (tag === "script" && !/^<\s*\//.test(token)) {
      const close = /<\/\s*script\s*>/ig;
      close.lastIndex = end + 1;
      const closing = close.exec(source);
      cursor = closing ? close.lastIndex : source.length;
      continue;
    }
    if (tag === "base") {
      cursor = end + 1;
      continue;
    }
    if (tag === "meta" && /(?:^|\s)http-equiv\s*=/i.test(token)) {
      cursor = end + 1;
      continue;
    }
    if (tag === "a" || tag === "area") {
      output += removeNavigationAttributes(token, match[0].length);
    } else {
      output += token;
    }
    cursor = end + 1;
  }
  if (!baseHref) return output;
  const base = `<base href="${baseHref.replace(/[&"<>]/g, char => ({ "&": "&amp;", "\"": "&quot;", "<": "&lt;", ">": "&gt;" })[char]!)}">`;
  return /<head\b[^>]*>/i.test(output)
    ? output.replace(/<head\b[^>]*>/i, match => `${match}${base}`)
    : `${base}${output}`;
}

function removeNavigationAttributes(token: string, offset: number): string {
  const removals: Array<[number, number]> = [];
  let cursor = offset;
  while (cursor < token.length - 1) {
    while (/\s/.test(token[cursor] ?? "")) cursor++;
    if (cursor >= token.length - 1 || token[cursor] === ">" || token[cursor] === "/") break;
    const begin = cursor;
    while (cursor < token.length && !/[\s=/>]/.test(token[cursor]!)) cursor++;
    const name = token.slice(begin, cursor).toLowerCase();
    while (/\s/.test(token[cursor] ?? "")) cursor++;
    if (token[cursor] === "=") {
      cursor++;
      while (/\s/.test(token[cursor] ?? "")) cursor++;
      const quote = token[cursor] === "\"" || token[cursor] === "'" ? token[cursor++] : "";
      if (quote) {
        while (cursor < token.length && token[cursor] !== quote) cursor++;
        if (cursor < token.length) cursor++;
      } else {
        while (cursor < token.length && !/[\s>]/.test(token[cursor]!)) cursor++;
      }
    }
    if (["href", "xlink:href", "target", "ping", "attributionsrc"].includes(name)) removals.push([begin, cursor]);
  }
  let result = "";
  let prior = 0;
  for (const [begin, end] of removals) {
    result += token.slice(prior, begin);
    prior = end;
  }
  return result + token.slice(prior);
}
