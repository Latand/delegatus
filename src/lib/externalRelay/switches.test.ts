import { test, expect, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readRelaySwitches, setRelaySwitch } from "./switches";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-switches-"));
process.env.LLV_STATE_DIR = root;
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
test("dark switches fail closed and compact requires conversations on the next read", () => {
  const off = { chat_conversations: false, compact: false, owner_tools: false };
  expect(readRelaySwitches()).toEqual(off);
  setRelaySwitch("compact", true);
  expect(readRelaySwitches()).toEqual(off);
  setRelaySwitch("chat_conversations", true);
  expect(readRelaySwitches()).toEqual({ ...off, compact: true, chat_conversations: true });
  for (const value of ["{", JSON.stringify({ v: 2, chat_conversations: true }), JSON.stringify({ v: 1, chat_conversations: "true" })]) {
    fs.writeFileSync(path.join(root, "external-relay/switches.json"), value);
    expect(readRelaySwitches()).toEqual(off);
  }
  fs.rmSync(path.join(root, "external-relay/switches.json"));
  fs.mkdirSync(path.join(root, "external-relay/switches.json"));
  expect(readRelaySwitches()).toEqual(off);
});
test("relay:owner_tools:enabled is independent, explicit and default OFF", () => {
  fs.rmSync(path.join(root, "external-relay/switches.json"), { recursive: true, force: true });
  expect(setRelaySwitch("relay:owner_tools:enabled", true)).toEqual({ chat_conversations: false, compact: false, owner_tools: true });
  expect(setRelaySwitch("relay:owner_tools:enabled", false).owner_tools).toBe(false);
  for (const value of ["true", 1, null]) {
    fs.writeFileSync(path.join(root, "external-relay/switches.json"), JSON.stringify({ v: 1, "relay:owner_tools:enabled": value }));
    expect(readRelaySwitches().owner_tools).toBe(false);
  }
});
