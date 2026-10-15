// A version's notes from a changelog, for its GitHub release (ADR 0029).
//
//   bun scripts/changelog.ts CHANGELOG.md <version>
//   bun scripts/changelog.ts packages/plugin-sdk/CHANGELOG.md <version>

/** The body of `## <version> — <date>`, up to the next `## ` heading, trimmed. */
export function releaseNotes(changelog: string, version: string): string | undefined {
  const lines = changelog.split("\n");
  const heading = `## ${version}`;
  const start = lines.findIndex((line) => line === heading || line.startsWith(`${heading} `));
  if (start < 0) return undefined;
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  const body = lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
  return body || undefined;
}

if (import.meta.main) {
  const [file, version] = process.argv.slice(2);
  if (!file || !version) {
    console.error("usage: bun scripts/changelog.ts <CHANGELOG.md> <version>");
    process.exit(2);
  }
  const notes = releaseNotes(await Bun.file(file).text(), version);
  if (!notes) {
    console.error(`${file} has no notes for ${version}`);
    process.exit(1);
  }
  console.log(notes);
}
