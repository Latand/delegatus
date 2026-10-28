import { expect, test } from "bun:test";
import { githubReadBackoff, githubReadFailure } from "./githubReadFailure";
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
  expect(githubReadFailure(new Error(`Command failed: gh --credential ${credential}`)).reason).toBe("GitHub read failed: no diagnostic returned");
});

function pathFromParts(): string {
  return ["", "home", "fixture", "private", "config"].join("/");
}

test("retry backoff starts at one minute and remains capped", () => {
  expect([1, 2, 3, 4, 5, 100].map(githubReadBackoff)).toEqual([60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
});

test.each([401, 403, 404, 429, 503])("status %s in a URL or PR number is not an HTTP status", status => {
  const result = githubReadFailure(new Error(`request ${status} failed for https://github.com/acme/timeout/pull/${status}: HTTP 503: Service Unavailable`));
  expect(result).toMatchObject({ transient: true, reason: expect.stringContaining("GitHub read temporarily unavailable:") });
});

test("message-only command wrappers are stripped before classification", () => {
  expect(githubReadFailure(new Error("Command failed: gh pr view 429 --repo acme/timeout\nHTTP 401: Bad credentials")))
    .toEqual({ transient: false, reason: "GitHub read authentication failed: HTTP 401: Bad credentials" });
});

test.each(["timeout", "rate-limit", "authentication"])("not-found evidence precedes quoted repository %s", name => {
  const diagnostic = `GraphQL: Could not resolve to a Repository with the name 'acme/${name}'. (repository)`;
  expect(githubReadFailure(Object.assign(new Error("Command failed: gh"), { stderr: diagnostic })))
    .toEqual({ transient: false, reason: `GitHub read not found: ${diagnostic}` });
});

test("timeout limit survives redaction and bounding before a long diagnostic", () => {
  const credential = ["ghp", "x".repeat(36)].join("_");
  const failure = Object.assign(new Error("Command failed: gh"), {
    killed: true, signal: "SIGTERM", timeoutMs: 1234, stderr: `${credential} ${"detail ".repeat(200)}`,
  });
  const result = githubReadFailure(failure);
  expect(result.reason).toStartWith("GitHub read timed out: limit 1234 ms; ");
  expect(result.reason.length).toBeLessThanOrEqual(400);
  expect(result.reason).not.toContain(credential);
  expect(result.transient).toBe(true);
});
