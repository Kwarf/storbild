import type { PluginConfig } from "@storbild/plugin-sdk";
import { StorbildScene } from "@storbild/plugin-sdk/viewer";
import { css, html, type PropertyValues } from "lit";
import { shaderDate, shaderTime, UNIFORMS } from "./glsl.ts";
import type plugin from "./plugin.ts";
import { compile, describe } from "./webgl.ts";

type Config = PluginConfig<typeof plugin, "shader">;
type Uniform = (typeof UNIFORMS)[number];

/** The stage's size; the canvas is this times the config's scale. */
const STAGE = { width: 1920, height: 1080 };
/** How often the theme colours are read again, so a theme change reaches a running shader. */
const COLOR_REFRESH_MS = 1_000;
const COLORS = [
  ["sbText", "--sb-color-text", "#ffffff"],
  ["sbMuted", "--sb-color-muted", "#a0a0a0"],
  ["sbAccent", "--sb-color-accent", "#ffcc00"],
  ["sbSurface", "--sb-color-surface", "#1a1a1a"],
] as const;

/** A linked program and where its uniforms are. */
interface Program {
  program: WebGLProgram;
  uniforms: Record<Uniform, WebGLUniformLocation | null>;
}

/** A channel's texture and the image's size. */
interface Channel {
  assetId: string;
  texture: WebGLTexture;
  width: number;
  height: number;
}

/**
 * Runs a Shadertoy-style fragment shader in WebGL2 (ADR 0031). Time comes from `serverNow()`,
 * so every screen shows the same frame. It draws only while `visible` (ADR 0030), and keeps
 * the last shader that compiled when an edit doesn't.
 */
export class ShaderScene extends StorbildScene<Config> {
  static override styles = css`
    :host {
      display: block;
      background: #000;
    }
    canvas {
      display: block;
      width: 100%;
      height: 100%;
    }
  `;

  #canvas: HTMLCanvasElement | undefined;
  #gl: WebGL2RenderingContext | undefined;
  #program: Program | undefined;
  /** The source last tried, whether it compiled or not. */
  #tried: string | undefined;
  #channels: (Channel | undefined)[] = [];
  #black: WebGLTexture | undefined;
  #loading: Promise<void> | undefined;
  #frame: number | undefined;
  #frames = 0;
  #last: number | undefined;
  #colors: Partial<Record<Uniform, [number, number, number]>> = {};
  #colorsAt = Number.NEGATIVE_INFINITY;
  #lost = false;

  override render() {
    return html`<canvas
      @webglcontextlost=${(e: Event) => {
        e.preventDefault();
        this.#lost = true;
        this.#stop();
      }}
      @webglcontextrestored=${() => {
        this.#lost = false;
        this.#program = undefined;
        this.#tried = undefined;
        this.#channels = [];
        this.#black = undefined;
        this.#setUp().then(
          () => this.#run(),
          (error) => console.error("shader: cannot restore the context", error),
        );
      }}
    ></canvas>`;
  }

