import { describe, expect, test } from "bun:test";
import plugin from "./plugin.ts";

describe("markdown/text config", () => {
  const { migrate, configVersion, config } = plugin.types.text;

  test("a config from before the alignments gets the old layout", () => {
    expect(config.parse({ content: "Be nice" })).toEqual({
      content: "Be nice",
      align: "left",
      verticalAlign: "center",
    });
  });

  test("version 1's title becomes a heading at the top of the content", () => {
    expect(configVersion).toBe(2);
    expect(migrate?.(1, { title: "Rules", content: "Be nice" })).toEqual({
      content: "# Rules\n\nBe nice",
    });
  });

  test("version 1 without a title keeps its content", () => {
    expect(migrate?.(1, { content: "Be nice" })).toEqual({ content: "Be nice" });
  });
});
