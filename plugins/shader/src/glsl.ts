// What the screens and the editor share (ADR 0031): the program text around a Shadertoy-style
// `mainImage()`, shader time, and reading compile logs. Pure, so it is unit tested.

/** Draws one triangle that covers the screen, without buffers. */
export const VERTEX_SHADER = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** Everything before the user's source. Shadertoy's inputs, plus the theme colours. */
const PREAMBLE = `#version 300 es
precision highp float;
precision highp int;
uniform vec3 iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform float iFrameRate;
uniform int iFrame;
uniform vec4 iDate;
uniform vec3 iChannelResolution[4];
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
uniform sampler2D iChannel3;
uniform vec3 sbText;
uniform vec3 sbMuted;
uniform vec3 sbAccent;
uniform vec3 sbSurface;
out vec4 sbFragColor;
`;

/**
 * Lines after the user's source are numbered from here, so an error in the wrapper (such as
 * a missing `mainImage`) can be told apart from one in the source.
 */
const EPILOGUE_LINE = 1_000_000;

const EPILOGUE = `
#line ${EPILOGUE_LINE}
void main() {
  sbFragColor = vec4(0.0, 0.0, 0.0, 1.0);
  mainImage(sbFragColor, gl_FragCoord.xy);
  sbFragColor.a = 1.0;
}
`;

/**
 * The fragment shader for `source`. `#line 1` before it makes compile errors carry the
 * source's own line numbers.
 */
export function fragmentShader(source: string): string {
  return `${PREAMBLE}#line 1\n${source}\n${EPILOGUE}`;
}

/** The uniforms the screens set, in the order they are looked up. */
export const UNIFORMS = [
  "iResolution",
  "iTime",
  "iTimeDelta",
  "iFrameRate",
  "iFrame",
  "iDate",
  "iChannelResolution",
  "iChannel0",
  "iChannel1",
  "iChannel2",
  "iChannel3",
  "sbText",
  "sbMuted",
  "sbAccent",
  "sbSurface",
] as const;

/**
 * Shader time in seconds: server time scaled by `speed`, wrapped after `loopMs`. Counted from
 * the epoch, so every screen shows the same frame and wraps at the same moment. The wrap
 * happens in double precision, before the value is narrowed to a 32-bit float for the GPU.
 */
export function shaderTime(serverNow: number, speed: number, loopMs: number): number {
  const scaled = serverNow * speed;
  return (((scaled % loopMs) + loopMs) % loopMs) / 1000;
}

/** Shadertoy's `iDate`: year, month from 0, day, and seconds since midnight, locally. */
export function shaderDate(serverNow: number): [number, number, number, number] {
  const date = new Date(serverNow);
  const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return [date.getFullYear(), date.getMonth(), date.getDate(), (serverNow - midnight) / 1000];
}

/** One message from a compile log. `line` is the source's, if the message points into it. */
export interface Diagnostic {
  severity: "error" | "warning";
  line?: number;
  message: string;
}

/**
 * Reads a compile log. ANGLE (Chromium, Firefox on Windows) writes `ERROR: 0:12: message`, and
 * Mesa `0:12(5): error: message`. Anything else is kept as a message without a line. Lines in
 * the preamble or the wrapper get no line number.
 */
export function parseLog(log: string, sourceLines: number): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const raw of log.split("\n")) {
    const text = raw.replace(/\0/g, "").trim();
    if (!text) continue;
    const angle = /^(ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/i.exec(text);
    const mesa = /^\d+:(\d+)\(\d+\):\s*(error|warning):\s*(.*)$/i.exec(text);
    let severity: Diagnostic["severity"] = "error";
    let line: number | undefined;
    let message = text;
    if (angle) {
      severity = angle[1]?.toLowerCase() === "warning" ? "warning" : "error";
      line = Number(angle[2]);
      message = angle[3] ?? "";
    } else if (mesa) {
      line = Number(mesa[1]);
      severity = mesa[2]?.toLowerCase() === "warning" ? "warning" : "error";
      message = mesa[3] ?? "";
    }
    // ANGLE ends a failed log with a count, e.g. "ERROR: 2 compilation errors.  No code generated."
    if (/compilation errors?\.\s*No code generated/i.test(message)) continue;
    diagnostics.push(
      line !== undefined && line >= 1 && line <= sourceLines
        ? { severity, line, message }
        : { severity, message },
    );
  }
  return diagnostics;
}

/** The source without comments, keeping its line breaks. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

/**
 * Problems found before compiling, and channels the shader reads that have no image.
 * `channels` is how many channel images the instance has.
 */
export function check(source: string, channels: number): Diagnostic[] {
  const code = withoutComments(source);
  const found: Diagnostic[] = [];
  if (/^\s*#\s*version\b/m.test(code)) {
    found.push({
      severity: "error",
      message: "Remove the #version line: the shader is wrapped in GLSL ES 3.00 already.",
    });
  }
  if (!/\bvoid\s+mainImage\s*\(/.test(code)) {
    found.push({
      severity: "error",
      message: "The shader needs a mainImage() function, as on Shadertoy's Image tab.",
    });
  }
  for (let i = channels; i < 4; i++) {
    if (new RegExp(`\\biChannel${i}\\b`).test(code)) {
      found.push({
        severity: "warning",
        message: `iChannel${i} has no image, so it reads as black. Add one under Channels.`,
      });
    }
  }
  return found;
}
