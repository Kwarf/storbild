import { describe, expect, test } from "bun:test";
import { check, fragmentShader, parseLog, shaderDate, shaderTime } from "./glsl.ts";

describe("fragmentShader", () => {
  test("wraps the source after the preamble, numbered from line 1", () => {
    const text = fragmentShader("void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }");
    expect(text.startsWith("#version 300 es\n")).toBe(true);
    expect(text).toContain("uniform float iTime;");
    expect(text).toContain("uniform vec3 sbAccent;");
    // Inputs without a meaning here are left out, so shaders that use them fail to compile.
    for (const name of ["iMouse", "iChannelTime", "iSampleRate"]) expect(text).not.toContain(name);
    expect(text).toContain("#line 1\nvoid mainImage");
    expect(text).toContain("mainImage(sbFragColor, gl_FragCoord.xy);");
  });
});

describe("shaderTime", () => {
  test("is server time in seconds, times the speed, wrapped after the loop", () => {
    const hour = 3_600_000;
    expect(shaderTime(hour * 1000 + 1_500, 1, hour)).toBe(1.5);
    expect(shaderTime(hour * 1000 + 1_500, 2, hour)).toBe(3);
    expect(shaderTime(hour * 1000 - 1, 1, hour)).toBeCloseTo(3599.999, 6);
  });

  test("is the same on every screen at the same server time, and small enough for a float", () => {
    const now = Date.UTC(2026, 9, 16, 20, 15, 30, 250);
    expect(shaderTime(now, 1, 3_600_000)).toBe(15 * 60 + 30.25);
    expect(Math.fround(shaderTime(now, 1, 3_600_000))).toBeCloseTo(930.25, 3);
  });
});

describe("shaderDate", () => {
  test("is year, month from 0, day and seconds since local midnight", () => {
    const now = new Date(2026, 9, 16, 1, 2, 3, 500).getTime();
    expect(shaderDate(now)).toEqual([2026, 9, 16, 3723.5]);
  });
});

describe("parseLog", () => {
  test("reads ANGLE logs, keeping only lines inside the source", () => {
    const log = [
      "ERROR: 0:3: 'foo' : undeclared identifier",
      "WARNING: 0:2: 'x' : unused",
      "ERROR: 0:1000001: 'mainImage' : no matching overloaded function found",
      "ERROR: 2 compilation errors.  No code generated.",
      "",
    ].join("\n");
    expect(parseLog(log, 5)).toEqual([
      { severity: "error", line: 3, message: "'foo' : undeclared identifier" },
      { severity: "warning", line: 2, message: "'x' : unused" },
      { severity: "error", message: "'mainImage' : no matching overloaded function found" },
    ]);
  });

  test("reads Mesa logs, and keeps anything else as a message", () => {
    expect(parseLog("0:4(12): error: syntax error\nsomething else\0", 10)).toEqual([
      { severity: "error", line: 4, message: "syntax error" },
      { severity: "error", message: "something else" },
    ]);
  });
});

describe("check", () => {
  const ok = "void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }";

  test("passes a plain mainImage", () => {
    expect(check(ok, 0)).toEqual([]);
  });

  test("needs mainImage and refuses a #version line, ignoring comments", () => {
    expect(check("// void mainImage(\nvoid main() {}", 0).map((d) => d.message)).toEqual([
      "The shader needs a mainImage() function, as on Shadertoy's Image tab.",
    ]);
    expect(check(`#version 300 es\n${ok}`, 0)[0]?.severity).toBe("error");
  });

  test("warns about channels the shader reads that have no image", () => {
    const source = `${ok}\nfloat a = texture(iChannel0, p).r + texture(iChannel2, p).r;`;
    expect(check(source, 1).map((d) => d.message)).toEqual([
      "iChannel2 has no image, so it reads as black. Add one under Channels.",
    ]);
    expect(check(`${ok} /* iChannel2 */`, 0)).toEqual([]);
  });
});
