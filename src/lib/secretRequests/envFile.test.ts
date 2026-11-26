import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { composeEnvFile, ENV_FILE_LIMIT, scanEnvFile } from "./envFile";
import { secretLength } from "./value";

function compose(old: string, value = Buffer.from("example")): string {
  return composeEnvFile(Buffer.from(old), "ENTRY", value).toString();
}

test("appends with one separator and preserves the source line endings", () => {
  expect(compose("")).toBe("ENTRY=example\n");
  expect(compose("OLD=1")).toBe("OLD=1\nENTRY=example\n");
  expect(compose("OLD=1\n")).toBe("OLD=1\nENTRY=example\n");
  expect(compose("OLD=1\r\nOTHER=2")).toBe("OLD=1\r\nOTHER=2\r\nENTRY=example\r\n");
});

test("edits one definition, leaves prefix and surrounding bytes intact", () => {
  const prefix = Buffer.concat([Buffer.from("#"), Buffer.from([0xff]), Buffer.from("\r\n\r\n  export\tENTRY =")]);
  const suffix = Buffer.from("\r\n\r\nOTHER=keep # comment\r\n");
  const original = Buffer.concat([prefix, Buffer.from(' "old\r\ncontinuation" # replaced'), suffix]);
  expect(composeEnvFile(original, "ENTRY", Buffer.from("two words"))).toEqual(
    Buffer.concat([prefix, Buffer.from("'two words'"), suffix]),
  );
  expect(compose("ENTRY=before")).toBe("ENTRY=example");
});

test("ignores assignments inside quoted values and refuses duplicate or unparsed input", () => {
  for (const quote of ["'", '"', "`"]) {
    const other = `OTHER=${quote}first\nENTRY=keep\nlast${quote}\n`;
    expect(compose(other)).toBe(other + "ENTRY=example\n");
    expect(compose(other + "ENTRY=real\n")).toBe(other + "ENTRY=example\n");
  }
  expect(() => compose("ENTRY=one\nexport ENTRY=two\n")).toThrow("secret_env_key_duplicated");
  expect(() => compose("OTHER='unclosed\nENTRY=ignored\n")).toThrow("secret_env_unparsed");
  expect(() => scanEnvFile(Buffer.alloc(ENV_FILE_LIMIT + 1), "ENTRY")).toThrow("secret_env_unparsed");
});

test("Bun reads every fixture value back byte-for-byte from the resulting line", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secret-dotenv-"));
  try {
    const filename = path.join(root, ".env");
    for (const value of ["Az09_./:@%+=,-~", " two words ", "text # literal", 'double "quote"', "literal `backticks`", "дані ☃"]) {
      const bytes = Buffer.from(value);
      const encoded = composeEnvFile(Buffer.alloc(0), "ENTRY", bytes);
      const bare = value === "Az09_./:@%+=,-~";
      expect(encoded.toString()).toBe(`ENTRY=${bare ? value : "'" + value + "'"}\n`);
      fs.writeFileSync(filename, encoded);
      const env = { ...process.env };
      delete env.ENTRY;
      const child = Bun.spawn([process.execPath, "--env-file", filename, "-e", "process.stdout.write(process.env.ENTRY ?? '')"],
        { cwd: root, env, stdout: "pipe", stderr: "pipe" });
      const [received, exit] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited]);
      expect(exit).toBe(0);
      expect(Buffer.from(received)).toEqual(bytes);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("editing a key preserves a quoted multiline dotted assignment containing its own key-like line", async () => {
  const original = Buffer.from('SERVICE.URL="first line\nENTRY=inside\nlast line"\n');
  const composed = composeEnvFile(original, "ENTRY", Buffer.from("saved value"));
  expect(composed.subarray(0, original.length)).toEqual(original);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secret-dotenv-dotted-"));
  try {
    const filename = path.join(root, ".env");
    fs.writeFileSync(filename, composed);
    const env = { ...process.env };
    delete env.ENTRY;
    delete env["SERVICE.URL"];
    const child = Bun.spawn([process.execPath, "--env-file", filename, "-e",
      "process.stdout.write(JSON.stringify([process.env['SERVICE.URL'], process.env.ENTRY]))"],
    { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const [output, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(exit).toBe(0);
    expect(JSON.parse(output)).toEqual(["first line\nENTRY=inside\nlast line", "saved value"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("refuses bytes that cannot be quoted consistently and checks byte length and format", () => {
  for (const value of ["quote'", "back\\slash", "has\$dollar", "has\nLF", "has\rCR"]) {
    expect(() => compose("", Buffer.from(value))).toThrow("secret_env_value_unquotable");
  }
  expect(secretLength(Buffer.from("☃🙂"), "line", 2)).toBe(2);
  expect(secretLength(Buffer.alloc(4096, 65), "token")).toBe(4096);
  expect(() => secretLength(Buffer.alloc(4097, 65), "line")).toThrow("secret_value_too_long");
  for (const bytes of [Buffer.alloc(0), Buffer.from("has\nnewline"), Buffer.from("has\u0085control"), Buffer.from([0xc0, 0xaf])]) {
    expect(() => secretLength(bytes, "line")).toThrow("secret_value_format");
  }
  for (const value of ["a b", "é"]) expect(() => secretLength(Buffer.from(value), "token")).toThrow("secret_value_format");
  expect(() => secretLength(Buffer.from("☃🙂"), "line", 3)).toThrow("secret_value_format");
});
