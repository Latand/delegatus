import { describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";

import {
  FORGE_APP_API_WRITES, FORGE_APP_GH_COMMANDS, FORGE_APP_ISSUE_PERMISSIONS, FORGE_APP_PERMISSIONS, FORGE_PUSH_BASE, FORGE_REPOSITORIES_ENV, ForgeAppRefusal, classifyGh, declaredRepositories, gitCredential,
  isDeclaredRepository, mintInstallationToken, parseRepository, runGh, runGit,
} from "./forge-app-token.mjs";

/* The App helper against an invented App: a key generated here, an invented
   repository and a fake GitHub. No credential store, no network, no real `gh`. */
const REPO = "acme/widgets";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ISSUED = "installation-token-for-tests";
const OPERATOR_CONFIG = "/operator/gh";
const PR_URL = `https://github.com/${REPO}/pull/5`;
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

function ports(options: { credential?: unknown; github?: ReturnType<typeof fakeGitHub>; env?: Record<string, string>; origin?: string | null; remotes?: string[]; ordinary?: string | null; remoteUrls?: string[]; expanded?: Record<string, string> } = {}) {
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
    /* The checkout's GitHub remotes, the one `gh` takes as its base first. */
    checkoutRepositories: async () => options.remotes ?? (options.origin === undefined ? [REPO] : options.origin ? [options.origin] : []),
    readCredential: async () => (credential == null ? null : JSON.stringify(credential)),
    request: github.request,
    findGh: () => "/usr/bin/gh",
    findGit: () => "/usr/bin/git",
    /* The checkout's remote URLs as its configuration spells them, and what
       its own `insteadOf` makes of a shorthand. */
    remoteUrls: async () => options.remoteUrls ?? [],
    expandedUrl: async (_git: string, _scope: string[], spelled: string) => options.expanded?.[spelled] ?? spelled,
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

  /* #2518: an approved bug report is filed on a token of its own. */
  test("an issue token is asked for issues and metadata alone, and a push token never carries them", async () => {
    const granted = { ...FORGE_APP_PERMISSIONS, issues: "write" };
    const github = fakeGitHub({
      [`GET repos/${REPO}/installation`]: { status: 200, body: { id: 42, app_id: 7, account: { login: "Acme" }, suspended_at: null, permissions: granted } },
      "POST app/installations/42/access_tokens": { status: 201, body: { token: ISSUED, expires_at: "2030-01-01T01:00:00Z", permissions: { ...FORGE_APP_ISSUE_PERMISSIONS } } },
    });
    expect(await mintInstallationToken(REPO, ports({ github }), FORGE_APP_ISSUE_PERMISSIONS)).toMatchObject({ token: ISSUED, repository: REPO });
    expect(github.calls[1]!.body).toEqual({ repositories: ["widgets"], permissions: { issues: "write", metadata: "read" } });
    expect(FORGE_APP_PERMISSIONS).not.toHaveProperty("issues");
  });

  test("an installation that was not granted issues refuses the issue token before any token exists", async () => {
    const github = fakeGitHub();
    const error = await mintInstallationToken(REPO, ports({ github }), FORGE_APP_ISSUE_PERMISSIONS).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ForgeAppRefusal);
    expect((error as Error).message).toContain("never with a person's credentials");
    expect(github.calls.some((call) => call.method === "POST")).toBe(false);
  });

  test("an issue token that came back with other permissions is revoked and refused", async () => {
    const github = fakeGitHub({
      [`GET repos/${REPO}/installation`]: { status: 200, body: { id: 42, app_id: 7, account: { login: "Acme" }, suspended_at: null, permissions: { ...FORGE_APP_PERMISSIONS, issues: "write" } } },
    });
    const error = await mintInstallationToken(REPO, ports({ github }), FORGE_APP_ISSUE_PERMISSIONS).catch((caught: unknown) => caught);
    expect((error as Error).message).toContain("unexpected permissions");
    expect(github.calls.at(-1)).toMatchObject({ method: "DELETE", target: "installation/token", token: ISSUED });
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
  /* The other names `gh` and git reach the same repository by: a subdomain of
     the host, a user name, a port, an encoded path. */
  expect(parseRepository("www.github.com/acme/widgets")).toBe(REPO);
  expect(parseRepository("https://WWW.GitHub.com/acme/widgets/")).toBe(REPO);
  expect(parseRepository(`https://${at("someone", "github.com")}:443/acme/widgets.git`)).toBe(REPO);
  expect(parseRepository(`ssh://${at("git", "ssh.github.com")}:443/acme/widgets.git`)).toBe(REPO);
  expect(parseRepository(`git+ssh://${at("git", "github.com")}/acme/widgets`)).toBe(REPO);
  expect(parseRepository("https://github.com/acme/wid%67ets.git?x=1")).toBe(REPO);
  expect(parseRepository("https://notgithub.com/acme/widgets")).toBeNull();
  expect(parseRepository("github.com.example.invalid/acme/widgets")).toBeNull();
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
    /* An owner and a name, each written out or as either placeholder `gh api` fills. */
    const SEGMENT = "(\\{owner\\}|:owner|[^/{}:]+)\\/(\\{repo\\}|:repo|[^/{}:]+)";
    expect([...FORGE_APP_GH_COMMANDS]).toEqual(["pr create", "pr edit", "pr merge", "pr update-branch"]);
    expect(FORGE_APP_API_WRITES.map((write) => `${write.method} ${write.path.source}`)).toEqual([
      `POST ^repos\\/${SEGMENT}\\/pulls$`,
      `PATCH ^repos\\/${SEGMENT}\\/pulls\\/\\d+$`,
      `PUT ^repos\\/${SEGMENT}\\/pulls\\/\\d+\\/merge$`,
      `PUT ^repos\\/${SEGMENT}\\/pulls\\/\\d+\\/update-branch$`,
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
    /* The other spellings `gh` accepts for the same actions. */
    [["pr", "new", "--fill"], null], [["pr", "new", "-R", REPO, "--title", "t"], REPO],
    [["pr", "merge", PR_URL, "--squash"], REPO], [["pr", "merge", "--squash", `${PR_URL}/files`], REPO],
    [["pr", "edit", PR_URL, "--title", "t"], REPO], [["pr", "update-branch", PR_URL], REPO],
    /* The pull request's own URL names the repository, whatever a flag says. */
    [["pr", "merge", PR_URL, "-R", "acme/gadgets"], REPO],
    /* A flag's value is not the pull request: this one is number 5 of the flag's repository. */
    [["pr", "edit", "--body", "https://github.com/acme/gadgets/pull/9", "5", "-R", REPO], REPO],
    [["pr", "merge", "-sdt", "subject", "5", `-R${REPO}`], REPO], [["pr", "edit", "5", "--body", "--help"], null],
    [["api", `https://api.github.com/repos/${REPO}/pulls/5/merge`, "-X", "PUT"], REPO],
    [["api", `repos/${REPO}/pulls`, "-ftitle=x", "-fhead=y", "-fbase=main"], REPO],
    [["api", `repos/${REPO}/pulls`, "-Ftitle=x"], REPO], [["api", "-if", "title=x", `repos/${REPO}/pulls`], REPO],
    [["api", `repos/${REPO}/pulls/5`, "-X=patch"], REPO], [["api", "--hostname", "github.com", "-XPUT", `repos/${REPO}/pulls/5/merge`], REPO],
    [["api", "repos/:owner/:repo/pulls/5/merge", "-X", "PUT"], null], [["api", "-XPUT", "/repos/{owner}/{repo}/pulls/5/merge"], null],
    [["api", "-XPUT", "REPOS/acme/./x/../wid%67ets//pulls/5/merge/?a=b"], REPO],
    /* An empty flag is absent to gh: the checkout names the repository. */
    [["pr", "merge", "5", "--repo", "", "--squash"], null], [["pr", "merge", "5", "-R", ""], null], [["pr", "create", "--repo=", "--fill"], null],
    [["pr", "merge", "5", "--repo", REPO, "--repo", ""], null],
    /* A pull request URL is read by its start, on any name of the host. */
    [["pr", "merge", `${PR_URL}.`], REPO], [["pr", "merge", `${PR_URL}abc`, "-R", "acme/gadgets"], REPO],
    [["pr", "edit", "HTTPS://www.github.com/acme/widgets/pull/5"], REPO], [["pr", "merge", "https://github.com:443/acme/wid%67ets/pull/5"], "acme/widgets"],
    [["api", "https://api.github.com:443/repos/acme/widgets/pulls/5/merge", "-XPUT"], REPO],
    [["api", "--hostname", "www.github.com", "-XPUT", `repos/${REPO}/pulls/5/merge`], REPO],
  ] as const)("%j is a covered kind", (args, repository) => {
    expect(classifyGh([...args])).toEqual({ kind: "app", repository });
  });

  test.each([
    [["pr", "merge", "5"]], [["api", "repos/:owner/:repo/pulls/5/merge", "-X", "PUT"]], [["api", "-XPATCH", "repos/{owner}/{repo}/pulls/5"]],
  ])("%j takes its repository from GH_REPO before the checkout", (args) => {
    expect(classifyGh(args, { GH_REPO: REPO })).toEqual({ kind: "app", repository: REPO });
    /* An empty GH_REPO is absent to gh, and an empty flag falls to GH_REPO. */
    expect(classifyGh(args, { GH_REPO: "" })).toEqual({ kind: "app", repository: null });
    if (args[0] === "pr") expect(classifyGh([...args, "--repo", ""], { GH_REPO: REPO })).toEqual({ kind: "app", repository: REPO });
  });

  /* A covered kind whose repository is named but cannot be read is refused,
     because passing it on would send it as a person. */
  test.each([
    [["api", "-XPUT", "repos/acme/{repo}/pulls/5/merge"]], [["api", "-XPUT", "repos/:owner/widgets/pulls/5/merge"]],
    [["api", "-XPUT", "repositories/123/pulls/5/merge"]], [["api", "repositories/123/pulls", "-ftitle=x"]],
    [["api", "-XPUT", "repos/acme/wid gets/pulls/5/merge"]],
  ])("%j is refused", (args) => {
    expect(classifyGh(args)).toMatchObject({ kind: "refuse" });
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
    /* The same spellings where they name another host, another method or another kind. */
    [["pr", "merge", "https://ghe.example.invalid/acme/widgets/pull/5"]], [["pr", "newer"]], [["pr", "merge", "5", "-h"]],
    [["api", `https://ghe.example.invalid/api/v3/repos/${REPO}/pulls/5/merge`, "-X", "PUT"]],
    [["api", "--hostname", "ghe.example.invalid", "-XPUT", `repos/${REPO}/pulls/5/merge`]],
    [["api", `repos/${REPO}/pulls`, "-XGET", "-fstate=open"]], [["api", `repos/${REPO}/pulls`, "-Htitle=x"]],
    [["api", "repositories/123/pulls"]], [["api", "-XDELETE", `repos/${REPO}/labels/good%20first%20issue`]],
    [["api", "-XPUT", `repos/${REPO}/pulls/5/merge`, "--help"]],
  ])("%j is not a covered kind", (args) => {
    expect(classifyGh(args)).toEqual({ kind: "pass" });
  });
});

/* One action in the other spellings `gh` accepts: the alias, the pull request
   as its URL, the API's absolute URL, flags joined to their values, and either
   placeholder, which the checkout fills. */
const OTHER_SPELLINGS = (repository: string) => [
  ["pr", "new", "--fill", "-R", repository], ["pr", "merge", `https://github.com/${repository}/pull/5`, "--squash"],
  ["pr", "edit", `https://github.com/${repository}/pull/5`, "--title", "t"],
  ["api", `https://api.github.com/repos/${repository}/pulls/5/merge`, "-X", "PUT"],
  ["api", `repos/${repository}/pulls`, "-ftitle=x", "-fhead=y", "-fbase=main"],
];
const FROM_THE_CHECKOUT = [["pr", "new", "--fill"], ["api", "repos/:owner/:repo/pulls/5/merge", "-X", "PUT"], ["api", "-XPUT", "repos/{owner}/{repo}/pulls/5/merge"],
  /* A repository flag given empty, which gh reads as absent. */
  ["pr", "merge", "5", "--repo", "", "--squash"], ["pr", "merge", "5", "-R", ""], ["pr", "create", "--repo=", "--fill"]];
/* Names gh reduces to the same repository. */
const REDUCED = (repository: string) => [
  ["pr", "merge", "5", "--repo", `www.github.com/${repository}`], ["pr", "merge", `https://github.com/${repository}/pull/5.`, "--squash"],
  ["pr", "edit", "5", "-R", `https://${at("someone", "github.com")}/${repository}.git`],
];

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

  test("a failed pr edit under the App names the REST form that makes the same edit", async () => {
    const p = ports();
    p.exec = async (command, args, env) => { p.started.push({ command, args, env }); return 1; };
    expect(await runGh(["pr", "edit", "5", "--body", "b"], p)).toBe(1);
    expect(p.err.join("")).toContain(`gh api -X PATCH repos/${REPO}/pulls/<number>`);
    p.err.length = 0;
    expect(await runGh(["pr", "merge", "5"], p)).toBe(1);
    expect(p.err).toEqual([]);
  });

  test("negative control: a covered write with no App credential starts no gh at all and says why", async () => {
    const p = ports({ credential: null });
    for (const write of [["pr", "merge", "5", "--squash"], ["pr", "create", "--fill"], ["pr", "edit", "5", "-b", "x"], ["pr", "update-branch", "5"],
      ["api", "-X", "PUT", `repos/${REPO}/pulls/5/update-branch`], ...OTHER_SPELLINGS(REPO)]) {
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

  test("negative control: every other spelling of a covered write is refused the same way, wherever it is typed", async () => {
    /* Outside any checkout, and in the checkout of an undeclared repository:
       the command itself names the declared one. */
    for (const origin of [null, "acme/gadgets"]) {
      const p = ports({ credential: null, origin });
      for (const write of [...OTHER_SPELLINGS(REPO), ...REDUCED(REPO)]) expect(await runGh(write, p)).toBe(1);
      expect(p.started).toEqual([]);
      expect(p.err).toHaveLength(OTHER_SPELLINGS(REPO).length + REDUCED(REPO).length);
      for (const line of p.err) expect(line).toContain(`Delegatus refused this GitHub write to ${REPO}: no GitHub App credential is available for it.`);
    }
    /* In the declared checkout, and with GH_REPO naming it from anywhere. */
    /* An empty GH_REPO is absent too, and the checkout is read. */
    for (const p of [ports({ credential: null }), ports({ credential: null, origin: null, env: { ...AGENT_ENV, GH_REPO: REPO } }), ports({ credential: null, env: { ...AGENT_ENV, GH_REPO: "" } })]) {
      for (const write of FROM_THE_CHECKOUT) expect(await runGh(write, p)).toBe(1);
      expect(p.started).toEqual([]);
      expect(p.err).toHaveLength(FROM_THE_CHECKOUT.length);
      for (const line of p.err) expect(line).toContain(`Delegatus refused this GitHub write to ${REPO}`);
    }
  });

  test("a covered write whose repository cannot be read, or cannot be settled among the remotes, is refused", async () => {
    const p = ports({ credential: null });
    expect(await runGh(["api", "-XPUT", "repositories/123/pulls/5/merge"], p)).toBe(1);
    expect(await runGh(["api", "-XPUT", "repos/acme/{repo}/pulls/5/merge"], p)).toBe(1);
    /* `gh` would take the first remote; a declared one further down may be the one it writes to. */
    const several = ports({ credential: null, remotes: ["acme/gadgets", REPO] });
    expect(await runGh(["pr", "merge", "5"], several)).toBe(1);
    expect(several.err.join("")).toContain("name the repository with --repo");
    expect([...p.started, ...several.started]).toEqual([]);
    for (const line of [...p.err, ...several.err]) expect(line).toContain("Delegatus refused this GitHub write");
    /* Named, the same checkout's write to the undeclared remote goes as typed. */
    expect(await runGh(["pr", "merge", "5", "-R", "acme/gadgets"], several)).toBe(0);
    expect(several.started).toHaveLength(1);
  });

  test("the same spellings aimed at an undeclared repository pass through unchanged", async () => {
    const p = ports({ credential: null, origin: "acme/gadgets" });
    const typed = [...OTHER_SPELLINGS("acme/gadgets"), ...REDUCED("acme/gadgets"), ...FROM_THE_CHECKOUT];
    for (const args of typed) expect(await runGh(args, p)).toBe(0);
    expect(p.started).toEqual(typed.map((args) => ({ command: "/usr/bin/gh", args, env: p.env })));
    for (const [index, start] of p.started.entries()) expect(start.args).toBe(typed[index]!);
    expect(p.github.calls).toEqual([]);
    expect(p.err).toEqual([]);
    /* With nothing declared, a form that would be refused is not even read. */
    const none = ports({ credential: null, env: { GH_CONFIG_DIR: OPERATOR_CONFIG } });
    expect(await runGh(["api", "-XPUT", "repositories/123/pulls/5/merge"], none)).toBe(0);
    expect(none.started).toHaveLength(1);
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

describe("running git for an agent", () => {
  const APP_URL = `${FORGE_PUSH_BASE}/`;
  const added = (env: Record<string, string | undefined>, from: number) =>
    Array.from({ length: Number(env.GIT_CONFIG_COUNT) - from }, (_, index) => [env[`GIT_CONFIG_KEY_${from + index}`], env[`GIT_CONFIG_VALUE_${from + index}`]]);
  /* Spellings of the declared repository no prefix written ahead of time matches. */
  const CASED = "https://github.com/ACME/Widgets.git";
  const NAMED = `https://${at("someone", "github.com")}/acme/widgets.git`;
  const SCP = `${at("git", "github.com")}:Acme/widgets.git`;

  test("a push gets a rewrite to the App's URL for every remote that names a declared repository in its own spelling", async () => {
    const env = { ...AGENT_ENV, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/guard" };
    const p = ports({ env, remoteUrls: [CASED, NAMED, SCP, "https://www.github.com/acme/widgets", "https://github.com/acme/gadgets.git", "https://example.invalid/acme/widgets.git", `${APP_URL}acme/widgets.git`] });
    const typed = ["-C", "push", "-c", "a=b", "push", "--force-with-lease=main:abc", "origin", "HEAD:refs/heads/x"];
    expect(await runGit(typed, p)).toBe(0);
    expect(p.started).toHaveLength(1);
    expect(p.started[0]!.args).toBe(typed);
    const started = p.started[0]!.env;
    /* What the launch set stays where it was; the rewrites follow it. */
    expect([started.GIT_CONFIG_KEY_0, started.GIT_CONFIG_VALUE_0]).toEqual(["core.hooksPath", "/guard"]);
    expect(added(started, 1)).toEqual([
      [`url.${APP_URL}ACME/Widgets.git.insteadOf`, CASED], [`url.${APP_URL}ACME/Widgets.git.pushInsteadOf`, CASED],
      [`url.${APP_URL}acme/widgets.git.insteadOf`, NAMED], [`url.${APP_URL}acme/widgets.git.pushInsteadOf`, NAMED],
      [`url.${APP_URL}Acme/widgets.git.insteadOf`, SCP], [`url.${APP_URL}Acme/widgets.git.pushInsteadOf`, SCP],
      [`url.${APP_URL}acme/widgets.git.insteadOf`, "https://www.github.com/acme/widgets"], [`url.${APP_URL}acme/widgets.git.pushInsteadOf`, "https://www.github.com/acme/widgets"],
    ]);
  });

  test("a URL typed on the command line, and a shorthand the checkout expands, are rewritten the same way", async () => {
    const p = ports({ remoteUrls: ["gh:Acme/Widgets"], expanded: { "gh:Acme/Widgets": "https://github.com/Acme/Widgets" } });
    expect(await runGit(["push", `--repo=${CASED}`, NAMED, "HEAD:refs/heads/x"], p)).toBe(0);
    expect(added(p.started[0]!.env, 0).map(([, value]) => value)).toEqual(["gh:Acme/Widgets", "gh:Acme/Widgets", CASED, CASED, NAMED, NAMED]);
  });

  /* Each of these reaches git with the arguments and the environment object the caller had. */
  test.each([
    ["a fetch", ["fetch", "origin"], {}],
    ["a commit whose message is the word", ["commit", "-m", "push"], {}],
    ["a push with only undeclared remotes", ["push", "origin"], { remoteUrls: ["https://github.com/acme/gadgets.git", `${at("git", "github.com")}:acme/widgets-site.git`] }],
    ["a push to a typed URL of an undeclared repository", ["push", "https://github.com/Acme/Gadgets.git", "main"], {}],
    ["a push with nothing declared", ["push", "origin"], { env: { GH_CONFIG_DIR: OPERATOR_CONFIG }, remoteUrls: [CASED] }],
    ["a push with another repository declared", ["push", "origin"], { env: { [FORGE_REPOSITORIES_ENV]: "acme/gadgets" }, remoteUrls: [CASED] }],
  ] as const)("%s passes through unchanged", async (_name, args, options) => {
    const p = ports(options as Parameters<typeof ports>[0]);
    const typed = [...args];
    expect(await runGit(typed, p)).toBe(0);
    expect(p.started).toEqual([{ command: "/usr/bin/git", args: typed, env: p.env }]);
    expect(p.started[0]!.args).toBe(typed);
    expect(p.started[0]!.env).toBe(p.env);
    expect(p.github.calls).toEqual([]);
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
