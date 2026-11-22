import { expect, test } from "bun:test";
import { githubReadBackoff, githubReadDiagnostic, githubReadFailure } from "./githubReadFailure";
import { ForgeAppWriteRefused } from "./appWrite";
import { refusalMessage } from "../../../bin/forge-app-token.mjs";

test.each([
  ["GitHub answered HTTP 429 while verifying the App installation", "rate limited", true],
  ["GitHub answered HTTP 403 (rate limited) while verifying the App installation", "rate limited", true],
  ["GitHub answered HTTP 500 while verifying the App installation", "temporarily unavailable", true],
  ["GitHub answered HTTP 503 while verifying the App installation", "temporarily unavailable", true],
  ["GitHub could not be reached to verify the App installation", "temporarily unavailable", true],
  ["GitHub answered HTTP 401 while verifying the App installation", "authentication failed", false],
  ["GitHub answered HTTP 403 while verifying the App installation", "authentication failed", false],
  ["GitHub answered HTTP 404 while verifying the App installation", "not found", false],
] as const)("App verification: %s", (cause, category, transient) => {
  const error = new ForgeAppWriteRefused(refusalMessage("acme/timeout", cause));
  expect(githubReadFailure(error)).toEqual({ reason: `GitHub read ${category}: ${cause}`, transient });
});

test.each(["timeout", "rate-limit", "connection", "HTTP503"])("unavailable App credentials for %s stay permanent", name => {
  const error = new ForgeAppWriteRefused(refusalMessage(`acme/${name}`, "no GitHub App credential is available for it"));
  expect(githubReadFailure(error)).toMatchObject({ reason: expect.stringContaining("GitHub App read refused:"), transient: false });
});

test.each([
  [Object.assign(new Error("request ended"), { code: "ETIMEDOUT" }), "timed out", true],
  [new Error("HTTP 403: secondary rate limit"), "rate limited", true],
  [new Error("HTTP 503: Service Unavailable"), "temporarily unavailable", true],
  [Object.assign(new Error("socket ended"), { code: "ECONNRESET" }), "temporarily unavailable", true],
  [new Error("HTTP 403: Resource not accessible by integration"), "authentication failed", false],
  [Object.assign(new Error("CLI needs login"), { code: 4 }), "authentication failed", false],
  [new Error("HTTP 404: Not Found"), "not found", false],
  [new Error("authentication token not found"), "authentication failed", false],
  [new SyntaxError("Unexpected end of JSON input"), "invalid response", false],
  [null, "failed", false],
] as const)("classifies %s", (error, category, transient) => {
  expect(githubReadFailure(error)).toMatchObject({ reason: expect.stringContaining(`GitHub read ${category}:`), transient });
});

test("redacts before bounding a diagnostic and never retains the command line", () => {
  const credential = ["ghp", "x".repeat(36)].join("_");
  const address = ["fixture", "example.invalid"].join("@");
  const privatePath = pathFromParts();
  const error = Object.assign(new Error(`Command failed: gh --credential ${credential}`), {
    stderr: `HTTP 401: ${credential} ${address} ${privatePath} ${"detail ".repeat(200)}`,
  });
  const result = githubReadFailure(error);
  expect(result.reason).toStartWith("GitHub read authentication failed:");
  expect(result.reason.length).toBeLessThanOrEqual(400);
  for (const value of [credential, address, privatePath, "Command failed"]) expect(result.reason).not.toContain(value);
  expect(githubReadFailure(new Error(`Command failed: gh --credential ${credential}`)).reason).toBe("GitHub read failed: details withheld for privacy");
});

function pathFromParts(): string {
  return ["", "home", "fixture", "private", "config"].join("/");
}

test("an unknown gh exit logs only a bounded scrubbed excerpt and a remedy", () => {
  const credential = ["ghp", "x".repeat(36)].join("_");
  const address = ["fixture", "example.invalid"].join("@");
  const url = "https://example.invalid/private";
  const error = Object.assign(new Error("Command failed: gh private-argument"), {
    code: 17, stderr: `\x1b[31munknown option\x1b[0m ${credential} ${address} ${pathFromParts()} ${url} ${"detail ".repeat(200)}\nsecond line`,
  });
  const diagnostic = githubReadDiagnostic(error);
  expect(diagnostic.cause).toBe("command-error");
  expect(diagnostic.message).toStartWith("GitHub read failed (exit 17): unknown option.");
  expect(diagnostic.message).toEndWith("Check the gh installation and configuration, then retry.");
  expect(diagnostic.message.length).toBeLessThan(500);
  for (const value of [credential, address, pathFromParts(), url, "private-argument", "second line", "\x1b"]) {
    expect(diagnostic.message).not.toContain(value);
  }
});

