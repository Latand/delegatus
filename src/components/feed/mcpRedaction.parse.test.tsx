import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { FileEntry } from "@/lib/types";
import { buildFeed } from "./parse";
import { summarizeTool } from "./tools";
import { ToolCard, ToolChips } from "./cards/ToolCard";
import { credentialSentinel, mcpArgumentCases, mcpArgumentLine } from "./__fixtures__/mcpRedaction";

for (const engine of ["codex", "claude"] as const) {
  for (const [index, args] of mcpArgumentCases.entries()) {
    test(`${engine} MCP summary and chips remove complete credentials, case ${index}`, () => {
      const summary = summarizeTool("mcp__catalog__lookup", args, engine);
      expect(JSON.stringify(summary)).not.toContain(credentialSentinel);
      expect(JSON.stringify(summary)).toContain("release notes");
      expect(JSON.stringify(summary)).toContain("[redacted]");
    });
    for (const typed of engine === "codex" ? [false, true] : [false]) {
      test(`${engine} ${typed ? "typed" : "call"} MCP parser and rendered disclosure redact case ${index}`, () => {
        const file = { path: "/workspace/demo.jsonl", engine, fmt: engine } as FileEntry;
        const items = buildFeed(file, [mcpArgumentLine(engine, args, "redaction", typed)], false, "").items;
        const event = items.flatMap(item => item.kind === "tool" ? [item] : item.kind === "cmd-group" ? item.calls : [])[0];
        expect(event).toBeDefined();
        for (const open of [false, true]) {
          const html = renderToStaticMarkup(<ToolCard event={{ ...event, open }} />);
          expect(html).not.toContain(credentialSentinel);
          if (open) expect(html).toContain("release notes");
          // Whole markup includes summary/title attributes and disclosure body.
          expect(renderToStaticMarkup(<ToolChips chips={event.chips} />)).not.toContain(credentialSentinel);
        }
        expect(JSON.stringify(event)).not.toContain(credentialSentinel);
      });
    }
  }
}

test("MCP chip sanitization bounds deep, wide, cyclic and oversized arguments", () => {
  let deep: Record<string, unknown> = { [["author", "ization"].join("")]: credentialSentinel };
  for (let depth = 0; depth < 100; depth++) deep = { next: deep };
  const cycle: Record<string, unknown> = {}; cycle.next = cycle;
  let reads = 0;
  const branch = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [i, i]));
  Object.defineProperty(branch, "0", { enumerable: true, get() { reads++; return "public value"; } });
  const wide = Array.from({ length: 40 }, () => Array.from({ length: 40 }, () => branch));
  for (const value of [deep, cycle, wide, `Bearer ${credentialSentinel}${"x".repeat(100_000)}`]) {
    const summary = summarizeTool("mcp__catalog__lookup", { query: "release notes", options: value }, "codex");
    expect(JSON.stringify(summary)).not.toContain(credentialSentinel);
    expect(summary.chips.every(chip => chip.value.length <= 120)).toBe(true);
  }
  expect(reads).toBeGreaterThan(0);
  expect(reads).toBeLessThan(10);
});

test("nested public MCP arguments remain readable and original inputs are unchanged", () => {
  const args = mcpArgumentCases[1];
  const before = JSON.stringify(args);
  const summary = summarizeTool("mcp__catalog__lookup", args, "codex");
  expect(JSON.stringify(summary)).toContain("application/json");
  expect(JSON.stringify(args)).toBe(before);
  expect(JSON.stringify(summarizeTool("mcp__catalog__lookup", mcpArgumentCases[2], "claude"))).toContain("compact");
});
