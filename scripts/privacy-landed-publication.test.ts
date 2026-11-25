import { expect, test } from "bun:test";
import { landedPushEvidence } from "./privacy-landed-publication";

const sha = "1".repeat(40);
const previous = "2".repeat(40);
const earlier = "3".repeat(40);
const base = "4".repeat(40);
const mailbox = ["noreply", "github.com"].join("@");
const person = ["fixture-person", "example.invalid"].join("@");
/* The entry point's `git log --first-parent --format=%H%x00%P%x00%cn%x00%ce`. */
const line = (commit: string, parents: string[], name = "GitHub", address = mailbox) =>
  [commit, parents.join(" "), name, address].join("\0") + "\n";
const range = line(sha, [previous, earlier]);
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
  expect(await landedPushEvidence(env, range, "fixture", trusted)).toEqual({ signedCommits: [sha] });
  expect(requests).toBe(1);
  for (const reply of [response(sha, true, false), response(sha, false, true), response(previous, true, true),
    Response.json({ errors: [{}] }), new Response(null, { status: 403 })]) {
    expect(await landedPushEvidence(env, range, "fixture", async () => reply)).toBeUndefined();
  }
  let queries = 0;
  const unexpected = async () => { queries++; return response(sha, true, true); };
  for (const overrides of [{ GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_REF_PROTECTED: "false" },
    { GITHUB_REF: "refs/heads/feature" }, { GITHUB_SHA: previous }]) {
    expect(await landedPushEvidence({ ...env, ...overrides }, range, "fixture", unexpected)).toBeUndefined();
  }
  for (const unparsed of [line(sha, [previous], "Fixture"), line(sha, [previous], "GitHub", person),
    "", line(sha, ["short"]), range.replace("\0GitHub", "GitHub"), line(previous, [earlier]) + range]) {
    expect(await landedPushEvidence(env, unparsed, "fixture", unexpected)).toBeUndefined();
  }
  expect(await landedPushEvidence(env, range, undefined, unexpected)).toBeUndefined();
  expect(queries).toBe(0);
});

const forgeAddress = (local: string) => [local, "users.noreply.github.com"].join("@");
const author = forgeAddress("fixture-author");
const committer = forgeAddress("fixture-committer");
const secondAuthor = forgeAddress("other-fixture-author");
const pull = {
  id: "fixture-pr", merged: true, baseRefName: "main", baseRepository: { nameWithOwner: env.GITHUB_REPOSITORY },
  headRefOid: base, mergeCommit: { oid: sha },
};

function identitiesPage(overrides: Partial<typeof pull> = {}, more = false, commit: unknown = { author: { email: author }, committer: { email: committer } }, oid = sha) {
  return Response.json({ data: { repository: { object: {
    oid,
    associatedPullRequests: {
      pageInfo: { hasNextPage: false },
      nodes: [{ ...pull, mergeCommit: { oid }, ...overrides, commits: {
        nodes: [{ commit }],
        pageInfo: { hasNextPage: more, endCursor: "fixture-cursor" },
      } }],
    },
  } } } });
}

const squashRange = line(sha, [previous]);

test("a verified squash takes author and committer addresses from all pages of the PR that landed the tip", async () => {
  const requests: { after?: string | null; oid: string }[] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  const lookup = async (_url: string, init: RequestInit) => {
    const { variables } = JSON.parse(String(init.body));
    requests.push(variables);
    signals.push(init.signal);
    if (variables.after === undefined) return response(sha, true, true, 1);
    if (variables.after === null) return identitiesPage({}, true);
    return identitiesPage({}, false, { author: { email: secondAuthor }, committer: { email: author } });
  };
  expect(await landedPushEvidence(env, squashRange, "fixture", lookup))
    .toEqual({ signedCommits: [sha], squashAddresses: { [sha]: [author, committer, secondAuthor] } });
  expect(requests.map(({ after, oid }) => [after, oid])).toEqual([[undefined, sha], [null, sha], ["fixture-cursor", sha]]);
  expect(signals[0]).toBeInstanceOf(AbortSignal);
  expect(new Set(signals).size).toBe(1);
});

