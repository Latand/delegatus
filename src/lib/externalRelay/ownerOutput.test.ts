import { expect, test } from "bun:test";
import { scrubOwnerOutput } from "./ownerOutput";

test.each([
  ["reported message", "/ai а так працюєш?"],
  ["short commands", "/ai /q /help /start"],
  ["bot command", "/manipulator@SomeBot"],
  ["bot mentions", "@SomeBot @AnotherBot"],
  ["quoted command", "Received «/ai а так працюєш?»"],
  ["code command", "Try `/q` or \"/ai\"."],
  ["root prefixes", "/tmpbot /etcetera /homework /UsersBot /private_chat /home_password /rootSecret"],
  ["known roots with suffix-like names", "/etcetera /tmpcache /privateer"],
  ["fractions and ratios", "1/2 3/4 16:9 1 / 2 /3"],
  ["ordinary prose", "Hello! Так, працюю. input/output and/or"],
  ["web links", "https://example.test/docs/work http://example.test/help"],
  ["URL root names", "https://example.test/tmp/file https://example.test/home/file"],
  ["command beside a URL", "/ai https://example.test/docs/work @SomeBot"],
  ["marker-like prose", "\uE000relay0\uE000relay /homework /ai"],
  ["structured commands", JSON.stringify({ command: "/homework", detail: "/ai @SomeBot" })],
])("owner output preserves %s", (_name, text) => {
  expect(scrubOwnerOutput(text)).toBe(text);
});

const posix = (...segments: string[]) => ["", ...segments].join("/");

test.each([
  ["home relative", "~/relay-fixture/note.txt"],
  ["named home relative", "~fixture/relay-fixture/note.txt"],
  ["two POSIX segments", posix("workspace", "note.txt")],
  ["deep POSIX path", posix("workspace", "relay-fixture", "note.txt")],
  ["escaped space", String.raw`~/relay\ fixture/note.txt`],
  ["POSIX escaped space", String.raw`/workspace/relay\ fixture/note.txt`],
  ...[2, 3, 4].flatMap(count => {
    const path = `${"/".repeat(count)}workspace/private-note.txt`;
    return [
      [`${count} leading slashes`, path],
      [`${count} leading slashes in code`, `Use \`${path}\` here.`],
    ];
  }),
  ["known root before comma", "Path: /tmp, done."],
  ["known root before semicolon", "Path: /etc; done."],
  ["known root before closing parenthesis", "Path: (/var) done."],
  ["known root in shell command", "cat /etc; printf done"],
  ["file URI", "file:///workspace/relay-fixture/note.txt"],
  ["remote file URI", "file://fixture-host/share/note.txt"],
  ["drive path", String.raw`C:\relay-fixture\note.txt`],
  ["drive with forward slashes", "D:/relay-fixture/note.txt"],
  ["UNC path", String.raw`\\fixture-host\share\note.txt`],
  ...["home", "Users", "root", "tmp", "var", "etc", "opt", "private", "mnt", "srv", "proc"]
    .flatMap(root => [[`${root} root`, posix(root)], [`${root} descendant`, posix(root, "relay-fixture", "note.txt")]]),
])("owner output redacts %s", (_name, text) => {
  const output = scrubOwnerOutput(`Location: ${text}`);
  expect(output).not.toContain(text);
  expect(output).toMatch(/\[path\]|~|…/);
  expect(output).toStartWith("Location: ");
});

test.each([
  ["comma prose", "Path: /tmp, done.", "Path: [path], done."],
  ["semicolon prose", "Path: /etc; done.", "Path: [path]; done."],
  ["closing parenthesis", "Path: (/var) done.", "Path: ([path]) done."],
  ["shell separator", "cat /etc; printf done", "cat [path]; printf done"],
])("owner output redacts a punctuated root in %s", (_name, input, expected) => {
  expect(scrubOwnerOutput(input)).toBe(expected);
});

test.each([
  ["known credential", ["fixture", "relay", "access", "value"].join("-"), true],
  ["opaque capability", "q".repeat(43), false],
  ["hex credential", "a".repeat(64), false],
  ["provider credential", "sk-" + "a".repeat(48), false],
  ["private armor", ["-----BEGIN PRIVATE KEY-----", "fixture-private-material", "-----END PRIVATE KEY-----"].join("\n"), false],
] as const)("owner output redacts %s beside commands", (_name, secret, known) => {
  const output = scrubOwnerOutput(`/ai @SomeBot ${secret}`, known ? [secret] : []);
  expect(output).toBe("/ai @SomeBot [redacted]");
});

test("owner output still scrubs structured and encoded credentials", () => {
  const secret = ["fixture", "relay", "access", "value"].join("-");
  expect(scrubOwnerOutput(JSON.stringify({ command: "/ai", password: secret })))
    .toBe(JSON.stringify({ command: "/ai", password: "[redacted]" }));
  expect(scrubOwnerOutput(JSON.stringify({ command: "/homework", credentials: { value: "/homework" } })))
    .toBe(JSON.stringify({ command: "/homework", credentials: "[redacted]" }));
  const encoded = Array.from(secret, char => `%${char.charCodeAt(0).toString(16)}`).join("");
  expect(scrubOwnerOutput(`/ai ${encoded}`, [secret])).toBe("[redacted]");
  expect(scrubOwnerOutput("Command /homework", ["/homework"])).toBe("Command [redacted]");
});

test.each(["/home_password", "/UsersSecret", "/rootAccessToken", String.raw`/home_\u0070assword`])(
  "owner output still recognizes sensitive command-shaped field %s", key => {
    const secret = ["fixture", "field", "value"].join("-");
    const text = `{"${key}":"${secret}"}`;
    const output = scrubOwnerOutput(text);
    expect(output).not.toContain(secret);
    expect(output).toContain("[redacted]");
  },
);
