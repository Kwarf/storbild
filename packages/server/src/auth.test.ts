import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./auth.ts";
import { openDatabase } from "./db.ts";
import { createTestAdminApp, FakeClock, TEST_PASSWORD } from "./testing.ts";

const DAY = 24 * 3_600_000;

type TestApp = ReturnType<typeof createTestAdminApp>["app"];

/** A Bun server stand-in that reports the client's socket address. */
const fromAddress = (address: string) => ({ requestIP: () => ({ address }) });

function login(
  app: TestApp,
  {
    username = "admin",
    password = TEST_PASSWORD,
    origin = "http://localhost",
    address = "203.0.113.1",
    headers = {},
  } = {},
) {
  return app.request(
    `${origin}/login`,
    {
      method: "POST",
      headers: { Origin: origin, ...headers },
      body: new URLSearchParams({ username, password }),
    },
    fromAddress(address),
  );
}

/** The `name=value` part of a response's session cookie. */
function cookieOf(res: Response): string {
  const cookie = res.headers.get("Set-Cookie")?.split(";")[0];
  if (!cookie) throw new Error("no cookie");
  return cookie;
}

const get = (app: TestApp, path: string, cookie?: string) =>
  app.request(path, { headers: cookie ? { Cookie: cookie } : {} });

describe("login", () => {
  test("sets a host-only, HttpOnly, SameSite=Lax session cookie and redirects", async () => {
    const { app } = createTestAdminApp();
    const res = await login(app);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/");
    const cookie = res.headers.get("Set-Cookie") as string;
    expect(cookie).toStartWith("storbild_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${7 * 24 * 3600}`);
    expect(cookie).not.toContain("Domain");
    // Plain http in development: a Secure cookie would not be sent back.
    expect(cookie).not.toContain("Secure");
    expect((await get(app, "/api/time", cookieOf(res))).status).toBe(200);
  });

  test("behind https the cookie is Secure and __Host- prefixed", async () => {
    const origin = "https://admin.example.org";
    const { app } = createTestAdminApp({ publicUrl: origin });
    const res = await login(app, { origin });
    const cookie = res.headers.get("Set-Cookie") as string;
    expect(cookie).toStartWith("__Host-storbild_session=");
    expect(cookie).toContain("Secure");
    expect((await get(app, `${origin}/api/time`, cookieOf(res))).status).toBe(200);
  });

  test.each([
    ["password", { password: "wrong" }],
    ["username", { username: "root" }],
    ["empty password", { password: "" }],
  ])("a wrong %s is refused", async (_, credentials) => {
    const { app } = createTestAdminApp();
    const res = await login(app, credentials);
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(await res.text()).toContain("Wrong username or password.");
  });

  test("the form shows, and redirects home once logged in", async () => {
    const { app } = createTestAdminApp();
    const form = await get(app, "/login");
    expect(form.status).toBe(200);
    expect(await form.text()).toContain('<form method="post" action="/login">');
    const res = await get(app, "/login", cookieOf(await login(app)));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
  });
});

describe("login rate limit", () => {
  test("blocks a client after 5 failures for 5 minutes, even with the right password", async () => {
    const clock = new FakeClock(0);
    const { app } = createTestAdminApp({ clock });
    for (let i = 0; i < 5; i++) expect((await login(app, { password: "nope" })).status).toBe(401);
    const blocked = await login(app);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("300");
    expect(await blocked.text()).toContain("Try again in 5 minutes.");

    await clock.advance(5 * 60_000);
    expect((await login(app)).status).toBe(303);
  });

  test("counts per client, so others can still log in", async () => {
    const { app } = createTestAdminApp();
    for (let i = 0; i < 5; i++) await login(app, { password: "nope", address: "203.0.113.9" });
    expect((await login(app, { address: "203.0.113.9" })).status).toBe(429);
    expect((await login(app, { address: "198.51.100.7" })).status).toBe(303);
  });

  test("behind a local proxy, the client is the first X-Forwarded-For hop", async () => {
    const { app } = createTestAdminApp();
    const via = (client: string) => ({
      address: "127.0.0.1",
      headers: { "X-Forwarded-For": client },
    });
    for (let i = 0; i < 5; i++) await login(app, { password: "nope", ...via("203.0.113.9") });
    expect((await login(app, via("203.0.113.9, 10.0.0.1"))).status).toBe(429);
    expect((await login(app, via("198.51.100.7"))).status).toBe(303);
  });

  test("ignores X-Forwarded-For from anyone but a local proxy", async () => {
    const { app } = createTestAdminApp();
    for (let i = 0; i < 5; i++) {
      await login(app, {
        password: "nope",
        headers: { "X-Forwarded-For": `198.51.100.${i}` },
      });
    }
    expect((await login(app)).status).toBe(429);
  });

  test("a successful login resets the count", async () => {
    const { app } = createTestAdminApp();
    for (let i = 0; i < 4; i++) await login(app, { password: "nope" });
    expect((await login(app)).status).toBe(303);
    for (let i = 0; i < 4; i++) await login(app, { password: "nope" });
    expect((await login(app)).status).toBe(303);
  });
});

describe("sessions", () => {
  test("expire 7 days after last use, and using one extends it", async () => {
    const clock = new FakeClock(0);
    const { app } = createTestAdminApp({ clock });
    const cookie = cookieOf(await login(app));
    await clock.advance(6 * DAY);
    const used = await get(app, "/api/time", cookie);
    expect(used.status).toBe(200);
    // The cookie is renewed along with the session.
    expect(used.headers.get("Set-Cookie")).toContain(`Max-Age=${7 * 24 * 3600}`);
    await clock.advance(6 * DAY);
    expect((await get(app, "/api/time", cookie)).status).toBe(200);
    await clock.advance(7 * DAY);
    expect((await get(app, "/api/time", cookie)).status).toBe(401);
  });

  test("logging out ends the session", async () => {
    const { app } = createTestAdminApp();
    const cookie = cookieOf(await login(app));
    const res = await app.request("/logout", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "http://localhost" },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/login");
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await get(app, "/api/time", cookie)).status).toBe(401);
  });

  test("survive a restart, and the database holds no usable token", () => {
    const dir = mkdtempSync(join(tmpdir(), "storbild-"));
    try {
      const path = join(dir, "storbild.db");
      const db = openDatabase(path);
      const token = new SessionStore(db, { now: () => 0 }).create();
      const stored = db.query<{ id: string }, []>("SELECT id FROM sessions").get();
      expect(stored?.id).not.toContain(token);
      db.close();
      const reopened = openDatabase(path);
      expect(new SessionStore(reopened, { now: () => 1 }).verify(token)).toBeDefined();
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("an unknown token is no session", () => {
    const store = new SessionStore(openDatabase(":memory:"), { now: () => 0 });
    expect(store.verify("forged")).toBeUndefined();
    expect(store.verify(undefined)).toBeUndefined();
  });
});

describe("protection", () => {
  test.each([
    ["GET", "/api/time"],
    ["GET", "/api/events"],
    ["POST", "/api/commands"],
    ["GET", "/api/plugins/markdown/hook"],
    ["POST", "/api/plugins/markdown/hook"],
  ])("%s %s needs a session", async (method, path) => {
    const { app } = createTestAdminApp();
    const res = await app.request(path, { method, headers: { Origin: "http://localhost" } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test.each([
    ["no", undefined],
    ["a foreign", "https://evil.example"],
  ])("a state-changing request with %s Origin is refused", async (_, origin) => {
    const { app, hub } = createTestAdminApp();
    const cookie = cookieOf(await login(app));
    const before = hub.state.revision;
    const res = await app.request("/api/commands", {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        ...(origin && { Origin: origin }),
      },
      body: JSON.stringify({ type: "live.blackout", payload: { on: true } }),
    });
    expect(res.status).toBe(403);
    expect(hub.state.revision).toBe(before);
    const form = await app.request("/login", {
      method: "POST",
      headers: origin ? { Origin: origin } : {},
      body: new URLSearchParams({ username: "admin", password: TEST_PASSWORD }),
    });
    expect(form.status).toBe(403);
  });

  test("the public URL's origin is accepted behind a proxy that changes the scheme", async () => {
    const { app } = createTestAdminApp({ publicUrl: "https://admin.example.org" });
    // Caddy terminates TLS, so the app sees http.
    const res = await login(app, {
      origin: "http://admin.example.org",
      headers: { Origin: "https://admin.example.org" },
    });
    expect(res.status).toBe(303);
  });
});
