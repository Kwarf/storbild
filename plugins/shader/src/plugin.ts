import { API_VERSION, definePlugin, fields, z } from "@storbild/plugin-sdk";

/**
 * What a new shader starts with: a slow flow of the theme's colours. Its motion repeats every
 * minute, so the hourly wrap of `iTime` is seamless.
 */
export const STARTER = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
  // One turn a minute, so the shader loops seamlessly when iTime wraps.
  float t = iTime * 6.2831853 / 60.0;
  for (int i = 1; i <= 4; i++) {
    float f = float(i);
    uv += 0.3 / f * vec2(sin(f * 2.0 * uv.y + f * t), cos(f * 2.0 * uv.x - t));
  }
  float v = 0.5 + 0.5 * sin(2.0 * uv.x + 1.5 * uv.y);
  vec3 color = mix(sbSurface, sbAccent, smoothstep(0.15, 0.95, v));
  color = mix(color, sbMuted, 0.12 * (0.5 + 0.5 * sin(3.0 * uv.y - t)));
  vec2 edge = (fragCoord / iResolution.xy - 0.5) * vec2(1.6, 1.2);
  color *= mix(0.55, 1.0, smoothstep(1.25, 0.35, length(edge)));
  fragColor = vec4(color, 1.0);
}
`;

// WebGL shaders as scenes, mainly for theme backgrounds (ADR 0031).
export default definePlugin({
  id: "shader",
  version: "0.1.0",
  apiVersion: API_VERSION,
  types: {
    shader: {
      kind: "scene",
      label: "Shader",
      config: z.object({
        source: z.string().min(1).max(65_536).default(STARTER).meta({
          title: "Shader",
          description: "The code from Shadertoy's Image tab: a mainImage() function.",
        }),
        loop: fields.duration().default(3_600_000).meta({
          title: "Loop after",
          description:
            "Shader time starts over after this. Set it to the shader's own period to loop seamlessly.",
        }),
        speed: z.number().positive().max(100).default(1),
        scale: z
          .union([
            z.literal(1).meta({ title: "Full" }),
            z.literal(0.75).meta({ title: "3/4" }),
            z.literal(0.5).meta({ title: "Half" }),
            z.literal(0.25).meta({ title: "Quarter" }),
          ])
          .default(1)
          .meta({
            title: "Resolution",
            description: "Lower draws fewer pixels and stretches them, for slow screens.",
          }),
        fps: z
          .union([
            z.literal(60).meta({ title: "60" }),
            z.literal(30).meta({ title: "30" }),
            z.literal(24).meta({ title: "24" }),
          ])
          .optional()
          .meta({ title: "Frame rate limit", description: "Default: the screen's own rate." }),
        channels: z
          .array(fields.asset({ accept: ["image/*"] }).meta({ title: "Image" }))
          .max(4)
          .default([])
          .meta({ description: "Images the shader reads as iChannel0 to iChannel3." }),
      }),
      background: "own",
      viewer: "sb-shader",
      editor: "sb-shader-editor",
    },
  },
});
