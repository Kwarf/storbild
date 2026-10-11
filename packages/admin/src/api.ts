import type { Command, Issue } from "@storbild/core";
import type { JsonSchema } from "@storbild/plugin-sdk/admin";
// biome-ignore lint/style/noRestrictedImports: a type-only import, erased from the bundle.
import type { AdminApp } from "@storbild/server";
import { hc } from "hono/client";

/** The admin API, typed from the server's admin app (DESIGN.md §5.3). */
export const api = hc<AdminApp>(location.origin);

/** Sends the operator to the login page, e.g. when the session has expired. */
export function toLogin() {
  location.assign("/login");
}

/** A command the server refused; `message` is fit to show next to the control. */
export class CommandFailed extends Error {
  override name = "CommandFailed";
  constructor(
    readonly status: number,
    message: string,
    /** Validation issues of a plugin config or settings, by path (422). */
    readonly issues: Issue[] = [],
  ) {
    super(message);
  }
}

/** The text to show for a failed action. */
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Sends a command. Throws `CommandFailed` with a readable message if it is refused. */
export async function send(
  command: Command,
): Promise<{ revision: number; id?: string | undefined }> {
  let res: Awaited<ReturnType<typeof api.api.commands.$post>>;
  try {
    res = await api.api.commands.$post({ json: command });
  } catch {
    throw new CommandFailed(0, "Can't reach the server.");
  }
  if (res.status === 200) return res.json();
  // The session middleware answers 401 before the typed handler runs.
  if ((res.status as number) === 401) {
    toLogin();
    throw new CommandFailed(401, "Your session has expired.");
  }
  const body = (await res.json().catch(() => ({}))) as {
    message?: string;
    error?: string;
    issues?: Issue[];
  };
  throw new CommandFailed(
    res.status,
    body.message ?? body.error ?? `Failed (${res.status}).`,
    res.status === 422 ? (body.issues ?? []) : [],
  );
}

/** The JSON Schemas of each usable plugin's settings and instance types (ADR 0010). */
export type Schemas = Record<string, { settings?: JsonSchema; types: Record<string, JsonSchema> }>;

/** Fetches the plugins' schemas; they change only when the server restarts. */
export async function fetchSchemas(): Promise<Schemas> {
  const res = await api.api.schemas.$get();
  if ((res.status as number) === 401) toLogin();
  if (!res.ok) throw new Error(`Failed to load plugin schemas (${res.status}).`);
  return (await res.json()) as Schemas;
}
