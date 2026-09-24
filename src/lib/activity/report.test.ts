import { expect, test } from "bun:test";

import { distinctNames } from "./report";

test("one project never reads twice: rows that share a display name take a piece of their key", () => {
  /* The shape of a real 7-day page: two scratch directories both named
     `work`, each its own project, beside a repository and an unattributed row. */
  const rows = distinctNames([
    { project: "repo-1111aaaa2222bbbb3333cccc4444dddd", name: "harbor" },
    { project: "dir-2a51da3c6f5a75e60546c35beb3cfebd", name: "work" },
    { project: "dir-92b4f8dcfa88eb3e179fb3a3355125ec", name: "work" },
    { project: "dir-0d83e166d2268dc0e7bdf7cc5210fa0d", name: "Handoff digests" },
    { project: null, name: null },
  ]);
  expect(rows.map((row) => row.name)).toEqual(["harbor", "work · 2a51da", "work · 92b4f8", "Handoff digests", null]);
  const named = rows.flatMap((row) => (row.name ? [row.name] : []));
  expect(new Set(named).size).toBe(named.length);
});
