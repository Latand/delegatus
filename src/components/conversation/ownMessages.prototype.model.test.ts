import { describe, expect, test } from "bun:test";

import { PROTO_OLDER, modeRows, outline, ownCounter, ownTurns, protoConversation, stepOwn } from "./ownMessages.prototype.model";

describe("own-message navigation prototype model", () => {
  const all = protoConversation();
  const loaded = all.slice(PROTO_OLDER);

  test("the fixture is a busy evening: few own messages among many machine turns", () => {
    expect(ownTurns(loaded).length).toBeGreaterThanOrEqual(6);
    expect(loaded.length - ownTurns(loaded).length).toBeGreaterThanOrEqual(30);
    expect(ownTurns(all).length).toBeGreaterThan(ownTurns(loaded).length);
    for (const turn of ownTurns(all)) expect(turn.reply.join(" ").length).toBeGreaterThan(600);
  });

  test("a step moves between own messages and stops at the loaded edge", () => {
    const own = ownTurns(loaded);
    expect(stepOwn(loaded, null, -1)?.id).toBe(own.at(-1)!.id);
    expect(stepOwn(loaded, null, 1)).toBeNull();
    expect(stepOwn(loaded, own[2]!.id, -1)?.id).toBe(own[1]!.id);
    expect(stepOwn(loaded, own[2]!.id, 1)?.id).toBe(own[3]!.id);
    expect(stepOwn(loaded, own[0]!.id, -1)).toBeNull();
    expect(stepOwn(loaded, own.at(-1)!.id, 1)).toBeNull();
  });

  test("the counter says the total is a floor while older history is unloaded", () => {
    const own = ownTurns(loaded);
    expect(ownCounter(loaded, own[2]!.id, true)).toBe(`3 / ${own.length}+`);
    expect(ownCounter(all, ownTurns(all)[0]!.id, false)).toBe(`1 / ${ownTurns(all).length}`);
    expect(ownCounter(loaded, null, false)).toBe(`– / ${own.length}`);
  });

  test("the mode folds each stretch of machine turns into one row and loses none", () => {
    const rows = modeRows(loaded);
    expect(rows.filter((row) => row.kind === "own").length).toBe(ownTurns(loaded).length);
    const folded = rows.flatMap((row) => row.kind === "machine" ? row.turns : []);
    expect(folded.length).toBe(loaded.length - ownTurns(loaded).length);
    for (const row of rows) if (row.kind === "machine") expect(row.wakes + row.notices).toBe(row.turns.length);
    for (let index = 1; index < rows.length; index++) expect(rows[index]!.kind === "machine" && rows[index - 1]!.kind === "machine").toBe(false);
  });

  test("the outline lists every own message and marks the ones outside the loaded window", () => {
    const entries = outline(all, PROTO_OLDER);
    expect(entries.length).toBe(ownTurns(all).length);
    expect(entries.filter((entry) => !entry.loaded).length).toBe(ownTurns(all).length - ownTurns(loaded).length);
    for (const entry of entries) {
      expect(entry.message.length).toBeLessThanOrEqual(96);
      expect(entry.reply.length).toBeGreaterThan(0);
    }
  });
});
