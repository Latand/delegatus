import { expect, test } from "bun:test";

import {
  discardUnsupportedApiCredentials,
  withoutUnsupportedApiCredentialEntries,
  withoutUnsupportedApiCredentials,
} from "./environmentIsolation";

test("child environments omit unapproved API keys without reading their values", () => {
  const pluginKey = ["EXAMPLE", "PLUGIN", "API", "KEY"].join("_");
  const providerKey = ["OPENAI", "API", "KEY"].join("_");
  let secretReads = 0;
  const source = new Proxy<NodeJS.ProcessEnv>({ NODE_ENV: "test", [providerKey]: "provider-fixture" }, {
    ownKeys: () => ["NODE_ENV", providerKey, pluginKey],
    getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }),
    get: (target, key) => {
      if (key === pluginKey) {
        secretReads += 1;
        return "private-fixture";
      }
      return Reflect.get(target, key);
    },
  });
  expect(withoutUnsupportedApiCredentials(source)).toEqual({ NODE_ENV: "test", [providerKey]: "provider-fixture" });
  expect(secretReads).toBe(0);
});

test("startup and container snapshots discard unapproved API keys", () => {
  const pluginKey = ["EXAMPLE", "PLUGIN", "API", "KEY"].join("_");
  const serviceKey = ["SONIOX", "API", "KEY"].join("_");
  const env: Record<string, string | undefined> = { [pluginKey]: "private-fixture", [serviceKey]: "service-fixture" };
  discardUnsupportedApiCredentials(env);
  expect(env).toEqual({ [serviceKey]: "service-fixture" });
  expect(withoutUnsupportedApiCredentialEntries([
    `${pluginKey}=private-fixture`,
    `${serviceKey}=service-fixture`,
  ])).toEqual([`${serviceKey}=service-fixture`]);
});
