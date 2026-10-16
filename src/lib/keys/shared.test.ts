import { expect, test } from "bun:test";

import { maskedTail, maskKey, maskPastedLines, parseKeyLines, validKeyValue } from "./shared";

/* Name-indexed: a NAME=value line with a key-shaped value reads as a credential to the publication gate. */
const envLine = (name: string, value: string) => [name, value].join("=");

/* Values are built at run time from runs of one character, so no line here is shaped like a secret. */
const openrouter = ["sk", "or", "v1", "0".repeat(64)].join("-");
const elevenlabs = `sk_${"1".repeat(48)}`;

test("a mask keeps the provider's public prefix and the last four characters, and a short value no tail", () => {
  expect(maskKey("openrouter", openrouter)).toBe("sk-or-v1-••••••••0000");
  expect(maskKey("elevenlabs", elevenlabs)).toBe("sk_••••••••1111");
  expect(maskKey("telegram", `${"9".repeat(9)}:${"6".repeat(35)}`)).toBe("999999999:••••••••6666");
  expect(maskKey("soniox", "abc123")).toBe("••••••••");
  expect(maskedTail("sk-or-v1-••••••••0000")).toBe("••••0000");
});

test("validation asks only what every key of that provider has", () => {
  expect(validKeyValue("openrouter", openrouter)).toBe(true);
  expect(validKeyValue("openrouter", elevenlabs)).toBe(false);
  expect(validKeyValue("elevenlabs", "3".repeat(32))).toBe(true);
  expect(validKeyValue("elevenlabs", "sk_short")).toBe(false);
  expect(validKeyValue("soniox", `${"4".repeat(20)} ${"4".repeat(20)}`)).toBe(false);
  expect(validKeyValue("telegram", "123:abc")).toBe(false);
});

test("lines read with export and quotes; a repeated name keeps its last line; order follows the catalog", () => {
  const parsed = parseKeyLines([
    "# header",
    `export ${envLine("SONIOX_API_KEY", `'${"4".repeat(64)}'`)}`,
    `${envLine("OPENROUTER_API_KEY", `"${openrouter}"`)}`,
    `${envLine("SONIOX_API_KEY", "5".repeat(64))}`,
    "",
  ].join("\r\n"));
  expect(parsed.entries).toEqual([{ id: "openrouter", value: openrouter }, { id: "soniox", value: "5".repeat(64) }]);
  expect(parsed).toMatchObject({ unknown: [], unparsed: [] });
});

test("an unknown name is echoed only when it is shaped like a variable; a key on either side of = is counted by its line", () => {
  const parsed = parseKeyLines([`LLV_TOKEN=${"8".repeat(32)}`, elevenlabs, `${elevenlabs}=x`, `${"A".repeat(32)}=x`, "PATH=/usr/bin"].join("\n"));
  expect(parsed.unknown).toEqual(["LLV_TOKEN", "PATH"]);
  expect(parsed.unparsed).toEqual([2, 3, 4]);
  expect(JSON.stringify(parsed)).not.toContain("1".repeat(16));
});

test("the pasted text shows masked: names kept, values down to four characters, a bare key or key-shaped name fully hidden", () => {
  const shown = maskPastedLines([`# Delegatus keys · 2026-10-15 · 2`, `export ${envLine("OPENROUTER_API_KEY", openrouter)}`, elevenlabs, `${elevenlabs}=x`, "SONIOX_API_KEY=short"].join("\n"));
  expect(shown).toEqual(["# Delegatus keys · 2026-10-15 · 2", "OPENROUTER_API_KEY=••••0000", "••••1111", "••••", "SONIOX_API_KEY=••••"]);
});

test("a comment never shows a pasted value: the export header stays, any other comment is hidden", () => {
  const openai = ["sk", "proj", "2".repeat(48)].join("-");
  const shown = maskPastedLines([
    "# Delegatus keys · 2026-10-15 · 2",
    `# ${envLine("OPENAI_API_KEY", openai)}`,
    `#${envLine("OPENROUTER_API_KEY", openrouter)}`,
    `## ${elevenlabs}`,
    "# a note about the keys",
  ].join("\n"));
  expect(shown[0]).toBe("# Delegatus keys · 2026-10-15 · 2");
  expect(shown.slice(1)).toEqual(["# ••••", "# ••••", "# ••••", "# ••••"]);
  for (const secret of [openai, openrouter, elevenlabs]) expect(shown.join("\n")).not.toContain(secret.slice(-8));
});