test("a merge commit, other PRs and incomplete pages grant only the already verified forge committer", async () => {
  for (const [parents, pages] of [
    [2, []],
    [0, []],
    [1, [identitiesPage({ merged: false })]],
    [1, [identitiesPage({ baseRefName: "feature" })]],
    [1, [identitiesPage({ baseRepository: { nameWithOwner: "fixture/other" } })]],
    [1, [identitiesPage({ mergeCommit: { oid: previous } })]],
    [1, [identitiesPage({ headRefOid: sha })]],
    [1, [identitiesPage({}, true), identitiesPage({ id: "other-pr" })]],
    [1, [identitiesPage({}, true), identitiesPage({}, true)]],
    [1, [identitiesPage({}, true), new Response(null, { status: 403 })]],
    [1, [Response.json({ errors: [{}] })]],
  ] as const) {
    const replies = [response(sha, true, true, parents), ...pages];
    expect(await landedPushEvidence(env, squashRange, "fixture", async () => replies.shift()!)).toEqual({ signedCommits: [sha] });
    expect(replies).toEqual([]);
  }
  /* GitHub's parent count must agree with the one git recorded. */
  const replies = [response(sha, true, true, 1)];
  expect(await landedPushEvidence(env, range, "fixture", async () => replies.shift()!)).toEqual({ signedCommits: [sha] });
  expect(replies).toEqual([]);
});

test("each forge-committed first-parent squash of a stacked push is verified on its own", async () => {
  /* Newest first: the tip squash, a commit pushed by a person, an unsigned
     forge-looking commit, then an earlier squash. */
  const unsigned = "5".repeat(40);
  const stack = line(sha, [previous]) + line(previous, [unsigned], "Fixture Person", person)
    + line(unsigned, [earlier]) + line(earlier, [base]);
  const requests: [string, string | null | undefined][] = [];
  const lookup = async (_url: string, init: RequestInit) => {
    const { variables } = JSON.parse(String(init.body));
    requests.push([variables.oid, variables.after]);
    if (variables.after === undefined) return response(variables.oid, variables.oid !== unsigned, true, 1);
    return variables.oid === sha
      ? identitiesPage({}, false, { author: { email: author }, committer: { email: committer } }, sha)
      : identitiesPage({}, false, { author: { email: secondAuthor }, committer: { email: secondAuthor } }, earlier);
  };
  expect(await landedPushEvidence(env, stack, "fixture", lookup)).toEqual({
    signedCommits: [sha, earlier],
    squashAddresses: { [sha]: [author, committer], [earlier]: [secondAuthor] },
  });
  expect(requests).toEqual([[sha, undefined], [sha, null], [unsigned, undefined], [earlier, undefined], [earlier, null]]);

  /* Evidence for one pull request never lands on another commit. */
  const misattributed = async (_url: string, init: RequestInit) => {
    const { variables } = JSON.parse(String(init.body));
    if (variables.after === undefined) return response(variables.oid, true, true, 1);
    return identitiesPage({ mergeCommit: { oid: sha } }, false, undefined, variables.oid);
  };
  expect(await landedPushEvidence(env, line(sha, [earlier]) + line(earlier, [base]), "fixture", misattributed))
    .toEqual({ signedCommits: [sha, earlier], squashAddresses: { [sha]: [author, committer] } });

  /* An unverified tip still leaves an earlier verified squash its evidence. */
  const personTip = line(sha, [earlier], "Fixture Person", person) + line(earlier, [base]);
  const earlierOnly = async (_url: string, init: RequestInit) => {
    const { variables } = JSON.parse(String(init.body));
    expect(variables.oid).toBe(earlier);
    return variables.after === undefined ? response(earlier, true, true, 1) : identitiesPage({}, false, undefined, earlier);
  };
  expect(await landedPushEvidence(env, personTip, "fixture", earlierOnly))
    .toEqual({ signedCommits: [earlier], squashAddresses: { [earlier]: [author, committer] } });
});

test("a push of more forge commits than the bound verifies only the newest ones", async () => {
  const hashes = Array.from({ length: 22 }, (_, index) => (index + 16).toString(16).padStart(40, "a"));
  hashes[0] = sha;
  const stack = hashes.map((hash, index) => line(hash, [hashes[index + 1] ?? base])).join("");
  const asked = new Set<string>();
  const lookup = async (_url: string, init: RequestInit) => {
    const { variables } = JSON.parse(String(init.body));
    asked.add(variables.oid);
    return variables.after === undefined ? response(variables.oid, true, true, 1) : identitiesPage({}, false, undefined, variables.oid);
  };
  const evidence = await landedPushEvidence(env, stack, "fixture", lookup);
  expect(evidence?.signedCommits).toEqual(hashes.slice(0, 20));
  expect(Object.keys(evidence?.squashAddresses ?? {}).sort()).toEqual(hashes.slice(0, 20).sort());
  expect([...asked].sort()).toEqual(hashes.slice(0, 20).sort());
});