  /** Compiles, loads the channels and draws one frame, so the scene fades in drawn. */
  override async prepare() {
    await this.#setUp();
    this.#draw();
    this.#run();
    if (!this.#program) throw new Error("the shader did not compile");
  }

  protected override updated(changed: PropertyValues) {
    super.updated(changed);
    if (changed.has("config") && this.#gl) {
      this.#setUp().then(
        // A hidden shader still shows the change when it comes back.
        () => {
          if (this.#frame === undefined) this.#draw();
        },
        (error) => console.error("shader:", error),
      );
    }
    this.#run();
  }

  override connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated) this.#run();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.#stop();
  }

  override dispose() {
    this.#stop();
    const gl = this.#gl;
    if (gl && !this.#lost) {
      if (this.#program) gl.deleteProgram(this.#program.program);
      for (const channel of this.#channels) if (channel) gl.deleteTexture(channel.texture);
      if (this.#black) gl.deleteTexture(this.#black);
      // Frees the context now rather than when it is collected.
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    this.#gl = this.#program = this.#black = undefined;
    this.#channels = [];
  }

  /** Creates the context if needed, then compiles and loads what the config changed. */
  async #setUp() {
    if (this.#lost) return;
    await this.updateComplete;
    if (!this.#gl) {
      const canvas = this.renderRoot.querySelector("canvas");
      const gl = canvas?.getContext("webgl2", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: "high-performance",
      });
      if (!canvas || !gl) throw new Error("WebGL2 is not available");
      this.#canvas = canvas;
      this.#gl = gl;
    }
    this.#resize();
    this.#compile();
    // One load at a time; each one loads only the channels that changed since the last.
    const loading = (this.#loading ?? Promise.resolve()).then(() => this.#loadChannels());
    this.#loading = loading;
    await loading;
  }

  #resize() {
    const canvas = this.#canvas;
    if (!canvas) return;
    const width = Math.round(STAGE.width * this.config.scale);
    const height = Math.round(STAGE.height * this.config.scale);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  /** Compiles a changed source. One that fails is logged, and the last good one stays. */
  #compile() {
    const gl = this.#gl;
    const source = this.config.source;
    if (!gl || source === this.#tried) return;
    this.#tried = source;
    const compiled = compile(gl, source);
    if (!compiled.ok) {
      console.error(`shader: ${describe(compiled)}`);
      return;
    }
    if (this.#program) gl.deleteProgram(this.#program.program);
    const uniforms = {} as Program["uniforms"];
    for (const name of UNIFORMS) uniforms[name] = gl.getUniformLocation(compiled.program, name);
    this.#program = { program: compiled.program, uniforms };
    this.#colorsAt = Number.NEGATIVE_INFINITY;
  }

  /** Loads the channel images that changed, as Shadertoy does: mipmapped, repeating, flipped. */
  async #loadChannels() {
    const gl = this.#gl;
    if (!gl) return;
    this.#black ??= texture(gl, (target) =>
      gl.texImage2D(target, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)),
    );
    const wanted = this.config.channels.slice(0, 4);
    await Promise.all(
      [0, 1, 2, 3].map(async (i) => {
        const assetId = wanted[i];
        const current = this.#channels[i];
        if (current?.assetId === assetId) return;
        let next: Channel | undefined;
        if (assetId) {
          try {
            const image = new Image();
            image.src = this.ctx.assetUrl(assetId);
            await image.decode();
            if (this.#gl !== gl) return;
            next = {
              assetId,
              width: image.naturalWidth,
              height: image.naturalHeight,
              texture: texture(gl, (target) => {
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
                gl.texImage2D(target, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                gl.generateMipmap(target);
                gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
              }),
            };
          } catch (error) {
            console.error(`shader: cannot load channel ${i}`, error);
          }
        }
        if (current) gl.deleteTexture(current.texture);
        this.#channels[i] = next;
      }),
    );
  }

  /** Starts or stops the frame loop as visibility asks. */
  #run() {
    const running = this.visible !== false && this.isConnected && !!this.#gl && !this.#lost;
    if (running && this.#frame === undefined) {
      this.#last = undefined;
      this.#frame = requestAnimationFrame(this.#tick);
    } else if (!running) {
      this.#stop();
    }
  }

  #stop() {
    if (this.#frame !== undefined) cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
  }

  readonly #tick = (at: number) => {
    this.#frame = requestAnimationFrame(this.#tick);
    const fps = this.config.fps;
    // Within a millisecond of the interval counts, since frames don't land exactly on it.
    if (fps && this.#last !== undefined && at - this.#last < 1000 / fps - 1) return;
    const delta = this.#last === undefined ? 0 : (at - this.#last) / 1000;
    this.#last = at;
    this.#draw(delta);
  };

  #draw(delta = 0) {
    const gl = this.#gl;
    const program = this.#program;
    if (!gl || !program || this.#lost) return;
    const { uniforms: u } = program;
    const now = this.ctx.serverNow();
    const { width, height } = gl.canvas;
    gl.viewport(0, 0, width, height);
    gl.useProgram(program.program);

    gl.uniform3f(u.iResolution, width, height, 1);
    gl.uniform1f(u.iTime, shaderTime(now, this.config.speed, this.config.loop));
    gl.uniform1f(u.iTimeDelta, delta);
    gl.uniform1f(u.iFrameRate, delta > 0 ? 1 / delta : 60);
    gl.uniform1i(u.iFrame, this.#frames++);
    gl.uniform4f(u.iDate, ...shaderDate(now));
    const sizes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const channel = this.#channels[i];
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, channel?.texture ?? this.#black ?? null);
      gl.uniform1i(u[`iChannel${i}` as Uniform], i);
      sizes.push(channel?.width ?? 0, channel?.height ?? 0, 1);
    }
    gl.uniform3fv(u.iChannelResolution, sizes);
    for (const [name, rgb] of Object.entries(this.#themeColors(now))) {
      gl.uniform3f(u[name as Uniform], ...rgb);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** The theme colours as RGB from 0 to 1, read again every second. */
  #themeColors(now: number) {
    if (now - this.#colorsAt >= COLOR_REFRESH_MS || now < this.#colorsAt) {
      this.#colorsAt = now;
      const style = getComputedStyle(this);
      for (const [uniform, variable, fallback] of COLORS) {
        this.#colors[uniform] = rgb(style.getPropertyValue(variable).trim() || fallback);
      }
    }
    return this.#colors;
  }
}

function texture(gl: WebGL2RenderingContext, fill: (target: GLenum) => void): WebGLTexture {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  fill(gl.TEXTURE_2D);
  return texture;
}

/** Any CSS colour as RGB from 0 to 1, by letting a canvas parse and paint it. */
const rgb = (() => {
  const cache = new Map<string, [number, number, number]>();
  let context: OffscreenCanvasRenderingContext2D | null | undefined;
  return (color: string): [number, number, number] => {
    const known = cache.get(color);
    if (known) return known;
    context ??= new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
    let value: [number, number, number] = [0, 0, 0];
    if (context) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "#000";
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
      value = [r / 255, g / 255, b / 255];
    }
    cache.set(color, value);
    return value;
  };
})();

customElements.define("sb-shader", ShaderScene);
