import { expect, describe as group, test } from "bun:test";
import { z } from "zod";
import { fields } from "./fields.ts";
import { describeForm, type Field, humanize, initialValue, type JsonSchema } from "./form-model.ts";

const formOf = (schema: z.ZodType) =>
  describeForm(z.toJSONSchema(schema, { io: "input" }) as JsonSchema);

function properties(field: Field) {
  if (field.kind !== "object") throw new Error(`expected an object, got ${field.kind}`);
  return Object.fromEntries(field.properties.map(({ key, field }) => [key, field]));
}

group("describeForm", () => {
  test("maps primitives, labels and required fields", () => {
    const form = properties(
      formOf(
        z.object({
          title: z.string().optional(),
          fontScale: z.number().positive().default(1),
          count: z.number().int().min(1).max(10),
          shown: z.boolean(),
          note: z.string().meta({ title: "Footnote", description: "Small print" }),
        }),
      ),
    );
    expect(form.title).toEqual({ kind: "text", label: "Title", required: false, nullable: false });
    expect(form.fontScale).toMatchObject({
      kind: "number",
      integer: false,
      default: 1,
      required: false,
    });
    expect(form.count).toMatchObject({
      kind: "number",
      integer: true,
      minimum: 1,
      maximum: 10,
      required: true,
    });
    expect(form.shown).toMatchObject({ kind: "boolean", required: true });
    expect(form.note).toMatchObject({
      kind: "text",
      label: "Footnote",
      description: "Small print",
    });
  });

  test("uses the widget hints of the SDK field helpers, through wrappers", () => {
    const form = properties(
      formOf(
        z.object({
          body: fields.markdown(),
          accent: fields.color().optional(),
          length: fields.duration().default(5_000),
          at: fields.datetime().meta({ title: "Starts" }),
        }),
      ),
    );
    expect(form.body?.kind).toBe("markdown");
    expect(form.accent).toMatchObject({ kind: "color", required: false });
    expect(form.length).toMatchObject({ kind: "duration", default: 5_000 });
    expect(form.at).toMatchObject({ kind: "datetime", label: "Starts" });
  });

  test("enums and literal unions are selects; nullable fields are flagged", () => {
    const form = properties(
      formOf(
        z.object({
          fit: z.enum(["cover", "contain"]),
          mode: z.union([z.literal("a"), z.literal(2)]),
          caption: z.string().nullable(),
        }),
      ),
    );
    expect(form.fit).toMatchObject({
      kind: "select",
      options: [
        { value: "cover", label: "cover" },
        { value: "contain", label: "contain" },
      ],
    });
    expect(form.mode).toMatchObject({ kind: "select", options: [{ value: "a" }, { value: 2 }] });
    expect(form.caption).toMatchObject({ kind: "text", nullable: true });
  });

  test("nests objects and lists", () => {
    const form = properties(
      formOf(
        z.object({
          wifi: z.object({ ssid: z.string() }),
          slides: z.array(z.object({ text: z.string() })).max(5),
        }),
      ),
    );
    expect(properties(form.wifi as Field).ssid?.kind).toBe("text");
    const slides = form.slides as Extract<Field, { kind: "list" }>;
    expect(slides).toMatchObject({ kind: "list", maxItems: 5 });
    expect(properties(slides.items).text?.kind).toBe("text");
  });

  test("falls back to raw JSON for what a form can't show", () => {
    const form = properties(
      formOf(
        z.object({
          either: z.union([z.string(), z.number()]),
          map: z.record(z.string(), z.number()),
          tuple: z.tuple([z.string(), z.number()]),
        }),
      ),
    );
    expect(form.either?.kind).toBe("json");
    expect(form.map?.kind).toBe("json");
    expect(form.tuple?.kind).toBe("json");
  });

  test("follows local references and stops on recursion", () => {
    interface Node {
      name: string;
      children: Node[];
    }
    const node: z.ZodType<Node> = z.lazy(() =>
      z.object({ name: z.string(), children: z.array(node) }),
    );
    const form = formOf(z.object({ root: node }));
    expect(form.kind).toBe("object");
    let field: Field | undefined = properties(form).root;
    for (let i = 0; i < 40 && field?.kind === "object"; i++) {
      const children = properties(field).children;
      field = children?.kind === "list" ? children.items : children;
    }
    expect(field?.kind).toBe("json");
  });
});

test("humanize", () => {
  expect(humanize("fontScale")).toBe("Font scale");
  expect(humanize("active_from")).toBe("Active from");
  expect(humanize("qr-code")).toBe("Qr code");
});

test("initialValue fills required fields and defaults, and leaves optional ones out", () => {
  const form = formOf(
    z.object({
      title: z.string().optional(),
      content: fields.markdown(),
      scale: z.number().default(1),
      fit: z.enum(["cover", "contain"]),
      items: z.array(z.string()),
      shown: z.boolean(),
    }),
  );
  expect(initialValue(form)).toEqual({
    content: "",
    scale: 1,
    fit: "cover",
    items: [],
    shown: false,
  });
});
