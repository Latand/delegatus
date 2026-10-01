import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { translate } from "@/lib/i18n";

import { diffFromApplyPatch } from "../diff";
import type { CmdGroupItem, ToolEvent } from "../parse";
import { CmdGroupCard } from "./CmdGroupCard";
import { DiffCard } from "./DiffCard";
import { OutputPreview } from "./OutputPreview";
import { RecordCard } from "./RecordCard";
import { SysMsgCard } from "./SysMsgCard";
import { MobileRunRow, PollRow, ToolBlockRow, ToolCard } from "./ToolCard";

const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("en", key, params);

function toolEvent(over: Partial<ToolEvent> = {}): ToolEvent {
  return {
    kind: "tool",
    id: "call-1",
    ts: "2026-07-10T10:00:00Z",
    srcCall: 0,
    family: "shell",
    tool: "Bash",
    icon: "shell",
    summary: "ls -la",
    chips: [],
    status: "ok",
    statusLabel: "ok",
    outputPreview: "",
    outputTruncated: false,
    open: false,
    ...over,
  };
}

test("a collapsed tool row renders its summary as a quiet line while body nodes stay lazily unmounted", () => {
  const html = renderToStaticMarkup(<ToolCard event={toolEvent({ endTs: "2026-07-10T10:00:00.750Z", outputPreview: "total 8\nfile.ts" })} />);
  expect(html).toContain("ls -la");
  expect(html).toContain("750ms");
  // Success is silence (§3.4): a collapsed ok row shows no status label.
  expect(html).not.toContain(">ok<");
  // The body (output pre, raw-record button) is not in the DOM until expanded.
  expect(html).not.toContain("total 8");
  expect(html).not.toContain(en("tools.rawRecord"));
});

test("a non-ok tool row surfaces its status label even when collapsed", () => {
  const html = renderToStaticMarkup(<ToolCard event={toolEvent({ status: "err", statusLabel: "exit 1" })} />);
  expect(html).toContain("exit 1");
  expect(html).toContain("text-danger");
});

test("an auto-opened error row mounts its body without empty-output noise", () => {
  const html = renderToStaticMarkup(<ToolCard event={toolEvent({ status: "err", statusLabel: "exit 1", open: true, outputPreview: "" })} />);
  // Absent output renders nothing: no apology chip, no raw-record toggle (compact-feed pass).
  expect(html).not.toContain(en("tools.noOutput"));
  expect(html).not.toContain("rollout session in the left list");
  expect(html).not.toContain(en("tools.rawRecord"));
});

test("the summary row is a native <summary> and every icon is aria-hidden", () => {
  const html = renderToStaticMarkup(<ToolCard event={toolEvent({ open: true })} />);
  expect(html).toContain("<summary");
  expect(html).not.toMatch(/<svg(?![^>]*aria-hidden)/);
});

test("diff lines carry structural token colors and real +/- markers", () => {
  const patch = ["*** Begin Patch", "*** Update File: src/a.ts", "@@", " keep", "-old", "+new", "*** End Patch"].join("\n");
  const body = diffFromApplyPatch(patch);
  const html = renderToStaticMarkup(<DiffCard body={{ type: "diff", files: body.files, filesTruncated: body.filesTruncated }} />);
  expect(html).toContain("bg-diff-add-soft");
  expect(html).toContain("bg-diff-del-soft");
  expect(html).toContain("+new");
  expect(html).toContain("-old");
  expect(html).toContain("a.ts");
  // no raw hex literals in the rendered markup
  expect(html).not.toMatch(/#[0-9a-fA-F]{6}/);
});

test("similar replacement lines render stronger intraline add/remove emphasis", () => {
  const patch = ["*** Begin Patch", "*** Update File: src/limit.ts", "@@", "-const limit = 10;", "+const limit = 20;", "*** End Patch"].join("\n");
  const body = diffFromApplyPatch(patch);
  const html = renderToStaticMarkup(<DiffCard body={{ type: "diff", files: body.files, filesTruncated: body.filesTruncated }} />);

  expect(html).toContain("bg-diff-add-strong");
  expect(html).toContain("bg-diff-del-strong");
});

test("an edit card opens its diff preview inline with a full-diff toggle", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/big.ts",
    "@@",
    ...Array.from({ length: 20 }, (_, i) => [`-old${i}`, `+new${i}`]).flat(),
    "*** End Patch",
  ].join("\n");
  const model = diffFromApplyPatch(patch);
  const total = model.files[0].hunks.flatMap((hunk) => hunk.lines).length;
  const html = renderToStaticMarkup(
    <ToolCard
      event={toolEvent({
        family: "edit",
        tool: "apply_patch",
        icon: "edit",
        summary: "Edit big.ts",
        open: true,
        body: { type: "diff", files: model.files, filesTruncated: model.filesTruncated },
      })}
    />,
  );
  // The diff renders inline (no click needed) with the structural colors.
  expect(html).toContain("bg-diff-add-soft");
  expect(html).toContain("src/big.ts");
  // Only a compact preview is shown, with a toggle revealing the full diff.
  expect(html).toContain(en("tools.showAllLines", { count: total }));
  // A line past the preview budget stays hidden until the toggle is used.
  expect(html).not.toContain("+new19");
});

