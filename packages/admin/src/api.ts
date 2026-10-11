import type { Command } from "@storbild/core";
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
  ) {
    super(message);
  }
}

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
  const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  throw new CommandFailed(res.status, body.message ?? body.error ?? `Failed (${res.status}).`);
}
