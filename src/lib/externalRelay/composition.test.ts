import { expect, test } from "bun:test";
import { answerCapabilities, checkedAnswerV2 } from "./answerV2";
import { validateAnswerComposition } from "./composition";
import { richRequest } from "./rich.fixture";
import { ExternalRelayError } from "./client";
import type { ExternalRelayAnswer, RelayAttachment } from "./protocol";

const request = () => {
  const r = richRequest(true);
  r.input.conversation = [{ id: "message", author: { key: "person_a", name: "Person", self: false }, sent_at: "2026-10-17T12:00:00Z", text: "Hello", reply_to: null }];
  r.input.requester = { key: "person_b", is_admin: false, can_restrict_members: false, can_delete_messages: false, is_anonymous_admin: false, is_owner: false };
  return r;
};
const reply = (text = "😀 Hello Person", extra = {}): ExternalRelayAnswer => ({ action: "reply", text, reply_to: null, format: "rich_markdown", ...extra });
const mention = { author_key: "person_a", offset: 8, length: 6 };
function refuses(fn: () => unknown, code = "malformed", status = 400) {
  try { fn(); throw new Error("accepted hostile input"); }
  catch (error) { expect(error).toBeInstanceOf(ExternalRelayError); expect(error).toMatchObject({ code, status }); }
}
test("rich answer preserves typed mentions at original scalar offsets", () => {
  const r = request();
  const value = reply(undefined, { mentions: [mention] });
  expect(checkedAnswerV2(value, r, answerCapabilities(r, "codex"))).toMatchObject(value);
  validateAnswerComposition(value, r, []);
  validateAnswerComposition(reply("Person_Name", { mentions: [{ ...mention, offset: 0, length: 11 }] }), r, []);
  validateAnswerComposition(reply("**Person**", { mentions: [{ ...mention, offset: 2 }] }), r, []);
  validateAnswerComposition(reply("x ".repeat(16), { mentions: Array.from({ length: 16 }, (_, i) => ({ ...mention, offset: i * 2, length: 1 })) }), r, []);
  validateAnswerComposition(reply("x".repeat(128), { mentions: [{ ...mention, offset: 0, length: 128 }] }), r, []);
});

