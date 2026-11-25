import { expect, test } from "bun:test";
import { signedLandedTip } from "./privacy-landed-publication";

test("only GitHub's valid signature on the exact protected push tip confirms its committer", async () => {
  const sha = "1".repeat(40), mailbox = ["noreply", "github.com"].join("@");
  const identity = [sha, "GitHub", mailbox].join("\0");
  const env = { ...process.env, GITHUB_REPOSITORY: "fixture/project", GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main", GITHUB_REF_PROTECTED: "true", PRIVACY_DEFAULT_BRANCH: "main", GITHUB_SHA: sha };
  const response = (oid: string, valid: boolean, github: boolean) => Response.json({ data: {
    repository: { object: { oid, signature: { isValid: valid, wasSignedByGitHub: github } } },
  } });
  const trusted = async (url: string, init: RequestInit) => {
    expect(url).toBe("https://api.github.com/graphql");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(String(init.body)).variables).toEqual({ owner: "fixture", name: "project", oid: sha });
    return response(sha, true, true);
  };
  expect(await signedLandedTip(env, identity, "fixture", trusted)).toBe(sha);
  for (const reply of [response(sha, true, false), response(sha, false, true), response("2".repeat(40), true, true),
    Response.json({ errors: [{}] }), new Response(null, { status: 403 })]) {
    expect(await signedLandedTip(env, identity, "fixture", async () => reply)).toBeUndefined();
  }
  let queries = 0;
  const unexpected = async () => { queries++; return response(sha, true, true); };
  for (const overrides of [{ GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_REF_PROTECTED: "false" },
    { GITHUB_REF: "refs/heads/feature" }, { GITHUB_SHA: "2".repeat(40) }]) {
    expect(await signedLandedTip({ ...env, ...overrides }, identity, "fixture", unexpected)).toBeUndefined();
  }
  expect(await signedLandedTip(env, identity.replace("GitHub", "Fixture"), "fixture", unexpected)).toBeUndefined();
  expect(await signedLandedTip(env, identity, undefined, unexpected)).toBeUndefined();
  expect(queries).toBe(0);
});
