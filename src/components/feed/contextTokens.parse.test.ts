import { describe, expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { buildFeed, createFeedSession, type FeedEntry, type Item, type ToolEvent } from "./parse";

/* The sizes below are the real ones from docs/design/tool-call-tokens.md §4;
   the results are filler of the same length, which is all the method reads. */

const claudeFile = { path: "/tmp/x.jsonl", engine: "claude", fmt: "claude", activity: "idle" } as FileEntry;
const codexFile = { path: "/tmp/x.jsonl", engine: "codex", fmt: "codex", activity: "idle" } as FileEntry;

const filler = (chars: number) => "lorem ipsum ".repeat(Math.ceil(chars / 12)).slice(0, chars);
const at = (n: number) => new Date(Date.UTC(2026, 9, 1, 10, 0, n)).toISOString();

type Usage = { input: number; read: number; created: number; output: number };
const promptOf = (u: Usage) => u.input + u.read + u.created;

let clock = 0;
const claudeAssistant = (id: string, usage: Usage, content: object[], extra: object = {}) =>
  JSON.stringify({
    type: "assistant",
    timestamp: at(clock++),
    requestId: `req-${id}`,
    message: {
      id,
      model: "claude-opus-5-5",
      role: "assistant",
      content,
      usage: { input_tokens: usage.input, cache_read_input_tokens: usage.read, cache_creation_input_tokens: usage.created, output_tokens: usage.output },
    },
    ...extra,
  });
const toolUse = (id: string, name = "Bash") => ({ type: "tool_use", id, name, input: name === "Bash" ? { command: `echo ${id}` } : { query: id } });
const claudeResult = (id: string, chars: number) =>
  JSON.stringify({ type: "user", timestamp: at(clock++), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: filler(chars) }] } });
const text = (value: string) => ({ type: "text", text: value });

const sonnet1: Usage = { input: 2, read: 49_018, created: 1_465, output: 286 };
const sonnet2: Usage = { input: 2, read: 50_483, created: 10_094, output: 40 };
const opus1: Usage = { input: 2, read: 45_940, created: 11_596, output: 446 };
const opus2: Usage = { input: 0, read: 79_886, created: 0, output: 12 };

const example1 = () => [claudeAssistant("m1", sonnet1, [toolUse("a")]), claudeResult("a", 26_024)];
const example1Next = () => claudeAssistant("m2", sonnet2, [text("done")]);
const example2 = () => [
  /* One line per content block, all repeating the response's usage. */
  claudeAssistant("m1", opus1, [toolUse("a", "Read")]),
  claudeAssistant("m1", opus1, [toolUse("b", "Grep")]),
  claudeAssistant("m1", opus1, [toolUse("c", "Glob")]),
  claudeResult("a", 6_411),
  claudeResult("b", 36_232),
  claudeResult("c", 5_593),
];
const example2Next = () => claudeAssistant("m2", opus2, [text("done")]);

function events(items: readonly (Item | FeedEntry)[]): ToolEvent[] {
  return items.flatMap((entry) => {
    const item = "item" in entry ? entry.item : entry;
    return item.kind === "cmd-group" ? item.calls : item.kind === "tool" ? [item] : [];
  });
}
const parse = (file: FileEntry, lines: string[]) => events(buildFeed(file, lines, false, "").items);
const tokens = (list: ToolEvent[]) => Object.fromEntries(list.map((event) => [event.id, event.contextTokens]));

