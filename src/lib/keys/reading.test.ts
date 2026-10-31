import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { configFilePath } from "@/lib/configDir";
import { KEY_VARIABLE } from "./shared";
import { readApiKey, type ApiKeyId } from "./reading";
import { readKey, removeOpenAiKey, writeKey } from "./store";

let root: string;
let saved: Record<string, string | undefined>;
const ids: ApiKeyId[] = ["openrouter", "openai", "elevenlabs", "soniox", "fishaudio"];
const variables = ["XDG_CONFIG_HOME", ...ids.map(id => KEY_VARIABLE[id])];
const credential = ["sk", "or", "synthetic", "provider", "credential"].join("-");

beforeEach(() => {
  saved = Object.fromEntries(variables.map(name => [name, process.env[name]]));
  for (const name of variables) delete process.env[name];
  root = fs.mkdtempSync(path.join(os.tmpdir(), "api-key-reading-"));
  process.env.XDG_CONFIG_HOME = root;
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

for (const id of ids) test(`${id}: writer and both readers agree after replacement and environment changes`, async () => {
  expect(readApiKey(id)).toEqual({ source: "missing", value: null });
  expect(await writeKey(id, credential)).toBe("ok");
  expect(readApiKey(id)).toEqual({ source: "file", value: credential });
  expect(readApiKey(id)).toEqual(readKey(id));
  const replacement = `${credential}-replacement`;
  expect(await writeKey(id, replacement)).toBe("ok");
  expect(readApiKey(id)).toEqual({ source: "file", value: replacement });
  process.env[KEY_VARIABLE[id]] = `  ${credential}-environment  `;
  expect(readApiKey(id)).toEqual({ source: "env", value: `${credential}-environment` });
  expect(readApiKey(id)).toEqual(readKey(id));
  delete process.env[KEY_VARIABLE[id]];
  expect(readApiKey(id)).toEqual({ source: "file", value: replacement });
});

test("removed, empty and unreadable OpenAI files keep their distinct outcomes", async () => {
  expect(await writeKey("openai", credential)).toBe("ok");
  expect(await removeOpenAiKey()).toBe("ok");
  expect(readApiKey("openai")).toEqual({ source: "missing", value: null });
  const file = configFilePath("openai-api-key");
  fs.writeFileSync(file, " \n");
  expect(readApiKey("openai")).toEqual({ source: "missing", value: null });
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  expect(readApiKey("openai")).toEqual({ source: "failed", value: null });
  expect(readApiKey("openai")).toEqual(readKey("openai"));
});
