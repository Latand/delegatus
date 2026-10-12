import fs from "node:fs";
import { expect, test } from "bun:test";
import { inboxFilesDir } from "./inboxFiles";
import { prepareMessageFiles } from "./longMessageFile";
import { MAX_INBOX_FILE_BYTES } from "./filePolicy";

test("exact UTF-8 boundary remains unchanged and path overhead triggers conversion", () => {
  const text = "я".repeat(16_000);
  expect(prepareMessageFiles(text, [], "boundary").payload).toBe(text);
  const prepared = prepareMessageFiles(text, [{ name: "notes.txt", data: Buffer.from("note") }], "boundary");
  expect(prepared.textAttachment?.name).toBe("message.txt");
  expect(prepared.files.at(-1)?.data).toEqual(Buffer.from(text));
});

test("conversion preserves whitespace and accommodates all five operator files", () => {
  const text = `  ${"ї".repeat(30_000)}\r\n\t `;
  const files = Array.from({ length: 5 }, (_, n) => ({ name: `notes-${n}.txt`, data: Buffer.from(String(n)) }));
  const prepared = prepareMessageFiles(text, files, "five-files");
  expect(prepared.files).toHaveLength(6);
  expect(prepared.files.at(-1)?.data.toString("utf8")).toBe(text);
  expect(prepared.files.slice(0, 5)).toEqual(files);
});

test("an over-budget generated file refuses before any inbox write", () => {
  const before = fs.existsSync(inboxFilesDir()) ? fs.readdirSync(inboxFilesDir()) : [];
  expect(() => prepareMessageFiles("a".repeat(MAX_INBOX_FILE_BYTES + 1), [], "too-large")).toThrow("attach a text file");
  expect(fs.existsSync(inboxFilesDir()) ? fs.readdirSync(inboxFilesDir()) : []).toEqual(before);
});
