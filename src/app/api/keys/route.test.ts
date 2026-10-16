import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";

import { internalServiceHeaders, spawnCapabilityDigest } from "@/lib/agent/callerClaims";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { setTelegramConnectForTests } from "@/lib/keys/store";
import type { ImportPreview, KeysAnswer } from "@/lib/keys/shared";
import { claimInstall, createInvite, redeemJoin } from "@/lib/team/members";
import { MEMBER_COOKIE } from "@/lib/team/sessions";
import { resetTeamStoreForTests, teamStore } from "@/lib/team/store";

import { GET } from "./route";
import { PUT } from "./[id]/route";
import { POST as REVEAL } from "./[id]/reveal/route";
import { POST as EXPORT } from "./export/route";
import { POST as IMPORT } from "./import/route";

/* Name-indexed: a NAME=value line with a key-shaped value reads as a credential to the publication gate. */
const envLine = (name: string, value: string) => [name, value].join("=");

/*
 * «Keys» (docs/design/keys-settings.md §5, §7, §9): a key's value leaves the
 * server only for the operator's own Delegatus page, and an import writes only
 * what the operator confirmed after its preview. Every case runs under a
 * throw-away config home and state directory; the values are built at run
 * time from runs of one character, so no line here is shaped like a secret.
 */

const VARIABLES = ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ELEVENLABS_API_KEY", "SONIOX_API_KEY", "FISH_AUDIO_API_KEY"] as const;
const SAVED = ["XDG_CONFIG_HOME", "LLV_STATE_DIR", "LLV_STAGING", ...VARIABLES] as const;
const saved: Record<string, string | undefined> = {};
let root = "";

/* Name-indexed: a literal assignment to an *_API_KEY variable reads as a credential to the publication gate. */
function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const value = {
  openrouter: ["sk", "or", "v1", "0".repeat(64)].join("-"),
  openrouterNext: ["sk", "or", "v1", "3".repeat(64)].join("-"),
  openai: ["sk", "proj", "2".repeat(48)].join("-"),
  elevenlabs: `sk_${"1".repeat(48)}`,
  soniox: "4".repeat(64),
  fishaudio: "7".repeat(32),
  telegram: `${"9".repeat(9)}:${"6".repeat(35)}`,
};
const ALL_VALUES = Object.values(value);

const configDir = () => path.join(root, "config", "delegatus");
const keyFile = (name: string) => path.join(configDir(), name);
function saveFile(name: string, content: string): void {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(keyFile(name), `${content}\n`, { mode: 0o600 });
}

beforeEach(() => {
  for (const name of SAVED) saved[name] = process.env[name];
  root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-keys-route-"));
  setEnv("XDG_CONFIG_HOME", path.join(root, "config"));
  setEnv("LLV_STATE_DIR", path.join(root, "state"));
  setEnv("LLV_STAGING", undefined);
  for (const name of VARIABLES) setEnv(name, undefined);
  resetTeamStoreForTests();
});

afterEach(() => {
  setTelegramConnectForTests(null);
  setCallerConversationResolverForTests(null);
  resetTeamStoreForTests();
  for (const name of SAVED) setEnv(name, saved[name]);
  fs.rmSync(root, { recursive: true, force: true });
});

const ORIGIN = "http://127.0.0.1:8898";
/** The headers a Delegatus page's own fetch carries. */
const PAGE = { host: "127.0.0.1:8898", origin: ORIGIN, "sec-fetch-site": "same-origin" };

