import { describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";

import {
  FORGE_APP_PERMISSIONS, FORGE_READ_CONFIG_ENV, ForgeAppRefusal, classifyGh, gitCredential, mintInstallationToken, parseRepository, runGh,
} from "./forge-app-token.mjs";

/* The App helper against an invented App: a key generated here, an invented
   repository and a fake GitHub. No credential store, no network, no real `gh`. */
const REPO = "acme/widgets";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ISSUED = "installation-token-for-tests";
const OPERATOR_CONFIG = "/operator/gh";
/* Address-shaped and credential-shaped fixtures are joined, never written out. */
const at = (user: string, host: string) => [user, host].join("@");

type Call = { method: string; target: string; token?: string; body?: unknown };
type Answer = { status: number; body: unknown };

function fakeGitHub(overrides: Record<string, Answer> = {}) {
  const calls: Call[] = [];
  const answers: Record<string, Answer> = {
    [`GET repos/${REPO}/installation`]: { status: 200, body: { id: 42, app_id: 7, account: { login: "Acme" }, suspended_at: null, permissions: { ...FORGE_APP_PERMISSIONS } } },
    "POST app/installations/42/access_tokens": { status: 201, body: { token: ISSUED, expires_at: "2030-01-01T01:00:00Z", permissions: { ...FORGE_APP_PERMISSIONS } } },
    "GET installation/repositories?per_page=100": { status: 200, body: { total_count: 1, repositories: [{ full_name: REPO }] } },
    "DELETE installation/token": { status: 204, body: null },
    ...overrides,
  };
  return {
    calls,
    request: async (method: string, target: string, options: { token?: string; body?: unknown } = {}) => {
      calls.push({ method, target, ...options });
      return answers[`${method} ${target}`] ?? { status: 404, body: null };
    },
  };
}

function ports(options: { credential?: unknown; github?: ReturnType<typeof fakeGitHub>; env?: Record<string, string>; origin?: string | null } = {}) {
  const github = options.github ?? fakeGitHub();
  const started: Array<{ command: string; args: string[]; env: Record<string, string | undefined> }> = [];
  const out: string[] = [];
  const err: string[] = [];
  const credential = "credential" in options ? options.credential : { id: 7, pem, installation_id: 42 };
  return {
    github, started, out, err,
    env: options.env ?? { [FORGE_READ_CONFIG_ENV]: OPERATOR_CONFIG, GH_CONFIG_DIR: "/agent/empty", GITHUB_TOKEN: "inherited-token" },
    now: () => Date.parse("2030-01-01T00:00:00Z"),
    originRepository: async () => (options.origin === undefined ? REPO : options.origin),
    readCredential: async () => (credential == null ? null : JSON.stringify(credential)),
    request: github.request,
    findGh: () => "/usr/bin/gh",
    exec: async (command: string, args: string[], env: Record<string, string | undefined>) => { started.push({ command, args, env }); return 0; },
    readStdin: async () => "",
    stdout: (text: string) => { out.push(text); },
    stderr: (text: string) => { err.push(text); },
  };
}

describe("minting", () => {
  test("a verified installation yields a token asked for one repository and three permissions, signed by the App key", async () => {
    const p = ports();
    expect(await mintInstallationToken(REPO, p)).toEqual({ token: ISSUED, expiresAt: "2030-01-01T01:00:00Z", repository: REPO });
    expect(p.github.calls.map((call) => `${call.method} ${call.target}`)).toEqual([
      `GET repos/${REPO}/installation`, "POST app/installations/42/access_tokens", "GET installation/repositories?per_page=100",
    ]);
    expect(p.github.calls[1]!.body).toEqual({ repositories: ["widgets"], permissions: { ...FORGE_APP_PERMISSIONS } });
    const [header, payload, signature] = p.github.calls[0]!.token!.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({ iat: 1893455940, exp: 1893456540, iss: "7" });
    /* The installation token, and not the App's own, proves what it reaches. */
    expect(p.github.calls[2]!.token).toBe(ISSUED);
  });

  test.each([
    ["no credential item", null, {}, "no GitHub App credential is available"],
    ["an item with no key", { id: 7, installation_id: 42 }, {}, "incomplete"],
    ["an App that was never verified as installed", { id: 7, pem }, {}, "no verified installation"],
    ["an installation GitHub no longer knows", undefined, { [`GET repos/${REPO}/installation`]: { status: 404, body: null } }, "HTTP 404"],
    ["an installation other than the verified one", undefined, { [`GET repos/${REPO}/installation`]: { status: 200, body: { id: 43, app_id: 7, account: { login: "acme" }, suspended_at: null, permissions: { ...FORGE_APP_PERMISSIONS } } } }, "differs from the verified one"],
    ["a suspended installation", undefined, { [`GET repos/${REPO}/installation`]: { status: 200, body: { id: 42, app_id: 7, account: { login: "acme" }, suspended_at: "2030-01-01T00:00:00Z", permissions: { ...FORGE_APP_PERMISSIONS } } } }, "suspended"],
    ["an installation without write access", undefined, { [`GET repos/${REPO}/installation`]: { status: 200, body: { id: 42, app_id: 7, account: { login: "acme" }, suspended_at: null, permissions: { contents: "read", pull_requests: "write", metadata: "read" } } } }, "differs from the verified one"],
  ] as const)("%s is refused before any token exists", async (_name, credential, overrides, expected) => {
    const github = fakeGitHub(overrides as Record<string, Answer>);
    const p = credential === undefined ? ports({ github }) : ports({ github, credential });
    const error = await mintInstallationToken(REPO, p).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ForgeAppRefusal);
    expect((error as Error).message).toContain(expected);
    expect((error as Error).message).toContain("never with a person's credentials");
    expect(github.calls.some((call) => call.method === "POST")).toBe(false);
  });

  test("a token that reaches more than the one repository is revoked and refused", async () => {
    const github = fakeGitHub({ "GET installation/repositories?per_page=100": { status: 200, body: { total_count: 2, repositories: [{ full_name: REPO }, { full_name: "acme/other" }] } } });
    const error = await mintInstallationToken(REPO, ports({ github })).catch((caught: unknown) => caught);
    expect((error as Error).message).toContain("not limited to this repository");
    expect(github.calls.at(-1)).toMatchObject({ method: "DELETE", target: "installation/token", token: ISSUED });
  });

  test("a repository on another forge is refused without reading a credential", async () => {
    const p = ports();
    await expect(mintInstallationToken("https://gitlab.example.invalid/acme/widgets.git", p)).rejects.toBeInstanceOf(ForgeAppRefusal);
    expect(p.github.calls).toEqual([]);
  });
});

