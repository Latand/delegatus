import { describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";

import {
  FORGE_APP_API_WRITES, FORGE_APP_GH_COMMANDS, FORGE_APP_PERMISSIONS, FORGE_REPOSITORIES_ENV, ForgeAppRefusal, classifyGh, declaredRepositories, gitCredential,
  isDeclaredRepository, mintInstallationToken, parseRepository, runGh,
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

/* What the agent's shell holds when it types `gh`: the operator's configuration,
   as the launch pins it, and the declaration naming the one App repository. */
const AGENT_ENV = { [FORGE_REPOSITORIES_ENV]: "Acme/Widgets", GH_CONFIG_DIR: OPERATOR_CONFIG, GITHUB_TOKEN: "inherited-token" };

function ports(options: { credential?: unknown; github?: ReturnType<typeof fakeGitHub>; env?: Record<string, string>; origin?: string | null; ordinary?: string | null } = {}) {
  const github = options.github ?? fakeGitHub();
  const started: Array<{ command: string; args: string[]; env: Record<string, string | undefined> }> = [];
  const out: string[] = [];
  const err: string[] = [];
  const credential = "credential" in options ? options.credential : { id: 7, pem, installation_id: 42 };
  return {
    github, started, out, err,
    env: options.env ?? AGENT_ENV,
    ordinaryCredential: async () => options.ordinary ?? null,
    emptyGhConfigDir: () => "/agent/empty",
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

describe("the declaration an environment carries", () => {
  test("names repositories whatever their case, and nothing when it is absent", () => {
    expect(declaredRepositories(AGENT_ENV)).toEqual([REPO]);
    expect(declaredRepositories({ [FORGE_REPOSITORIES_ENV]: "acme/widgets,acme/gadgets, ,not a repository" })).toEqual([REPO, "acme/gadgets"]);
    expect(declaredRepositories({})).toEqual([]);
    expect(isDeclaredRepository("https://github.com/ACME/widgets.git", AGENT_ENV)).toBe(true);
    expect(isDeclaredRepository("acme/widgets-site", AGENT_ENV)).toBe(false);
    expect(isDeclaredRepository(REPO, {})).toBe(false);
  });
});

describe("what a gh command is", () => {
  test("the covered kinds are a written list, and it is exactly what the App is permitted to do", () => {
    expect([...FORGE_APP_GH_COMMANDS]).toEqual(["pr create", "pr edit", "pr merge", "pr update-branch"]);
    expect(FORGE_APP_API_WRITES.map((write) => `${write.method} ${write.path.source}`)).toEqual([
      "POST ^repos\\/(\\{owner\\}\\/\\{repo\\}|[^/{}]+\\/[^/{}]+)\\/pulls$",
      "PATCH ^repos\\/(\\{owner\\}\\/\\{repo\\}|[^/{}]+\\/[^/{}]+)\\/pulls\\/\\d+$",
      "PUT ^repos\\/(\\{owner\\}\\/\\{repo\\}|[^/{}]+\\/[^/{}]+)\\/pulls\\/\\d+\\/merge$",
      "PUT ^repos\\/(\\{owner\\}\\/\\{repo\\}|[^/{}]+\\/[^/{}]+)\\/pulls\\/\\d+\\/update-branch$",
    ]);
  });

  test.each([
    [["pr", "merge", "5", "--squash"], null], [["pr", "create", "--title", "t"], null], [["pr", "edit", "5", "--body", "b"], null],
    [["pr", "update-branch", "5"], null],
    [["pr", "merge", "5", "--repo", REPO], REPO], [["pr", "merge", "5", `--repo=${REPO}`], REPO], [["-R", REPO, "pr", "edit", "5"], REPO],
    [["api", "-X", "PUT", `repos/${REPO}/pulls/5/update-branch`, "-f", "expected_head_sha=abc"], REPO],
    [["api", "--method=PUT", `/repos/${REPO}/pulls/5/merge`], REPO],
    [["api", `repos/${REPO}/pulls`, "-f", "title=t"], REPO], [["api", "--input", "body.json", `repos/${REPO}/pulls`], REPO],
    [["api", "-XPATCH", `repos/${REPO}/pulls/5`, "-f", "body=b"], REPO],
    [["api", "-X", "PATCH", "repos/{owner}/{repo}/pulls/5", "-f", "body=b"], null],
    /* An installation endpoint answers nothing but an installation token. */
    [["api", "installation/repositories?per_page=100", "--paginate"], null],
  ] as const)("%j is a covered kind", (args, repository) => {
    expect(classifyGh([...args])).toEqual({ kind: "app", repository });
  });

  test("a covered write names its repository from GH_REPO when no flag does", () => {
    expect(classifyGh(["pr", "merge", "5"], { GH_REPO: REPO })).toEqual({ kind: "app", repository: REPO });
  });

  /* Reads, and every kind of write the App holds no permission for. */
  test.each([
    [["pr", "view", "5"]], [["pr", "list"]], [["pr", "checks", "5"]], [["pr", "diff"]], [["pr", "checkout", "5"]],
    [["issue", "list"]], [["repo", "view", "--json", "name"]], [["run", "watch", "9"]], [["search", "prs", "x"]],
    [["auth", "status"]], [["auth", "token"]], [["auth", "git-credential", "get"]], [["--version"]], [["pr", "merge", "--help"]], [[]],
    [["api", `repos/${REPO}/pulls`]], [["api", "-X", "GET", `repos/${REPO}/pulls`, "-f", "state=open"]],
    [["api", "--method=GET", "user"]], [["api", "graphql", "-f", "query=query { viewer { login } }"]],
    [["issue", "create", "-t", "t"]], [["issue", "comment", "5", "-b", "x"]], [["run", "rerun", "9"]], [["workflow", "run", "ci"]],
    [["release", "create", "v1"]], [["label", "create", "x"]], [["pr", "comment", "5", "-b", "x"]], [["pr", "review", "5", "--approve"]],
    [["pr", "close", "5"]], [["pr", "ready", "5"]],
    [["api", `repos/${REPO}/issues/5/comments`, "-f", "body=x"]], [["api", "-XDELETE", `repos/${REPO}/git/refs/heads/x`]],
    [["api", "-X", "POST", `repos/${REPO}/actions/workflows/ci.yml/dispatches`, "-f", "ref=main"]],
    [["api", "graphql", "-f", "query=mutation { mergePullRequest(input: {}) { clientMutationId } }"]],
    [["some-command-gh-adds-later", "do"]],
  ])("%j is not a covered kind", (args) => {
    expect(classifyGh(args)).toEqual({ kind: "pass" });
  });
});

describe("running gh for an agent", () => {
  test("a covered write to a declared repository starts gh with the App token as its whole identity, then revokes it", async () => {
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

  test("negative control: a covered write with no App credential starts no gh at all and says why", async () => {
    const p = ports({ credential: null });
    for (const write of [["pr", "merge", "5", "--squash"], ["pr", "create", "--fill"], ["pr", "edit", "5", "-b", "x"], ["pr", "update-branch", "5"],
      ["api", "-X", "PUT", `repos/${REPO}/pulls/5/update-branch`]]) {
      expect(await runGh(write, p)).toBe(1);
    }
    /* `gh` is the only thing here that could reach a person's token, through
       the configuration directory or an inherited variable. It never ran. */
    expect(p.started).toEqual([]);
    expect(p.github.calls).toEqual([]);
    expect(p.err.join("")).toContain(`Delegatus refused this GitHub write to ${REPO}: no GitHub App credential is available for it.`);
    expect(p.err.join("")).toContain("never with a person's credentials, so nothing was sent");
  });

  test("a covered write GitHub refuses to authenticate for starts no gh either", async () => {
    const github = fakeGitHub({ "POST app/installations/42/access_tokens": { status: 403, body: { message: "suspended" } } });
    const p = ports({ github });
    expect(await runGh(["api", "-X", "PUT", `repos/${REPO}/pulls/5/update-branch`], p)).toBe(1);
    expect(p.started).toEqual([]);
    expect(p.err.join("")).toContain("HTTP 403");
  });

  /* Each of these reaches gh with the arguments and the environment object the
     caller had: same array, same variables, nothing minted. */
  test.each([
    ["a read", ["pr", "view", "5"], {}],
    ["an uncovered write in a declared repository: an issue", ["issue", "create", "-t", "t"], {}],
    ["an uncovered write in a declared repository: a workflow dispatch", ["workflow", "run", "ci.yml", "--ref", "main"], {}],
    ["an uncovered write in a declared repository: a run rerun", ["run", "rerun", "9"], {}],
    ["gh auth token", ["auth", "token"], {}],
    ["a covered kind in an undeclared repository, by flag", ["pr", "merge", "5", "--repo", "acme/gadgets"], {}],
    ["a covered kind in an undeclared repository, by checkout", ["pr", "create", "--fill"], { origin: "acme/gadgets" }],
    ["a covered kind where no repository can be named", ["pr", "create", "--fill"], { origin: null }],
    ["a covered kind with nothing declared", ["pr", "merge", "5"], { env: { GH_CONFIG_DIR: OPERATOR_CONFIG } }],
  ] as const)("%s passes through unchanged", async (_name, args, options) => {
    const p = ports({ ...options, credential: null });
    const typed = [...args];
    expect(await runGh(typed, p)).toBe(0);
    expect(p.started).toEqual([{ command: "/usr/bin/gh", args: typed, env: p.env }]);
    expect(p.started[0]!.args).toBe(typed);
    expect(p.started[0]!.env).toBe(p.env);
    expect(p.github.calls).toEqual([]);
    expect(p.err).toEqual([]);
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

  test("negative control: with no App credential git is told to stop asking, and the ordinary helpers are not consulted", async () => {
    const p = ports({ credential: null, ordinary: "username=operator\n" });
    expect(await gitCredential("get", ask, p)).toBe(1);
    expect(p.out.join("")).toBe("quit=true\n");
    expect(p.err.join("")).toContain("Delegatus refused this GitHub write");
  });

  test("a sibling repository the prefix rewrite caught is answered by git's ordinary helpers, never by the App", async () => {
    const ordinary = `username=operator\n${["password", "fixture"].join("=")}\n`;
    const p = ports({ ordinary });
    expect(await gitCredential("get", ask.replace("widgets.git", "widgets-site.git"), p)).toBe(0);
    expect(p.out.join("")).toBe(ordinary);
    expect(p.github.calls).toEqual([]);
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
