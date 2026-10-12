import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { statePath } from "@/lib/configDir";
import { readProfileRow, writeProfileRow } from "./profileStore";
import type { ProfileRow } from "./profileTypes";

test("profile persistence uses its own collection and separates locales", () => {
  expect(readProfileRow("sample-store", "en")).toBeNull();
  const row: ProfileRow = { project: "sample-store", locale: "en", model: "haiku", promptVersion: 1, parts: [] };
  writeProfileRow(row);
  expect(readProfileRow("sample-store", "en")).toEqual(row);
  expect(readProfileRow("sample-store", "uk")).toBeNull();
  const db = new Database(statePath("state.sqlite"), { readonly: true });
  try {
    expect(db.query("SELECT count(*) AS n FROM state_rows WHERE collection = ?").get("memory_profile")).toEqual({ n: 1 });
    expect(db.query("SELECT count(*) AS n FROM state_rows WHERE collection = ?").get("role_memory")).toEqual({ n: 0 });
  } finally { db.close(); }
});