test("repositories are named from slugs and GitHub URLs only", () => {
  expect(parseRepository("acme/widgets")).toBe(REPO);
  expect(parseRepository("https://github.com/acme/widgets.git")).toBe(REPO);
  expect(parseRepository(`https://${at("x-access-token", "github.com")}/acme/widgets.git`)).toBe(REPO);
  expect(parseRepository(`${at("git", "github.com")}:acme/widgets.git`)).toBe(REPO);
  expect(parseRepository(`ssh://${at("git", "github.com")}/acme/widgets`)).toBe(REPO);
  expect(parseRepository("github.com/acme/widgets")).toBe(REPO);
  expect(parseRepository("https://example.invalid/acme/widgets")).toBeNull();
  expect(parseRepository("acme/widgets/extra/part")).toBeNull();
  expect(parseRepository("")).toBeNull();
});

describe("what a gh command is", () => {
  test.each([
    [["pr", "view", "5"]], [["pr", "list"]], [["pr", "checks", "5"]], [["pr", "diff"]], [["pr", "checkout", "5"]],
    [["issue", "list"]], [["repo", "view", "--json", "name"]], [["run", "watch", "9"]], [["search", "prs", "x"]],
    [["auth", "status"]], [["--version"]], [["pr", "merge", "--help"]], [[]],
    [["api", `repos/${REPO}/pulls`]], [["api", "-X", "GET", `repos/${REPO}/pulls`, "-f", "state=open"]],
    [["api", "--method=GET", "user"]], [["api", "graphql", "-f", "query=query { viewer { login } }"]],
    [["-R", REPO, "pr", "view", "5"]],
  ])("%j keeps the credentials reads always had", (args) => {
    expect(classifyGh(args).kind).toBe("read");
  });

  test.each([
    [["pr", "merge", "5", "--squash"], null], [["pr", "create", "--title", "t"], null], [["pr", "edit", "5", "--body", "b"], null],
    [["pr", "comment", "5", "-b", "x"], null], [["pr", "close", "5"], null], [["pr", "update-branch", "5"], null],
    [["pr", "merge", "5", "--repo", REPO], REPO], [["pr", "merge", "5", `--repo=${REPO}`], REPO], [["-R", REPO, "pr", "ready", "5"], REPO],
    [["issue", "create", "-t", "t"], null], [["release", "create", "v1"], null], [["run", "rerun", "9"], null], [["workflow", "run", "ci"], null],
    [["api", "-X", "PUT", `repos/${REPO}/pulls/5/update-branch`, "-f", "expected_head_sha=abc"], REPO],
    [["api", `repos/${REPO}/issues/5/comments`, "-f", "body=x"], REPO], [["api", "-XDELETE", `repos/${REPO}/git/refs/heads/x`], REPO],
    [["api", "--input", "body.json", `repos/${REPO}/pulls`], REPO],
    [["api", "graphql", "-f", "query=mutation { mergePullRequest(input: {}) { clientMutationId } }"], null],
    [["api", "graphql", "--input", "query.json"], null], [["api", "graphql", "-F", at("query=", "query.graphql")], null],
    /* An installation endpoint answers nothing but an installation token. */
    [["api", "installation/repositories?per_page=100", "--paginate"], null],
    [["some-command-gh-adds-later", "do"], null],
  ] as const)("%j goes out as the App", (args, repository) => {
    expect(classifyGh([...args])).toEqual({ kind: "write", repository });
  });

  test("a write names its repository from GH_REPO when no flag does", () => {
    expect(classifyGh(["pr", "merge", "5"], { GH_REPO: REPO })).toEqual({ kind: "write", repository: REPO });
  });

  test.each([[["auth", "token"]], [["auth", "login"]], [["auth", "setup-git"]], [["auth", "refresh"]]])("%j is not given to an agent", (args) => {
    expect(classifyGh(args).kind).toBe("refuse");
  });
});

