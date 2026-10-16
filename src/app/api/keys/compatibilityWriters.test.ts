import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { spawnCapabilityDigest } from "@/lib/agent/callerClaims";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { setTelegramBotServiceForTests, type TelegramBotService } from "@/lib/telegram/bot/service";
import { claimInstall, createInvite, redeemJoin } from "@/lib/team/members";
import { MEMBER_COOKIE } from "@/lib/team/sessions";
import { resetTeamStoreForTests, teamStore } from "@/lib/team/store";

import { PUT as asksYouKey } from "../asks-you/key/route";
import { POST as telegramBot } from "../telegram/bot/route";
import { PUT as transcribeKey } from "../transcribe/key/route";
import { PUT as voiceCompanionKey } from "../voice-companion/key/route";

/*
 * Every route that still writes a catalog key under its older address takes
 * the same owner gate as `PUT /api/keys/:id` (design §9): an agent, a plain
 * request, a page on another site and a team member who is not the owner
 * change nothing, and the operator's own page still saves.
 */

const VARIABLES = ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ELEVENLABS_API_KEY", "SONIOX_API_KEY", "FISH_AUDIO_API_KEY"] as const;
const SAVED = ["XDG_CONFIG_HOME", "LLV_STATE_DIR", "LLV_STAGING", "LLV_TRANSCRIBE_BACKEND", ...VARIABLES] as const;
const saved: Record<string, string | undefined> = {};
let root = "";

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const ORIGIN = "http://127.0.0.1:8898";
const PAGE = { host: "127.0.0.1:8898", origin: ORIGIN, "sec-fetch-site": "same-origin" };
const AGENT_CAPABILITY = "a".repeat(43);
const FIXTURE_VALUE = ["fixture", "compat", "value", "0123456789"].join("-");
const TELEGRAM_VALUE = `${"9".repeat(9)}:${"6".repeat(35)}`;

/* The bot's own connect, counted: it reaches Telegram, so a refused caller must never get that far. */
let connects = 0;
function countConnects(): void {
  connects = 0;
  setTelegramBotServiceForTests({ connect: async () => { connects += 1; throw new Error("not reached against Telegram"); } } as unknown as TelegramBotService);
}

const configDir = () => path.join(root, "config", "delegatus");
const files = () => (fs.existsSync(configDir()) ? fs.readdirSync(configDir()).filter((name) => name.endsWith("-api-key")) : []);

beforeEach(() => {
  for (const name of SAVED) saved[name] = process.env[name];
  root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-keys-compat-"));
  setEnv("XDG_CONFIG_HOME", path.join(root, "config"));
  setEnv("LLV_STATE_DIR", path.join(root, "state"));
  setEnv("LLV_STAGING", undefined);
  setEnv("LLV_TRANSCRIBE_BACKEND", undefined);
  for (const name of VARIABLES) setEnv(name, undefined);
  resetTeamStoreForTests();
});

afterEach(() => {
  setTelegramBotServiceForTests(null);
  setCallerConversationResolverForTests(null);
  resetTeamStoreForTests();
  for (const name of SAVED) setEnv(name, saved[name]);
  fs.rmSync(root, { recursive: true, force: true });
});

function put(url: string, body: unknown, headers: Record<string, string>): NextRequest {
  return new NextRequest(`${ORIGIN}${url}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/* Each older writer, with the request it has always taken. */
const WRITERS: [string, (headers: Record<string, string>) => Promise<Response>][] = [
  ["PUT /api/transcribe/key", (headers) => transcribeKey(put("/api/transcribe/key", { provider: "soniox", key: FIXTURE_VALUE }, headers))],
  ["PUT /api/asks-you/key", (headers) => asksYouKey(put("/api/asks-you/key", { key: FIXTURE_VALUE }, headers))],
  ["PUT /api/voice-companion/key", (headers) => voiceCompanionKey(put("/api/voice-companion/key", { key: FIXTURE_VALUE }, headers))],
  ["POST /api/telegram/bot connect", (headers) => telegramBot(new NextRequest(`${ORIGIN}/api/telegram/bot`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ action: "connect", token: TELEGRAM_VALUE }),
  }))],
];

function asAgent(): Record<string, string> {
  setCallerConversationResolverForTests((digest) => (digest === spawnCapabilityDigest(AGENT_CAPABILITY) ? "conversation_agent" : null));
  return { ...PAGE, "x-llv-spawn-capability": AGENT_CAPABILITY };
}

const REFUSED: [string, () => Record<string, string>][] = [
  ["an agent presenting its capability", asAgent],
  ["a plain request with no browser stamp", () => ({ host: "127.0.0.1:8898" })],
  ["a page on another site", () => ({ host: "127.0.0.1:8898", origin: "https://elsewhere.example", "sec-fetch-site": "cross-site" })],
];

describe("the older key writers share the owner gate", () => {
  for (const [name, write] of WRITERS) {
    for (const [who, headers] of REFUSED) {
      test(`${name} refuses ${who} and changes nothing`, async () => {
        countConnects();
        const answer = await write(headers());
        expect(answer.status).toBe(403);
        const text = await answer.text();
        expect(text).not.toContain(FIXTURE_VALUE);
        expect(text).not.toContain(TELEGRAM_VALUE);
        expect(files()).toEqual([]);
        expect(connects).toBe(0);
      });
    }
  }

  describe("on a team install", () => {
    let owner = "";
    let member = "";
    beforeEach(() => {
      const store = teamStore();
      const claimed = claimInstall(store, "Mira", { surface: "desktop", browser: "chrome" });
      owner = claimed.cookie;
      member = redeemJoin(store, createInvite(store, claimed.member, null).code, "Oleh", { surface: "phone", browser: "safari" }).cookie;
    });
    const as = (cookie: string) => ({ ...PAGE, cookie: `${MEMBER_COOKIE}=${cookie}` });

    for (const [name, write] of WRITERS) {
      test(`${name} refuses a member who is not the owner, and saves for the owner`, async () => {
        countConnects();
        const refused = await write(as(member));
        expect(refused.status).toBe(403);
        expect(files()).toEqual([]);
        expect(connects).toBe(0);
        const accepted = await write(as(owner));
        expect(accepted.status).not.toBe(403);
        expect(files().length + connects).toBe(1);
      });
    }
  });

  for (const [name, write] of WRITERS) {
    test(`${name} still saves for the operator's own page`, async () => {
      countConnects();
      const answer = await write(PAGE);
      expect(answer.status).not.toBe(403);
      expect(files().length + connects).toBe(1);
    });
  }
});
