import { expect, test } from "bun:test";
import { answerCapabilities, checkedAnswerV2, richTextRefusal, checkedButtons, checkedCaption, withAnswerParts } from "./answerV2";
import { answerSchema, checkedAnswer, requestSchema } from "./protocol";
import { sampleRequest } from "./request.fixture";
import { richRequest } from "./rich.fixture";
const request = richRequest(true);
const caps = answerCapabilities(request, "codex");
const reply = (text: string, format = "rich_markdown", extra = {}) => ({ action: "reply", text, reply_to: "unknown", format, ...extra });
test("negotiation requires per-request features, guide and attachment limits", () => {
  expect(caps).toMatchObject({ rich: true, media: true, generate: true, plainMax: 4000, richMax: 32000 });
  expect(answerCapabilities(request, "claude").generate).toBe(false);
  expect(answerCapabilities({ ...request, features: undefined }, "codex").rich).toBe(false);
  expect(answerCapabilities({ ...request, features: ["relay_media_out"] }, "codex").media).toBe(false);
  expect(answerCapabilities({ ...request, input: { ...request.input, format: undefined } }, "codex")).toMatchObject({ rich: false, plainMax: 4000 });
  const legacy = requestSchema.parse(sampleRequest);
  expect(withAnswerParts(answerSchema, answerCapabilities(legacy, "codex"))).toBe(answerSchema);
  expect(checkedAnswerV2(reply("hi"), legacy, answerCapabilities(legacy, "codex"))).toEqual(checkedAnswer(reply("hi"), legacy));
});
test("plain and rich caps count code points, preserve rich bytes, and downgrade once", () => {
  expect(checkedAnswerV2(reply("😀".repeat(4000), "plain"), request, caps)?.text.length).toBe(8000);
  expect(checkedAnswerV2(reply("x".repeat(4001), "plain"), request, caps)).toBeNull();
  expect(checkedAnswerV2(reply("😀".repeat(32000)), request, caps)?.text.length).toBe(64000);
  expect(checkedAnswerV2(reply("x".repeat(32001)), request, caps)).toBeNull();
  const drops: import("./answerV2").AnswerDrop[] = [];
  expect(checkedAnswerV2(reply("<b>hi</b>"), request, caps, undefined, drops)).toMatchObject({ format: "plain", text: "<b>hi</b>", reply_to: null });
  expect(drops).toHaveLength(1);
  expect(checkedAnswerV2(reply("<b>" + "x".repeat(4001)), request, caps)).toBeNull();
});
test("rich validation checks syntax, code exceptions, blocks, depth and columns", () => {
  for (const text of ["<b>x</b>", "<https://example.com>", "![x](https://example.com/x)", "[a](http://example.com)", "[a](tg://user?id=1)", "[a]: https://example.com", "[^a]", "[a](https://127.0.0.1)"])
    expect(richTextRefusal(text, caps)).not.toBeNull();
  for (const text of ["\\<b>literal", "`<b>x</b>`", "```html\n<b>x</b>\n```", "[a](https://example.com)"])
    expect(richTextRefusal(text, caps)).toBeNull();
  expect(richTextRefusal(Array(500).fill("# x").join("\n"), caps)).toBeNull();
  expect(richTextRefusal(Array(501).fill("# x").join("\n"), caps)).toBe("blocks");
  expect(richTextRefusal(">".repeat(16) + " x", caps)).toBeNull();
  expect(richTextRefusal(">".repeat(17) + " x", caps)).toBe("depth");
  expect(richTextRefusal(">".repeat(17) + " ```", caps)).toBe("depth");
  expect(richTextRefusal("\\`<b>raw</b>`", caps)).toBe("raw_html");
  expect(richTextRefusal("|" + Array(20).fill("x").join("|") + "|", caps)).toBeNull();
  expect(richTextRefusal("|" + Array(21).fill("x").join("|") + "|", caps)).toBe("table_columns");
});
test("buttons and captions enforce every wire bound", () => {
  const good = { text: "x".repeat(64), url: "https://example.com/" };
  expect(checkedButtons([Array(3).fill(good), Array(3).fill(good), [good]], caps)).toHaveLength(2);
  const bad = ["http://example.com", "tg://user?id=1", "https://" + ["a", "b"].join(":") + "@example.com", "https://127.0.0.1", "https://" + [10,1,2,3].join("."), "https://[::1]", "https://[::ffff:127.0.0.1]", "https://localhost", "https://a.localhost"];
  for (const url of bad) expect(checkedButtons([[{ ...good, url }]], caps)).toEqual([]);
  for (const text of [" ", "x".repeat(65), "a\nb"]) expect(checkedButtons([[{ ...good, text }]], caps)).toEqual([]);
  const prefix = "https://example.com/";
  expect(checkedButtons([[{ ...good, url: prefix + "x".repeat(2048 - prefix.length) }]], caps)[0]).toHaveLength(1);
  expect(checkedButtons([[{ ...good, url: prefix + "x".repeat(2049 - prefix.length) }]], caps)).toEqual([]);
  expect(checkedCaption("😀".repeat(512))).toBe("😀".repeat(512));
  expect(checkedCaption("😀".repeat(513))).toBe("😀".repeat(512));
});
test("ignore strips parts; a media-only reply keeps its local references for staging", () => {
  expect(checkedAnswerV2({ ...reply(""), action: "ignore", buttons: [[{text:"x",url:"https://example.com"}]] }, request, caps)).toEqual({ action: "ignore", text: "", reply_to: null, format: "plain", buttons: [] });
  expect(checkedAnswerV2(reply("", "plain", { attachments: [{path:"exec-1.png",kind:"photo",caption:"x"}] }), request, caps)).not.toBeNull();
});
