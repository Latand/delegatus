import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realExec } from "@/lib/workflows/provision";
import { ClaudeStreamBrokerHost } from "./claudeStreamBrokerHost";
import { CodexAppServerHost } from "./codexAppServerHost";

const sessionId = ["00000000", "0000", "4000", "8000", "000000000001"].join("-");
const refusals = [
  ["malformed publication manifest", "Repository publication configuration could not be read (values withheld)"],
  ["failed Git identity read", "Repository Git identity could not be read (values withheld)"],
  ["invalid repository identity", "Invalid repository Git identity (values withheld)"],
  ["invalid publication identity", "Invalid agent publication identity"],
] as const;

for (const [engine, Host] of [["Claude", ClaudeStreamBrokerHost], ["Codex", CodexAppServerHost]] as const) {
  describe(`${engine} repository identity startup cleanup`, () => {
    for (const mode of ["fresh", "adopted"] as const) {
      for (const [failure, message] of refusals) {
        test(`${mode}: ${failure} releases scratch once before rejecting without a child`, async () => {
          const root = fs.mkdtempSync(path.join(os.tmpdir(), "repository-identity-cleanup-"));
          const cwd = path.join(root, "repository");
          const scratch = path.join(root, "scratch");
          fs.mkdirSync(cwd);
          fs.mkdirSync(scratch);
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            DELEGATUS_PUBLICATION_EMAIL: undefined,
            LLV_PUBLICATION_EMAIL: failure === "invalid publication identity" ? "invalid" : undefined,
          };
          const git = async (...args: string[]) => {
            const result = await realExec("git", args, cwd, env);
            expect(result.code, result.stderr).toBe(0);
          };
          let cleanups = 0;
          let launches = 0;
          try {
            await git("init", "-q", "-b", "main");
            if (failure === "malformed publication manifest") {
              fs.writeFileSync(path.join(cwd, "package.json"), "{");
            } else if (failure === "failed Git identity read") {
              fs.appendFileSync(path.join(cwd, ".git", "config"), "\n[unterminated\n");
            } else if (failure === "invalid repository identity") {
              await git("config", "user.name", "Invalid\nFixture");
              await git("config", "user.email", ["fixture", "example.invalid"].join("@"));
            } else if (failure === "invalid publication identity") {
              fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
                scripts: { "privacy:check": "bun scripts/privacy-publication-gate.ts" },
              }));
              fs.mkdirSync(path.join(cwd, "scripts"));
              fs.writeFileSync(path.join(cwd, "scripts", "privacy-known-value-fingerprints.json"), "{}");
            }
            const options = {
              cwd, env, sessionId, permissionMode: "bypassPermissions" as const,
              readProtocolVersion: () => "0.162.1",
              releaseCleanup: () => {
                cleanups++;
                fs.rmSync(scratch, { recursive: true, force: true });
              },
              spawnProcess: () => { launches++; throw new Error("Unexpected host child launch"); },
            };
            const opening = mode === "fresh" ? Host.start(options) : Host.adopt(sessionId, options);
            await expect(opening).rejects.toThrow(message);
            expect(cleanups).toBe(1);
            expect(fs.existsSync(scratch)).toBe(false);
            expect(launches).toBe(0);
          } finally {
            fs.rmSync(root, { recursive: true, force: true });
          }
        });
      }
    }
  });
}