describe("Claude", () => {
  test("example 1: one call is measured from the next response, and estimated until it lands", () => {
    expect(tokens(parse(claudeFile, example1())).a).toEqual({ n: 10_843, basis: "estimate" });
    const [call] = parse(claudeFile, [...example1(), example1Next()]);
    expect(promptOf(sonnet2) - promptOf(sonnet1) - sonnet1.output).toBe(9_808);
    expect(call.contextTokens).toEqual({ n: 9_808, basis: "measured" });
  });

  test("example 2: three parallel calls share the measured growth by result size", () => {
    const list = parse(claudeFile, [...example2(), example2Next()]);
    expect(list.map((event) => event.contextTokens?.n)).toEqual([2_911, 16_451, 2_540]);
    for (const event of list) {
      expect(event.contextTokens?.basis).toBe("shared");
      expect(event.contextTokens?.round).toEqual({ total: 21_902, calls: 3 });
    }
  });

  test("a running call has no number", () => {
    const [call] = parse(claudeFile, [claudeAssistant("m1", sonnet1, [toolUse("a")])]);
    expect(call.status).toBe("run");
    expect(call.contextTokens).toBeUndefined();
  });

  test("an empty result with no measurement shows nothing, and one with a measurement shows it", () => {
    const empty = [claudeAssistant("m1", sonnet1, [toolUse("a")]), claudeResult("a", 0)];
    expect(parse(claudeFile, empty)[0].contextTokens).toBeUndefined();
    expect(parse(claudeFile, [...empty, example1Next()])[0].contextTokens?.basis).toBe("measured");
  });

  const between: [string, string][] = [
    ["a queued_command attachment", JSON.stringify({ type: "attachment", timestamp: at(0), attachment: { type: "queued_command", prompt: "hello" } })],
    ["an edited_text_file attachment", JSON.stringify({ type: "attachment", timestamp: at(0), attachment: { type: "edited_text_file", filename: "a.ts" } })],
    ["typed user text", JSON.stringify({ type: "user", timestamp: at(0), message: { role: "user", content: "also do this" } })],
    ["a user record with a text part", JSON.stringify({ type: "user", timestamp: at(0), message: { role: "user", content: [{ type: "text", text: "interrupted" }] } })],
    ["a compact boundary", JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: at(0), compactMetadata: { trigger: "auto", preTokens: 100 } })],
  ];
  test.each(between)("%s between the responses keeps the estimate", (_name, line) => {
    const [call] = parse(claudeFile, [...example1(), line, example1Next()]);
    expect(call.contextTokens).toEqual({ n: 10_843, basis: "estimate" });
  });

  test("an everyday reminder attachment does not spoil the measurement", () => {
    const reminder = JSON.stringify({ type: "attachment", timestamp: at(0), attachment: { type: "total_tokens_reminder" } });
    expect(parse(claudeFile, [...example1(), reminder, example1Next()])[0].contextTokens?.basis).toBe("measured");
  });

  test("a hidden ToolSearch in the round leaves the Bash sibling with its estimate", () => {
    const lines = [
      claudeAssistant("m1", sonnet1, [toolUse("search", "ToolSearch"), toolUse("a")]),
      claudeResult("search", 500),
      claudeResult("a", 933),
      example1Next(),
    ];
    const [call] = parse(claudeFile, lines);
    expect(call.contextTokens).toEqual({ n: 389, basis: "estimate" });
  });

  describe("a picture result", () => {
    const pictureResult = (id: string) =>
      JSON.stringify({
        type: "user", timestamp: at(clock++),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }] }] },
      });
    const imageNote = (content = "[Image: original 780x2376, displayed at 657x2000. Multiply coordinates by 1.19 to map to original image.]") =>
      JSON.stringify({ type: "user", isMeta: true, timestamp: at(clock++), message: { role: "user", content } });
    const lines = (...between: string[]) => [claudeAssistant("m1", sonnet1, [toolUse("a", "Read")]), pictureResult("a"), ...between, example1Next()];

    test("the harness's dimension note belongs to the result and the call is measured", () => {
      expect(parse(claudeFile, lines(imageNote()))[0].contextTokens).toEqual({ n: 9_808, basis: "measured" });
    });

    test("typed text in the same place still keeps the call unmeasured", () => {
      expect(parse(claudeFile, lines(imageNote("look at this too")))[0].contextTokens).toBeUndefined();
    });

    test("a dimension note that follows no picture result is foreign", () => {
      const list = parse(claudeFile, [...example1(), imageNote(), example1Next()]);
      expect(list[0].contextTokens?.basis).toBe("estimate");
    });
  });

  test("growth that is zero or negative keeps the estimate", () => {
    const shrunk = claudeAssistant("m2", { input: 1, read: 100, created: 0, output: 5 }, [text("done")]);
    expect(parse(claudeFile, [...example1(), shrunk])[0].contextTokens?.basis).toBe("estimate");
  });

  test("a subagent's records do not count as responses of this conversation", () => {
    const side = claudeAssistant("s1", { input: 1, read: 999_999, created: 0, output: 5 }, [text("inner")], { isSidechain: true });
    expect(parse(claudeFile, [...example1(), side, example1Next()])[0].contextTokens).toEqual({ n: 9_808, basis: "measured" });
  });

  test("a window that starts inside a response never measures that round", () => {
    const lines = [...example2(), example2Next()];
    const session = createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" });
    const list = events(session.feed(lines.slice(1), 1, false).items);
    expect(list.map((event) => event.id)).toEqual(["b", "c"]);
    expect(list.map((event) => event.contextTokens?.basis)).toEqual(["estimate", "estimate"]);
  });

  test("only the rows of the resolved round change identity, and a repeat feed changes none", () => {
    const user = JSON.stringify({ type: "user", timestamp: at(0), message: { role: "user", content: "go" } });
    const lines = [
      user,
      claudeAssistant("m1", sonnet1, [toolUse("a")]),
      claudeResult("a", 26_024),
      claudeAssistant("m2", sonnet2, [text("between"), toolUse("b")]),
      claudeResult("b", 2_400),
    ];
    const session = createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" });
    const before = session.feed(lines, 0, false);
    expect(session.feed(lines, 0, false)).toBe(before);
    const a = before.items.find((entry) => entry.item.kind === "tool" && entry.item.id === "a")!;
    const b = before.items.find((entry) => entry.item.kind === "tool" && entry.item.id === "b")!;
    const first = before.items[0].item;
    expect((a.item as ToolEvent).contextTokens?.basis).toBe("measured");
    expect((b.item as ToolEvent).contextTokens?.basis).toBe("estimate");
    const next = claudeAssistant("m3", { input: 1, read: promptOf(sonnet2) + 2_000, created: 0, output: 3 }, [text("end")]);
    const after = session.feed([...lines, next], 0, false);
    expect(after.items[0].item).toBe(first);
    expect(after.items.find((entry) => entry.item.kind === "tool" && entry.item.id === "a")?.item).toBe(a.item);
    const b2 = after.items.find((entry) => entry.item.kind === "tool" && entry.item.id === "b")!;
    expect(b2.item).not.toBe(b.item);
    expect((b2.item as ToolEvent).contextTokens?.basis).toBe("measured");
  });

  test("a folded group sums its calls and is approximate when any is", () => {
    const items = buildFeed(claudeFile, [...example2(), example2Next()], false, "").items;
    const group = items.find((item) => item.kind === "cmd-group");
    expect(group?.kind === "cmd-group" && group.contextTokens).toEqual({ n: 21_902, basis: "estimate" });
  });
});

