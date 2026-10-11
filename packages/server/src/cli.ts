#!/usr/bin/env bun
// The storbild command line. `storbild hash-password` prints an argon2id hash for
// STORBILD_ADMIN_PASSWORD_HASH (DESIGN.md §8.1).

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

/** Reads one line from a terminal without echoing it. */
function readHidden(prompt: string): Promise<string> {
  const { stdin, stderr } = process;
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") return done();
        if (char === "\u0003") return done(new Error("cancelled"));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });
}

/** Asks twice on a terminal; otherwise reads the first line of stdin. */
async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    const input = await Bun.stdin.text();
    return input.split(/\r?\n/)[0] ?? "";
  }
  const password = await readHidden("Password: ");
  if ((await readHidden("Repeat password: ")) !== password) {
    throw new Error("the passwords don't match");
  }
  return password;
}

async function main(args: string[]): Promise<number> {
  const [command] = args;
  if (command !== "hash-password") {
    console.error(
      "usage: storbild hash-password\n\nReads a password and prints its argon2id hash.",
    );
    return command === undefined || command === "--help" ? 0 : 1;
  }
  try {
    const password = await readPassword();
    if (password === "") throw new Error("the password is empty");
    const hash = await hashPassword(password);
    console.log(hash);
    // Bun expands `$` in .env files, even inside quotes, unless it is escaped.
    console.error(`\nFor .env:\nSTORBILD_ADMIN_PASSWORD_HASH=${hash.replaceAll("$", "\\$")}`);
    return 0;
  } catch (error) {
    console.error(`storbild: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
