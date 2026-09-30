import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import recorded from "./fixtures/usage-metrics/recorded.json";
import { appendHistory, collect, parseOptions, render, TIMEOUT_MS, type IO, type Report } from "./usage-metrics";

// Recorded from the three live APIs on 2026-09-30. Credential/account/site
// identifiers are discarded; only the numeric report and public referrers remain.
function fixtureIO(fail?: string): IO {
  const npm = recorded.npm!;
  const gh = recorded.github!;
  const id = "0".repeat(32);
  return {
    async token() { return "fixture-credential"; },
    async run(args) {
      if (fail === "GitHub") throw new Error("fixture-credential in subprocess stderr");
      if (args[1] === "repo") {
        expect(args).toEqual(["gh", "repo", "view", "Latand/delegatus", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
        return "fixture/project";
      }
      expect(args[2]).toStartWith("repos/fixture/project");
      if (args[2].includes("views")) return JSON.stringify(gh.views);
      if (args[2].includes("referrers")) return JSON.stringify(gh.referrers);
      return JSON.stringify({ stargazers_count: gh.stars });
    },
    async json(url, init) {
      if (fail === "npm" && url.includes("npmjs.org")) throw new Error("fixture-credential in upstream body");
      if (url.includes("/downloads/point/")) return { start: npm.versions.start, end: npm.versions.end, downloads: 800 };
      if (url.includes("/downloads/range/")) {
        expect(url).toContain("2026-09-22:2026-09-28");
        return npm.range;
      }
      if (url.includes("/versions/")) return { downloads: npm.versions.downloads };
      if (url.includes("registry.npmjs.org")) return { time: Object.fromEntries(Object.entries(npm.releases).flatMap(([day, versions]) => versions.map(v => [v, `${day}T22:58:00.000Z`]))) };
      if (fail === "Cloudflare") throw new Error("fixture-credential in GraphQL error");
      if (url.endsWith("/accounts")) return { success: true, result: [{ id }] };
      if (url.endsWith("/rum/site_info/list")) return { success: true, result: [{ site_tag: id, ruleset: { zone_name: "delegatus.org" } }] };
      expect(url).toEndWith("/graphql");
      const body = JSON.parse(init!.body as string);
      expect(body.query).toContain('requestPath:"/",userAgentBrowser_neq:"ChromeHeadless"');
      expect(body.query).toContain("sum{visits}");
      expect(body.query).toContain("avg{sampleInterval}");
      expect(body.variables).toMatchObject({ from: "2026-09-22", to: "2026-09-30", account: id, site: id });
      return { errors: null, data: { viewer: { accounts: [{ rumPageloadEventsAdaptiveGroups: recorded.site!.days.map(d => ({ dimensions: { date: d.day }, sum: { visits: d.visits }, avg: { sampleInterval: d.sampleInterval } })) }] } } };
    },
  };
}
const now = new Date("2026-09-30T12:00:00Z");
const options = parseOptions(["--from", "2026-09-22", "--to", "2026-09-30", "--date", "2026-09-28"], now);

test("recorded APIs reproduce the pinned days, split, GitHub window and sampled visits without network", async () => {
  const report = await collect(options, fixtureIO(), now);
  expect(report.failures).toEqual([]);
  expect(report.npm!.range.downloads.map(d => d.downloads)).toEqual([113, 185, 161, 166, 32, 14, 129]);
  const table = render(report, options);
  expect(table).toContain("людей ≈27–40; релізи 1.4.0 | 161");
  expect(table).toContain("людей ≈0–9; релізи 1.6.0 | 129");
  expect(table).toContain("людей ≈130–186 | 800"); // Sum of the design's seven daily upper bounds is 186.
  for (const [v, count] of Object.entries({ "0.0.0": 182, "1.3.0": 184, "1.4.0": 162, "1.5.0": 162, "1.6.0": 110 })) expect(table).toContain(`версія ${v} | ${count}`);
  expect(report.github!.views).toMatchObject({ count: 464, uniques: 86 });
  expect(report.github!.stars).toBe(20);
  expect(report.site!.days.map(d => d.visits)).toEqual([50, 40, 30, 10, 30]);
  expect(render(report, { ...options, line: true })).toBe("📈 Delegatus 28.09 · npm 129, з них людей ≈0–9 (реліз 1.6.0) · встановлення: — · сайт: 30 візитів, копій промпту: — · GitHub: 19 відвідувачів");
  expect(render(report, { ...options, day: undefined, line: true })).toContain("Delegatus 28.09");
  expect(TIMEOUT_MS).toBe(30_000);
});

test("failed sources are named, other sources survive, credentials and raw errors stay absent", async () => {
  for (const fail of ["npm", "GitHub", "Cloudflare"]) {
    const report = await collect(options, fixtureIO(fail), now);
    expect(report.failures).toEqual([fail === "Cloudflare" ? "Cloudflare Web Analytics" : fail]);
    const output = render(report, options) + render(report, { ...options, line: true }) + JSON.stringify(report);
    expect(output).not.toContain("fixture-credential");
    expect(output).not.toContain("upstream body");
    if (fail !== "npm") expect(output).toContain("129");
    if (fail !== "GitHub") expect(output).toContain("464");
    if (fail !== "Cloudflare") expect(output).toContain("візити / без ChromeHeadless");
  }
  const io = fixtureIO();
  const run = io.run;
  io.run = async args => {
    if (args[2]?.includes("/traffic/views")) throw new Error("fixture-credential");
    return run(args);
  };
  const report = await collect(options, io, now);
  expect(report.failures).toEqual(["GitHub views"]);
  expect(render(report, options)).toContain("зірки загалом | 20");
});

test("append-only history retains all GitHub days and window uniques and refuses repo/state/symlink targets", async () => {
  const scratch = await mkdtemp("/var/tmp/usage-metrics-test-");
  const originalState = process.env.LLV_STATE_DIR;
  try {
    const report = await collect(options, fixtureIO(), now);
    const path = join(scratch, "metrics", "history.jsonl");
    await appendHistory(path, report);
    await appendHistory(path, { ...report, observedAt: "2026-10-01T12:00:00Z" });
    const lines = (await readFile(path, "utf8")).trim().split("\n").map(s => JSON.parse(s) as Report);
    expect(lines).toHaveLength(2);
    expect(lines[0].github!.views!.views).toHaveLength(14);
    expect(lines[0].github!.views!.uniques).toBe(86);
    expect(lines[0].github!.referrers).toEqual(recorded.github!.referrers);
    await expect(appendHistory(join(import.meta.dir, "history.jsonl"), report)).rejects.toThrow("unsafe history location");
    const state = join(scratch, "viewer-state");
    process.env.LLV_STATE_DIR = state;
    await mkdir(state);
    await symlink(state, join(scratch, "alias"));
    await expect(appendHistory(join(scratch, "alias", "history.jsonl"), report)).rejects.toThrow("unsafe history location");
    const checkout = join(scratch, "checkout");
    await mkdir(checkout);
    await writeFile(join(checkout, ".git"), "gitdir: fixture\n");
    await expect(appendHistory(join(checkout, "history.jsonl"), report)).rejects.toThrow("unsafe history location");
  } finally {
    if (originalState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = originalState;
    await rm(scratch, { recursive: true, force: true });
  }
});

test("date and option validation rejects invalid or ambiguous windows", () => {
  for (const args of [["--from", "2026-02-30"], ["--to", "2027-01-01"], ["--from", "2026-01-01"], ["--history"], ["--unknown"], ["--date", "2026-08-31"]]) expect(() => parseOptions(args, now)).toThrow();
  expect(parseOptions([], now).history).toEndWith(".local/share/delegatus-metrics/history.jsonl");
});
