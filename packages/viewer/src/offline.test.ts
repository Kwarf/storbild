import { describe, expect, test } from "bun:test";
import { assetDelta, parseRange, route } from "./offline.ts";

const hash = "a".repeat(64);

describe("route", () => {
  test.each([
    ["/", "GET", "navigate", "page"],
    ["/assets/x", "GET", "navigate", "network"],
    ["/events", "GET", "cors", "network"],
    ["/time", "GET", "cors", "network"],
    ["/importmap.json", "GET", "cors", "network"],
    ["/app/abc/viewer.js", "GET", "cors", "immutable"],
    ["/vendor/abc/lit.js", "GET", "cors", "immutable"],
    ["/plugins/markdown/1.0.0/viewer.js", "GET", "cors", "immutable"],
    [`/assets/${hash}`, "GET", "no-cors", "asset"],
    [`/assets/${hash}/thumbnail`, "GET", "no-cors", "network"],
    [`/assets/${hash}`, "HEAD", "no-cors", "network"],
    ["/app/abc/viewer.js", "POST", "cors", "network"],
  ])("%s %s (%s) is %s", (path, method, mode, strategy) => {
    expect(route(path, method, mode)).toBe(strategy as never);
  });
});

describe("assetDelta", () => {
  test("adds what is wanted and missing, removes what is no longer wanted", () => {
    expect(assetDelta(["/assets/a", "/assets/b"], ["/assets/b", "/assets/c", "/assets/c"])).toEqual(
      { add: ["/assets/c"], remove: ["/assets/a"] },
    );
  });
});

describe("parseRange", () => {
  test.each([
    ["bytes=0-", { start: 0, end: 99 }],
    ["bytes=10-19", { start: 10, end: 19 }],
    ["bytes=90-200", { start: 90, end: 99 }],
    ["bytes=-10", { start: 90, end: 99 }],
    ["bytes=-500", { start: 0, end: 99 }],
    ["bytes=100-", "unsatisfiable"],
    ["bytes=20-10", "unsatisfiable"],
    ["bytes=-0", "unsatisfiable"],
    ["bytes=0-1,5-6", undefined],
    ["items=0-1", undefined],
    ["bytes=-", undefined],
  ])("%s of 100 bytes", (header, expected) => {
    expect(parseRange(header, 100)).toEqual(expected as never);
  });
});
