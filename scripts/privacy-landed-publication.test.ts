import { expect, test } from "bun:test";
import { landedPushEvidence } from "./privacy-landed-publication";

const sha = "1".repeat(40);
const previous = "2".repeat(40);
const mailbox = ["noreply", "github.com"].join("@");
const identity = [sha, "GitHub", mailbox].join("\0");
const env = { NODE_ENV: "test", GITHUB_REPOSITORY: "fixture/project", GITHUB_EVENT_NAME: "push",
  GITHUB_REF: "refs/heads/main", GITHUB_REF_PROTECTED: "true", PRIVACY_DEFAULT_BRANCH: "main", GITHUB_SHA: sha } satisfies NodeJS.ProcessEnv;
const response = (oid: string, valid: boolean, github: boolean) => Response.json({ data: {
  repository: { object: { oid, signature: { isValid: valid, wasSignedByGitHub: github } } },
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

test("squash signature evidence carries no trailer provenance", async () => {
  for (const parents of [1, 2]) {
    const evidence = await landedPushEvidence(env, identity, "fixture", async () => Response.json({ data: {
      repository: { object: { oid: sha, signature: { isValid: true, wasSignedByGitHub: true }, parents: { totalCount: parents } } },
    } }));
    expect(evidence).toEqual({ tip: sha });
    expect(evidence).not.toHaveProperty("authors");
  }
});