/* ------------------------------------------------------------------ Codex */

const codexItem = (payload: object) => JSON.stringify({ type: "response_item", timestamp: at(clock++), payload });
const codexEvent = (payload: object) => JSON.stringify({ type: "event_msg", timestamp: at(clock++), payload });
const tokenCount = (input: number, output: number, total: number) =>
  codexEvent({
    type: "token_count",
    info: {
      last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output },
      total_token_usage: { total_tokens: total },
    },
  });
const shellCall = (id: string) => codexItem({ type: "function_call", name: "exec_command", call_id: id, arguments: JSON.stringify({ cmd: `echo ${id}` }) });
const shellOutput = (id: string, chars: number) => codexItem({ type: "function_call_output", call_id: id, output: filler(chars) });
const finalMessage = () => codexItem({ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] });

describe("Codex", () => {
  const example3 = () => [
    shellCall("c1"), shellCall("c2"), shellCall("c3"), shellCall("c4"),
    shellOutput("c1", 5_710), shellOutput("c2", 33_970), shellOutput("c3", 15_584), shellOutput("c4", 40_170),
    tokenCount(27_153, 699, 27_852),
  ];
  const example3Next = () => [finalMessage(), tokenCount(59_848, 20, 87_720)];

  test("example 3: four parallel calls share the growth, the token_count arriving after their outputs", () => {
    const list = parse(codexFile, [...example3(), ...example3Next()]);
    expect(list.map((event) => event.contextTokens?.n)).toEqual([1_914, 11_389, 5_225, 13_468]);
    expect(list.every((event) => event.contextTokens?.basis === "shared")).toBe(true);
  });

  test("a repeated token_count of the same response changes nothing", () => {
    const repeated = [...example3(), tokenCount(27_153, 699, 27_852), ...example3Next()];
    expect(parse(codexFile, repeated).map((event) => event.contextTokens?.n)).toEqual([1_914, 11_389, 5_225, 13_468]);
  });

  test("before the next response lands the calls hold their estimates", () => {
    const list = parse(codexFile, example3());
    expect(list.map((event) => event.contextTokens?.basis)).toEqual(["estimate", "estimate", "estimate", "estimate"]);
    expect(list[0].contextTokens?.n).toBe(Math.round(5_710 / 3.6));
  });

  test("one call is measured without a ~", () => {
    const lines = [shellCall("c1"), shellOutput("c1", 4_000), tokenCount(1_000, 50, 1_050), finalMessage(), tokenCount(3_050, 10, 4_110)];
    expect(parse(codexFile, lines)[0].contextTokens).toEqual({ n: 2_000, basis: "measured" });
  });

  test("a user message between the outputs and the token_count keeps the estimate", () => {
    const lines = [
      shellCall("c1"), shellOutput("c1", 3_600),
      codexEvent({ type: "user_message", message: "one more thing" }),
      tokenCount(1_000, 50, 1_050), finalMessage(), tokenCount(9_050, 10, 10_110),
    ];
    expect(parse(codexFile, lines)[0].contextTokens).toEqual({ n: 1_000, basis: "estimate" });
  });

  test("a developer message after the token_count keeps the estimate", () => {
    const lines = [
      shellCall("c1"), shellOutput("c1", 3_600), tokenCount(1_000, 50, 1_050),
      codexItem({ type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>" }] }),
      finalMessage(), tokenCount(9_050, 10, 10_110),
    ];
    expect(parse(codexFile, lines)[0].contextTokens?.basis).toBe("estimate");
  });

  test("a response that ran a hosted web search keeps the earlier round's estimate", () => {
    const search = codexItem({ type: "web_search_call", status: "completed", action: { type: "search", query: "q" } });
    const lines = [shellCall("c1"), shellOutput("c1", 4_000), tokenCount(1_000, 50, 1_050), search, finalMessage(), tokenCount(18_000, 10, 19_060)];
    expect(parse(codexFile, lines)[0].contextTokens).toEqual({ n: 1_111, basis: "estimate" });
  });

  test("a call with no result has no number", () => {
    const [call] = parse(codexFile, [shellCall("c1")]);
    expect(call.contextTokens).toBeUndefined();
  });

  describe("code mode", () => {
    const nested = (id: string, stdout: string) =>
      codexEvent({
        type: "item_completed",
        turn_id: "t1",
        item: { type: "CommandExecution", id, command: ["/usr/bin/zsh", "-lc", `echo ${id}`], cwd: "/w", stdout, exit_code: 0, status: "completed", duration: { secs: 0, nanos: 240000000 } },
        started_at_ms: 1789898400000,
        completed_at_ms: 1789898400240,
      });
    const exec = (input: string) => codexItem({ type: "custom_tool_call", name: "exec", call_id: "wrapper", input });
    const picture = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const wrapperOutput = () =>
      codexItem({
        type: "custom_tool_call_output",
        call_id: "wrapper",
        output: [{ type: "input_text", text: `Script completed\nOutput:\n${filler(1_194)}` }, { type: "input_image", image_url: picture }],
      });
    const example4 = () => [
      exec('text(await tools.exec_command({cmd:"echo a"}));'),
      nested("exec-shell", filler(1_194)),
      wrapperOutput(),
      tokenCount(50_150, 131, 50_281),
    ];

    test("example 4: a result with a picture is measured on the nested row the feed draws", () => {
      const list = parse(codexFile, [...example4(), finalMessage(), tokenCount(52_531, 5, 102_817)]);
      expect(list.some((event) => event.id === "wrapper")).toBe(false);
      expect(list.find((event) => event.id === "exec-shell")?.contextTokens).toEqual({ n: 2_250, basis: "measured" });
    });

    test("the same rollout without the next token_count shows nothing: a text estimate would understate a picture", () => {
      const list = parse(codexFile, example4());
      expect(list.find((event) => event.id === "exec-shell")?.contextTokens).toBeUndefined();
    });

    test("an exec that stays visible carries the number and its nested rows carry none", () => {
      const lines = [
        exec('text(await tools.exec_command({cmd:"echo a"}));'),
        nested("exec-shell", "ok"),
        codexItem({ type: "custom_tool_call_output", call_id: "wrapper", output: `Script failed\n${filler(3_600)}` }),
        tokenCount(1_000, 50, 1_050),
        finalMessage(),
        tokenCount(3_050, 10, 4_110),
      ];
      const list = parse(codexFile, lines);
      expect(list.find((event) => event.id === "wrapper")?.contextTokens).toEqual({ n: 2_000, basis: "measured" });
      expect(list.find((event) => event.id === "exec-shell")?.contextTokens).toBeUndefined();
    });
  });
});

describe("engines without a calibrated ratio", () => {
  test("OpenClaw and Copilot rows carry no number", () => {
    const openclaw = [
      JSON.stringify({ type: "message", timestamp: at(0), message: { role: "assistant", provider: "p", model: "m", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }] } }),
      JSON.stringify({ type: "message", timestamp: at(1), message: { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: filler(5_000) }] } }),
    ];
    const list = parse({ path: "/tmp/x.jsonl", engine: "openclaw", fmt: "openclaw", activity: "idle" } as FileEntry, openclaw);
    expect(list).toHaveLength(1);
    expect(list[0].contextTokens).toBeUndefined();
  });
});