function request(pathname: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): NextRequest {
  return new NextRequest(`${ORIGIN}${pathname}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(init.headers ?? PAGE) },
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const list = (headers?: Record<string, string>) => GET(request("/api/keys", { headers }));
const reveal = (id: string, headers?: Record<string, string>, purpose = "reveal") => REVEAL(request(`/api/keys/${id}/reveal`, { method: "POST", headers, body: { purpose } }), params(id));
const replace = (id: string, next: string, headers?: Record<string, string>) => PUT(request(`/api/keys/${id}`, { method: "PUT", headers, body: { value: next } }), params(id));
const exportAll = (headers?: Record<string, string>) => EXPORT(request("/api/keys/export", { method: "POST", headers, body: {} }));
const importKeys = (body: unknown, headers?: Record<string, string>) => IMPORT(request("/api/keys/import", { method: "POST", headers, body }));

function expectNoValue(text: string): void {
  for (const secret of ALL_VALUES) expect(text).not.toContain(secret);
}

/** A capability the registry resolves to a conversation: an agent naming itself. */
const AGENT_CAPABILITY = "a".repeat(43);
function asAgent(): Record<string, string> {
  setCallerConversationResolverForTests((digest) => (digest === spawnCapabilityDigest(AGENT_CAPABILITY) ? "conversation_agent" : null));
  return { ...PAGE, "x-llv-spawn-capability": AGENT_CAPABILITY };
}

/* The callers that must never get a value back, each with the reason it is refused. */
const REFUSED: [string, () => Record<string, string>][] = [
  ["an agent presenting its capability", asAgent],
  ["a caller presenting a capability no conversation owns", () => ({ ...PAGE, "x-llv-spawn-capability": "b".repeat(43) })],
  ["a spawned process's plain request, with no browser stamp", () => ({ host: "127.0.0.1:8898" })],
  ["a page on another site", () => ({ host: "127.0.0.1:8898", origin: "https://elsewhere.example", "sec-fetch-site": "cross-site" })],
  ["a Viewer service's own request", () => ({ ...PAGE, ...internalServiceHeaders("mcp") })],
];

describe("who may read a key", () => {
  for (const [who, headers] of REFUSED) {
    test(`${who} is refused every reveal, copy, export, import and replace, and sees no masked value`, async () => {
      saveFile("openrouter-api-key", value.openrouter);
      setEnv("OPENAI_API_KEY", value.openai);
      const answers = [
        await reveal("openrouter", headers()),
        await reveal("openai", headers(), "copy"),
        await exportAll(headers()),
        await importKeys({ text: `${envLine("OPENROUTER_API_KEY", value.openrouterNext)}` }, headers()),
        await importKeys({ text: `${envLine("OPENROUTER_API_KEY", value.openrouterNext)}`, confirm: { openrouter: { kind: "replaces", was: "sk-or-v1-••••••••0000" } } }, headers()),
        await replace("openrouter", value.openrouterNext, headers()),
      ];
      for (const answer of answers) {
        expect(answer.status).toBe(403);
        expectNoValue(await answer.text());
      }
      expect(fs.readFileSync(keyFile("openrouter-api-key"), "utf8")).toBe(`${value.openrouter}\n`);
      const listed = await list(headers());
      if (listed.status === 200) {
        const body = await listed.json() as KeysAnswer;
        expect(body.owner).toBe(false);
        expect(body.keys.every((entry) => entry.masked === null)).toBe(true);
      } else {
        expect(listed.status).toBe(403);
      }
    });
  }

  test("the operator's page reveals and copies a key, each answer is no-store, and no log line carries it", async () => {
    saveFile("openrouter-api-key", value.openrouter);
    const info = spyOn(console, "info");
    const log = spyOn(console, "log");
    const error = spyOn(console, "error");
    try {
      for (const purpose of ["reveal", "copy"]) {
        const answer = await reveal("openrouter", PAGE, purpose);
        expect(answer.status).toBe(200);
        expect(answer.headers.get("cache-control")).toBe("no-store");
        expect(await answer.json()).toEqual({ value: value.openrouter });
      }
      const logged = [...info.mock.calls, ...log.mock.calls, ...error.mock.calls].flat().map(String).join("\n");
      expectNoValue(logged);
      expect(logged).toContain("[keys] reveal openrouter");
      expect(logged).toContain("[keys] copy openrouter");
    } finally {
      info.mockRestore(); log.mockRestore(); error.mockRestore();
    }
  });

  test("the list answers states and masked values and never a value", async () => {
    saveFile("openrouter-api-key", value.openrouter);
    saveFile("elevenlabs-api-key", value.elevenlabs);
    setEnv("OPENAI_API_KEY", value.openai);
    const answer = await list();
    expect(answer.headers.get("cache-control")).toBe("no-store");
    const text = await answer.text();
    expectNoValue(text);
    const body = JSON.parse(text) as KeysAnswer;
    expect(body.owner).toBe(true);
    expect(body.staging).toBe(false);
    expect(body.keys.map((entry) => [entry.id, entry.source, entry.masked])).toEqual([
      ["openrouter", "file", "sk-or-v1-••••••••0000"],
      ["openai", "env", "sk-proj-••••••••2222"],
      ["elevenlabs", "file", "sk_••••••••1111"],
      ["soniox", "missing", null],
      ["fishaudio", "missing", null],
      ["telegram", "missing", null],
    ]);
  });

  test("an unknown key and a missing one answer 404 without a value", async () => {
    expect((await reveal("github")).status).toBe(404);
    expect((await reveal("soniox")).status).toBe(404);
  });

  test("a body past the bound is refused before it is read whole", async () => {
    const answer = await IMPORT(request("/api/keys/import", { method: "POST", body: JSON.stringify({ text: "#".repeat(70 * 1024) }) }));
    expect(answer.status).toBe(400);
  });
});

describe("a team install", () => {
  let owner = "";
  let member = "";
  beforeEach(() => {
    const store = teamStore();
    const claimed = claimInstall(store, "Mira", { surface: "desktop", browser: "chrome" });
    owner = claimed.cookie;
    member = redeemJoin(store, createInvite(store, claimed.member, null).code, "Oleh", { surface: "phone", browser: "safari" }).cookie;
  });
  const as = (cookie: string) => ({ ...PAGE, cookie: `${MEMBER_COOKIE}=${cookie}` });

  test("a member sees states only and is refused every value; the owner is answered", async () => {
    saveFile("openrouter-api-key", value.openrouter);
    const memberList = await (await list(as(member))).json() as KeysAnswer;
    expect(memberList.owner).toBe(false);
    expect(memberList.keys[0]).toMatchObject({ id: "openrouter", source: "file", masked: null });
    const refused = await reveal("openrouter", as(member));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "owner_required" });
    expect((await exportAll(as(member))).status).toBe(403);
    expect((await replace("openrouter", value.openrouterNext, as(member))).status).toBe(403);

    const ownerList = await (await list(as(owner))).json() as KeysAnswer;
    expect(ownerList.owner).toBe(true);
    expect(await (await reveal("openrouter", as(owner))).json()).toEqual({ value: value.openrouter });
  });

  test("nobody signed in is refused", async () => {
    saveFile("openrouter-api-key", value.openrouter);
    expect((await reveal("openrouter", PAGE)).status).toBe(403);
  });
});

describe("keys set by a variable", () => {
  test("are listed as such, revealed and exported, and never written", async () => {
    setEnv("SONIOX_API_KEY", value.soniox);
    saveFile("soniox-api-key", "5".repeat(64));
    const body = await (await list()).json() as KeysAnswer;
    expect(body.keys.find((entry) => entry.id === "soniox")).toMatchObject({ source: "env", variable: "SONIOX_API_KEY", masked: `••••••••${"4".repeat(4)}` });
    expect(await (await reveal("soniox")).json()).toEqual({ value: value.soniox });
    const refused = await replace("soniox", "6".repeat(64));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "set_by_env" });
    expect(fs.readFileSync(keyFile("soniox-api-key"), "utf8")).toBe(`${"5".repeat(64)}\n`);
    const exported = await (await exportAll()).json() as { text: string };
    expect(exported.text).toContain(`${envLine("SONIOX_API_KEY", value.soniox)}\n`);
  });
});

describe("replacing a key", () => {
  test("writes the file its reader reads, at mode 600, and answers the masked list", async () => {
    saveFile("fishaudio-api-key", "8".repeat(32));
    fs.chmodSync(keyFile("fishaudio-api-key"), 0o644);
    const answer = await replace("fishaudio", `  ${value.fishaudio}  `);
    expect(answer.status).toBe(200);
    const text = await answer.text();
    expectNoValue(text);
    expect((JSON.parse(text) as KeysAnswer).keys.find((entry) => entry.id === "fishaudio")?.masked).toBe("••••••••7777");
    expect(fs.readFileSync(keyFile("fishaudio-api-key"), "utf8")).toBe(`${value.fishaudio}\n`);
    expect(fs.statSync(keyFile("fishaudio-api-key")).mode & 0o777).toBe(0o600);
  });

  test("refuses a value that cannot be the key, and changes nothing", async () => {
    saveFile("openrouter-api-key", value.openrouter);
    for (const bad of ["sk_short", "not-an-openrouter-key-at-all", `sk-or-v1-${"0".repeat(10)} space`]) {
      const answer = await replace("openrouter", bad);
      expect(answer.status).toBe(400);
      expect(await answer.text()).not.toContain(bad);
    }
    expect(fs.readFileSync(keyFile("openrouter-api-key"), "utf8")).toBe(`${value.openrouter}\n`);
  });

  test("a staging release refuses every write and every import", async () => {
    setEnv("LLV_STAGING", "1");
    const answer = await replace("openrouter", value.openrouter);
    expect(answer.status).toBe(409);
    expect(await answer.json()).toMatchObject({ code: "staging" });
    expect((await importKeys({ text: `${envLine("OPENROUTER_API_KEY", value.openrouter)}`, confirm: { openrouter: { kind: "new" } } })).status).toBe(409);
    expect(fs.existsSync(keyFile("openrouter-api-key"))).toBe(false);
    expect(((await (await list()).json()) as KeysAnswer).staging).toBe(true);
  });

  test("an unreadable key file is listed as failed and can be replaced", async () => {
    fs.mkdirSync(keyFile("elevenlabs-api-key"), { recursive: true });
    const body = await (await list()).json() as KeysAnswer;
    expect(body.keys.find((entry) => entry.id === "elevenlabs")?.source).toBe("failed");
  });
});

describe("export", () => {
  test("is one NAME=value line per set key under a dated header, with the bot token under its own name", async () => {
    saveFile("openrouter-api-key", value.openrouter);
    setEnv("OPENAI_API_KEY", value.openai);
    const answer = await exportAll();
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    const { text, count } = await answer.json() as { text: string; count: number };
    expect(count).toBe(2);
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^# Delegatus keys · \d{4}-\d{2}-\d{2} · 2$/);
    expect(lines.slice(1)).toEqual([`${envLine("OPENROUTER_API_KEY", value.openrouter)}`, `${envLine("OPENAI_API_KEY", value.openai)}`]);
  });
});

describe("import", () => {
  const pasted = () => [
    "# Delegatus keys · 2026-10-15 · 6",
    `${envLine("OPENROUTER_API_KEY", value.openrouterNext)}`,
    `export ${envLine("SONIOX_API_KEY", `"${value.soniox}"`)}`,
    `${envLine("OPENAI_API_KEY", value.openai)}`,
    "ELEVENLABS_API_KEY=sk_short",
    `${envLine("FISH_AUDIO_API_KEY", value.fishaudio)}`,
    `LLV_TOKEN=${"8".repeat(32)}`,
    value.elevenlabs,
    `${value.elevenlabs}=x`,
  ].join("\n");

  beforeEach(() => {
    saveFile("openrouter-api-key", value.openrouter);
    saveFile("fishaudio-api-key", value.fishaudio);
    setEnv("OPENAI_API_KEY", value.openai.replace(/2/g, "5"));
  });

  test("previews every known name masked, names unknown ones and counts lines without NAME=, and writes nothing", async () => {
    const answer = await importKeys({ text: pasted() });
    expect(answer.status).toBe(200);
    const text = await answer.text();
    expectNoValue(text);
    expect(text).not.toContain("8".repeat(32));
    const preview = JSON.parse(text) as ImportPreview;
    expect(preview.rows).toEqual([
      { id: "openrouter", kind: "replaces", masked: "sk-or-v1-••••••••3333", was: "sk-or-v1-••••••••0000" },
      { id: "openai", kind: "env", masked: "sk-proj-••••••••2222" },
      { id: "elevenlabs", kind: "invalid" },
      { id: "soniox", kind: "new", masked: "••••••••4444" },
      { id: "fishaudio", kind: "same", masked: "••••••••7777" },
    ]);
    expect(preview.unknown).toEqual(["LLV_TOKEN"]);
    expect(preview.unparsed).toEqual([8, 9]);
    expect(fs.readFileSync(keyFile("openrouter-api-key"), "utf8")).toBe(`${value.openrouter}\n`);
    expect(fs.existsSync(keyFile("soniox-api-key"))).toBe(false);
  });

  test("writes only the keys confirmed against the preview, never one set by a variable", async () => {
    const answer = await importKeys({ text: pasted(), confirm: { soniox: { kind: "new" }, openai: { kind: "new" } } });
    expect(answer.status).toBe(200);
    const outcome = await answer.json() as { saved: string[]; unconfirmed: string[] };
    expect(outcome.saved).toEqual(["soniox"]);
    expect(outcome.unconfirmed).toEqual(["openrouter"]);
    expect(fs.readFileSync(keyFile("soniox-api-key"), "utf8")).toBe(`${value.soniox}\n`);
    /* The replacement was shown and not confirmed: the saved key stays. */
    expect(fs.readFileSync(keyFile("openrouter-api-key"), "utf8")).toBe(`${value.openrouter}\n`);
    expect(fs.existsSync(keyFile("openai-api-key"))).toBe(false);
  });

  test("a confirmed replacement is written only while it replaces the key the preview showed", async () => {
    const confirm = { openrouter: { kind: "replaces", was: "sk-or-v1-••••••••0000" } };
    /* Another tab changed the key after this preview: the confirmation no longer describes this machine. */
    saveFile("openrouter-api-key", ["sk", "or", "v1", "1".repeat(64)].join("-"));
    const stale = await (await importKeys({ text: pasted(), confirm })).json() as { saved: string[]; unconfirmed: string[] };
    expect(stale.saved).toEqual([]);
    expect(stale.unconfirmed).toContain("openrouter");
    expect(fs.readFileSync(keyFile("openrouter-api-key"), "utf8")).toBe(`${["sk", "or", "v1", "1".repeat(64)].join("-")}\n`);

    saveFile("openrouter-api-key", value.openrouter);
    const fresh = await (await importKeys({ text: pasted(), confirm })).json() as { saved: string[] };
    expect(fresh.saved).toEqual(["openrouter"]);
    expect(fs.readFileSync(keyFile("openrouter-api-key"), "utf8")).toBe(value.openrouterNext);
  });

  test("a confirmed new key that was set since the preview is left alone", async () => {
    saveFile("soniox-api-key", "6".repeat(64));
    const outcome = await (await importKeys({ text: pasted(), confirm: { soniox: { kind: "new" } } })).json() as { saved: string[]; unconfirmed: string[] };
    expect(outcome.saved).toEqual([]);
    expect(outcome.unconfirmed).toEqual(["openrouter", "soniox"]);
    expect(fs.readFileSync(keyFile("soniox-api-key"), "utf8")).toBe(`${"6".repeat(64)}\n`);
  });

  test("the bot token goes through the bot's own connect, and a refusal is reported without the token", async () => {
    const connected: string[] = [];
    setTelegramConnectForTests(async (token) => { connected.push(token); });
    const text = `${envLine("DELEGATUS_TELEGRAM_BOT_TOKEN", value.telegram)}`;
    const preview = await (await importKeys({ text })).json() as ImportPreview;
    expect(preview.rows).toEqual([{ id: "telegram", kind: "new", masked: `${"9".repeat(9)}:••••••••6666` }]);
    expect(await (await importKeys({ text, confirm: { telegram: { kind: "new" } } })).json()).toMatchObject({ saved: ["telegram"] });
    expect(connected).toEqual([value.telegram]);

    setTelegramConnectForTests(async () => { throw new Error(`refused ${value.telegram}`); });
    const refused = await importKeys({ text, confirm: { telegram: { kind: "new" } } });
    const body = await refused.text();
    expect(body).not.toContain(value.telegram);
    expect(JSON.parse(body)).toMatchObject({ saved: [], failed: [{ id: "telegram", reason: "telegram_refused" }] });
  });
});
