import { expect, test } from "bun:test";

import { connectionFailure, describeTransientGitFailure, transientGitFailure } from "./transientFailure";

test("the wordings from the incidents classify as transient, each by its class", () => {
  expect(transientGitFailure("fatal: unable to access 'https://github.com/example/delegatus.git/': Could not resolve host: github.com")).toBe("dns");
  expect(transientGitFailure("ssh: Could not resolve hostname github.com: Temporary failure in name resolution")).toBe("dns");
  expect(transientGitFailure("resolve image config for docker-image://docker.io/docker/dockerfile:1.7: lookup registry-1.docker.io on 127.0.0.53:53: no such host")).toBe("dns");
  expect(transientGitFailure("fatal: cannot lock ref 'refs/heads/pipeline/a-1': Unable to create '/repo/.git/refs/heads/pipeline/a-1.lock': File exists.")).toBe("lock");
  expect(transientGitFailure("fatal: Unable to create '/repo/.git/index.lock': File exists.")).toBe("lock");
  expect(transientGitFailure("fatal: Unable to create '/repo/.git/packed-refs.lock': File exists.")).toBe("lock");
  expect(transientGitFailure("git worktree add: checkout interrupted or timed out after 60s")).toBe("timeout");
  expect(transientGitFailure("fetching origin/main: git fetch timed out after 60s")).toBe("network");
});

test("a real error is never transient, even when it mentions a lock or a connection", () => {
  for (const error of [
    "fatal: couldn't find remote ref refs/heads/missing",
    "Permission denied (publickey).\nConnection closed by 140.82.121.4 port 22",
    "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/example/delegatus.git/'",
    "remote: Repository not found.",
    "fatal: cannot lock ref 'refs/heads/a/b': 'refs/heads/a' exists; cannot create 'refs/heads/a/b'",
    "fatal: a branch named 'pipeline/a-1' already exists",
    "fatal: invalid reference: main",
    "origin unavailable",
  ]) expect(transientGitFailure(error)).toBeNull();
});

test("a whole build is retried only for name resolution and connection failures", () => {
  expect(connectionFailure("ERROR: failed to solve: lookup registry-1.docker.io: no such host")).toBe("dns");
  expect(connectionFailure("error: getaddrinfo EAI_AGAIN registry.npmjs.org")).toBe("dns");
  expect(connectionFailure("net/http: TLS handshake timeout")).toBe("network");
  expect(connectionFailure("RUN bun test: test timed out after 5000ms")).toBeNull();
  expect(connectionFailure("error: lockfile had changes, but lockfile is frozen")).toBeNull();
});

test("the cause names the host a DNS failure could not resolve", () => {
  expect(describeTransientGitFailure("dns", "Could not resolve host: github.com").cause).toBe("DNS lookup of github.com failed");
  expect(describeTransientGitFailure("dns", "lookup registry-1.docker.io: no such host").cause).toBe("DNS lookup of registry-1.docker.io failed");
  expect(describeTransientGitFailure("dns", "Temporary failure in name resolution").cause).toBe("a DNS lookup failed");
});