test("output preview shows content with an accessible copy control", () => {
  const html = renderToStaticMarkup(<OutputPreview output={"line1\nline2"} truncated={false} />);
  expect(html).toContain("line1");
  expect(html).toContain(en("tools.copyOutput"));
  expect(html).toContain("overflow");
});

function cmdGroup(calls: ToolEvent[]): CmdGroupItem {
  const byTool: Record<string, number> = {};
  let okCount = 0;
  let errCount = 0;
  for (const call of calls) {
    byTool[call.tool] = (byTool[call.tool] ?? 0) + 1;
    if (call.status === "ok") okCount += 1;
    else if (call.status === "err") errCount += 1;
  }
  return {
    kind: "cmd-group",
    ids: calls.map((c) => c.id),
    calls,
    t0: calls[0]?.ts,
    t1: calls.at(-1)?.ts,
    byTool,
    okCount,
    errCount,
    hasErr: errCount > 0,
    active: false,
  };
}

test("a collapsed cmd-group defers all child rendering until it is expanded", () => {
  const html = renderToStaticMarkup(
    <CmdGroupCard
      item={cmdGroup([
        toolEvent({ id: "a", summary: "ls -la", outputPreview: "total 8\nfile.ts" }),
        toolEvent({ id: "b", tool: "Read", family: "read", icon: "file", summary: "Read a.ts", outputPreview: "line-a\nline-b" }),
      ])}
    />,
  );
  // The header renders...
  expect(html).toContain("ran 1 command · read 1 file");
  // ...but no child summary or body is in the DOM until the group is expanded.
  expect(html).not.toContain("ls -la");
  expect(html).not.toContain("Read a.ts");
  expect(html).not.toContain("total 8");
  expect(html).not.toContain(en("tools.rawRecord"));
});

test("a collapsed action group renders its transcript start-to-completion duration", () => {
  const item = cmdGroup([
    toolEvent({ id: "a", ts: "2026-07-10T10:00:00.000Z" }),
    toolEvent({ id: "b", ts: "2026-07-10T10:00:01.000Z", endTs: "2026-07-10T10:00:02.250Z" }),
  ]);
  item.t1 = item.calls.at(-1)?.endTs;
  const html = renderToStaticMarkup(<CmdGroupCard item={item} />);
  expect(html).toContain("2.3s");
});

test("a collapsed cmd-group does not mount a diff-backed child's diff body", () => {
  const patch = ["*** Begin Patch", "*** Update File: src/edit-x.ts", "@@", " keep", "-old", "+new", "*** End Patch"].join("\n");
  const model = diffFromApplyPatch(patch);
  const diffEvent = toolEvent({
    id: "e1",
    family: "edit",
    tool: "apply_patch",
    icon: "edit",
    summary: "Edit edit-x.ts",
    open: true, // a diff-backed event opens itself — but a closed group must not mount it
    body: { type: "diff", files: model.files, filesTruncated: model.filesTruncated },
  });
  const html = renderToStaticMarkup(<CmdGroupCard item={cmdGroup([diffEvent, toolEvent({ id: "e2", summary: "echo done" })])} />);
  expect(html).toContain("patched 1 file · ran 1 command");
  // The successful (no-error) group is collapsed, so the child's diff DOM is absent.
  expect(html).not.toContain("bg-diff-add-soft");
  expect(html).not.toContain("src/edit-x.ts");
});

test("a cmd-group carrying an error opens and mounts the failing child's full body", () => {
  const html = renderToStaticMarkup(
    <CmdGroupCard
      item={cmdGroup([
        toolEvent({ id: "a", summary: "ls -la" }),
        toolEvent({ id: "b", summary: "bun test", status: "err", statusLabel: "exit 1", open: true, outputPreview: "boom" }),
      ])}
    />,
  );
  // The failing line is danger and never silenced.
  expect(html).toContain("exit 1");
  expect(html).toContain("text-danger");
  // The opened error child mounts its body with the real output and no
  // raw-record noise toggle (compact-feed pass).
  expect(html).toContain("boom");
  expect(html).not.toContain(en("tools.rawRecord"));
});

