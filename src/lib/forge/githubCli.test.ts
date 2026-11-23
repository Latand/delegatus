import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { agentBinaryCandidates } from "../../../bin/agent-binaries.mjs";
import { runGithubCliRead } from "./githubCli";

test.skipIf(process.platform === "win32")("Darwin resolves gh outside a minimal PATH and preserves its pinned config", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gh-resolution-"));
  try {
    const env = { NODE_ENV: "test" as const, HOME: root, PATH: path.join(root, "path"), XDG_CONFIG_HOME: path.join(root, "sandbox"), GH_CONFIG_DIR: path.join(root, "pinned") };
    fs.mkdirSync(env.PATH);
    const candidates = agentBinaryCandidates("gh", { home: root, platform: "darwin", envPath: "" });
    expect(candidates).toContain("/opt/homebrew/bin/gh");
    expect(candidates).toContain("/usr/local/bin/gh");
    const binary = candidates[0]!;
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, '#!/bin/sh\nprintf "fallback:%s\\n" "$GH_CONFIG_DIR"\n', { mode: 0o700 });
    const run = (platform: NodeJS.Platform) => runGithubCliRead(["api"], { env, timeout: 2_000 }, { platform });
    await expect(run("linux")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(run("darwin")).resolves.toBe(`fallback:${env.GH_CONFIG_DIR}\n`);

    fs.writeFileSync(path.join(env.PATH, "gh"), '#!/bin/sh\nprintf "path:%s\\n" "$GH_CONFIG_DIR"\n', { mode: 0o700 });
    await expect(run("darwin")).resolves.toBe(`path:${env.GH_CONFIG_DIR}\n`);
    fs.writeFileSync(path.join(env.PATH, "gh"), "#!/bin/sh\nexit 4\n", { mode: 0o700 });
    await expect(run("darwin")).rejects.toMatchObject({ code: 4 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
