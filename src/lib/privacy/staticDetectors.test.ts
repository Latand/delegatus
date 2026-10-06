import { expect, test } from "bun:test";
import { staticSensitiveClasses } from "./staticDetectors";

const cases = [
  ["home_path", ["", "home", "someone", "notes"].join("/")],
  ["credential", ["pass", "word"].join("") + '=synthetic-fixture-value'],
  ["private_network", [10, 0, 0, 12].join(".")],
  ["resource_identifier", ["3f2b8c1e", "9a4d", "4c7e", "b1a2", "0d9e8f7a6b5c"].join("-")],
  ["transcript_content", ["user", " synthetic fixture words"].join(":")],
] as const;

test.each(cases)("the shared %s detector exposes its matched span with the same verdict", (kind, text) => {
  const matches: { kind: string; start: number; end: number }[] = [];
  const classes = staticSensitiveClasses(text, (kind, start, end) => matches.push({ kind, start, end }));
  expect(classes).toEqual(staticSensitiveClasses(text));
  expect(classes.has(kind)).toBe(true);
  expect(matches).toContainEqual({ kind, start: 0, end: kind === "home_path" ? text.lastIndexOf("/") + 1 : kind === "transcript_content" ? text.indexOf("synthetic") + 1 : text.length });
});
