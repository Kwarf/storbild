import { describe, expect, test } from "bun:test";
import { applyPatch, diff, JsonPatchError } from "./json-patch.ts";

const pairs: [string, unknown, unknown][] = [
  ["identical", { a: 1 }, { a: 1 }],
  ["primitive root", 1, 2],
  ["type change", { a: [1] }, { a: { 0: 1 } }],
  ["nested change", { a: { b: { c: 1, d: 2 } } }, { a: { b: { c: 3, d: 2 } } }],
  ["add and remove keys", { a: 1, b: 2 }, { b: 2, c: 3 }],
  ["same-length array", { list: [{ x: 1 }, { x: 2 }] }, { list: [{ x: 1 }, { x: 5 }] }],
  ["array grows", { list: [1, 2] }, { list: [1, 2, 3] }],
  ["array shrinks", { list: [1, 2, 3] }, { list: [3] }],
  ["null values", { a: null }, { a: { b: null } }],
  ["special keys", { "a/b": 1, "c~d": 2 }, { "a/b": 2, "e~/f": 3 }],
];

describe("diff and applyPatch", () => {
  test.each(pairs)("round-trips: %s", (_, before, after) => {
    expect(applyPatch(before, diff(before, after))).toEqual(after);
  });

  test("targets the narrowest path", () => {
    const before = { plugins: { "now-playing": { state: { artist: "A", title: "x" } } } };
    const after = { plugins: { "now-playing": { state: { artist: "A", title: "y" } } } };
    expect(diff(before, after)).toEqual([
      { op: "replace", path: "/plugins/now-playing/state/title", value: "y" },
    ]);
  });

  test("escapes JSON pointer tokens", () => {
    expect(diff({}, { "a/b~c": 1 })).toEqual([{ op: "add", path: "/a~1b~0c", value: 1 }]);
  });

  test("treats undefined properties as absent", () => {
    expect(diff({ a: undefined, b: 1 }, { b: 1, c: undefined })).toEqual([]);
    expect(diff({ a: 1 }, { a: undefined })).toEqual([{ op: "remove", path: "/a" }]);
  });

  test("replaces arrays whose length changes", () => {
    expect(diff({ l: [1] }, { l: [1, 2] })).toEqual([{ op: "replace", path: "/l", value: [1, 2] }]);
  });

  test("does not mutate the input", () => {
    const doc = { a: { b: [1, 2] } };
    const result = applyPatch(doc, [{ op: "add", path: "/a/b/-", value: 3 }]);
    expect(doc).toEqual({ a: { b: [1, 2] } });
    expect(result).toEqual({ a: { b: [1, 2, 3] } });
  });

  test("supports inserting and removing array elements by index", () => {
    expect(
      applyPatch(
        [1, 3],
        [
          { op: "add", path: "/1", value: 2 },
          { op: "remove", path: "/0" },
        ],
      ),
    ).toEqual([2, 3]);
  });

  test.each([
    ["missing parent", { op: "add", path: "/a/b", value: 1 }],
    ["missing key", { op: "replace", path: "/x", value: 1 }],
    ["index out of range", { op: "replace", path: "/l/5", value: 1 }],
    ["non-numeric index", { op: "remove", path: "/l/x" }],
    ["no leading slash", { op: "remove", path: "l" }],
  ] as const)("rejects %s", (_, op) => {
    expect(() => applyPatch({ l: [1] }, [op])).toThrow(JsonPatchError);
  });
});
