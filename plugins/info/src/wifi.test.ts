import { describe, expect, test } from "bun:test";
import { encode } from "uqr";
import { qrPath, wifiPayload } from "./wifi.ts";

describe("wifiPayload", () => {
  test("a WPA network", () => {
    expect(wifiPayload({ ssid: "party", password: "demoscene", security: "WPA" })).toBe(
      "WIFI:T:WPA;S:party;P:demoscene;;",
    );
  });

  test("escapes special characters", () => {
    expect(wifiPayload({ ssid: 'a;b,c:d"e\\f', password: "p;w", security: "WEP" })).toBe(
      'WIFI:T:WEP;S:a\\;b\\,c\\:d\\"e\\\\f;P:p\\;w;;',
    );
  });

  test("an open network has no password", () => {
    expect(wifiPayload({ ssid: "guest", password: "ignored", security: "none" })).toBe(
      "WIFI:T:nopass;S:guest;;",
    );
  });

  test("a hidden network", () => {
    expect(wifiPayload({ ssid: "x", security: "WPA", password: "y", hidden: true })).toBe(
      "WIFI:T:WPA;S:x;P:y;H:true;;",
    );
  });
});

describe("qrPath", () => {
  test("draws exactly the dark modules, with a 4-module quiet zone", () => {
    const text = "WIFI:T:WPA;S:party;P:demoscene;;";
    const { size, d } = qrPath(text);
    const expected = encode(text, { ecc: "M", border: 4 });
    expect(size).toBe(expected.size);
    expect(size).toBe(expected.version * 4 + 17 + 8);

    // Every dark module, as "x,y", from the path and from the encoder.
    const drawn = new Set<string>();
    for (const [, x, y, w] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      for (let i = 0; i < Number(w); i++) drawn.add(`${Number(x) + i},${y}`);
    }
    const dark = new Set<string>();
    expected.data.forEach((row, y) => {
      row.forEach((on, x) => {
        if (on) dark.add(`${x},${y}`);
      });
    });
    expect(drawn).toEqual(dark);
    // The quiet zone is empty and the top-left finder pattern starts right after it.
    expect(drawn.has("3,3")).toBe(false);
    expect(drawn.has("4,4")).toBe(true);
  });
});
