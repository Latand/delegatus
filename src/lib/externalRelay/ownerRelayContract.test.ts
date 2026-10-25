import { expect, test } from "bun:test";
import { ownerTierFor } from "./profile";
import { requestSchema } from "./protocol";
import { contextRequest } from "./request.fixture";
import { runOwnerAgent } from "./ownerRun";

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
