import { execFile } from "node:child_process";

import type { CodexAuth } from "@/lib/codexAuth";

import { transcriptionLanguage } from "./languages";

import type { UpstreamResult } from "./types";

/* ChatGPT-backend path (opt-in only). Same endpoint the Codex Desktop composer
   dictation posts to. Cloudflare fingerprints the TLS client: node/undici fetch
   gets a 403 HTML challenge while curl passes, so the upstream call shells out
   to curl. The token goes in via a stdin config file, never on the argv. */
const TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";
const UPSTREAM_TIMEOUT_S = 90;

export function callTranscribe(auth: CodexAuth, audioPath: string, mime: string, language: string): Promise<UpstreamResult> {
  const config = [
    `url = "${TRANSCRIBE_URL}"`,
    `request = "POST"`,
    "silent",
    `max-time = ${UPSTREAM_TIMEOUT_S}`,
    `header = "Authorization: Bearer ${auth.accessToken}"`,
    `header = "chatgpt-account-id: ${auth.accountId}"`,
    `header = "originator: codex_cli_rs"`,
    `header = "User-Agent: codex_cli_rs (live-log-viewer)"`,
    `form = "file=@${audioPath};type=${mime}"`,
    `form = "language=${transcriptionLanguage(language)}"`,
    `write-out = "\\n%{http_code}"`,
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = execFile(
      "curl",
      ["--config", "-"],
      { maxBuffer: 4 * 1024 * 1024, timeout: (UPSTREAM_TIMEOUT_S + 5) * 1000 },
      (error, stdout) => {
        if (error && !stdout) {
          reject(new Error(error.message));
          return;
        }
        const cut = stdout.lastIndexOf("\n");
        const status = Number(stdout.slice(cut + 1).trim());
        resolve({ status: Number.isInteger(status) ? status : 0, body: stdout.slice(0, cut) });
      },
    );
    child.stdin?.end(config);
  });
}
