import { expect, test } from "bun:test";
import { agentCodexPublicationPolicy, agentPublicationIdentityEnv } from "./agentPublicationIdentity";

test.each([
  {},
  { inherit: "core", set: { GIT_AUTHOR_EMAIL: "unsafe", OTHER: "kept" } },
  { include_only: ["PATH", "HOME"], exclude: ["PRIVATE_*"] },
  { filters: { PATH: "include", HOME: "include", "PRIVATE_*": "exclude" } },
  { filters: { "PRIVATE_*": "exclude" } },
])("Codex publication overrides protect identity while preserving filter restrictions", (policy) => {
  const source: NodeJS.ProcessEnv = { NODE_ENV: "test", LLV_PUBLICATION_NAME: "Build Agent", LLV_PUBLICATION_EMAIL: ["no-reply", "build.example.invalid"].join("@") };
  const original = JSON.stringify(policy);
  const override = agentCodexPublicationPolicy(policy, source);
  expect(override.set).toEqual(agentPublicationIdentityEnv(source));
  if ("include_only" in policy) expect(override.include_only).toEqual([...policy.include_only!, ...Object.keys(agentPublicationIdentityEnv(source))]);
  if ("filters" in policy && Object.values(policy.filters!).includes("include")) {
    expect(override.filters).toEqual(Object.fromEntries(Object.keys(agentPublicationIdentityEnv(source)).map((key) => [key, "include"])));
  } else expect(override.filters).toBeUndefined();
  expect(JSON.stringify(policy)).toBe(original);
  expect(override.inherit).toBeUndefined();
  expect(override.exclude).toBeUndefined();
});
