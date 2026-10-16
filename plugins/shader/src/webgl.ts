// Compiling the program, shared by the screens and the editor's check (ADR 0031).
import { type Diagnostic, fragmentShader, parseLog, VERTEX_SHADER } from "./glsl.ts";

export type Compiled =
  | { ok: true; program: WebGLProgram }
  | { ok: false; diagnostics: Diagnostic[]; log: string };

/** Compiles and links `source`, wrapped as in `fragmentShader`. */
export function compile(gl: WebGL2RenderingContext, source: string): Compiled {
  const vertex = shader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = shader(gl, gl.FRAGMENT_SHADER, fragmentShader(source));
  const sourceLines = source.split("\n").length;
  const failed = (log: string): Compiled => ({
    ok: false,
    diagnostics: parseLog(log, sourceLines),
    log,
  });
  try {
    if (!vertex || !fragment) return failed("could not create a shader");
    if (!gl.getShaderParameter(fragment, gl.COMPILE_STATUS)) {
      return failed(gl.getShaderInfoLog(fragment) ?? "");
    }
    if (!gl.getShaderParameter(vertex, gl.COMPILE_STATUS)) {
      return failed(gl.getShaderInfoLog(vertex) ?? "");
    }
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? "";
      gl.deleteProgram(program);
      return failed(log);
    }
    return { ok: true, program };
  } finally {
    // A linked program keeps what it needs.
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
  }
}

function shader(gl: WebGL2RenderingContext, type: GLenum, text: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, text);
  gl.compileShader(shader);
  return shader;
}

/** Shows a compile result as one line for the console. */
export function describe(compiled: Extract<Compiled, { ok: false }>): string {
  const lines = compiled.diagnostics.map((d) =>
    d.line === undefined ? d.message : `line ${d.line}: ${d.message}`,
  );
  return lines.join("; ") || compiled.log;
}
