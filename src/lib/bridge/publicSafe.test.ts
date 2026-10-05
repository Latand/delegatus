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
  [`${["C:", "Evidence", "notes.txt"].join("/")} failed`, "path"],
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

test("strict reports refuse special-use domains and explicitly named single-label hosts", () => {
  for (const ending of ["test", "invalid", "example", "localhost", "alt"]) {
    expect(privateClasses(`The failing hostname was ${"remote-worker"}.${ending}.`, undefined, { strict: true })).toContain("domain");
  }
  for (const line of ["The failing hostname is remote-worker.", "The hostname was `remote-worker`.", "hostname: remote-worker", "Ім'я хоста: remote-worker"]) {
    expect(privateClasses(line, undefined, { strict: true })).toContain("host");
  }
  for (const line of ["The remote host: buildbox failed", "HOST=buildbox"]) {
    expect(privateClasses(line, undefined, { strict: true })).toContain("host");
  }
  for (const line of ["See README.md and src/lib/mcp/bindings.ts.", "Date.now() returned.", "The hostname field never refreshed."]) {
    expect(privateClasses(line, undefined, { strict: true })).toEqual([]);
  }
});

test("explicitly labeled usernames and account names need no local deny-list entry", () => {
  for (const line of ["username: builduser", "account_name: user-alias", '{"user_name":"builduser"}']) {
    expect(privateClasses(line, undefined, { strict: true })).toContain("account");
  }
  for (const line of ["The username field was missing.", "The account_name field was missing."]) {
    expect(privateClasses(line, undefined, { strict: true })).toEqual([]);
  }
});

test("named home paths are private and repository-relative paths stay readable", () => {
  for (const user of ["other-user", "other_user", "інший", "other.user", "दूसरा", "other+user"]) {
    expect(privateClasses(`The evidence is ${[`~${user}`, "private", "notes.txt"].join("/")}.`, undefined, { strict: true })).toContain("path");
  }
  expect(privateClasses("See src/lib/mcp/bindings.ts.", undefined, { strict: true })).toEqual([]);
});

test("strict reports refuse compact token counts and explicit billing amounts", () => {
  for (const line of [
    "The account has 1M input tokens.", "The account has 1.5k output tokens.", "The account has 2B cached tokens.",
    "The account cost USD 20 per month.", "The account cost 20 USD per month.",
    "The subscription costs 20 dollars per month.", "The subscription costs 20 per month.",
  ]) expect(privateClasses(line, undefined, { strict: true })).toContain("usage");
  for (const line of ["The billing retry took 20 seconds.", "The usage meter did not refresh.", "The investigation plan has 3 steps."]) {
    expect(privateClasses(line, undefined, { strict: true })).toEqual([]);
  }
});

test("strict endpoint ports allow whitespace after the colon", () => {
  for (const gap of [" ", "\t", "\n"]) for (const endpoint of [`:${gap}8898`, `remote-worker:${gap}8898`]) {
    expect(privateClasses(`The listener bound to ${endpoint}.`, undefined, { strict: true })).toContain("port");
  }
  for (const line of ["The check ran at 12:30 and took 20 seconds.", "Symptom: the listener refused a connection."]) {
    expect(privateClasses(line, undefined, { strict: true })).toEqual([]);
  }
});

test("complete shell homes and quoted leading-space absolute paths are private", () => {
  for (const home of ["~", "~+", "~-", "~reportuser", "~інший", "~दूसरा", "~other+user", "~other.user"]) {
    for (const line of [`The directory is \`${home}\`.`, `The directory is (${home}),`, `The directory is '${home}';`]) {
      expect(privateClasses(line)).toContain("path");
      expect(privateClasses(line, undefined, { strict: true })).toContain("path");
    }
  }
  for (const path of [["", " My notes", "log.txt"].join("/"), ["", " leading.txt"].join("/"), ["", "\tМої записи", "звіт.txt"].join("/")]) {
    for (const quoted of [`\`${path}\``, `'${path}'`, `“${path}”`]) {
      expect(privateClasses(`The log is in ${quoted}.`, undefined, { strict: true })).toContain("path");
    }
  }
  for (const line of ["The ~~old~~ state differs.", "The estimate was ~5 minutes.", "Either / or was shown.", "See src/lib/mcp/bindings.ts."]) {
    expect(privateClasses(line, undefined, { strict: true })).toEqual([]);
  }
});

test("internal DNS suffixes and explicit machine or node fields need no local deny list", () => {
  for (const suffix of ["consul", "svc"]) {
    expect(privateClasses(`The failure occurred on ${["buildbox", "node", suffix].join(".")}.`, undefined, { strict: true })).toContain("domain");
  }
  for (const line of ["The machine name is runner-q.", "The node name was `runner-q`.", '{"machine_name":"runner-q"}', '{"node_name":"runner-q"}', "Ім’я машини: runner-q", "Ім’я вузла: runner-q"]) {
    expect(privateClasses(line, undefined, { strict: true })).toContain("host");
  }
  for (const line of ["Date.now() and rows.map(render) returned.", "The machine name field was missing.", "The node name field was missing.", "See src/lib/mcp/bindings.ts."]) {
    expect(privateClasses(line, undefined, { strict: true })).toEqual([]);
  }
});

test("technical numeric labels and source locations grant no exemption to a later endpoint", () => {
  for (const line of ["HTTP status: 503.", "retryAfterMs: 1000.", "Observed attempts: 3; expected attempts: 1.", "src/lib/mcp/bindings.ts:1767.", "README.md:12."]) {
    expect(privateClasses(line, undefined, { strict: true })).toEqual([]);
    expect(privateClasses(`${line} The endpoint was buildbox: 8898.`, undefined, { strict: true })).toContain("port");
  }
  for (const line of ["The endpoint was buildbox: 8898.", "The endpoint was remote-worker: 9.", "The listener used port: 9.", "The listener bound to : 8898."]) {
    expect(privateClasses(line, undefined, { strict: true })).toContain("port");
  }
});
