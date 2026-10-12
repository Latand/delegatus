import { describe, expect, test } from "bun:test";
import { basisChanges, MemoryProfileError, PROFILE_INPUT_LIMIT, profileInputs, profilePrompt, profileView, validateProfileAnswer } from "./profile";
import { sampleAnswer, sampleMemory } from "./profile.fixture";

describe("memory profile input and binding", () => {
  test("covers every active launch scope once, including roles across projects", () => {
    const inputs = profileInputs(sampleMemory());
    expect(inputs.map(input => input.scope)).toEqual(["overall", "role:garden:builder", "role:*:builder", "project:garden", "machine"]);
    expect(inputs[0]!.rules).toHaveLength(5);
    expect(inputs[1]!.compact).toContain("1. Check the sample color");
    expect(profilePrompt(inputs[1]!, "uk")).toContain("Ukrainian");
    expect(inputs[1]!.compact).not.toContain("stage");
    expect(inputs[1]!.compact).not.toContain("one");
  });
  test("rejects a foreign number rather than dropping its binding", () => {
    const input = profileInputs(sampleMemory())[2]!;
    const answer = sampleAnswer(); answer.topics[0]!.rules = [2];
    expect(() => validateProfileAnswer(answer, input, "en")).toThrow("invalid");
    answer.topics[0]!.rules = [0];
    expect(() => validateProfileAnswer(answer, input, "en")).toThrow("invalid");
  });
  test("enforces locale and bounds Unicode prose", () => {
    const input = profileInputs(sampleMemory())[0]!;
    expect(() => validateProfileAnswer(sampleAnswer(), input, "uk")).toThrow("language");
    const answer = sampleAnswer(true); answer.text = "Перевіряємо зразки. ".repeat(90);
    expect([...validateProfileAnswer(answer, input, "uk").text].length).toBeLessThanOrEqual(700);
  });
  test("omits why lines at the input limit and refuses oversized rules", () => {
    const memory = sampleMemory(); memory.scopes = [memory.scopes[0]!];
    memory.scopes[0]!.active[0]!.why = "w".repeat(PROFILE_INPUT_LIMIT);
    const input = profileInputs(memory)[1]!;
    expect(input.withWhy).toBe(false);
    expect(input.compact).not.toContain("why:");
    memory.scopes[0]!.active[0]!.rule = "r".repeat(PROFILE_INPUT_LIMIT);
    expect(() => profileInputs(memory)).toThrow(MemoryProfileError);
  });
  test("content hashes change only for the affected slice and overall", () => {
    const memory = sampleMemory(); const before = profileInputs(memory);
    memory.scopes[0]!.revision++;
    expect(profileInputs(memory).map(input => input.hash)).toEqual(before.map(input => input.hash));
    memory.scopes[0]!.active[0]!.why = "A second sample was reviewed.";
    const after = profileInputs(memory);
    expect(after[0]!.hash).not.toBe(before[0]!.hash);
    expect(after[1]!.hash).not.toBe(before[1]!.hash);
    expect(after.slice(2).map(input => input.hash)).toEqual(before.slice(2).map(input => input.hash));
  });
  test("counts added, rewritten and removed rules", () => {
    expect(basisChanges([{ id: "one", changedAt: "old" }, { id: "two", changedAt: "old" }], [{ id: "one", changedAt: "new" }, { id: "three", changedAt: "old" }])).toEqual({ added: 1, rewritten: 1, removed: 1 });
    expect(profileView(sampleMemory(), "en", "haiku", null).stale).toBe(false);
  });
});
