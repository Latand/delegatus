import { expect, test } from "bun:test";
import { cloneMethodPayload, cloneMultipart } from "./cloneMethods";
import { cloneMethodLimits, cloneMethodRights, decodeCloneMultipart } from "./cloneMethods.fixture";

const common = { client_key: "fixture-method-key", chat_id: -1000000000101, text: "", parse_mode: null, silent: false } as const;
test.each([
  ["sendPhoto", "photo", "can_send_photos"], ["sendDocument", "document", "can_send_documents"],
  ["sendVideo", "video", "can_send_videos"], ["sendAnimation", "animation", "can_send_other_messages"],
  ["sendAudio", "audio", "can_send_audios"], ["sendVoice", "voice", "can_send_voice_notes"],
  ["sendVideoNote", "video_note", "can_send_video_notes"], ["sendSticker", "sticker", "can_send_other_messages"],
] as const)("%s requires its advertised file kind and actual send right", (method, field, flag) => {
  const limits = cloneMethodLimits(); limits.methods.push(method); limits.files[field] = { mime_types: ["application/pdf"], max_bytes: 100 };
  const params = { chat_id: common.chat_id, [field]: new File(["fixture"], "fixture.pdf", { type: "application/pdf" }) };
  expect(cloneMethodPayload(method, params, common, limits, cloneMethodRights())).toMatchObject({ input: { method, [field]: `attach://${field}` }, files: [expect.objectContaining({ kind: field })] });
  expect(cloneMethodPayload(method, params, common, limits, cloneMethodRights({ [flag]: false }))).toBeNull();
  expect(cloneMethodPayload(method, params, common, limits, null)).toBeNull();
  expect(cloneMethodPayload(method, params, common, { ...limits, methods: [] }, cloneMethodRights())).toBeNull();
});
test.each([
  ["sendLocation", { latitude: 50, longitude: 30 }], ["sendVenue", { latitude: 50, longitude: 30, title: "Fixture", address: "Fixture" }],
  ["sendContact", { phone_number: "fixture", first_name: "Fixture" }],
  ["sendPoll", { question: "Fixture?", options: [{ text: "Yes" }, { text: "No" }] }], ["sendDice", { emoji: "🎲" }],
] as const)("%s preserves its JSON fields and refuses unknown options", (method, fields) => {
  const limits = cloneMethodLimits(); limits.methods.push(method);
  expect(cloneMethodPayload(method, { chat_id: common.chat_id, ...fields }, common, limits, cloneMethodRights()))
    .toMatchObject({ input: { method, ...fields }, files: [] });
  expect(cloneMethodPayload(method, { chat_id: common.chat_id, ...fields, allow_paid_broadcast: true }, common, limits, cloneMethodRights())).toBeNull();
});
test("multipart streams exact bytes and preserves quoted Unicode filenames", async () => {
  const bytes = Buffer.from([0, 255, 2]);
  const file = new File([bytes], 'fixture "é".pdf', { type: "application/pdf" });
  const payload = cloneMethodPayload("sendDocument", { chat_id: common.chat_id, document: file, caption: "Fixture" }, common, cloneMethodLimits(), cloneMethodRights())!;
  const upload = cloneMultipart(payload), chunks: Buffer[] = [];
  for await (const chunk of upload.body()) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks); expect(raw.length).toBe(upload.byteLength);
  const decoded = await decodeCloneMultipart({ "content-type": upload.contentType }, raw);
  expect(decoded.input).toEqual(payload.input); expect(decoded.files.get("document")!.name).toBe(file.name);
  expect(Buffer.from(await decoded.files.get("document")!.arrayBuffer())).toEqual(bytes);
});
test("unsupported parse mode, hidden options, missing parts and extra parts stay on the local route", () => {
  const document = new File(["fixture"], "fixture.pdf", { type: "application/pdf" });
  const params = { chat_id: common.chat_id, document };
  for (const extra of [{ parse_mode: "MarkdownV2" }, { protect_content: true }, { document: "attach://missing" }, { extra: document }])
    expect(cloneMethodPayload("sendDocument", { ...params, ...extra }, common, cloneMethodLimits(), cloneMethodRights())).toBeNull();
  expect(cloneMethodPayload("sendDocument", params, common, cloneMethodLimits(), cloneMethodRights({ status: "left" }))).toBeNull();
});
