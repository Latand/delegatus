import { expect, test } from "bun:test";

import { deepFreeze } from "./deepFreeze";

test("freezes every reachable data property, through arrays and cycles, and returns the same value", () => {
  const value = { list: [{ nested: { leaf: 1 } }], self: null as unknown };
  value.self = value;
  expect(deepFreeze(value)).toBe(value);
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.isFrozen(value.list)).toBe(true);
  expect(Object.isFrozen(value.list[0])).toBe(true);
  expect(Object.isFrozen(value.list[0]!.nested)).toBe(true);
  expect(() => { value.list[0]!.nested.leaf = 2; }).toThrow(TypeError);
  expect(() => { value.list.push({ nested: { leaf: 3 } }); }).toThrow(TypeError);
});

test("leaves primitives as they are and does not run accessors", () => {
  expect(deepFreeze(7)).toBe(7);
  expect(deepFreeze(null)).toBeNull();
  let reads = 0;
  const value = { get computed() { reads += 1; return { inner: true }; } };
  deepFreeze(value);
  expect(reads).toBe(0);
  expect(Object.isFrozen(value)).toBe(true);
});
