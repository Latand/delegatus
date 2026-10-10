import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry } from "./registry";
import { externalRelayFile } from "@/lib/externalRelay/store";
import { rotateOperatorSpawnCapability } from "./operatorCapability";
import { retainProviderRedactionSecrets } from "@/lib/accounts/providerSecretRedaction";
import { bindSpawnDiagnostics, spawnDiagnosticError, spawnDiagnosticErrorForRegistry, withSpawnDiagnostics } from "./spawnDiagnostics";

test("ordinary spawn diagnostics keep their caller attribution and object fields", () => {
  const fields = { launchId: "launch_fixture", conversationId: "conversation_fixture", error: new Error("fixture error"), password: ["ordinary", "fixture", "value"].join("-") };
  const logger = spyOn(console, "error").mockImplementation(() => {});
  try {
    withSpawnDiagnostics("ordinary_fixture", () => spawnDiagnosticError("Launch failed", fields));
    expect(logger).toHaveBeenCalledWith("Launch failed", fields);
  } finally { logger.mockRestore(); }
});

test("owner diagnostics scrub nested Error credentials by key and escaped JSON", () => {
  const secret = ["fixture", "host", "credential", "value"].join("-");
  const error = Object.assign(new Error("refused"), { cause: {
    password: secret, api_key: secret, clientSecret: [secret], token: 12345,
    credentials: { values: [secret] }, nested: new Error(JSON.stringify({ password: secret })),
    detail: JSON.stringify({ payload: JSON.stringify({ api_key: secret }) }),
    tokenCount: 7, passwordChanged: false,
  } });
  Object.defineProperty(error, "password", { value: secret });
  const logger = spyOn(console, "error").mockImplementation(() => {});
  try {
    const report = withSpawnDiagnostics("relay-owner-fixture", () => bindSpawnDiagnostics(() => {
      spawnDiagnosticError("Launch failed", { conversationId: "conversation_fixture", error });
    }));
    report();
    const output = logger.mock.calls[0]![0] as string;
    expect(output).not.toContain(secret);
    expect(output).not.toContain("12345");
    const fields = JSON.parse(output)[1];
    expect(fields).toMatchObject({ conversationId: "conversation_fixture", error: {
      message: "refused", password: "[redacted]", cause: {
        password: "[redacted]", api_key: "[redacted]", clientSecret: "[redacted]",
        token: "[redacted]", credentials: "[redacted]", tokenCount: 7, passwordChanged: false,
      },
    } });
    expect(output).toContain("Launch failed");
  } finally { logger.mockRestore(); }
});

test("owner diagnostics with truncated encoded credentials withhold the payload", () => {
  const logger = spyOn(console, "error").mockImplementation(() => {});
  try {
    withSpawnDiagnostics("relay-owner-fixture", () => spawnDiagnosticError(new Error(
      JSON.stringify({ detail: '{"password":"fixture-host-credential-value' }),
    )));
    expect(logger.mock.calls).toEqual([["Owner relay diagnostic unavailable; sensitive details withheld"]]);
  } finally { logger.mockRestore(); }
});

test("owner diagnostics scrub known credentials in object keys", () => {
  const capability = rotateOperatorSpawnCapability();
  const logger = spyOn(console, "error").mockImplementation(() => {});
  try {
    withSpawnDiagnostics("relay-owner-fixture", () => spawnDiagnosticError("Launch failed", {
      error: Object.assign(new Error("refused"), { cause: { [capability]: "refused" } }),
    }));
    const output = logger.mock.calls[0]![0] as string;
    expect(output).not.toContain(capability);
    expect(JSON.parse(output)[1]).toMatchObject({ error: { cause: { "[redacted]": "refused" } } });
  } finally { logger.mockRestore(); }
});

test("owner diagnostics withhold encoded known credentials in nested JSON", () => {
  const capability = rotateOperatorSpawnCapability();
  const encoded = Array.from(capability, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  const logger = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const text of [`{"detail":"${encoded}"}`, JSON.stringify({ detail: encoded })]) {
      withSpawnDiagnostics("relay-owner-fixture", () => spawnDiagnosticError(new Error(text)));
      const output = logger.mock.calls.at(-1)![0] as string;
      expect(output).not.toContain(capability);
      expect(output).not.toContain(encoded);
      const message = JSON.parse(output)[0].message as string;
      expect(["[redacted]", "[path]"]).toContain(message.startsWith("{") ? JSON.parse(message).detail : message);
    }
  } finally { logger.mockRestore(); }
});

test("owner diagnostics withhold encoded retained provider credentials", () => {
  const value = ["fixture", "retained", "provider", "value"].join("-");
  retainProviderRedactionSecrets([value]);
  const encoded = Array.from(value, char => `%${char.charCodeAt(0).toString(16)}`).join("");
  const logger = spyOn(console, "error").mockImplementation(() => {});
  try {
    withSpawnDiagnostics("relay-owner-fixture", () => spawnDiagnosticError(new Error(JSON.stringify({ detail: encoded }))));
    const output = logger.mock.calls[0]![0] as string;
    expect(output).not.toContain(encoded);
    expect(JSON.parse(output)[0].message).toBe("[redacted]");
  } finally { logger.mockRestore(); }
});