test.each([
  ["gh: unknown flag: --private-account-handle", "unknown flag"],
  ["unknown option --private-account-handle", "unknown option"],
  ["unknown option --connection-timeout-configuration", "unknown option"],
  ["unexpected output: unknown option --private-account-handle", "details withheld for privacy"],
])("only an actual unknown option diagnostic supplies a fixed phrase: %s", (stderr, excerpt) => {
  const error = { code: 17, stderr };
  const reason = `GitHub read failed (exit 17): ${excerpt}`;
  expect(githubReadFailure(error)).toEqual({ reason, transient: false });
  expect(githubReadDiagnostic(error)).toEqual({
    cause: "command-error",
    message: `${reason}. Check the gh installation and configuration, then retry.`,
  });
});

test.each([
  "proxyconnect tcp: tls: failed to verify certificate: x509: certificate signed by unknown authority",
  "certificate verify failed: x509: unknown authority",
  "connection failed: tls: failed to verify certificate: x509: certificate is valid for example.invalid, not api.github.com",
])("diagnoses TLS verification failures ahead of transport text: %s", stderr => {
  const error = Object.assign(new Error("Command failed: gh api"), { code: 1, stderr });
  expect(githubReadDiagnostic(error)).toEqual({
    cause: "certificate",
    message: "GitHub TLS certificate verification failed. Check the system trust store and proxy certificate configuration, then retry.",
  });
  expect(githubReadFailure(error).transient).toBe(false);
});

test("Go DNS failures are actionable without admitting transient merge fallback", () => {
  const error = { code: 1, stderr: "network connection failed: lookup example.invalid: no such host" };
  expect(githubReadDiagnostic(error)).toEqual({
    cause: "dns",
    message: "GitHub DNS lookup failed. Check DNS and proxy settings, then retry.",
  });
  expect(githubReadFailure(error)).toEqual({
    reason: "GitHub DNS lookup failed: details withheld for privacy", transient: false,
  });
});

test.each([
  ["gh: pull request not found\nwarning: connection closed", "not-found", "not found"],
  ["dial tcp: ENETUNREACH", "network", "temporarily unavailable"],
] as const)("the optional read diagnoses %s while the merge read blocks", (stderr, cause, label) => {
  const error = { code: 1, stderr };
  expect(githubReadDiagnostic(error).cause).toBe(cause);
  expect(githubReadFailure(error)).toEqual({
    reason: `GitHub read ${label}: details withheld for privacy`, transient: false,
  });
});

test.each([
  ["HTTP CONNECT: 407 Proxy Authentication Required", false],
  ["proxyconnect tcp: unexpected EOF", false],
])("proxy transport failure %s stays network classified", (stderr, transient) => {
  const error = Object.assign(new Error("Command failed: gh api"), { code: 1, stderr });
  expect(githubReadDiagnostic(error).cause).toBe("network");
  expect(githubReadDiagnostic(error).message).toContain("Check connectivity");
  expect(githubReadFailure(error).transient).toBe(transient);
});

test("classified reasons never retain handles, repository slugs, or macOS paths", () => {
  const error = Object.assign(new Error("request failed"), {
    code: 1, stderr: "HTTP 401: @synthetic_handle private-owner/private-repo /Volumes/Private Drive/Account A/config",
  });
  const reason = githubReadFailure(error).reason;
  for (const fragment of ["@synthetic_handle", "private-owner/private-repo", "/Volumes/Private Drive/Account A/config"]) {
    expect(reason).not.toContain(fragment);
  }
});

test("retry backoff starts at one minute and remains capped", () => {
  expect([1, 2, 3, 4, 5, 100].map(githubReadBackoff)).toEqual([60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
});

test.each([401, 403, 404, 429, 503])("status %s in a URL or PR number is not an HTTP status", status => {
  const result = githubReadFailure(new Error(`request ${status} failed for https://github.com/acme/timeout/pull/${status}: HTTP 503: Service Unavailable`));
  expect(result).toMatchObject({ transient: true, reason: expect.stringContaining("GitHub read temporarily unavailable:") });
});

test("message-only command wrappers are stripped before classification", () => {
  expect(githubReadFailure(new Error("Command failed: gh pr view 429 --repo acme/timeout\nHTTP 401: Bad credentials")))
    .toEqual({ transient: false, reason: "GitHub read authentication failed: details withheld for privacy" });
});

test.each(["timeout", "rate-limit", "authentication"])("not-found evidence precedes quoted repository %s", name => {
  const diagnostic = `GraphQL: Could not resolve to a Repository with the name 'acme/${name}'. (repository)`;
  expect(githubReadFailure(Object.assign(new Error("Command failed: gh"), { stderr: diagnostic })))
    .toEqual({ transient: false, reason: "GitHub read not found: details withheld for privacy" });
});

test("timeout limit survives redaction and bounding before a long diagnostic", () => {
  const credential = ["ghp", "x".repeat(36)].join("_");
  const failure = Object.assign(new Error("Command failed: gh"), {
    killed: true, signal: "SIGTERM", timeoutMs: 1234, stderr: `${credential} ${"detail ".repeat(200)}`,
  });
  const result = githubReadFailure(failure);
  expect(result.reason).toStartWith("GitHub read timed out: limit 1234 ms");
  expect(result.reason.length).toBeLessThanOrEqual(400);
  expect(result.reason).not.toContain(credential);
  expect(result.transient).toBe(true);
});
