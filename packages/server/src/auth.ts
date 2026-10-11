import type { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";

const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest();

export interface SessionStoreOptions {
  now: () => number;
  /** A session expires this long after it was last used. */
  ttlMs?: number;
  /** A session's expiry is pushed back at most this often, to keep writes rare. */
  refreshMs?: number;
}

/**
 * Admin sessions in SQLite (DESIGN.md §8.1, ADR 0007). The cookie holds a random token; the
 * table holds only its SHA-256, so a copy of the database can't be used to log in.
 */
export class SessionStore {
  readonly #db: Database;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #refreshMs: number;

  constructor(
    db: Database,
    { now, ttlMs = 7 * 24 * 3_600_000, refreshMs = 3_600_000 }: SessionStoreOptions,
  ) {
    this.#db = db;
    this.#now = now;
    this.#ttlMs = ttlMs;
    this.#refreshMs = refreshMs;
  }

  /** Starts a session and returns its token. Expired sessions are pruned here. */
  create(): string {
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const now = this.#now();
    this.#db.run("DELETE FROM sessions WHERE expires_at <= ?", [now]);
    this.#db.run("INSERT INTO sessions (id, expires_at) VALUES (?, ?)", [
      sha256(token).toString("hex"),
      now + this.#ttlMs,
    ]);
    return token;
  }

  /**
   * Checks that the token belongs to a live session, or returns undefined. Using a session
   * extends it; `refreshed` says the expiry moved, so the cookie can be renewed too.
   */
  verify(token: string | undefined): { refreshed: boolean } | undefined {
    if (!token) return undefined;
    const id = sha256(token).toString("hex");
    const row = this.#db
      .query<{ expires_at: number }, [string]>("SELECT expires_at FROM sessions WHERE id = ?")
      .get(id);
    const now = this.#now();
    if (!row || row.expires_at <= now) return undefined;
    const expiresAt = now + this.#ttlMs;
    const refreshed = expiresAt - row.expires_at >= this.#refreshMs;
    if (refreshed) this.#db.run("UPDATE sessions SET expires_at = ? WHERE id = ?", [expiresAt, id]);
    return { refreshed };
  }

  /** How long a session lives after its last use. */
  get ttlMs(): number {
    return this.#ttlMs;
  }

  delete(token: string | undefined) {
    if (token) this.#db.run("DELETE FROM sessions WHERE id = ?", [sha256(token).toString("hex")]);
  }
}

export interface LoginLimiterOptions {
  now: () => number;
  /** Failed attempts allowed per client within `windowMs`. */
  maxFailures?: number;
  windowMs?: number;
}

/**
 * Limits failed logins per client. Counting per client rather than globally means an attacker
 * can't lock the crew out.
 */
export class LoginLimiter {
  readonly #now: () => number;
  readonly #maxFailures: number;
  readonly #windowMs: number;
  readonly #failures = new Map<string, { count: number; resetAt: number }>();

  constructor({ now, maxFailures = 5, windowMs = 5 * 60_000 }: LoginLimiterOptions) {
    this.#now = now;
    this.#maxFailures = maxFailures;
    this.#windowMs = windowMs;
  }

  /** Milliseconds until the client may try again, or 0 if it may now. */
  retryAfter(client: string): number {
    const entry = this.#entry(client);
    return entry && entry.count >= this.#maxFailures ? entry.resetAt - this.#now() : 0;
  }

  fail(client: string) {
    const entry = this.#entry(client);
    if (entry) entry.count++;
    else this.#failures.set(client, { count: 1, resetAt: this.#now() + this.#windowMs });
  }

  succeed(client: string) {
    this.#failures.delete(client);
  }

  #entry(client: string) {
    const now = this.#now();
    for (const [key, entry] of this.#failures) {
      if (entry.resetAt <= now) this.#failures.delete(key);
    }
    return this.#failures.get(client);
  }
}

/** Compares two strings in time independent of where they differ. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

const loopback = /^(?:127\.|::1$|::ffff:127\.)/;

/**
 * The client a request comes from: the socket address, or the first `X-Forwarded-For` hop
 * when the socket is loopback, i.e. the request came through the local reverse proxy.
 */
export function clientOf(request: Request, socketAddress: string | undefined): string {
  if (socketAddress === undefined) return "unknown";
  if (!loopback.test(socketAddress)) return socketAddress;
  const forwarded = request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim();
  return forwarded || socketAddress;
}

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Whether a request may change state: safe methods always, others only with an `Origin` of
 * the admin's public URL or the request's own origin. Browsers always send `Origin` on such
 * requests; other clients must set it.
 */
export function originAllowed(request: Request, publicOrigin: string): boolean {
  if (safeMethods.has(request.method)) return true;
  const origin = request.headers.get("Origin");
  return origin !== null && (origin === publicOrigin || origin === new URL(request.url).origin);
}
