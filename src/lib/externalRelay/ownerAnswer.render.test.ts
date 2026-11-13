import { expect, test } from "bun:test";
import { ownerAnswer } from "./ownerRun";
import { richRequest } from "./rich.fixture";

// Run against an isolated export of the receiving service. No bot or HTTP
// transport is imported: its admitted Markdown renderer and Telethon's HTML
// entity parser are enough to exercise the delivery boundary offline.
const render = process.env.LLV_RELAY_SERVICE_ROOT && process.env.LLV_RELAY_RENDER_PYTHON ? test : test.skip;
const cases = [
  ["😀 **Вітаю**", "😀 Вітаю", [{ type: "MessageEntityBold", offset: 3, length: 5 }]],
  ["😀 *Вітаю*", "😀 Вітаю", [{ type: "MessageEntityItalic", offset: 3, length: 5 }]],
  ["[Опис](https://example.com/)", "Опис", [{ type: "MessageEntityTextUrl", offset: 0, length: 4, url: "https://example.com/" }]],
  ["- **Перший**\n- *Другий*", "- Перший\n\n\n- Другий", [{ type: "MessageEntityBold", offset: 2, length: 6 }, { type: "MessageEntityItalic", offset: 13, length: 6 }]],
] as const;

for (const [source, text, entities] of cases)
render(`owner reply renders Telegram entities: ${entities.map(entity => entity.type).join(", ")}`, async () => {
  const request = richRequest();
  const answer = ownerAnswer(source, request, { messageId: request.input.respond_to!, text: "Привіт", requestText: null });
  expect(answer).toMatchObject({ action: "reply", format: "rich_markdown" });
  const child = Bun.spawn([process.env.LLV_RELAY_RENDER_PYTHON!, "-c", `
import json, sys
from application.usecase.clones.relay_output import validate_answer, fallback_html
from telethon.extensions.html import parse
answer = json.load(sys.stdin)
_, output = validate_answer({"lease_id": "lease_fixture", "outcome": "answered", "answer": answer, "duration_ms": 1}, ("relay_rich_messages",), {})
text, entities = parse(fallback_html(output.flat_markdown))
print(json.dumps({"text": text, "entities": [{"type": type(entity).__name__, "offset": entity.offset, "length": entity.length, **({"url": entity.url} if hasattr(entity, "url") else {})} for entity in entities]}))
`], { cwd: process.env.LLV_RELAY_SERVICE_ROOT, env: { ...process.env, PYTHONPATH: process.env.LLV_RELAY_SERVICE_ROOT, PYTHONDONTWRITEBYTECODE: "1" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  await child.stdin.write(JSON.stringify(answer));
  child.stdin.end();
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual({ text, entities });
});
