import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { parseConfig, RESERVED_PORTS } from "./lib/config";
import { childEnv } from "./lib/env";

const ROOT = import.meta.dir;

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (name === "node_modules") return [];
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/* Assembled so this file does not match itself. */
const FORBIDDEN = ["pk" + "ill", "kill" + "all", "fus" + "er", "ls" + "of", ".config/" + "agent-log-viewer"];
const PORT_TOKENS = [String(8000 + 898), String(8000 + 899)];

describe("safety grep over prototypes/self-update", () => {
  const sources = files(ROOT).filter((path) => path !== import.meta.path);

  test("no process is ever found by name, pattern or port", () => {
    const hits = sources.flatMap((path) => {
      const text = readFileSync(path, "utf8");
      return FORBIDDEN.filter((token) => text.includes(token)).map((token) => `${relative(ROOT, path)}: ${token}`);
    });
    expect(hits).toEqual([]);
  });

  test("the production ports appear only in the one refusal list", () => {
    const hits = sources.flatMap((path) => readFileSync(path, "utf8").split("\n")
      .filter((line) => PORT_TOKENS.some((token) => line.includes(token)))
      .filter((line) => !line.startsWith("export const RESERVED_PORTS"))
      .map((line) => `${relative(ROOT, path)}: ${line.trim()}`));
    expect(hits).toEqual([]);
    expect(RESERVED_PORTS.map(String)).toEqual(PORT_TOKENS);
  });
});

describe("childEnv", () => {
  const inherited = {
    PATH: "/usr/bin",
    HOME: "/home/someone",
    LLV_STATE_DIR: join(homedir(), ".config", "agent-log-viewer", "state"),
    LLV_STATE_OWNER: "tool",
    LLV_RUNTIME_HOST_SOCKET: "/somewhere/runtime-host.sock",
    __NEXT_PRIVATE_STANDALONE_CONFIG: "{}",
    __NEXT_PRIVATE_ORIGIN: "http://127.0.0.1:1",
    NEXT_DEPLOYMENT_ID: "abc",
    NEXT_PHASE: "phase-production-build",
    NODE_ENV: "production",
    TMPDIR: "/somewhere/scratch",
    PORT: "1",
    HOSTNAME: "workstation",
  };
  const root = "/var/tmp/self-update-root";

  test("strips every inherited LLV_*, NEXT_*, __NEXT_*, NODE_ENV, TMPDIR, PORT and HOSTNAME for a build", () => {
    const env = childEnv({ configRoot: root, webPort: 45123 }, "build", inherited);
    for (const key of Object.keys(env)) expect(key.startsWith("__NEXT_")).toBe(false);
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.NEXT_DEPLOYMENT_ID).toBeUndefined();
    expect(env.NEXT_PHASE).toBeUndefined();
    expect(env.PORT).toBeUndefined();
    expect(env.HOSTNAME).toBeUndefined();
    expect(env.LLV_STATE_OWNER).toBeUndefined();
    expect(env.LLV_STATE_DIR).toBe(`${root}/state`);
    expect(env.TMPDIR).toBe(`${root}/tmp`);
    expect(env.XDG_CONFIG_HOME).toBe(root);
    expect(env.XDG_CACHE_HOME).toBe(`${root}/cache`);
    expect(env.LLV_RUNTIME_HOST_SOCKET).toBe(`${root}/state/runtime-host.sock`);
    expect(env.LLV_RUNTIME_HOST_FENCE).toBe(`${root}/state/runtime-host.sock.lock`);
    expect(env.LLV_RUNTIME_JOURNAL).toBe(`${root}/state/runtime-events.sqlite`);
    expect(env.NEXT_PUBLIC_RUNTIME_UI).toBe("1");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/someone");
    expect(env.LLV_VIEWER_DEPLOYMENTS).toBeUndefined();
  });

  test("web claims the viewer owner and its port on loopback", () => {
    const env = childEnv({ configRoot: root, webPort: 45123 }, "web", inherited);
    expect(env.LLV_STATE_OWNER).toBe("viewer");
    expect(env.PORT).toBe("45123");
    expect(env.HOSTNAME).toBe("127.0.0.1");
  });

  test("the runtime host claims its own owner", () => {
    const env = childEnv({ configRoot: root, webPort: 45123 }, "runtime-host", inherited);
    expect(env.LLV_STATE_OWNER).toBeUndefined();
    expect(env.PORT).toBeUndefined();
    expect(env.LLV_STRUCTURED_HOSTS).toBe("1");
  });

  test("refuses a config root under $HOME/.config", () => {
    expect(() => childEnv({ configRoot: join(homedir(), ".config"), webPort: 1 }, "build", inherited)).toThrow("~/.config");
    expect(() => childEnv({ configRoot: join(homedir(), ".config", "x"), webPort: 1 }, "build", inherited)).toThrow("~/.config");
  });
});

describe("parseConfig", () => {
  const home = homedir();
  const base = ["--checkout", "/var/tmp/b/checkout", "--config-root", "/var/tmp/b/config", "--web-port", "45123"];

  test("reads flags and applies the defaults", () => {
    const config = parseConfig(base, {}, home);
    expect(config.remote).toBe("https://github.com/Latand/live-log-viewer-next.git");
    expect(config.branch).toBe("main");
    expect(config.pollMinutes).toBe(60);
    expect(config.port).toBe(0);
    expect(config.bun).toBe(process.execPath);
    expect(config.processesFile).toBe("/var/tmp/b/config/self-update/processes.json");
  });

  test("reads the environment when a flag is absent", () => {
    const config = parseConfig([], {
      SELF_UPDATE_CHECKOUT: "/var/tmp/c", SELF_UPDATE_CONFIG_ROOT: "/tmp/r", SELF_UPDATE_WEB_PORT: "40000",
      SELF_UPDATE_BRANCH: "next", SELF_UPDATE_POLL_MINUTES: "5",
    }, home);
    expect(config.checkout).toBe("/var/tmp/c");
    expect(config.branch).toBe("next");
    expect(config.pollMinutes).toBe(5);
  });

  test("refuses the production ports, a missing value and a root outside the temp directories", () => {
    for (const port of RESERVED_PORTS) {
      expect(() => parseConfig([...base.slice(0, 4), "--web-port", String(port)], {}, home)).toThrow("reserved");
    }
    expect(() => parseConfig(base.slice(0, 4), {}, home)).toThrow("--web-port");
    expect(() => parseConfig([...base.slice(0, 2), "--config-root", "/srv/root", ...base.slice(4)], {}, home)).toThrow("/var/tmp");
    expect(parseConfig([...base.slice(0, 2), "--config-root", "/srv/root", ...base.slice(4), "--allow-any-root"], {}, home).configRoot).toBe("/srv/root");
    expect(() => parseConfig([...base.slice(0, 2), "--config-root", join(home, ".config", "x"), ...base.slice(4), "--allow-any-root"], {}, home)).toThrow("~/.config");
  });
});
