import fs from "node:fs";
import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { conversationHostPOST } from "./handlers";
import { setConversationHostDependenciesForTests } from "./dependencies";
import { assertStructuredTextEnvelope } from "@/lib/runtime/structuredContent";

const admitted: { text: string; images?: unknown[] }[] = [];
setConversationHostDependenciesForTests({
  completedFileScan: async () => ({ snapshot: { files: [] } }) as never,
  recordOperatorRequest: () => null,
  collectImagePayloads: body => ({ images: (body as { images?: never[] }).images ?? [], error: null }),
  enqueueStructuredMessage: async input => {
    assertStructuredTextEnvelope(input.text);
    admitted.push(input);
    return { ok: true, structured: true, outcome: "queued", target: "conversation_long_text",
      operationId: "op_long_text", receipt: { operationId: "op_long_text", status: "queued" } } as never;
  },
});
afterAll(() => setConversationHostDependenciesForTests(null));

function request(text: string, key: string, files: unknown[] = [], images: unknown[] = []) {
  return new NextRequest("http://127.0.0.1/api/conversation-host", { method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ conversationId: "conversation_long_text", text, clientMessageId: key, files, images }) });
}

test("the seat/legacy send path converts long text, preserves files and images, and replays identically", async () => {
  const text = "я".repeat(30_000);
  const file = { name: "notes.txt", base64: Buffer.from("notes").toString("base64") };
  const image = { mime: "image/png", base64: Buffer.from("image").toString("base64") };
  const response = await conversationHostPOST(request(text, "seat-long-text", [file], [image]));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.filePaths).toHaveLength(2);
  expect(fs.readFileSync(body.textAttachment.path, "utf8")).toBe(text);
  expect(fs.readFileSync(body.filePaths[0], "utf8")).toBe("notes");
  expect(admitted.at(-1)?.images).toEqual([image]);
  const payload = admitted.at(-1)?.text;
  const retry = await conversationHostPOST(request(text, "seat-long-text", [file], [image]));
  expect(retry.status).toBe(200);
  expect(admitted.at(-1)?.text).toBe(payload);
});

test("the seat/legacy short-message payload stays byte-identical", async () => {
  const text = "коротке повідомлення";
  const response = await conversationHostPOST(request(text, "seat-short-text"));
  expect(response.status).toBe(200);
  expect(Buffer.from(admitted.at(-1)!.text)).toEqual(Buffer.from(text));
  expect((await response.json()).textAttachment).toBeUndefined();
});
