import { expect, test } from "bun:test";
import { redactArchive, sensitiveKey } from "./redaction";

test.each([
  ["apiKey", true], ["APIToken", true], ["DBPassword", true],
  ["HTTPAuthorization", true], ["TLSPrivateKey", true], ["api_key", true],
  ["api-key", true], ["auth.password", true], ["PRIVATE KEY", true],
  ["DBPasswordHash", true], ["clientSecret", true], ["accessTokenValue", true],
  ["pAsSwOrD", true], ["aPiKeY", true],
  ["tokenCount", false], ["APITokenCount", false], ["token_count", false],
  ["token-count", false], ["token.count", false], ["passwordChanged", false],
  ["DBPasswordChanged", false], ["secretary", false], ["receiptId", false],
] as const)("credential classification: %s", (key, expected) => {
  expect(sensitiveKey(key)).toBe(expected);
});

test("ordinary quotation and backslashes remain prose; binary text refuses export", () => {
  for (const prose of ['ordinary "quotes"', String.raw`Use "\d+" literally`, "unfinished 'prose", String.raw`escaped \"ordinary\" prose`]) {
    expect(redactArchive(prose)).toBe(prose);
  }
  expect(() => redactArchive("binary\0text")).toThrow("ARCHIVE_UNAVAILABLE");
});
