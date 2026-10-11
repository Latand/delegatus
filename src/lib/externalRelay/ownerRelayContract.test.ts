import { expect, test } from "bun:test";
import { ownerTierFor } from "./profile";
import { requestSchema } from "./protocol";
import { contextRequest } from "./request.fixture";
import { ownerRunPrompt, runOwnerAgent } from "./ownerRun";

const request = requestSchema.parse({ ...contextRequest, answer: { ...contextRequest.answer, max_chars: 4000 },
  input: { ...contextRequest.input, requester: { ...contextRequest.input.requester, is_owner: true } },
});
const owner = ownerTierFor({ ownerTier: true }, request)!;

test("owner contract carries the ask through a refused relay and explains a concrete owner action", () => {
  const prompt = ownerRunPrompt(request, owner, 3);
  for (const instruction of [
    "send_message_to_orchestrator, quoting <owner_request>",
    "If the handoff is refused or unavailable, continue the work yourself with your tools",
    "explain what failed, what you completed or queued, and the concrete action the owner can take",
    'never end at "nothing started" or hide a refusal with a silent sentinel',
    "status assigned so the seat tick wakes that project's seat with an unstarted-task item",
    "check that the project has a designated seat and an enabled tick",
    "Report the task title and project in your reply",
  ]) expect(prompt).toContain(instruction);
});

test("owner run delivers the refusal outcome and queued board destination to the chat", async () => {
  const reply = "Передачу відхилено. Задача «Виконати зміну» чекає на дошці project-b. Увімкніть перевірки місця оркестратора, щоб він її отримав.";
  const result = await runOwnerAgent({ request, owner, accountId: "fixture",
    target: { id: "target", name: "Target", answered_by: "install", fallback: "service", enabled: true, engine: "codex", model: "auto", effort: "low", project: null, concurrency: 1, hardCapMinutes: 3 },
    hardCapMs: 2000, onConversation: () => {}, ports: {
      launch: async body => {
        expect(body.prompt).toContain("If the handoff is refused or unavailable");
        return { status: 202, body: { conversationId: "conversation_fixture" } };
      },
      observe: async () => ({ state: "ended", finalText: reply }),
      stop: async () => { throw new Error("a settled reply needs no cancellation"); }, pollMs: 1,
    },
  }).done;
  expect(result).toMatchObject({ status: "done", answer: { action: "reply", text: reply, reply_to: owner.messageId } });
});
