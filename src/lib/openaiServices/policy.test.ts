import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { configFilePath } from "@/lib/configDir";
import { soloBrowserSession } from "@/lib/agent/operatorSession";
import { internalServiceHeaders } from "@/lib/agent/callerClaims";
import { claimInstall, createInvite, redeemJoin } from "@/lib/team/members";
import { MEMBER_COOKIE } from "@/lib/team/sessions";
import { resetTeamStoreForTests, teamStore } from "@/lib/team/store";
import { readKey, removeOpenAiKey, writeKey, applyImport } from "@/lib/keys/store";
import { asksYouSettingView } from "@/lib/asks/view";
import { memorySettingView } from "@/lib/memory/view";
import { readAsksYouSettings } from "@/lib/asks/settings";
import { writeTtsBackend, ttsBackendInfo } from "@/lib/ttsBackend";
import { writeTranscribeBackend, transcribeBackendInfo } from "@/lib/transcribeBackend";
import { CompanionStorage } from "@/lib/voiceCompanion/storage";
import { GET, PUT } from "@/app/api/openai-services/route";
import { DELETE } from "@/app/api/keys/[id]/route";
import { POST as TTS } from "@/app/api/tts/backend/route";
import { POST as STT } from "@/app/api/transcribe/backend/route";
import { PUT as VOICE } from "@/app/api/voice-companion/settings/route";
import { SERVICE_FEATURES, chooseService, resolveService, servicesView } from "./policy";

