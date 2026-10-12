import path from "node:path";
import { MAX_INBOX_FILE_BYTES, MAX_INBOX_FILES_TOTAL_BYTES } from "./filePolicy";
import { inboxFilePaths, inboxFileText, type InboxFileUpload } from "./inboxFiles";
import { messageTextExcerpt } from "./messageTextAttachment";
import { assertStructuredTextEnvelope, MAX_STRUCTURED_TEXT_BYTES } from "./runtime/structuredContent";

/** Plans the whole envelope before any bytes are written. The generated file
 * is additional to the operator's admitted batch, including a full five files. */
export function prepareMessageFiles(text: string, files: readonly InboxFileUpload[], batch: string) {
  const payload = inboxFileText(text, inboxFilePaths(files, batch));
  if (Buffer.byteLength(payload.trim(), "utf8") <= MAX_STRUCTURED_TEXT_BYTES) {
    return { files, payload, textAttachment: undefined };
  }
  const data = Buffer.from(text, "utf8");
  if (data.length > MAX_INBOX_FILE_BYTES
    || files.reduce((total, file) => total + file.data.length, data.length) > MAX_INBOX_FILES_TOTAL_BYTES) {
    throw new Error("message text is too large to convert automatically; attach a text file within the attachment size limit");
  }
  const expanded = [...files, { name: "message.txt", data }];
  const paths = inboxFilePaths(expanded, batch);
  const filePath = paths.at(-1)!;
  const name = path.basename(filePath);
  const excerpt = messageTextExcerpt(text);
  const converted = inboxFileText(
    [`The full message is attached as ${name}. Read the file in full before responding.`, excerpt].filter(Boolean).join("\n"),
    paths,
  );
  assertStructuredTextEnvelope(converted);
  return { files: expanded, payload: converted, textAttachment: { name, path: filePath, text: converted } };
}
