import { expect, test } from "bun:test";

import {
  FIRST_SCREEN_STATUSES, FIRST_SCREEN_VERSION, firstScreenColumn, mergeFirstScreenParts, readFirstScreenParts,
  type ProjectFirstScreen,
} from "./projectFirstScreen";

const NOW = Date.parse("2100-01-01T00:00:00.000Z");
const SCOPE = "a".repeat(64);
const PROJECT = "repo-fixture";
const OLD = NOW - 8 * 24 * 60 * 60 * 1000;
const record: ProjectFirstScreen = {
  version: FIRST_SCREEN_VERSION, savedAt: NOW, scope: SCOPE, project: PROJECT, seat: { name: "Planning", savedAt: NOW },
  desktop: {
    revision: 7, active: "assigned", savedAt: NOW,
    columns: FIRST_SCREEN_STATUSES.map(status => firstScreenColumn(status, ["", " Plan delivery ", ...Array(20).fill("x".repeat(400))])),
  },
};

test("the bounded column projection survives round-trip", () => {
  const restored: unknown = JSON.parse(JSON.stringify(record));
  expect(readFirstScreenParts(restored, SCOPE, PROJECT, NOW)).toEqual({ ...record, phone: undefined });
  expect(record.desktop?.columns[0]?.titles).toEqual(["Plan delivery", ...Array(7).fill("x".repeat(256))]);
  expect(readFirstScreenParts({ ...record, desktop: undefined }, SCOPE, PROJECT, NOW)?.seat?.name).toBe("Planning");
  expect(readFirstScreenParts({ ...record, seat: undefined }, SCOPE, PROJECT, NOW)?.desktop).toEqual(record.desktop);
});

test("schema, time, project, authority and malformed columns are refused", () => {
  expect(readFirstScreenParts(record, SCOPE, "repo-other", NOW)).toBeNull();
  expect(readFirstScreenParts(record, "b".repeat(64), PROJECT, NOW)).toBeNull();
  for (const invalid of [
    { ...record, version: FIRST_SCREEN_VERSION + 1 },
    { ...record, savedAt: OLD },
    { ...record, savedAt: NOW + 1 },
    { ...record, seat: undefined, desktop: { ...record.desktop, revision: -1 } },
    { ...record, seat: undefined, desktop: { ...record.desktop, columns: [{ status: "assigned", titles: ["Invalid"] }] } },
    { ...record, seat: {}, desktop: undefined },
  ]) {
    expect(readFirstScreenParts(invalid, SCOPE, PROJECT, NOW)).toBeNull();
  }
});

test("each part keeps its own freshness and concurrent writes preserve other parts", () => {
  const desktop = { ...record.desktop!, savedAt: OLD };
  const incoming = {
    ...record, savedAt: NOW - 1, desktop: undefined,
    phone: { ...record.desktop!, savedAt: NOW - 1 },
    seat: { name: null, savedAt: NOW - 1 },
  };
  const merged = mergeFirstScreenParts(record, incoming);
  expect(readFirstScreenParts(merged, SCOPE, PROJECT, NOW)).toEqual({
    ...record, phone: incoming.phone,
  });
  expect(readFirstScreenParts({ ...merged, desktop }, SCOPE, PROJECT, NOW)?.desktop).toBeUndefined();
  expect(readFirstScreenParts({ ...merged, desktop }, SCOPE, PROJECT, NOW)?.seat?.name).toBe("Planning");
  expect(mergeFirstScreenParts(merged, {
    ...record, desktop: { ...record.desktop!, revision: 6, savedAt: NOW + 1 }, savedAt: NOW + 1,
  }).desktop).toEqual(record.desktop);
});
