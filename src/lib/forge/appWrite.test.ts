import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FORGE_APP_TOKEN_MARGIN_MS, ForgeAppTokenSource, ForgeAppWriteRefused, forgeAppWriter, mintForgeAppToken } from "./appWrite";

/* The engine's write seam with an invented repository and tokens. `gh` is a
   function here and the minting helper a stand-in or the real one facing an
   empty credential store; nothing reaches GitHub. */
const REPO = "acme/widgets";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-app-write-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const source: NodeJS.ProcessEnv = { NODE_ENV: "test", HOME: root, PATH: process.env.PATH, GH_CONFIG_DIR: path.join(root, "operator-gh"), GITHUB_TOKEN: "inherited", GH_ENTERPRISE_TOKEN: "inherited" };

describe("the token the engine holds", () => {
  test("is minted once, reused while it is good, and minted again before it expires", async () => {
    let clock = Date.parse("2030-01-01T00:00:00Z");
    const minted: string[] = [];
    const tokens = new ForgeAppTokenSource(async (repository) => {
      minted.push(repository);
      return { token: `token-${minted.length}`, expiresAt: new Date(clock + 60 * 60_000).toISOString() };
    }, () => clock);
    expect(await tokens.token(REPO)).toBe("token-1");
    clock += 54 * 60_000;
    expect(await tokens.token("Acme/Widgets")).toBe("token-1");
    clock += 60_000 + 1;
    expect(60 * 60_000 - (55 * 60_000 + 1)).toBeLessThan(FORGE_APP_TOKEN_MARGIN_MS);
    expect(await tokens.token(REPO)).toBe("token-2");
    expect(minted).toEqual([REPO, REPO]);
  });

  test("is per repository, and is dropped when GitHub stops taking it", async () => {
    let count = 0;
    const tokens = new ForgeAppTokenSource(async () => ({ token: `token-${++count}`, expiresAt: "2999-01-01T00:00:00Z" }), () => 0);
    expect(await tokens.token(REPO)).toBe("token-1");
    expect(await tokens.token("acme/other")).toBe("token-2");
    tokens.forget(REPO);
    expect(await tokens.token(REPO)).toBe("token-3");
    expect(await tokens.token("acme/other")).toBe("token-2");
  });

  test("with no expiry is used for one write only", async () => {
    let count = 0;
    const tokens = new ForgeAppTokenSource(async () => ({ token: `token-${++count}`, expiresAt: null }), () => 0);
    expect([await tokens.token(REPO), await tokens.token(REPO)]).toEqual(["token-1", "token-2"]);
  });
});

describe("a write by the engine", () => {
  test("starts gh with the App token as its whole identity", async () => {
    const started: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const write = forgeAppWriter(root, 1_000, {
      source,
      tokens: new ForgeAppTokenSource(async () => ({ token: "app-token", expiresAt: null })),
      exec: async (args, env) => { started.push({ args, env }); return "done"; },
    });
    expect(await write(["pr", "merge", "5", "--repo", REPO, "--squash"], REPO)).toBe("done");
    expect(started).toHaveLength(1);
    const env = started[0]!.env;
    expect(env.GH_TOKEN).toBe("app-token");
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined();
    /* Not the configuration of whoever started the Viewer: an empty directory. */
    expect(env.GH_CONFIG_DIR).not.toBe(source.GH_CONFIG_DIR);
    expect(fs.readdirSync(env.GH_CONFIG_DIR!)).toEqual([]);
  });

  test("negative control: with no App credential gh is never started", async () => {
    const started: string[][] = [];
    const write = forgeAppWriter(root, 1_000, {
      source,
      tokens: new ForgeAppTokenSource(async () => { throw new ForgeAppWriteRefused("Delegatus refused this GitHub write to acme/widgets: no GitHub App credential is available for it."); }),
      exec: async (args) => { started.push(args); return ""; },
    });
    await expect(write(["pr", "merge", "5"], REPO)).rejects.toBeInstanceOf(ForgeAppWriteRefused);
    expect(started).toEqual([]);
  });

  test("a token GitHub rejects is forgotten, so the next write mints again", async () => {
    let count = 0;
    const tokens = new ForgeAppTokenSource(async () => ({ token: `token-${++count}`, expiresAt: "2999-01-01T00:00:00Z" }), () => 0);
    const seen: Array<string | undefined> = [];
    const write = forgeAppWriter(root, 1_000, {
      source, tokens,
      exec: async (_args, env) => {
        seen.push(env.GH_TOKEN);
        if (seen.length === 1) throw Object.assign(new Error("Command failed"), { stderr: "gh: Bad credentials (HTTP 401)" });
        return "";
      },
    });
    await expect(write(["pr", "merge", "5"], REPO)).rejects.toThrow();
    await write(["pr", "merge", "5"], REPO);
    expect(seen).toEqual(["token-1", "token-2"]);
  });
});

test.skipIf(process.platform === "win32")("negative control: the real helper facing an empty credential store refuses in plain words", async () => {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "secret-tool"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const error = await mintForgeAppToken(REPO, { ...source, PATH: `${bin}${path.delimiter}${process.env.PATH}` }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ForgeAppWriteRefused);
  expect((error as Error).message).toBe("Delegatus refused this GitHub write to acme/widgets: no GitHub App credential is available for it. "
    + "Agents and pipelines write to GitHub only as the Delegatus GitHub App and never with a person's credentials, so nothing was sent. "
    + "The operator can check that the App is installed on this repository and that the credential store is unlocked.");
});
