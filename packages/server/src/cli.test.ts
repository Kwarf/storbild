import { expect, test } from "bun:test";

const cli = new URL("./cli.ts", import.meta.url).pathname;

async function run(args: string[], stdin: string) {
  const proc = Bun.spawn(["bun", cli, ...args], {
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

test("hash-password prints an argon2id hash of the first line of stdin", async () => {
  const { stdout, stderr, code } = await run(["hash-password"], "s3cret pass\nignored\n");
  expect(code).toBe(0);
  const hash = stdout.trim();
  expect(hash).toStartWith("$argon2id$");
  expect(await Bun.password.verify("s3cret pass", hash)).toBe(true);
  // A .env line with `$` escaped, since Bun expands it there.
  expect(stderr).toContain(`STORBILD_ADMIN_PASSWORD_HASH=${hash.replaceAll("$", "\\$")}`);
});

test("hash-password refuses an empty password", async () => {
  const { stdout, stderr, code } = await run(["hash-password"], "\n");
  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain("empty");
});

test("an unknown command prints usage and fails", async () => {
  const { stderr, code } = await run(["nope"], "");
  expect(code).toBe(1);
  expect(stderr).toContain("usage: storbild hash-password");
});