const variables = ["XDG_CONFIG_HOME", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "LLV_STAGING", "LLV_TTS_BACKEND", "LLV_TRANSCRIBE_BACKEND", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "SONIOX_API_KEY"];
let root: string, saved: Record<string, string | undefined>;
const credential = ["sk", "proj", "q".repeat(48)].join("-");
beforeEach(() => {
  saved = Object.fromEntries(variables.map(name => [name, process.env[name]]));
  for (const name of variables) delete process.env[name];
  root = fs.mkdtempSync(path.join(os.tmpdir(), "service-policy-"));
  for (const name of ["XDG_CONFIG_HOME", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME"]) process.env[name] = path.join(root, name);
  resetTeamStoreForTests();
});
afterEach(() => {
  resetTeamStoreForTests();
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  fs.rmSync(root, { recursive: true, force: true });
});
function save(name: string, value: string) { const file = configFilePath(name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }
const baseline = () => { writeTtsBackend("soniox"); writeTranscribeBackend("local"); new CompanionStorage().updateSettings({ backend: "codex" }); };
const origin = "http://127.0.0.1";
function request(method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(origin + "/api/openai-services", { method, headers: { host: "127.0.0.1", origin, cookie: `llv_operator=${soloBrowserSession()}`, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
}
const remove = (headers?: Record<string, string>, id = "openai") => DELETE(request("DELETE", undefined, headers), { params: Promise.resolve({ id }) });

test("saving and importing a key leave every existing choice and enable flag intact", async () => {
  baseline();
  const before = servicesView().features.map(row => row.requested);
  expect(await writeKey("openai", credential)).toBe("ok");
  expect(servicesView().features.map(row => row.requested)).toEqual(before);
  expect(readAsksYouSettings().enabled).toBe(false);
  expect(new CompanionStorage().settings().enabled).toBe(false);
  expect(fs.readFileSync(configFilePath("openai-services.json"), "utf8")).not.toContain('"since"');
  await removeOpenAiKey();
  const text = ["OPENAI_API_KEY", credential].join("=");
  expect((await applyImport(text, { openai: { kind: "new" } })).saved).toEqual(["openai"]);
  expect(servicesView().features.map(row => row.requested)).toEqual(before);
});

test("all six choices retain baselines through removal, restore, and fresh-process reads", async () => {
  baseline();
  const prior = SERVICE_FEATURES.map(feature => resolveService(feature).effective);
  await writeKey("openai", credential);
  for (const feature of SERVICE_FEATURES) await chooseService(feature, feature === "voice" ? "api" : "openai");
  expect(fs.statSync(configFilePath("openai-services.json")).mode & 0o777).toBe(0o600);
  expect(SERVICE_FEATURES.map(feature => resolveService(feature).held)).toEqual(SERVICE_FEATURES.map(() => false));
  expect((await remove()).status).toBe(200);
  expect((await remove()).status).toBe(200);
  expect(SERVICE_FEATURES.map(feature => resolveService(feature).effective)).toEqual(prior);
  expect(SERVICE_FEATURES.every(feature => resolveService(feature).held)).toBe(true);
  expect(resolveService("read").available).toBe(false);
  await writeKey("openai", credential);
  const expected = servicesView().features.map(row => [row.requested, row.effective, row.held]);
  const child = Bun.spawn([process.execPath, "-e", 'import {servicesView} from "./src/lib/openaiServices/policy"; console.log(JSON.stringify(servicesView().features.map(r=>[r.requested,r.effective,r.held])))'], { cwd: process.cwd(), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(JSON.parse(output)).toEqual(expected);
  expect(new CompanionStorage().settings()).toMatchObject({ backend: "api", requestedBackend: "api", held: false, enabled: false });
});

test("legacy defaults remain OpenAI; locked providers and failed keys resolve consistently", async () => {
  expect(resolveService("read")).toMatchObject({ requested: "openai", effective: "openai", held: false, available: false });
  expect(resolveService("voice").effective).toBe("api");
  baseline(); await writeKey("openai", credential);
  await chooseService("read", "openai"); await chooseService("dictation", "openai");
  process.env.LLV_TTS_BACKEND = "elevenlabs";
  process.env.LLV_TRANSCRIBE_BACKEND = "chatgpt";
  expect(resolveService("read")).toMatchObject({ effective: "elevenlabs", lockedBy: "LLV_TTS_BACKEND", held: false });
  expect(resolveService("dictation")).toMatchObject({ effective: "chatgpt", lockedBy: "LLV_TRANSCRIBE_BACKEND" });
  expect((await PUT(request("PUT", { feature: "read", provider: "openai" }))).status).toBe(409);
  delete process.env.LLV_TTS_BACKEND;
  await removeOpenAiKey(); fs.mkdirSync(configFilePath("openai-api-key"));
  expect(readKey("openai").source).toBe("failed");
  expect(resolveService("read")).toMatchObject({ effective: "soniox", held: true, available: false });
  save("openai-services.json", "broken");
  expect(resolveService("read")).toMatchObject({ effective: "soniox", held: false });
});

test("each existing selector uses the shared writer, including its keyless flow", async () => {
  baseline();
  expect((await PUT(request("PUT", { feature: "read", provider: "openai" }))).status).toBe(409);
  for (const [route, method, feature] of [[TTS, "POST", "read"], [STT, "POST", "dictation"], [VOICE, "PUT", "voice"]] as const) {
    const provider = feature === "voice" ? "api" : "openai";
    expect((await route(request(method, { backend: provider }))).status).toBe(200);
    expect(resolveService(feature)).toMatchObject({ requested: provider, effective: provider, held: false });
  }
  baseline(); await writeKey("openai", credential);
  expect((await TTS(request("POST", { backend: "openai" }))).status).toBe(200);
  expect((await STT(request("POST", { backend: "openai" }))).status).toBe(200);
  expect((await VOICE(request("PUT", { backend: "api" }))).status).toBe(200);
  await removeOpenAiKey();
  expect(ttsBackendInfo()).toMatchObject({ backend: "soniox", requested: "openai", held: true });
  expect(transcribeBackendInfo()).toMatchObject({ backend: "local", requested: "openai", held: true });
  expect(new CompanionStorage().settings()).toMatchObject({ backend: "codex", held: true });
  await chooseService("read", "elevenlabs", { legacy: true });
  await writeKey("openai", credential);
  expect(resolveService("read").effective).toBe("elevenlabs");
});

test("new route returns states only and refuses invalid, oversized and staging writes", async () => {
  await writeKey("openai", credential);
  const response = await GET(request()); const text = await response.text();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(text).not.toContain(credential); expect(text).not.toContain("masked"); expect(text).not.toContain("apiKey");
  for (const body of [{ feature: "codex", provider: "openai" }, { feature: "asks", provider: "codex" }, { feature: "asks", provider: "x".repeat(1024) }]) expect((await PUT(request("PUT", body))).status).toBe(400);
  expect((await remove(undefined, "soniox")).status).toBe(409);
  process.env.LLV_STAGING = "1";
  expect((await PUT(request("PUT", { feature: "asks", provider: "openai" }))).status).toBe(409);
  expect((await remove()).status).toBe(409);
  delete process.env.LLV_STAGING;
  process.env["OPENAI_API_KEY"] = credential;
  expect((await remove()).status).toBe(409);
});

test.each(["origin", "agent", "cookie", "service"])("hostile %s caller cannot read choices, write them or remove the key", async kind => {
  const headers: Record<string, string> = kind === "origin" ? { origin: "https://other.example" } : kind === "agent" ? { "x-llv-spawn-capability": "a".repeat(43) } : kind === "cookie" ? { cookie: "" } : internalServiceHeaders("mcp");
  await writeKey("openai", credential);
  expect((await GET(request("GET", undefined, headers))).status).toBe(403);
  expect((await PUT(request("PUT", { feature: "asks", provider: "openai" }, headers))).status).toBe(403);
  expect((await remove(headers)).status).toBe(403);
  expect(readKey("openai").value).toBe(credential);
});

test("a member in another workspace cannot adopt installation policy or remove its key", async () => {
  const store = teamStore();
  const owner = claimInstall(store, "Owner", { surface: "desktop", browser: "chrome" });
  const member = redeemJoin(store, createInvite(store, owner.member, null).code, "Member", { surface: "phone", browser: "safari" });
  await writeKey("openai", credential);
  const headers = { cookie: `${MEMBER_COOKIE}=${member.cookie}`, "x-llv-workspace": "another-workspace" };
  expect((await GET(request("GET", undefined, headers))).status).toBe(403);
  expect((await PUT(request("PUT", { feature: "asks", provider: "openai" }, headers))).status).toBe(403);
  expect((await remove(headers)).status).toBe(403);
  expect((await PUT(request("PUT", { feature: "asks", provider: "openai" }, { cookie: `${MEMBER_COOKIE}=${owner.cookie}` }))).status).toBe(200);
  expect(resolveService("asks").effective).toBe("openai");
});

test("classifier status views follow the effective provider's current key state", async () => {
  await writeKey("openai", credential);
  await chooseService("asks", "openai"); await chooseService("memory", "openai");
  expect(asksYouSettingView()).toMatchObject({ provider: "openai", keySource: "file", keyPath: configFilePath("openai-api-key") });
  expect(memorySettingView("repo-fixture")).toMatchObject({ provider: "openai", keySource: "file" });
  await removeOpenAiKey();
  expect(asksYouSettingView()).toMatchObject({ provider: "openrouter", keySource: null });
  expect(memorySettingView("repo-fixture").reasons).toContain("noKey");
});

test("a refused native write keeps the explicit OpenAI choice, and a later choice repairs malformed preferences", async () => {
  baseline(); await writeKey("openai", credential); await chooseService("read", "openai");
  const before = fs.readFileSync(configFilePath("openai-services.json"), "utf8");
  fs.unlinkSync(configFilePath("tts-backend")); fs.mkdirSync(configFilePath("tts-backend"));
  await expect(chooseService("read", "soniox", { legacy: true })).rejects.toThrow();
  expect(fs.readFileSync(configFilePath("openai-services.json"), "utf8")).toBe(before);
  expect(resolveService("read").requested).toBe("openai");
  save("openai-services.json", "malformed");
  await chooseService("asks", "openai");
  expect(resolveService("asks")).toMatchObject({ effective: "openai", held: false });
  await removeOpenAiKey();
  process.env["OPENAI_API_KEY"] = credential;
  expect(resolveService("asks")).toMatchObject({ effective: "openai", apiKey: credential, held: false });
});