test("a system message collapses to the compact per-1000 size, not chars/kB (§3.4)", () => {
  const html = renderToStaticMarkup(<SysMsgCard label="system-reminder" text={"x".repeat(1402)} />);
  expect(html).toContain("1.4k");
  // The verbose "1402 chars" / "1.4 kB" forms are gone.
  expect(html).not.toContain("1402 ");
  expect(html).not.toContain(en("common.kb"));
});

test("a fallback transcript record renders a typed chip with bounded collapsible detail", () => {
  const html = renderToStaticMarkup(
    <RecordCard
      item={{
        kind: "record",
        ts: "2026-07-14T10:00:00Z",
        recordType: "future_payload",
        summary: "A future payload summary",
        body: '{\n  "detail": "synthetic"\n}',
        truncated: true,
      }}
    />,
  );
  expect(html).toContain(en("render.transcriptRecord"));
  expect(html).toContain("future_payload");
  expect(html).toContain("A future payload summary");
  expect(html).toContain("synthetic");
  expect(html).toContain(en("render.truncated"));
  expect(html).toContain("<details");
});

test("an orchestration row renders nested children and the meaningful outer summary", () => {
  const html = renderToStaticMarkup(
    <ToolCard
      event={toolEvent({
        open: true,
        icon: "cmd-group",
        summary: en("tools.orchestration", { count: 3 }),
        orchestration: {
          source: "await Promise.all([...])",
          sourceTruncated: false,
          calls: [
            { id: "a#0", tool: "exec_command", family: "shell", icon: "shell", summary: "git status" },
            { id: "b#1", tool: "read_file", family: "read", icon: "file", summary: "Read a.ts" },
          ],
        },
      })}
    />,
  );
  expect(html).toContain(en("tools.nestedCalls"));
  expect(html).toContain("git status");
  expect(html).toContain("Read a.ts");
  // The raw JavaScript "source" disclosure is gone (compact-feed pass).
  expect(html).not.toContain(en("tools.source"));
});

