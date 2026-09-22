import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

import { buildEnv } from "./env";

/* #2007, carried over from the prototype: self-update finds a process only
   by the PID it recorded, never by name, pattern or port, and a build never
   inherits the serving install's state, socket or Next configuration. */

const REPO = resolve(import.meta.dir, "../../..");
const SOURCES = [
  join(REPO, "src/lib/selfUpdate"),
  join(REPO, "src/components/selfUpdate"),
  join(REPO, "src/app/api/self-update"),
  join(REPO, "bin/self-update-supervisor.mjs"),
];

function files(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => files(join(path, name)));
}

/* Assembled so this file does not match itself. */
const FORBIDDEN = ["pk" + "ill", "kill" + "all", "fus" + "er", "ls" + "of", ".config/" + "agent-log-viewer", String(8000 + 898), String(8000 + 899)];

describe("safety grep over the self-update sources", () => {
  test("no process is found by name, pattern or port, and no operator path is written in", () => {
    const hits = SOURCES.flatMap(files).filter((path) => path !== import.meta.path).flatMap((path) => {
      const text = readFileSync(path, "utf8");
      return FORBIDDEN.filter((token) => text.includes(token)).map((token) => `${relative(REPO, path)}: ${token}`);
    });
    expect(hits).toEqual([]);
  });
});

describe("buildEnv", () => {
  const inherited = {
    PATH: "/usr/bin",
    HOME: "/home/someone",
    LLV_STATE_DIR: join(homedir(), ".config", "agent-log-viewer", "state"),
    LLV_STATE_OWNER: "viewer",
    LLV_RUNTIME_HOST_SOCKET: "/somewhere/runtime-host.sock",
    LLV_SELF_UPDATE_RECORD: "/somewhere/launcher.json",
    __NEXT_PRIVATE_STANDALONE_CONFIG: "{}",
    __NEXT_PRIVATE_ORIGIN: "http://127.0.0.1:1",
    NEXT_DEPLOYMENT_ID: "abc",
    NODE_ENV: "production",
    TMPDIR: "/somewhere/scratch",
    PORT: "1",
    HOSTNAME: "workstation",
  };

  test("drops the serving install's state, socket, owner token, Next config, NODE_ENV, port and host", () => {
    const env = buildEnv("/var/tmp/self-update-scratch", inherited);
    for (const key of Object.keys(env)) expect(key.startsWith("__NEXT_")).toBe(false);
    expect(env.NEXT_DEPLOYMENT_ID).toBeUndefined();
    expect(env.NEXT_PUBLIC_RUNTIME_UI).toBe("1");
    for (const key of ["LLV_STATE_OWNER", "LLV_RUNTIME_HOST_SOCKET", "LLV_SELF_UPDATE_RECORD", "NODE_ENV", "PORT", "HOSTNAME"]) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/someone");
  });

  test("gives the build a scratch state directory and temp directory of its own", () => {
    const env = buildEnv("/var/tmp/self-update-scratch", inherited);
    expect(env.LLV_STATE_DIR).toBe("/var/tmp/self-update-scratch/build-state");
    expect(env.TMPDIR).toBe("/var/tmp/self-update-scratch/tmp");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });
});
