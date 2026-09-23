/*
 * A task's text is one string: its title is the first line and its
 * description the rest (`details` is its own stored field and never reaches
 * these two, #1834). The desktop card and the phone's task screen (#2072
 * slice 5) edit either part in place through these, so an edit of one part
 * keeps the other byte for byte.
 */

/** The title (first line) or description (the rest) of a task's text. */
export function textField(text: string, field: "title" | "description"): string {
  const newline = text.search(/\r?\n/);
  if (field === "title") return (newline < 0 ? text : text.slice(0, newline)).trim();
  return newline < 0 ? "" : text.slice(newline).trim();
}

/** The task's text with one of its fields replaced, the other kept byte for byte. */
export function withField(text: string, field: "title" | "description", value: string): string {
  const newline = text.search(/\r?\n/);
  if (field === "title") return newline < 0 ? value : value + text.slice(newline);
  const first = newline < 0 ? text : text.slice(0, newline);
  return value ? `${first}\n${value}` : first;
}
