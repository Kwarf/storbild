import { expect, test } from "bun:test";
import plugin from "./plugin.ts";

const config = plugin.types.greeting.config;

test("fills in the defaults", () => {
  expect(config.parse({ message: "Welcome" })).toEqual({ message: "Welcome", showClock: true });
});

test("needs a message", () => {
  expect(config.safeParse({}).success).toBe(false);
});
