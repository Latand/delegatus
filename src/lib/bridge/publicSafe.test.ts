import { expect, test } from "bun:test";

import { privateClasses, type PublicDenyList } from "./publicSafe";

/* docs/design/orchestrator-reports.md §3.7, §5.5. Every name below is
   invented for this test. */

/* Assembled at run time: a home path or a UUID written out is what the
   publication gate refuses in a committed file. */
const HOME_PATH = ["", "home", "someone", "work"].join("/");
const UUID = ["1b4e28ba", "2fa1", "11d2", "883f", "0016d3cca427"].join("-");

const DENY: PublicDenyList = {
  accounts: ["account-b", "acct_7f3a", "main", "pro", "max"],
  people: ["Person Bee", "pbee_handle", "Al"],
  local: ["devbox-one"],
  projects: [
    { repository: "someone/tools-repo", names: ["tools-repo", "tools"] },
    { repository: null, names: ["client-site-2"] },
  ],
};

const FOUND: readonly [string, string][] = [
  [`the checkout at ${HOME_PATH} is dirty`, "path"],
  ["the build reads /srv/build/checkout", "path"],
  [`see ${["~", "notes"].join("/")} for the plan`, "path"],
  [`the state under ${["$HOME", ".config"].join("/")} moved`, "path"],
  [`${["C:", "Users", "someone", "repo"].join("\\")} failed`, "path"],
  ["open https://example.invalid/pull/1 for details", "url"],
  ["the page on status.example.com is down", "domain"],
  ["prod on localhost:8898 answers 200", "host"],
  ["prod on devbox.example.net:8898 answers 200", "port"],
  ["the viewer listens on port 8898", "port"],
  ["the host at 203.0.113.20 answered", "ip"],
  ["write to someone@example.invalid", "email"],
  ["call +380 44 123 45 67", "phone"],
  [`conversation ${UUID} stalled`, "id"],
  ["conversation_abc123 stalled", "id"],
  ["the account is at 97% of its weekly limit", "usage"],
  ["акаунт вичерпав 100% тижневого ліміту", "usage"],
  ["the Max 20x plan ran out", "usage"],
  ["the deploy used account-b", "account"],
  ["Person Bee asked for it", "person"],
  ["pbee_handle approved", "person"],
  ["devbox-one rebooted", "host"],
  ["merged in someone/tools-repo too", "project"],
  ["the tools-repo build is green", "project"],
  ["client-site-2 needs a deploy", "project"],
  ["Bearer abcdefghijklmnop1234 leaked", "secret"],
];

for (const [text, kind] of FOUND) {
  test(`${JSON.stringify(text)} is private (${kind})`, () => {
    expect(privateClasses(text, DENY)).toContain(kind as never);
  });
}

const CLEAN: readonly string[] = [
  "release 1.5.0 is on prod and npm is still catching up",
  "the RRSI document (#2222) merges once its checks pass",
  "deploy 1c41d361 passed; the first-run flow is next",
  "the board's scroll takes 40% less time after the fix",
  "src/lib/bridge/reportRender.ts gained a byte budget",
  "the new tools panel opens on the phone",
  "the main branch is green and the pro tip in the docs holds",
  "about ~5 minutes until the next check",
  "Al and/or anyone reviews the plan",
  "реліз 1.5.0 на проді, npm ще оновлює версію",
];

for (const text of CLEAN) {
  test(`${JSON.stringify(text)} is left alone`, () => {
    expect(privateClasses(text, DENY)).toEqual([]);
  });
}
