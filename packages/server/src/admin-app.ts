import { zValidator } from "@hono/zod-validator";
import { adminPage, loginPage, shellPaths } from "@storbild/admin";
import { type Command, CommandError, commandRequestSchema } from "@storbild/core";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AdminBundle } from "./admin-page.ts";
import { createBundleRoutes } from "./app-bundle.ts";
import { type AssetStore, createAssetRoutes, MAX_THUMBNAIL_BYTES } from "./assets.ts";
import {
  clientOf,
  type LoginLimiter,
  originAllowed,
  type SessionStore,
  safeEqual,
} from "./auth.ts";
import type { PluginSchemas } from "./plugins/load.ts";
import { createModuleRoutes, type ModuleRegistry } from "./plugins/routes.ts";
import { type StreamOptions, streamState } from "./sse.ts";
import { RevisionConflictError, type StateHub } from "./state-hub.ts";

export interface AdminAuth {
  username: string;
  passwordHash: string;
  /** The admin's public URL. Its origin is trusted, and https makes the cookie Secure. */
  publicUrl: string;
  sessions: SessionStore;
  limiter: LoginLimiter;
}

export interface AdminAppDeps {
  hub: StateHub;
  now: () => number;
  auth: AdminAuth;
  stream?: StreamOptions;
  /** Plugin modules, also served here for the admin's preview and custom editors. */
  modules?: ModuleRegistry;
  /** The admin page's bundle. Without it, the shell paths are a 404. */
  bundle?: AdminBundle;
  /** Handles plugin routes under `/api/plugins/<id>/`. */
  plugins?: { handle(id: string, request: Request): Promise<Response | undefined> };
  /** The JSON Schemas of each usable plugin's settings and types, for generated forms. */
  schemas?: Record<string, PluginSchemas>;
  /** Uploaded files, served here for the preview and stored by `POST /api/assets`. */
  assets?: AssetStore;
  /** The largest upload, in bytes. */
  maxUploadBytes?: number;
}

/**
 * Bun passes its server as the second argument to `fetch`, which tells the client address.
 * It is absent in `app.request()` tests.
 */
interface Env {
  Bindings: { requestIP?(request: Request): { address: string } | null };
}

/**
 * The operator-facing app: login, the admin shell, `/api/commands`, `/api/events`. Everything
 * under `/api/` needs a session (DESIGN.md §8.1, ADR 0007). Bundles, fonts and plugin modules
 * are public, as they are on the viewer app.
 */