test("seat panel b3: a shell row with an absolute path stays one truncated line and keeps the whole command as its tooltip", () => {
  const command = "ls -d /workspace/demo/projects/atlas-pipeline-9c1d2e3f && git -C /workspace/demo/projects/atlas-pipeline-9c1d2e3f status --short";
  const html = renderToStaticMarkup(<ToolCard event={toolEvent({ summary: command, command })} />);
  const summary = html.match(/<span class="min-w-0 flex-1 truncate[^"]*" title="([^"]*)">/);
  expect(summary).not.toBeNull();
  expect(summary![1]).toBe(command.replaceAll("&", "&amp;"));
  /* The row is not a wrapping container: no flex-wrap, and the expanded body is still lazy. */
  expect(html.match(/<summary[^>]*class="([^"]*)"/)![1]).not.toContain("flex-wrap");
  expect(html).not.toContain("whitespace-pre-wrap");
});

/* Context tokens per tool call (docs/design/tool-call-tokens.md §9): every row
   that prints a duration prints the number right after it. */
const tokenHtml = (html: string) => html.match(/<span data-context-tokens[^>]*>.*?<\/span><\/span>/)?.[0] ?? "";
const timed = { endTs: "2026-07-10T10:00:00.352Z" };

test("a tool line prints the context tokens right after the duration, before the clock time", () => {
  const html = renderToStaticMarkup(<ToolCard event={toolEvent({ ...timed, contextTokens: { n: 12_449, basis: "measured" } })} />);
  expect(html).toContain("352ms");
  expect(html.indexOf("352ms")).toBeLessThan(html.indexOf("data-context-tokens"));
  expect(html.indexOf("data-context-tokens")).toBeLessThan(html.indexOf("12:00") === -1 ? Infinity : html.indexOf("12:00"));
  const caption = tokenHtml(html);
  expect(caption).toContain(">12.4k<");
  expect(caption).toContain('data-context-band="2"');
  expect(caption).toContain('data-context-basis="measured"');
  expect(caption).toContain("text-caution");
  expect(caption).toContain("whitespace-nowrap");
  expect(caption).toContain('title="12,449 tokens added to the context by this call"');
});

test("the four bands get four classes, each more prominent than the last", () => {
  const classes = [352, 1_000, 10_000, 20_000].map((n) => {
    const caption = tokenHtml(renderToStaticMarkup(<ToolCard event={toolEvent({ ...timed, contextTokens: { n, basis: "measured" } })} />));
    return [caption.match(/data-context-band="(\d)"/)?.[1], caption.match(/class="(text-[a-z]+(?: font-[a-z]+)?)"/)?.[1]];
  });
  expect(classes).toEqual([["0", "text-muted"], ["1", "text-warning"], ["2", "text-caution font-medium"], ["3", "text-danger font-semibold"]]);
});

test("an estimate and a shared value wear a ~ and say approximately", () => {
  const estimate = tokenHtml(renderToStaticMarkup(<ToolCard event={toolEvent({ ...timed, contextTokens: { n: 352, basis: "estimate" } })} />));
  expect(estimate).toContain(">~352<");
  expect(estimate).toContain("Approximately 352 tokens added to the context by this call, estimated from the size of its result");
  const shared = tokenHtml(renderToStaticMarkup(<ToolCard event={toolEvent({ ...timed, contextTokens: { n: 2_911, basis: "shared", round: { total: 21_902, calls: 3 } } })} />));
  expect(shared).toContain(">~2.9k<");
  expect(shared).toContain("of 21,902 measured for 3 parallel calls");
});

test("a row without the field, or a running one, prints no number and no stray dot", () => {
  expect(renderToStaticMarkup(<ToolCard event={toolEvent(timed)} />)).not.toContain("data-context-tokens");
  expect(renderToStaticMarkup(<ToolCard event={toolEvent({ status: "run", statusLabel: "executing" })} />)).not.toContain("data-context-tokens");
});

test("without a duration the number stands alone, with no leading dot", () => {
  const html = renderToStaticMarkup(<ToolCard event={toolEvent({ contextTokens: { n: 352, basis: "measured" } })} />);
  expect(tokenHtml(html)).not.toContain("aria-hidden");
});

test("a block row inside an open group prints it after the duration", () => {
  const html = renderToStaticMarkup(<ToolBlockRow event={toolEvent({ ...timed, contextTokens: { n: 25_000, basis: "measured" } })} index={1} />);
  expect(html.indexOf("352ms")).toBeLessThan(html.indexOf("data-context-tokens"));
  expect(tokenHtml(html)).toContain('data-context-band="3"');
});

test("a phone run row ends its meta with the number, dot and value in their own spans", () => {
  const html = renderToStaticMarkup(<MobileRunRow event={toolEvent({ ...timed, contextTokens: { n: 1_500, basis: "measured" } })} />);
  expect(html).toMatch(/352ms<span data-context-tokens[^>]*><span class="mx-1 text-muted" aria-hidden="true">·<\/span><span class="text-warning">1\.5k<\/span>/);
});

test("a coalesced poll row carries the sum of its polls, worded for several calls", () => {
  const poll = (n: number) => toolEvent({ tool: "wait", poll: true, contextTokens: { n, basis: "estimate" } });
  const html = renderToStaticMarkup(<PollRow events={[poll(10), poll(15)]} contextTokens={{ n: 25, basis: "estimate" }} />);
  expect(tokenHtml(html)).toContain(">~25<");
  expect(tokenHtml(html)).toContain("Approximately 25 tokens added to the context by these calls");
});

test("a folded desktop group prints the sum after its duration and before the time range", () => {
  const calls = [
    toolEvent({ id: "g1", ts: "2026-07-10T10:00:00Z", endTs: "2026-07-10T10:00:01Z" }),
    toolEvent({ id: "g2", ts: "2026-07-10T10:00:01Z", endTs: "2026-07-10T10:00:03Z" }),
  ];
  const item: CmdGroupItem = {
    kind: "cmd-group", ids: ["g1", "g2"], calls, t0: calls[0].ts, t1: "2026-07-10T10:00:03Z", byTool: { Bash: 2 },
    okCount: 2, errCount: 0, hasErr: false, active: false, contextTokens: { n: 21_000, basis: "measured" },
  };
  const html = renderToStaticMarkup(<CmdGroupCard item={item} />);
  const caption = tokenHtml(html);
  expect(caption).toContain('data-context-band="3"');
  expect(caption).toContain('title="21,000 tokens added to the context by these calls"');
  expect(html.indexOf("3s")).toBeLessThan(html.indexOf("data-context-tokens"));
  const { contextTokens: _omitted, ...without } = item;
  expect(renderToStaticMarkup(<CmdGroupCard item={without} />)).not.toContain("data-context-tokens");
});
