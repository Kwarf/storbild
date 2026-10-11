// Turns the JSON Schema of a config or settings schema into a tree of form fields (ADR 0010).
// No DOM: the admin's form components render the tree, and tests check it directly.
import { ACCEPT_KEY, WIDGET_KEY } from "./fields.ts";

export type JsonSchema = { [key: string]: unknown };

interface FieldBase {
  label: string;
  description?: string;
  /** Must be present in the parent object; optional fields can be left blank. */
  required: boolean;
  /** `null` is a valid value. */
  nullable: boolean;
  /** Shown in an empty text or number input, such as the value used when it is left blank. */
  placeholder?: string;
  default?: unknown;
}

export type Field = FieldBase &
  (
    | { kind: "text" | "markdown" | "color" | "duration" | "datetime" | "boolean" }
    | { kind: "number"; integer: boolean; minimum?: number; maximum?: number }
    | { kind: "select"; options: { value: unknown; label: string }[] }
    /** An asset ID, limited to MIME types like `image/*` when `accept` is given. */
    | { kind: "asset"; accept?: string[] }
    | { kind: "object"; properties: { key: string; field: Field }[] }
    | { kind: "list"; items: Field; minItems?: number; maxItems?: number }
    /** Anything the form can't represent, edited as raw JSON. */
    | { kind: "json" }
  );

export type FieldKind = Field["kind"];

/** `fontScale` → `Font scale`. */
export function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const isObject = (value: unknown): value is JsonSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Zod writes the safe-integer range for every `.int()`; it says nothing to an operator. */
const bound = (value: unknown) =>
  typeof value === "number" && Math.abs(value) < Number.MAX_SAFE_INTEGER ? value : undefined;

const widgets = new Set(["markdown", "color", "duration", "datetime", "asset"]);

/** Describes a whole form: the root schema of a config or settings value. */
export function describeForm(schema: JsonSchema): Field {
  return describe(schema, { root: schema, label: "", required: true, depth: 0 });
}

interface Context {
  root: JsonSchema;
  label: string;
  required: boolean;
  depth: number;
}

function describe(input: JsonSchema, ctx: Context): Field {
  // Local references only, with a depth limit for recursive schemas.
  let schema = input;
  if (typeof schema.$ref === "string") {
    const target = resolveRef(ctx.root, schema.$ref);
    if (!target || ctx.depth > 16) return json(input, ctx, false);
    const { $ref: _, ...rest } = schema;
    schema = { ...target, ...rest };
  }

  // `T | null`, as `anyOf` or a type list.
  let nullable = false;
  if (Array.isArray(schema.anyOf)) {
    const options = schema.anyOf.filter(isObject);
    const nonNull = options.filter((option) => option.type !== "null");
    if (nonNull.length === 1 && options.length === 2) {
      const { anyOf: _, ...rest } = schema;
      schema = { ...(nonNull[0] as JsonSchema), ...rest };
      nullable = true;
    }
  }
  let type = schema.type;
  if (Array.isArray(type)) {
    nullable ||= type.includes("null");
    const rest = type.filter((t) => t !== "null");
    type = rest.length === 1 ? rest[0] : rest;
  }

  const base: FieldBase = {
    label: typeof schema.title === "string" ? schema.title : ctx.label,
    required: ctx.required,
    nullable,
    ...(typeof schema.description === "string" && { description: schema.description }),
    ...("default" in schema && { default: schema.default }),
  };

  const options = selectOptions(schema);
  if (options) return { ...base, kind: "select", options };

  const widget = schema[WIDGET_KEY];
  if (typeof widget === "string" && widgets.has(widget)) {
    const expected =
      widget === "duration" || widget === "datetime" ? ["integer", "number"] : ["string"];
    if (expected.includes(type as string)) {
      if (widget === "asset") {
        const accept = schema[ACCEPT_KEY];
        const types = Array.isArray(accept) ? accept.filter((t) => typeof t === "string") : [];
        return { ...base, kind: "asset", ...(types.length > 0 && { accept: types }) };
      }
      return { ...base, kind: widget as "markdown" | "color" | "duration" | "datetime" };
    }
  }

  switch (type) {
    case "string":
      return { ...base, kind: "text" };
    case "boolean":
      return { ...base, kind: "boolean" };
    case "number":
    case "integer": {
      const minimum = bound(schema.minimum) ?? bound(schema.exclusiveMinimum);
      const maximum = bound(schema.maximum) ?? bound(schema.exclusiveMaximum);
      return {
        ...base,
        kind: "number",
        integer: type === "integer",
        ...(minimum !== undefined && { minimum }),
        ...(maximum !== undefined && { maximum }),
      };
    }
    case "object": {
      if (!isObject(schema.properties) || isObject(schema.additionalProperties)) {
        return json(schema, ctx, nullable, base);
      }
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      return {
        ...base,
        kind: "object",
        properties: Object.entries(schema.properties).flatMap(([key, value]) =>
          isObject(value)
            ? [
                {
                  key,
                  field: describe(value, {
                    root: ctx.root,
                    label: humanize(key),
                    required: required.has(key),
                    depth: ctx.depth + 1,
                  }),
                },
              ]
            : [],
        ),
      };
    }
    case "array": {
      if (!isObject(schema.items)) return json(schema, ctx, nullable, base);
      const minItems = bound(schema.minItems);
      const maxItems = bound(schema.maxItems);
      return {
        ...base,
        kind: "list",
        items: describe(schema.items, {
          root: ctx.root,
          label: "Item",
          required: true,
          depth: ctx.depth + 1,
        }),
        ...(minItems !== undefined && { minItems }),
        ...(maxItems !== undefined && { maxItems }),
      };
    }
    default:
      return json(schema, ctx, nullable, base);
  }
}

function json(schema: JsonSchema, ctx: Context, nullable: boolean, base?: FieldBase): Field {
  return {
    ...(base ?? {
      label: typeof schema.title === "string" ? schema.title : ctx.label,
      required: ctx.required,
      nullable,
    }),
    kind: "json",
  };
}

/** An `enum`, or a union of `const`s. */
function selectOptions(schema: JsonSchema): { value: unknown; label: string }[] | undefined {
  const label = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => ({ value, label: label(value) }));
  }
  if ("const" in schema) return [{ value: schema.const, label: label(schema.const) }];
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union) && union.length > 0 && union.every((o) => isObject(o) && "const" in o)) {
    return (union as JsonSchema[]).map((option) => ({
      value: option.const,
      label: typeof option.title === "string" ? option.title : label(option.const),
    }));
  }
  return undefined;
}

function resolveRef(root: JsonSchema, ref: string): JsonSchema | undefined {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    if (!isObject(node)) return undefined;
    node = node[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return isObject(node) ? node : undefined;
}

/**
 * A starting value for a field: its default, else an empty value of its kind for required
 * fields, else `undefined` (left out).
 */
export function initialValue(field: Field): unknown {
  if (field.default !== undefined) return structuredClone(field.default);
  if (!field.required) return undefined;
  switch (field.kind) {
    case "object":
      return Object.fromEntries(
        field.properties.flatMap(({ key, field: child }) => {
          const value = initialValue(child);
          return value === undefined ? [] : [[key, value]];
        }),
      );
    case "list":
      return [];
    case "text":
    case "markdown":
    case "asset":
      return "";
    case "boolean":
      return false;
    case "select":
      return field.options[0]?.value;
    default:
      return field.nullable ? null : undefined;
  }
}
