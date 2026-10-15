import { describe, expect, test } from "bun:test";
import { widgetVariables } from "./theme.ts";

describe("widgetVariables", () => {
  test("defaults to glass with an 8 px blur and a soft shadow", () => {
    const vars = widgetVariables();
    expect(vars["--sb-widget-background"]).toBe(
      "color-mix(in srgb, var(--sb-color-surface) 55%, transparent)",
    );
    expect(vars["--sb-widget-backdrop"]).toBe("blur(8px) saturate(140%)");
    expect(vars["--sb-widget-radius"]).toBe("20px");
    expect(vars["--sb-widget-border"]).toContain("1px solid");
    expect(vars["--sb-widget-shadow"]).toStartWith("inset 0 1px 0");
    expect(vars["--sb-widget-shadow"]).toContain("0 8px 24px");
    expect(vars["--sb-widget-shadow-margin"]).toBe("32px");
  });

  test("glass takes the theme's opacity, blur and radius", () => {
    const vars = widgetVariables({ opacity: 0.3, blur: 0, radius: 4 });
    expect(vars["--sb-widget-background"]).toContain(" 30%,");
    expect(vars["--sb-widget-backdrop"]).toBe("none");
    expect(vars["--sb-widget-radius"]).toBe("4px");
  });

  test("solid is opaque, with no border, blur or lit edge", () => {
    const vars = widgetVariables({ style: "solid", opacity: 0.2, blur: 20 });
    expect(vars["--sb-widget-background"]).toBe("var(--sb-color-surface)");
    expect(vars["--sb-widget-backdrop"]).toBe("none");
    expect(vars["--sb-widget-border"]).toBe("none");
    expect(vars["--sb-widget-shadow"]).toBe("0 8px 24px rgb(0 0 0 / 0.35)");
  });

  test("each shadow sets a clip margin that covers it", () => {
    const margin = (shadow: "none" | "soft" | "deep" | "glow") =>
      widgetVariables({ style: "solid", shadow })["--sb-widget-shadow-margin"];
    expect(margin("none")).toBe("0px");
    expect(margin("soft")).toBe("32px");
    expect(margin("glow")).toBe("48px");
    expect(margin("deep")).toBe("64px");
    expect(widgetVariables({ style: "solid", shadow: "none" })["--sb-widget-shadow"]).toBe("none");
    expect(widgetVariables({ shadow: "glow" })["--sb-widget-shadow"]).toContain(
      "var(--sb-color-accent)",
    );
  });

  test("an unknown shadow falls back to the default", () => {
    const frame = { shadow: "neon" } as unknown as Parameters<typeof widgetVariables>[0];
    expect(widgetVariables(frame)["--sb-widget-shadow-margin"]).toBe("32px");
  });

  test("none draws no box and shadows the text instead", () => {
    const vars = widgetVariables({ style: "none", shadow: "deep" });
    expect(vars["--sb-widget-padding"]).toBe("0");
    expect(vars["--sb-widget-background"]).toBe("transparent");
    expect(vars["--sb-widget-shadow"]).toBe("none");
    expect(vars["--sb-widget-text-shadow"]).not.toBe("none");
    expect(vars["--sb-widget-shadow-margin"]).toBe("16px");
  });
});
