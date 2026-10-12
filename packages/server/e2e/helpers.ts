// Helpers shared by the e2e tests.
import { join } from "node:path";
import type { Page } from "playwright";
import { TEST_PASSWORD } from "../src/testing.ts";

export const enabled = process.env.STORBILD_E2E === "1";
export const TIMEOUT = 30_000;
export const screenshots = join(import.meta.dir, "screenshots");

export async function until(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(25);
  }
}

/** Screenshots `page` in light and dark to `screenshots/<name>-<scheme>.png`. */
export async function shot(page: Page, name: string) {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    // Let colour transitions settle.
    await Bun.sleep(300);
    await page.screenshot({ path: join(screenshots, `${name}-${colorScheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/** Logs in to the admin at `url` and waits for the Live page. */
export async function logIn(page: Page, url: URL) {
  await page.goto(url.href);
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL((url) => url.pathname === "/live");
}

/** A `datetime-local` value in the local time zone. */
export function toLocalInput(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  // Chromium drops `:00` seconds from the value, and Playwright's fill rejects a value that
  // doesn't read back the same.
  const seconds = date.getSeconds() ? `:${pad(date.getSeconds())}` : "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}${seconds}`;
}
