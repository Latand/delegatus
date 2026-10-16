import { expect, test } from "bun:test";
import { shortId, matchesShortId, resolveShortId, shortenHashesInText, shortIdsInAnswer } from "./shortIds";

const hash = "a1b2c3d4" + "e".repeat(56);
const sha = hash.slice(0, 40);
const uuid = ["a1b2c3d4", "0000", "4000", "8000", "000000000000"].join("-");
const values = [hash, sha, `repo-${hash.slice(0, 32)}`, `dir-${hash.slice(0, 32)}`, `pr_${hash.slice(0, 32)}`,
  `m_${hash.slice(0, 24)}`, `roles-3-${hash.slice(0, 20)}`, `evt_${hash.slice(0, 24)}`, `rpt_${hash.slice(0, 24)}`, `task-legacy:${hash}`, `task-v1:${uuid}`];

test.each(values)("short ids preserve the type and resolve case-insensitively: %s", value => {
  const short = shortId(value);
  expect(short.endsWith("a1b2c3d4")).toBe(true);
  expect(matchesShortId(value, value)).toBe(true);
  expect(matchesShortId(value, short)).toBe(true);
  expect(matchesShortId(value, short.slice(0, -1).toUpperCase())).toBe(true);
  expect(matchesShortId(value, short.slice(0, -2))).toBe(false);
  expect(matchesShortId(value, short.replace("a1b2c3d4", "ffffffff"))).toBe(false);
  if (short !== "a1b2c3d4") expect(matchesShortId(value, "a1b2c3d4")).toBe(false);
});

test("unknown ids, UUIDs and existing short forms stay byte-identical", () => {
  for (const value of ["a1b2c3d4", "a".repeat(12), "a".repeat(16), "unknown_" + hash.slice(0, 24), "task-v1:a1b2c3d4", uuid, "ordinary text"]) expect(shortId(value)).toBe(value);
});

test("set lookup refuses collisions and gives distinct extended candidates", () => {
  const other = "a1b2c3d4f" + "e".repeat(55);
  expect(resolveShortId([hash], "a1b2c3d4")).toEqual({ kind: "match", value: hash });
  expect(resolveShortId([hash, hash], hash)).toEqual({ kind: "match", value: hash });
  expect(resolveShortId([hash, other], "a1b2c3d4")).toEqual({ kind: "ambiguous", candidates: ["a1b2c3d4e", "a1b2c3d4f"] });
  expect(resolveShortId([hash], "ffffffff")).toEqual({ kind: "none" });
});

test("status text shortens hashes beside punctuation and keeps gate paths and UUIDs", () => {
  const path = "/self-update/1234567890abcdef/releases/123456789abc/scripts/gate-slot.sh";
  expect(shortenHashesInText(`head ${sha}. (repo-${hash.slice(0, 32)}) ${path} ${uuid}`))
    .toBe(`head a1b2c3d4. (repo-a1b2c3d4) ${path} ${uuid}`);
});

test("answer transformation is idempotent, preserves authored strings and traverses nested objects", () => {
  const authored = Object.fromEntries(["text", "details", "body", "prompt", "spec", "summary", "findings", "snippet", "content", "comment", "answer", "title", "task", "clientRequestId", "idempotencyKey"].map(key => [key, hash]));
  const input = { ...authored, revision: hash, stateDetail: `head ${sha}`, error: `changed ${sha}`, nested: { task: { revision: hash }, details: { sha } }, stages: [hash] };
  const output = shortIdsInAnswer(input);
  for (const [key, value] of Object.entries(authored)) expect(output[key as keyof typeof output]).toBe(value);
  expect(output.nested.task.revision).toBe("a1b2c3d4");
  expect(output.nested.details.sha).toBe("a1b2c3d4");
  expect(output.stages).toEqual(["a1b2c3d4"]);
  expect(shortIdsInAnswer(output)).toEqual(output);
  expect(input.revision).toBe(hash);
});

test("prototype media URLs carry usable short review and media references", () => {
  const review = `pr_${hash.slice(0, 32)}`;
  const url = `/api/image?taskId=task-1&prototype=${review}&media=${hash}`;
  expect(shortIdsInAnswer({ url }).url).toBe(`/api/image?taskId=task-1&prototype=pr_a1b2c3d4&media=a1b2c3d4`);
});

test("only the server's consent labels shorten embedded digests in labels", () => {
  expect(shortIdsInAnswer({ label: `Yes, publish report ${hash}` }).label).toBe("Yes, publish report a1b2c3d4");
  expect(shortIdsInAnswer({ label: `Так, публікуй звіт ${hash}` }).label).toBe("Так, публікуй звіт a1b2c3d4");
  expect(shortIdsInAnswer({ label: `A user's label ${hash}` }).label).toBe(`A user's label ${hash}`);
});
