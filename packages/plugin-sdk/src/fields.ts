// Field helpers for config and settings schemas (ADR 0010). Each is a plain Zod schema tagged
// with a widget hint, which `z.toJSONSchema()` carries into the admin's generated forms.
import { z } from "zod";

/** The JSON Schema keyword that names a field's admin widget. */
export const WIDGET_KEY = "x-storbild-widget";

export type Widget = "markdown" | "color" | "duration" | "datetime";

const tagged = <T extends z.ZodType>(schema: T, widget: Widget): T =>
  schema.meta({ [WIDGET_KEY]: widget });

export const fields = {
  /** Markdown text, edited in a multi-line field. */
  markdown: () => tagged(z.string(), "markdown"),
  /** A colour as `#rrggbb`. */
  color: () =>
    tagged(z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a colour like #ff8800"), "color"),
  /** A duration in milliseconds, entered as seconds or m:ss. */
  duration: () => tagged(z.number().int().positive(), "duration"),
  /** A point in time as epoch milliseconds (server time), entered in local time. */
  datetime: () => tagged(z.number().int(), "datetime"),
};
