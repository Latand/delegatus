import { expect, test } from "bun:test";
import { landedPushEvidence } from "./privacy-landed-publication";

const sha = "1".repeat(40);
const previous = "2".repeat(40);
const mailbox = ["noreply", "github.com"].join("@");
const identity = [sha, "GitHub", mailbox].join("\0");
const env = { NODE_ENV: "test", GITHUB_REPOSITORY: "fixture/project", GITHUB_EVENT_NAME: "push",
  GITHUB_REF: "refs/heads/main", GITHUB_REF_PROTECTED: "true", PRIVACY_DEFAULT_BRANCH: "main", GITHUB_SHA: sha } satisfies NodeJS.ProcessEnv;
const response = (oid: string, valid: boolean, github: boolean, parentCount = 2) => Response.json({ data: {
  repository: { object: { oid, signature: { isValid: valid, wasSignedByGitHub: github }, parents: { totalCount: parentCount } } },
} });

test("only GitHub's valid signature on the exact protected push tip confirms its committer", async () => {
  let requests = 0;
  const trusted = async (url: string, init: RequestInit) => {
    requests++;
    expect(url).toBe("https://api.github.com/graphql");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(String(init.body)).variables).toEqual({ owner: "fixture", name: "project", oid: sha });
    return response(sha, true, true);
  };
  expect(await landedPushEvidence(env, identity, "fixture", trusted)).toEqual({ tip: sha });
  expect(requests).toBe(1);
  for (const reply of [response(sha, true, false), response(sha, false, true), response(previous, true, true),
    Response.json({ errors: [{}] }), new Response(null, { status: 403 })]) {
    expect(await landedPushEvidence(env, identity, "fixture", async () => reply)).toBeUndefined();
  }
  let queries = 0;
  const unexpected = async () => { queries++; return response(sha, true, true); };
  for (const overrides of [{ GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_REF_PROTECTED: "false" },
    { GITHUB_REF: "refs/heads/feature" }, { GITHUB_SHA: previous }]) {
    expect(await landedPushEvidence({ ...env, ...overrides }, identity, "fixture", unexpected)).toBeUndefined();
  }
  expect(await landedPushEvidence(env, identity.replace("GitHub", "Fixture"), "fixture", unexpected)).toBeUndefined();
  expect(await landedPushEvidence(env, identity, undefined, unexpected)).toBeUndefined();
  expect(queries).toBe(0);
});

const author = { name: "Fixture Author", email: ["fixture-author", "users.noreply.github.com"].join("@") };
const secondAuthor = { ...author, name: "Other Fixture Author" };
const pull = {
  id: "fixture-pr", merged: true, baseRefName: "main", baseRepository: { nameWithOwner: env.GITHUB_REPOSITORY },
  headRefOid: previous, mergeCommit: { oid: sha },
};

function authorsPage(overrides: Partial<typeof pull> = {}, more = false, currentAuthor = author) {
  return Response.json({ data: { repository: { object: {
    oid: sha,
    associatedPullRequests: {
      pageInfo: { hasNextPage: false },
      nodes: [{ ...pull, ...overrides, commits: {
        nodes: [{ commit: { author: currentAuthor } }],
        pageInfo: { hasNextPage: more, endCursor: "fixture-cursor" },
      } }],
    },
  } } } });
}

test("a verified squash takes authors from all pages of the PR that landed the tip", async () => {
  const requests: { after?: string | null; oid: string }[] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  const lookup = async (_url: string, init: RequestInit) => {
    const { variables } = JSON.parse(String(init.body));
    requests.push(variables);
    signals.push(init.signal);
    if (variables.after === undefined) return response(sha, true, true, 1);
    if (variables.after === null) return authorsPage({}, true);
    return authorsPage({}, false, secondAuthor);
  };
  expect(await landedPushEvidence(env, identity, "fixture", lookup)).toEqual({ tip: sha, authors: [author, secondAuthor] });
  expect(requests.map(({ after, oid }) => [after, oid])).toEqual([[undefined, sha], [null, sha], ["fixture-cursor", sha]]);
  expect(signals[0]).toBeInstanceOf(AbortSignal);
  expect(new Set(signals).size).toBe(1);
});

test("other PRs and incomplete pages grant only the already verified forge committer", async () => {
  for (const pages of [
    [authorsPage({ merged: false })],
    [authorsPage({ baseRefName: "feature" })],
    [authorsPage({ baseRepository: { nameWithOwner: "fixture/other" } })],
    [authorsPage({ mergeCommit: { oid: previous } })],
    [authorsPage({ headRefOid: sha })],
    [authorsPage({}, true), authorsPage({ id: "other-pr" })],
    [authorsPage({}, true), authorsPage({}, true)],
    [authorsPage({}, true), new Response(null, { status: 403 })],
  ]) {
    const replies = [response(sha, true, true, 1), ...pages];
    expect(await landedPushEvidence(env, identity, "fixture", async () => replies.shift()!)).toEqual({ tip: sha });
    expect(replies).toEqual([]);
  }
});
