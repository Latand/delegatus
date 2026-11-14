import { expect, test } from "bun:test";
import { ownerTierFor } from "./profile";
import { requestSchema } from "./protocol";
import { contextRequest } from "./request.fixture";
import { ownerAnswer, runOwnerAgent } from "./ownerRun";
import { richRequest } from "./rich.fixture";

for (const text of ["**Вітаю**", "*Вітаю*", "[Опис](https://example.com/)", "- **Перший**\n- *Другий*", "Звичайна відповідь", "x".repeat(4001)])
test(`owner chat replies preserve negotiated Markdown without selecting answer parts (${text.length} chars)`, async () => {
  const request = richRequest();
  const owner = { messageId: request.input.respond_to!, text: "Привіт", requestText: null };
  const result = await runOwnerAgent({ request, owner, accountId: "fixture",
    target: { id: "target", name: "Target", answered_by: "install", fallback: "service", enabled: true, engine: "claude", model: "auto", effort: "low", project: null, concurrency: 1, hardCapMinutes: 3 },
    hardCapMs: 2000, onConversation: () => {}, ports: {
      launch: async () => ({ status: 202, body: { conversationId: "conversation_chat_reply" } }),
      observe: async () => ({ state: "ended", finalText: text }),
      stop: async () => { throw new Error("a settled reply needs no cancellation"); }, pollMs: 1,
    },
  }).done;
  expect(result).toMatchObject({ status: "done", answer: { action: "reply", text, format: "rich_markdown", reply_to: owner.messageId } });
});

test("the default rich reply retains the existing bounded fallback for unsupported content", () => {
  const request = richRequest();
  const owner = { messageId: request.input.respond_to!, text: "Привіт", requestText: null };
  const text = "<b>unsupported</b>" + "x".repeat(4000);
  expect(ownerAnswer(text, request, owner)).toMatchObject({ format: "plain", text: text.slice(0, 3999) + "…" });
});

const request = requestSchema.parse({ ...contextRequest, answer: { ...contextRequest.answer, max_chars: 4000 },
  input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true } },
});
const owner = ownerTierFor({ ownerTier: true }, request)!;

test("owner run delivers the refusal outcome and queued board destination to the chat", async () => {
  const reply = "Передачу відхилено. Задача «Виконати зміну» чекає на дошці project-b. Увімкніть перевірки місця оркестратора, щоб він її отримав.";
  const result = await runOwnerAgent({ request, owner, accountId: "fixture",
    target: { id: "target", name: "Target", answered_by: "install", fallback: "service", enabled: true, engine: "codex", model: "auto", effort: "low", project: null, concurrency: 1, hardCapMinutes: 3 },
    hardCapMs: 2000, onConversation: () => {}, ports: {
      launch: async () => {
        return { status: 202, body: { conversationId: "conversation_fixture" } };
      },
      observe: async () => ({ state: "ended", finalText: reply }),
      stop: async () => { throw new Error("a settled reply needs no cancellation"); }, pollMs: 1,
    },
  }).done;
  expect(result).toMatchObject({ status: "done", answer: { action: "reply", text: reply, reply_to: owner.messageId } });
});

for (const text of ["Proceed with the change", "Виконай зміну"])
test(`a missing owner outcome remains actionable within a small reply budget for ${text}`, async () => {
  const boundedRequest = requestSchema.parse({ ...request, answer: { ...request.answer, max_chars: 20 } });
  const result = await runOwnerAgent({ request: boundedRequest, owner: { ...owner, text }, accountId: "fixture",
    target: { id: "target", name: "Target", answered_by: "install", fallback: "service", enabled: true, engine: "codex", model: "auto", effort: "low", project: null, concurrency: 1, hardCapMinutes: 3 },
    hardCapMs: 2000, onConversation: () => {}, ports: {
      launch: async () => ({ status: 202, body: { conversationId: "conversation_fixture" } }),
      observe: async () => ({ state: "ended", finalText: null }),
      stop: async () => {},
    },
  }).done;
  expect(result).toMatchObject({ status: "done", answer: { action: "reply", reply_to: owner.messageId } });
  const answer = result.answer as { text: string };
  expect(answer.text).toContain(/[а-яіїєґ]/iu.test(text) ? "Повтори" : "Retry");
  expect(answer.text).not.toContain("…");
  expect(Array.from(answer.text).length).toBeLessThanOrEqual(20);
  expect(/[а-яіїєґ]/iu.test(answer.text)).toBe(/[а-яіїєґ]/iu.test(text));
});

test("chat operations can still continue through the service's assistant", async () => {
  const result = await runOwnerAgent({ request, owner, accountId: "fixture",
    target: { id: "target", name: "Target", answered_by: "install", fallback: "service", enabled: true, engine: "codex", model: "auto", effort: "low", project: null, concurrency: 1, hardCapMinutes: 3 },
    hardCapMs: 2000, onConversation: () => {}, ports: {
      launch: async () => ({ status: 202, body: { conversationId: "conversation_fixture" } }),
      observe: async () => ({ state: "ended", finalText: "[handoff]" }),
      stop: async () => {},
    },
  }).done;
  expect(result).toMatchObject({ status: "done", answer: { action: "handoff", text: "", reply_to: null } });
});
