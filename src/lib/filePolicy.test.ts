import { expect, test } from "bun:test";
import { screenAttachments } from "./attachmentIntake";
import { MAX_INBOX_FILE_BYTES, MAX_INBOX_FILES_TOTAL_BYTES, MAX_INBOX_FILES } from "./filePolicy";

const MiB = 1024 * 1024;
function picked(name: string, size: number): File {
  return { name, size, type: "audio/ogg" } as File;
}

test("composer admits a 100 MiB recording and a 200 MiB batch, with five slots", () => {
  const files = [picked("recording.ogg", 100 * MiB), picked("archive.bin", 100 * MiB)];
  const screened = screenAttachments(files, { acceptFiles: true });
  expect(screened.refusals).toEqual([]);
  expect(screened.accepted.map(entry => entry.file.name)).toEqual(files.map(file => file.name));
  expect(MAX_INBOX_FILE_BYTES).toBe(100 * MiB);
  expect(MAX_INBOX_FILES_TOTAL_BYTES).toBe(200 * MiB);
  expect(MAX_INBOX_FILES).toBe(5);
});

test("one byte beyond the file and batch boundaries names the new limits", () => {
  const tooBig = screenAttachments([picked("recording.ogg", 100 * MiB + 1)], { acceptFiles: true });
  expect(tooBig.accepted).toEqual([]);
  expect(tooBig.refusals[0]?.name).toBe("recording.ogg");
  expect(tooBig.refusals[0]?.reason).toContain("100 MB");
  const tooManyBytes = screenAttachments([picked("extra.bin", 1)], {
    acceptFiles: true, staged: { files: 2, bytes: 200 * MiB },
  });
  expect(tooManyBytes.refusals[0]?.reason).toContain("200 MB");
});
