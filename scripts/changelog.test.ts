import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { releaseNotes } from "./changelog.ts";

const root = join(import.meta.dir, "..");

/** The release notes for a package's current version, in a changelog. */
async function notesFor(changelog: string, pkg: string) {
  const { version } = (await Bun.file(join(root, pkg)).json()) as { version: string };
  return releaseNotes(await Bun.file(join(root, changelog)).text(), version);
}

describe("changelogs", () => {
  test("the server's version has release notes in CHANGELOG.md", async () => {
    expect(await notesFor("CHANGELOG.md", "packages/server/package.json")).toBeString();
  });

  test("the SDK's version has release notes in its CHANGELOG.md", async () => {
    expect(
      await notesFor("packages/plugin-sdk/CHANGELOG.md", "packages/plugin-sdk/package.json"),
    ).toBeString();
  });

  test("a version's notes run to the next version", () => {
    const changelog = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "## 1.10.0 — 2026-11-01",
      "",
      "### Added",
      "",
      "- Something.",
      "",
      "## 1.1.0 — 2026-10-15",
      "",
      "- Older.",
    ].join("\n");
    expect(releaseNotes(changelog, "1.10.0")).toBe("### Added\n\n- Something.");
    expect(releaseNotes(changelog, "1.1.0")).toBe("- Older.");
    expect(releaseNotes(changelog, "1.1")).toBeUndefined();
    expect(releaseNotes(changelog, "Unreleased")).toBeUndefined();
  });
});