export function createAdminApp({
  hub,
  now,
  auth,
  stream,
  modules,
  bundle,
  plugins,
  schemas = {},
  assets,
  maxUploadBytes = 25 * 1024 * 1024,
}: AdminAppDeps) {
  const { sessions, limiter } = auth;
  const secure = new URL(auth.publicUrl).protocol === "https:";
  const publicOrigin = new URL(auth.publicUrl).origin;
  // `__Host-` makes the browser enforce Secure, Path=/ and no Domain: a host-only cookie.
  const cookie = secure ? "__Host-storbild_session" : "storbild_session";
  const fontBase = bundle ? `/app/${bundle.hash}/fonts/` : "/fonts/";

  /** Whether the request has a live session; renews the cookie when the session was extended. */
  const hasSession = (c: Context) => {
    const token = getCookie(c, cookie);
    const session = sessions.verify(token);
    if (session?.refreshed && token) setSessionCookie(c, token);
    return session !== undefined;
  };
  const setSessionCookie = (c: Context, token: string) =>
    setCookie(c, cookie, token, {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/",
      maxAge: Math.floor(sessions.ttlMs / 1000),
    });
  const login = (c: Context, status: 200 | 401 | 429, username?: string, error?: string) => {
    c.header("Cache-Control", "no-store");
    return c.html(
      loginPage({ fontBase, ...(username && { username }), ...(error && { error }) }),
      status,
    );
  };

  const tooLarge = (c: Context) =>
    c.json(
      {
        error: "too_large" as const,
        message: `Files can be at most ${Math.round(maxUploadBytes / (1024 * 1024))} MB.`,
      },
      413,
    );

  const app = new Hono<Env>();
  // Browsers send Origin on every state-changing request; a foreign one is a cross-site forgery.
  app.use(async (c, next) => {
    if (!originAllowed(c.req.raw, publicOrigin)) return c.json({ error: "forbidden_origin" }, 403);
    await next();
  });
  app.use("/api/*", async (c, next) => {
    if (!hasSession(c)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  if (modules) app.route("/", createModuleRoutes(modules));
  if (assets) app.route("/", createAssetRoutes(assets, { thumbnails: true }));
  if (bundle) {
    app.route("/", createBundleRoutes(bundle));
    const html = adminPage({
      script: `/app/${bundle.hash}/admin.js`,
      importMap: modules?.importMap ?? { imports: {} },
      fontBase,
    });
    for (const path of shellPaths) {
      app.get(path, (c) => {
        if (!hasSession(c)) return c.redirect("/login");
        c.header("Cache-Control", "no-store");
        return c.html(html);
      });
    }
  }

  return (
    app
      .get("/login", (c) => (hasSession(c) ? c.redirect("/") : login(c, 200)))
      .post("/login", async (c) => {
        const client = clientOf(
          c.req.raw,
          (c.env as Env["Bindings"] | undefined)?.requestIP?.(c.req.raw)?.address,
        );
        const wait = limiter.retryAfter(client);
        if (wait > 0) {
          const minutes = Math.ceil(wait / 60_000);
          c.header("Retry-After", String(Math.ceil(wait / 1000)));
          return login(
            c,
            429,
            undefined,
            `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
          );
        }
        const form = await c.req.parseBody();
        const username = typeof form.username === "string" ? form.username : "";
        const password = typeof form.password === "string" ? form.password : "";
        // Both checks always run, so the response time doesn't reveal a valid username.
        const userOk = safeEqual(username, auth.username);
        const passwordOk = await Bun.password
          .verify(password, auth.passwordHash)
          .catch(() => false);
        if (!userOk || !passwordOk) {
          limiter.fail(client);
          return login(c, 401, username, "Wrong username or password.");
        }
        limiter.succeed(client);
        setSessionCookie(c, sessions.create());
        return c.redirect("/", 303);
      })
      .post("/logout", (c) => {
        sessions.delete(getCookie(c, cookie));
        deleteCookie(c, cookie, { path: "/", secure });
        return c.redirect("/login", 303);
      })
      .all("/api/plugins/:id/*", async (c) => {
        const id = c.req.param("id");
        // The plugin sees paths relative to its prefix.
        const url = new URL(c.req.url);
        url.pathname = url.pathname.slice(`/api/plugins/${id}`.length) || "/";
        const response = await plugins?.handle(id, new Request(url.href, c.req.raw));
        return response ?? c.json({ error: "not_found" }, 404);
      })
      // Plugins only change on restart, but a reload must not keep a stale copy.
      .get("/api/schemas", (c) => {
        c.header("Cache-Control", "no-store");
        return c.json(schemas);
      })
      .get("/api/time", (c) => {
        c.header("Cache-Control", "no-store");
        return c.json({ now: now() });
      })
      .get("/api/events", (c) => streamState(c, hub, stream))
      // Multipart: `file`, and optionally `name` and a WebP `thumbnail` made by the admin.
      .post(
        "/api/assets",
        bodyLimit({
          maxSize: maxUploadBytes + MAX_THUMBNAIL_BYTES + 64 * 1024,
          onError: tooLarge,
        }),
        async (c) => {
          if (!assets)
            return c.json({ error: "not_found" as const, message: "no asset store" }, 404);
          const form = await c.req.formData().catch(() => undefined);
          const file = form?.get("file");
          if (!(file instanceof Blob)) {
            return c.json({ error: "invalid_upload" as const, message: "no file was sent" }, 400);
          }
          if (file.size > maxUploadBytes) return tooLarge(c);
          const name = form?.get("name");
          const thumbnail = form?.get("thumbnail");
          const result = await assets.upload(
            file,
            typeof name === "string" ? name : file instanceof File ? file.name : "",
            thumbnail instanceof Blob ? thumbnail : undefined,
          );
          if (!result.ok) return c.json({ error: result.error, message: result.message }, 415);
          return c.json(result.asset, 200);
        },
      )
      .post(
        "/api/commands",
        zValidator("json", commandRequestSchema, (result, c) => {
          if (!result.success) {
            return c.json({ error: "invalid_command", issues: result.error.issues }, 400);
          }
        }),
        (c) => {
          const { expectedRevision, ...command } = c.req.valid("json");
          try {
            return c.json(hub.dispatch(command as Command, expectedRevision), 200);
          } catch (error) {
            if (error instanceof RevisionConflictError) {
              return c.json({ error: "revision_conflict", revision: error.revision }, 409);
            }
            if (error instanceof CommandError) {
              return c.json(
                {
                  error: error.code,
                  message: error.message,
                  ...(error.issues && { issues: error.issues }),
                },
                error.code === "not_found" ? 404 : 422,
              );
            }
            throw error;
          }
        },
      )
  );
}

/** The admin app's type, for the admin's typed `hc` client. */
export type AdminApp = ReturnType<typeof createAdminApp>;