test("owner diagnostics withhold partially encoded capabilities at multiple JSON depths", () => {
  const value = rotateOperatorSpawnCapability();
  let text = value.slice(0, 42) + `\\u${value.charCodeAt(42).toString(16).padStart(4, "0")}`;
  const logger = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (let depth = 0; depth < 4; depth++) {
      text = JSON.stringify({ detail: text });
      withSpawnDiagnostics("relay-owner-fixture", () => spawnDiagnosticError("Launch failed", {
        conversationId: "conversation_fixture", error: Object.assign(new Error("refused"), { cause: { detail: text } }),
      }));
      const output = logger.mock.calls.at(-1)![0] as string;
      expect(output).not.toContain(value.slice(0, 42));
      expect(JSON.parse(output)[1]).toMatchObject({ conversationId: "conversation_fixture", error: {
        message: "refused", cause: { detail: "[redacted]" },
      } });
    }
  } finally { logger.mockRestore(); }
});

test("owner diagnostics check encoded provider credentials before archive path shaping", () => {
  const value = ["fixture-provider-prefix", "fixture", "path"].join("/");
  retainProviderRedactionSecrets([value]);
  const encoded = value.replaceAll("/", "%2F");
  const logger = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const text of [encoded, JSON.stringify({ detail: encoded }), JSON.stringify({ detail: JSON.stringify({ detail: encoded }) })]) {
      withSpawnDiagnostics("relay-owner-fixture", () => spawnDiagnosticError("Launch failed", {
        conversationId: "conversation_fixture", error: Object.assign(new Error("refused"), { cause: { detail: text } }),
      }));
      const output = logger.mock.calls.at(-1)![0] as string;
      expect(output).not.toContain(value.split("/")[0]!);
      expect(JSON.parse(output)[1]).toMatchObject({ conversationId: "conversation_fixture", error: {
        message: "refused", cause: { detail: "[redacted]" },
      } });
    }
  } finally { logger.mockRestore(); }
});

test("owner diagnostics scrub opaque tokens before archive and vendor shaping", () => {
  const logger = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const value of ["q".repeat(36) + ["", "home", "a"].join("-"), "q".repeat(27) + ["", "sk", "r".repeat(12)].join("-")]) {
      for (const text of [value, "%71" + value.slice(1), "\\u0071" + value.slice(1)]) {
        withSpawnDiagnostics("relay-owner-fixture", () => spawnDiagnosticError("Launch failed", {
          error: Object.assign(new Error(text), { cause: { detail: JSON.stringify({ detail: text }) } }),
        }));
        const output = logger.mock.calls.at(-1)![0] as string;
        expect(output).not.toContain(value.slice(0, 27));
        expect(JSON.parse(output)[1].error.message).toBe("[redacted]");
      }
    }
  } finally { logger.mockRestore(); }
});

test("deferred owner diagnostics retain their scope and withhold unserializable input", () => {
  const emitted: unknown[][] = [];
  const logger = spyOn(console, "error").mockImplementation((...args) => { emitted.push(args); });
  try {
    const report = withSpawnDiagnostics("relay-owner-fixture", () => bindSpawnDiagnostics(() => {
      spawnDiagnosticError("Launch failed", { conversationId: "conversation_fixture", get error() { throw Error("private input"); } });
    }));
    report();
    expect(emitted).toEqual([["Owner relay diagnostic unavailable; sensitive details withheld"]]);
  } finally { logger.mockRestore(); }
});

test("a failed credential resolver cannot expose an owner diagnostic", () => {
  const emitted: unknown[][] = [];
  const logger = spyOn(console, "error").mockImplementation((...args) => { emitted.push(args); });
  const read = fs.readFileSync.bind(fs);
  const reader = spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(file) === externalRelayFile("relays")) throw Error("credential store unavailable");
    return (read as (...args: unknown[]) => unknown)(file, ...args);
  }) as typeof fs.readFileSync);
  try {
    withSpawnDiagnostics("relay-owner-fixture", () => spawnDiagnosticError(new Error("sensitive payload")));
    expect(emitted).toEqual([["Owner relay diagnostic unavailable; sensitive details withheld"]]);
  } finally { reader.mockRestore(); logger.mockRestore(); }
});


test("background diagnostics with unreadable attribution fail closed", () => {
  const logger = spyOn(console, "error").mockImplementation(() => {});
  const transcript = path.join(os.tmpdir(), "private-transcript.jsonl");
  try {
    spawnDiagnosticErrorForRegistry({ readOnlySnapshot: () => { throw Error("registry unavailable"); } }, new Error(transcript));
    const logs = JSON.stringify(logger.mock.calls);
    expect(logs).not.toContain(transcript);
  } finally { logger.mockRestore(); }
});


test("background diagnostics for an ordinary receipt preserve normal attribution", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ordinary-diagnostic-"));
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const logger = spyOn(console, "error").mockImplementation(() => {});
  const fields = { conversationId: "conversation_fixture", error: new Error("fixture error") };
  try {
    spawnDiagnosticErrorForRegistry(registry, "Delivery failed", fields);
    expect(logger).toHaveBeenCalledWith("Delivery failed", fields);
  } finally { logger.mockRestore(); registry.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
