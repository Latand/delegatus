import fs from "node:fs";

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";

import * as codexAuth from "@/lib/codexAuth";
import * as chatgpt from "@/lib/transcribe/chatgpt";
import * as backend from "@/lib/transcribeBackend";

import { POST } from "./route";

const payload = "recorded audio fixture";
const restores: Array<() => void> = [];

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

async function upload(filename: string, type: string) {
  const form = new FormData();
  form.append("file", new Blob([payload], { type }), filename);
  form.append("language", "uk");
  // Serialize and parse real multipart bytes: returning a fabricated FormData
  // would hide Bun's filename-based MIME inference.
  const serialized = new Request("http://127.0.0.1/api/transcribe", { method: "POST", body: form });
  const req = new NextRequest(serialized.url, {
    method: "POST",
    headers: { "content-type": serialized.headers.get("content-type")!, host: "127.0.0.1" },
    body: await serialized.arrayBuffer(),
  });
  const parsed = (await req.clone().formData()).get("file") as File;
  return { parsedType: parsed.type, response: await POST(req) };
}

describe("transcription multipart media guard", () => {
  test.each([
    ["dictation.webm", "audio/webm", "video/webm", "audio/webm"],
    ["dictation.weba", "audio/webm", "audio/webm", "audio/webm"],
    ["dictation.ogv", "video/ogg", "video/ogg", "audio/ogg"],
    ["dictation.ogg", "audio/ogg", "audio/ogg", "audio/ogg"],
    ["dictation.mp4", "audio/mp4", "video/mp4", "audio/mp4"],
    ["dictation.m4a", "audio/mp4", "audio/x-m4a", "audio/x-m4a"],
    ["dictation.mp3", "audio/mpeg", "audio/mpeg", "audio/mpeg"],
    ["dictation", "audio/webm", "", "audio/webm"],
  ])("transcribes %s through the ChatGPT branch", async (filename, type, parsedType, upstreamType) => {
    const select = spyOn(backend, "resolveTranscribeBackend").mockReturnValue("chatgpt");
    restores.push(() => select.mockRestore());
    const auth = spyOn(codexAuth, "readCodexAuth").mockReturnValue({ accessToken: "fixture", accountId: "fixture" });
    restores.push(() => auth.mockRestore());
    let audioPath = "";
    const transcribe = spyOn(chatgpt, "callTranscribe").mockImplementation(async (_auth, filePath, mime, language) => {
      audioPath = filePath;
      expect(fs.readFileSync(filePath, "utf8")).toBe(payload);
      expect(mime).toBe(upstreamType);
      expect(language).toBe("uk");
      return { status: 200, body: JSON.stringify({ text: "Transcribed speech" }) };
    });
    restores.push(() => transcribe.mockRestore());

    const result = await upload(filename, type);
    expect(result.parsedType).toBe(parsedType);
    expect(result.response.status).toBe(200);
    expect(await result.response.json()).toEqual({ text: "Transcribed speech" });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(audioPath)).toBe(false);
  });

  test.each([
    ["image.png", "image/png"],
    ["text.txt", "text/plain"],
    ["archive.zip", "application/zip"],
    ["movie.avi", "video/x-msvideo"],
  ])("rejects %s before selecting a backend", async (filename, type) => {
    const select = spyOn(backend, "resolveTranscribeBackend");
    restores.push(() => select.mockRestore());
    const { response } = await upload(filename, type);
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: "expected audio" });
    expect(select).not.toHaveBeenCalled();
  });
});
