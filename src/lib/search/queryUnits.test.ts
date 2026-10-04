import { expect, test } from "bun:test";
import { queryUnits, widerExpression } from "./queryUnits";

test("word forms preserve identifiers, numbers and phrase boundaries", () => {
  expect(queryUnits("logins картки").map((u) => u.label)).toEqual(["login*", "картк*"]);
  expect(queryUnits("сохраненные")[0].expression).toContain('"сохранённ"*');
  expect(queryUnits("client_id #73 Build_State").map((u) => u.expression)).toEqual(['"client_id"', '"#73"', '"build_state"']);
  expect(queryUnits("taskIds")[0].label).toBe("taskid*");
  expect(queryUnits("1533")[0].expression).toBe('(\"1533\" OR \"#1533\")');
  expect(queryUnits('"two words" sign-in report.md').map((u) => u.expression)).toEqual(['"two words"', '"sign in"', '"report md"']);
  expect(queryUnits("liveness")[0].label).toBe("livenes*");
});

test("a common stem keeps the rarer original word, and syntax cannot inject FTS operators", () => {
  expect(queryUnits("rebasing", (word) => word === "rebas" ? 100 : 1, 1000)[0].label).toBe("rebasing*");
  expect(queryUnits('alpha OR beta* -gamma').map((u) => u.expression)).toEqual(['"alpha"*', '"or"', '"beta"', '"gamma"*']);
});

test("the second pass widens unquoted compound terms and identifiers only", () => {
  const wider = (query: string) => widerExpression(queryUnits(query)[0]);
  expect(wider("account_project_binding")).toBe('("account_project_binding" OR NEAR("account" "project" "binding", 8) OR "account_project_binding"*)');
  expect(wider("src/search.ts")).toBe('("src search ts" OR NEAR("src" "search" "ts", 8))');
  expect(wider("4f9a2c7")).toBe('("4f9a2c7" OR "4f9a2c7"*)');
  for (const query of ['"account project binding"', '"api_gateway_id"', "5.3", "v2-1", "sign-in", "of-the", "same-same", "migration", "#1533", "1533", "ab_1"]) {
    expect(wider(query)).toBeNull();
  }
});