describe("running gh for an agent", () => {
  test("a read starts gh with the configuration reads use and mints nothing", async () => {
    const p = ports();
    expect(await runGh(["pr", "view", "5"], p)).toBe(0);
    expect(p.started).toHaveLength(1);
    expect(p.started[0]!.env.GH_CONFIG_DIR).toBe(OPERATOR_CONFIG);
    expect(p.github.calls).toEqual([]);
  });

  test("a write starts gh with the App token as its whole identity, then revokes it", async () => {
    const p = ports();
    expect(await runGh(["pr", "merge", "5", "--squash"], p)).toBe(0);
    expect(p.started).toHaveLength(1);
    const env = p.started[0]!.env;
    expect(env.GH_TOKEN).toBe(ISSUED);
    expect(env.GH_CONFIG_DIR).toBe("/agent/empty");
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(p.github.calls.at(-1)).toMatchObject({ method: "DELETE", target: "installation/token", token: ISSUED });
    expect(`${p.out.join("")}${p.err.join("")}`).not.toContain(ISSUED);
  });

  test("negative control: with no App credential a write starts no gh at all and says why", async () => {
    const p = ports({ credential: null });
    expect(await runGh(["pr", "merge", "5", "--squash"], p)).toBe(1);
    /* `gh` is the only thing here that could reach a person's token, through
       the configuration directory or an inherited variable. It never ran. */
    expect(p.started).toEqual([]);
    expect(p.github.calls).toEqual([]);
    expect(p.err.join("")).toContain(`Delegatus refused this GitHub write to ${REPO}: no GitHub App credential is available for it.`);
    expect(p.err.join("")).toContain("never with a person's credentials, so nothing was sent");
  });

  test("a write GitHub refuses to authenticate for starts no gh either", async () => {
    const github = fakeGitHub({ "POST app/installations/42/access_tokens": { status: 403, body: { message: "suspended" } } });
    const p = ports({ github });
    expect(await runGh(["api", "-X", "PUT", `repos/${REPO}/pulls/5/update-branch`], p)).toBe(1);
    expect(p.started).toEqual([]);
    expect(p.err.join("")).toContain("HTTP 403");
  });

  test("a write whose repository cannot be named is refused", async () => {
    const p = ports({ origin: null });
    expect(await runGh(["pr", "create", "--fill"], p)).toBe(1);
    expect(p.started).toEqual([]);
    expect(p.err.join("")).toContain("could not be determined");
  });

  test("gh auth token is refused and starts nothing", async () => {
    const p = ports();
    expect(await runGh(["auth", "token"], p)).toBe(1);
    expect(p.started).toEqual([]);
    expect(p.err.join("")).toContain("not available to an agent");
  });
});

describe("git's push credential helper", () => {
  const ask = "protocol=https\nhost=github.com\nusername=x-access-token\npath=acme/widgets.git\n";

  test("a push is answered with the App token for the repository in its path", async () => {
    const p = ports({ origin: null });
    expect(await gitCredential("get", ask, p)).toBe(0);
    expect(p.out.join("")).toBe(`username=x-access-token\n${["password", ISSUED].join("=")}\n`);
    expect(p.github.calls[1]!.body).toEqual({ repositories: ["widgets"], permissions: { ...FORGE_APP_PERMISSIONS } });
  });

  test("negative control: with no App credential git is told to stop asking", async () => {
    const p = ports({ credential: null });
    expect(await gitCredential("get", ask, p)).toBe(1);
    expect(p.out.join("")).toBe("quit=true\n");
    expect(p.err.join("")).toContain("Delegatus refused this GitHub write");
  });

  test("another host is refused, and store and erase do nothing", async () => {
    const p = ports();
    expect(await gitCredential("get", "protocol=https\nhost=example.invalid\n", p)).toBe(1);
    expect(p.out.join("")).toBe("quit=true\n");
    expect(await gitCredential("store", ask, p)).toBe(0);
    expect(await gitCredential("erase", ask, p)).toBe(0);
    expect(p.github.calls).toEqual([]);
  });
});