test("heading delimiters stay outside mention leaves, including nested block prefixes", () => {
  const valid = [
    { text: "# Person ###", offset: 2, length: 6 },
    { text: "> - ## Person ##", offset: 7, length: 6 },
    { text: "- > ## Person ###", offset: 7, length: 6 },
  ];
  for (const item of valid) {
    validateAnswerComposition(reply(item.text, { mentions: [{ ...mention, offset: item.offset, length: item.length }] }), request(), []);
  }
  for (const item of [
    { text: "# Person ###", offset: 2, length: 10 },
    { text: "> - ## Person ##", offset: 7, length: 9 },
    { text: "- > ## Person ###", offset: 7, length: 10 },
    { text: "## Person ##", offset: 3, length: 9 },
  ]) {
    refuses(() => validateAnswerComposition(reply(item.text, { mentions: [{ ...mention, offset: item.offset, length: item.length }] }), request(), []));
  }
});
test("mentions cannot cross Markdown container and closing syntax", () => {
  const invalid = [
    { text: "- > Person", offset: 2, length: 8 },
    { text: "***Person** label*", offset: 3, length: 8 },
    { text: "# Person #######", offset: 2, length: 14 },
  ];
  for (const item of invalid) refuses(() => validateAnswerComposition(reply(item.text, {
    mentions: [{ ...mention, offset: item.offset, length: item.length }],
  }), request(), []));
  const nestedList = "- Outer\n    - Person";
  validateAnswerComposition(reply(nestedList, { mentions: [{ ...mention, offset: 14, length: 6 }] }), request(), []);
  const nestedQuoteList = "> - Outer\n>     - Person";
  validateAnswerComposition(reply(nestedQuoteList, { mentions: [{ ...mention, offset: 18, length: 6 }] }), request(), []);
  refuses(() => validateAnswerComposition(reply("    Person", { mentions: [{ ...mention, offset: 4, length: 6 }] }), request(), []));
  refuses(() => validateAnswerComposition(reply(">     Person", { mentions: [{ ...mention, offset: 6, length: 6 }] }), request(), []));
  validateAnswerComposition(reply("- Intro\n    Person", { mentions: [{ ...mention, offset: 12, length: 6 }] }), request(), []);
});
test("every malformed mention is refused before completion", () => {
  const cases = [null, {}, [null], [{ ...mention, extra: true }], [{ ...mention, offset: -1 }], [{ ...mention, offset: 0.5 }], [{ ...mention, offset: 31999 }], [{ ...mention, length: 0 }], [{ ...mention, length: 129 }], [{ ...mention, length: 1.5 }], [{ ...mention, author_key: "foreign" }], [{ ...mention, author_key: "123" }], [{ ...mention, author_key: "person_a " }], [mention, mention], [{ ...mention, offset: 9, length: 1 }, mention], Array(17).fill(mention)];
  for (const mentions of cases) refuses(() => checkedAnswerV2(reply(undefined, { mentions }), request(), answerCapabilities(request(), "codex")));
  for (const text of ["`Person`", "[Person](https://example.com)", "**Per**son", "Pers\non", "      ", "Per\tson", "```\nPerson\n```", "    Person", "![](attachment:photo_a)", "`code\nPerson`", "[Person\nlabel](https://example.com)", "> ```\n> Person\n> ```"])
    refuses(() => validateAnswerComposition(reply(text, { mentions: [{ ...mention, offset: Math.max(0, text.indexOf("Person")), length: 6 }] }), request(), []));
  refuses(() => validateAnswerComposition(reply(undefined, { format: "plain", mentions: [mention] }), request(), []));
  refuses(() => validateAnswerComposition(reply("\ud800 Person", { mentions: [{ ...mention, offset: 2 }] }), request(), []));
  refuses(() => validateAnswerComposition({ ...reply("", { mentions: [mention] }), action: "ignore" }, request(), []));
  for (const tags of [["bot"], ["channel"], ["anonymous"], ["assistant"]]) {
    const r = request(); r.input.conversation[0]!.author.tags = tags;
    refuses(() => validateAnswerComposition(reply(undefined, { mentions: [mention] }), r, []));
  }
  const self = request(); self.input.conversation[0]!.author.self = true;
  refuses(() => validateAnswerComposition(reply(undefined, { mentions: [mention] }), self, []));
  const anon = request(); anon.input.requester!.is_anonymous_admin = true;
  refuses(() => validateAnswerComposition(reply(undefined, { mentions: [{ ...mention, author_key: "person_b" }] }), anon, []));
  const trimmed = request(); trimmed.input.conversation = [];
  refuses(() => validateAnswerComposition(reply(undefined, { mentions: [mention] }), trimmed, []));
});
const photos: RelayAttachment[] = ["photo_a", "photo_b"].map(attachment_id => ({ attachment_id, kind: "photo", caption: "caption" }));
test("carousel refs preserve attachment order and permit implicit composition", () => {
  const r = request();
  for (const attachments of [photos.slice(0, 1), photos, [...photos, ...["photo_c", "photo_d"].map(attachment_id => ({ attachment_id, kind: "photo" as const }))], [...photos, { attachment_id: "doc", kind: "document" as const }]]) {
    validateAnswerComposition(reply("Body"), r, attachments);
    validateAnswerComposition(reply("Body", { format: "plain" }), r, attachments);
    const text = attachments.filter(a => a.kind === "photo").map(a => `![](attachment:${a.attachment_id})`).join("\n\n");
    validateAnswerComposition(reply(text), r, attachments);
  }
  const text = "Before\n\n![](attachment:photo_a)\n\n![](attachment:photo_b)\n\nAfter";
  expect(checkedAnswerV2(reply(text), r, answerCapabilities(r, "codex"))).toMatchObject({ format: "rich_markdown", text });
  validateAnswerComposition(reply(text), r, photos);
});
test("hostile photo references retain their exact contract refusal", () => {
  const r = request();
  for (const text of ["![](attachment:photo_b)\n![](attachment:photo_a)", "![](attachment:photo_a)", "![](attachment:photo_a)\n![](attachment:photo_a)", "![](attachment:foreign)", "![](attachment:doc)", "prefix ![](attachment:photo_a)", "> ![](attachment:photo_a)", "![alt](attachment:photo_a)", "![](https://example.com/a.png)", "![](attachment:../secret)", "<tg-slideshow>x</tg-slideshow>", "![](attachment:photo_a)\ntext\n![](attachment:photo_b)"])
    refuses(() => validateAnswerComposition(reply(text), r, photos), "invalid_format", 422);
  refuses(() => validateAnswerComposition(reply("![](attachment:photo_a)", { format: "plain" }), r, photos), "invalid_format", 422);
  refuses(() => validateAnswerComposition(reply("![](attachment:photo_a)\n![](attachment:photo_b)"), r, photos, photos.slice(0, 1)), "attachment_not_ready", 422);
  validateAnswerComposition(reply("`![](https://example.com/image)`"), r, []);
  validateAnswerComposition(reply("\\![](https://example.com/image)"), r, []);
  const noMedia = request(); noMedia.features = ["relay_rich_messages"];
  refuses(() => validateAnswerComposition(reply("![](attachment:photo_a)"), noMedia, photos.slice(0, 1)), "invalid_format", 422);
});
