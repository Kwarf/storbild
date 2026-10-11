import { describe, expect, test } from "bun:test";
import { ConfigError, parseConfig } from "./config.ts";

const HASH = "$argon2id$v=19$m=65536,t=2,p=1$c2FsdA$aGFzaA";

/** The minimal valid environment. */
const base = { STORBILD_ADMIN_PASSWORD_HASH: HASH };

function issuesOf(env: Record<string, string>): string[] {
  try {
    parseConfig({ ...base, ...env });
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error("expected parseConfig to throw");
}

describe("parseConfig", () => {
  test("applies defaults to every other variable", () => {
    expect(parseConfig(base)).toEqual({
      host: "127.0.0.1",
      viewer: { port: 3000, publicUrl: "http://localhost:3000" },
      admin: {
        port: 3001,
        publicUrl: "http://localhost:3001",
        username: "admin",
        passwordHash: HASH,
      },
      dataDir: "./data",
      pluginPaths: [],
      maxUploadBytes: 25 * 1024 * 1024,
    });
  });

  test("reads every variable", () => {
    const config = parseConfig({
      STORBILD_HOST: "0.0.0.0",
      STORBILD_VIEWER_PORT: "8000",
      STORBILD_ADMIN_PORT: "8001",
      STORBILD_DATA_DIR: "/var/lib/storbild",
      STORBILD_ADMIN_USERNAME: "crew",
      STORBILD_ADMIN_PASSWORD_HASH: HASH,
      STORBILD_PLUGIN_PATHS: "/a:/b",
      STORBILD_MAX_UPLOAD_MB: "0.5",
      STORBILD_VIEWER_URL: "https://screen.example.org",
      STORBILD_ADMIN_URL: "https://admin.example.org",
    });
    expect(config).toEqual({
      host: "0.0.0.0",
      viewer: { port: 8000, publicUrl: "https://screen.example.org" },
      admin: {
        port: 8001,
        publicUrl: "https://admin.example.org",
        username: "crew",
        passwordHash: HASH,
      },
      dataDir: "/var/lib/storbild",
      pluginPaths: ["/a", "/b"],
      maxUploadBytes: 512 * 1024,
    });
  });

  test("ignores unrelated variables and treats empty values as unset", () => {
    const config = parseConfig({ ...base, PATH: "/usr/bin", STORBILD_VIEWER_PORT: "" });
    expect(config.viewer.port).toBe(3000);
  });

  test("splits plugin paths on the given delimiter and drops empty entries", () => {
    expect(
      parseConfig({ ...base, STORBILD_PLUGIN_PATHS: "C:\\a;; C:\\b ;" }, ";").pluginPaths,
    ).toEqual(["C:\\a", "C:\\b"]);
  });

  test("rejects out-of-range and non-numeric ports", () => {
    expect(issuesOf({ STORBILD_VIEWER_PORT: "70000" })[0]).toStartWith("STORBILD_VIEWER_PORT");
    expect(issuesOf({ STORBILD_ADMIN_PORT: "abc" })[0]).toStartWith("STORBILD_ADMIN_PORT");
  });

  test("rejects identical viewer and admin ports", () => {
    expect(issuesOf({ STORBILD_VIEWER_PORT: "4000", STORBILD_ADMIN_PORT: "4000" })).toEqual([
      "STORBILD_ADMIN_PORT: viewer and admin ports must differ",
    ]);
  });

  test("allows ephemeral port 0 for both apps", () => {
    const config = parseConfig({ ...base, STORBILD_VIEWER_PORT: "0", STORBILD_ADMIN_PORT: "0" });
    expect([config.viewer.port, config.admin.port]).toEqual([0, 0]);
  });

  test("requires a password hash", () => {
    expect(issuesOf({ STORBILD_ADMIN_PASSWORD_HASH: "" })).toEqual([
      "STORBILD_ADMIN_PASSWORD_HASH: is required; generate one with `bun run hash-password`",
    ]);
  });

  test("rejects a password hash that is not argon2id", () => {
    expect(issuesOf({ STORBILD_ADMIN_PASSWORD_HASH: "$2b$10$bcrypt" })[0]).toContain("argon2id");
  });

  test("lists every invalid variable in one error", () => {
    const issues = issuesOf({
      STORBILD_VIEWER_PORT: "-1",
      STORBILD_VIEWER_URL: "not a url",
      STORBILD_ADMIN_PASSWORD_HASH: "plain",
    });
    expect(issues.map((issue) => issue.split(":")[0])).toEqual([
      "STORBILD_VIEWER_PORT",
      "STORBILD_ADMIN_PASSWORD_HASH",
      "STORBILD_VIEWER_URL",
    ]);
  });
});
