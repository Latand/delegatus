import fs from "node:fs";
import { expect, test } from "bun:test";
import { inboxFilesDir } from "./inboxFiles";
import { prepareMessageFiles } from "./longMessageFile";
import { MAX_INBOX_FILE_BYTES } from "./filePolicy";
import { messageTextAttachmentFromText, messageTextExcerpt } from "./messageTextAttachment";

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

test("the delivered marker carries a one-line excerpt of the opening words", () => {
  const text = `  Привіт,\n\tось   експорт.\n${"ї".repeat(30_000)}`;
  const prepared = prepareMessageFiles(text, [], "excerpt");
  const lines = prepared.payload.split("\n");
  expect(lines).toHaveLength(3);
  expect(lines[1]).toBe(`The message begins: Привіт, ось експорт. ${"ї".repeat(160 - "Привіт, ось експорт. ".length)}…`);
  expect(lines[2]).toBe(prepared.textAttachment!.path);
  const marker = messageTextAttachmentFromText(prepared.payload)!;
  expect(marker.excerpt).toBe(lines[1]!.slice("The message begins: ".length));
  expect(marker.path).toBe(prepared.textAttachment!.path);
  expect(marker.operatorPaths).toEqual([]);
});

test("an excerpt never splits a character and a blank message has none", () => {
  expect(messageTextExcerpt("😀".repeat(300))).toBe(`The message begins: ${"😀".repeat(160)}…`);
  expect(messageTextExcerpt(" \n\t ")).toBeNull();
  expect(messageTextExcerpt("short")).toBe("The message begins: short");
});

test("the marker separates the operator's own files from the generated one", () => {
  const files = ["a.log", "b.csv", "c.pdf"].map(name => ({ name, data: Buffer.from(name) }));
  const prepared = prepareMessageFiles("я".repeat(30_000), files, "marker-files");
  const marker = messageTextAttachmentFromText(prepared.payload)!;
  expect(marker.operatorPaths).toHaveLength(3);
  expect(marker.operatorPaths).not.toContain(marker.path);
});
