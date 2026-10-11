// Pure helpers for the Theme page (ADR 0014). No DOM, so they're unit-tested.
import type { FontRef, Instance, ShowState, Theme, ThemeBackground } from "@storbild/core";
import type { Field } from "@storbild/plugin-sdk/admin";

/** A theme being edited: absent `id` for one not created yet. */
export type ThemeDraft = Omit<Theme, "id"> & { id?: string };

/** The ID the preview gives a theme that hasn't been created yet. */
export const DRAFT_THEME_ID = "draft-theme";

const field = <F extends Field>(f: F) => f;
const required = { required: true, nullable: false } as const;
const optional = { required: false, nullable: false } as const;

export const backgroundTypes = [
  { type: "color", label: "Colour" },
  { type: "image", label: "Image" },
  { type: "video", label: "Video" },
  { type: "scene", label: "Scene" },
] as const satisfies readonly { type: ThemeBackground["type"]; label: string }[];

const dim = field({
  kind: "number",
  integer: false,
  minimum: 0,
  maximum: 1,
  label: "Dim",
  description: "A black wash over it, from 0 (none) to 1 (black), so text stays readable.",
  ...optional,
});

/** The fields of a background of one type, without its `type`. */
export function backgroundField(state: ShowState, type: ThemeBackground["type"]): Field {
  const properties: { key: string; field: Field }[] = [];
  switch (type) {
    case "color":
      properties.push({ key: "color", field: { kind: "color", label: "Colour", ...required } });
      break;
    case "image":
      properties.push(
        {
          key: "assetId",
          field: { kind: "asset", accept: ["image/*"], label: "Image", ...required },
        },
        {
          key: "fit",
          field: {
            kind: "select",
            label: "Fit",
            options: [
              { value: "cover", label: "Fill the screen" },
              { value: "contain", label: "Show it whole" },
            ],
            ...required,
          },
        },
        { key: "dim", field: dim },
      );
      break;
    case "video":
      properties.push(
        {
          key: "assetId",
          field: {
            kind: "asset",
            accept: ["video/*"],
            label: "Video",
            description: "Plays muted, in a loop, filling the screen.",
            ...required,
          },
        },
        { key: "dim", field: dim },
      );
      break;
    case "scene":
      properties.push({
        key: "instanceId",
        field: {
          kind: "select",
          label: "Scene",
          description: "A scene from the Library, drawn behind everything.",
          options: sceneInstances(state).map((instance) => ({
            value: instance.id,
            label: instance.name,
          })),
          ...required,
        },
      });
      break;
  }
  return { kind: "object", label: "", properties, ...required };
}

/** The instances that can be a background: playable scenes, by name. */
export function sceneInstances(state: ShowState): Instance[] {
  return Object.values(state.instances)
    .filter(
      (instance) =>
        instance.error === undefined &&
        state.plugins[instance.plugin]?.types[instance.type]?.kind === "scene",
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A new background of a type, keeping what carries over from the old one. */
export function switchBackground(
  state: ShowState,
  old: ThemeBackground,
  type: ThemeBackground["type"],
): ThemeBackground {
  if (old.type === type) return old;
  const dimOf = "dim" in old && old.dim !== undefined ? { dim: old.dim } : {};
  switch (type) {
    case "color":
      return { type, color: "#000000" };
    case "image":
      return { type, assetId: "", fit: "cover", ...dimOf };
    case "video":
      return { type, assetId: "", ...dimOf };
    case "scene":
      return { type, instanceId: sceneInstances(state)[0]?.id ?? "" };
  }
}

const weights = [100, 200, 300, 400, 500, 600, 700, 800, 900];
const weightNames: Record<number, string> = {
  100: "Thin",
  200: "Extra light",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semibold",
  700: "Bold",
  800: "Extra bold",
  900: "Black",
};

function fontField(label: string, description: string, isRequired: boolean): Field {
  return {
    kind: "object",
    label,
    description,
    properties: [
      {
        key: "family",
        field: {
          kind: "text",
          label: "Family",
          description:
            "Without files, a font the screens have, such as sans-serif. With files, a name for them.",
          ...(isRequired ? required : optional),
        },
      },
      {
        key: "faces",
        field: {
          kind: "list",
          label: "Files",
          description: "woff2 files, one per weight and style.",
          items: {
            kind: "object",
            label: "",
            properties: [
              {
                key: "assetId",
                field: { kind: "asset", accept: ["font/woff2"], label: "File", ...required },
              },
              {
                key: "weight",
                field: {
                  kind: "select",
                  label: "Weight",
                  options: weights.map((w) => ({ value: w, label: `${w} ${weightNames[w]}` })),
                  default: 400,
                  ...required,
                },
              },
              {
                key: "style",
                field: {
                  kind: "select",
                  label: "Style",
                  options: [
                    { value: "normal", label: "Upright" },
                    { value: "italic", label: "Italic" },
                  ],
                  default: "normal",
                  ...required,
                },
              },
            ],
            ...required,
          },
          ...optional,
        },
      },
    ],
    ...(isRequired ? required : optional),
  };
}

/** The colours, fonts and layout of a theme, edited with the SDK's form components. */
export const themeFields: { key: "colors" | "fonts" | "layout"; label: string; field: Field }[] = [
  {
    key: "colors",
    label: "Colours",
    field: {
      kind: "object",
      label: "",
      properties: [
        { key: "text", field: { kind: "color", label: "Text", ...required } },
        {
          key: "muted",
          field: { kind: "color", label: "Muted", description: "Secondary text.", ...required },
        },
        {
          key: "accent",
          field: {
            kind: "color",
            label: "Accent",
            description: "Highlights and headings.",
            ...required,
          },
        },
        {
          key: "surface",
          field: {
            kind: "color",
            label: "Surface",
            description: "Panels drawn over the background, like widgets and announcements.",
            ...required,
          },
        },
      ],
      ...required,
    },
  },
  {
    key: "fonts",
    label: "Fonts",
    field: {
      kind: "object",
      label: "",
      properties: [
        { key: "heading", field: fontField("Headings", "Titles and big numbers.", true) },
        { key: "body", field: fontField("Body", "Running text.", true) },
        { key: "mono", field: fontField("Monospace", "Code and fixed-width text.", false) },
      ],
      ...required,
    },
  },
  {
    key: "layout",
    label: "Layout",
    field: {
      kind: "object",
      label: "",
      properties: [
        {
          key: "safeArea",
          field: {
            kind: "number",
            integer: true,
            minimum: 0,
            maximum: 400,
            label: "Safe area (px)",
            description: "Space kept clear at the screen's edges, on the 1920×1080 canvas.",
            placeholder: "96",
            ...optional,
          },
        },
        {
          key: "gap",
          field: {
            kind: "number",
            integer: true,
            minimum: 0,
            maximum: 200,
            label: "Widget gap (px)",
            description: "Space between overlay widgets.",
            placeholder: "24",
            ...optional,
          },
        },
      ],
      ...required,
    },
  },
];

/** A theme's values as the Theme page edits them. */
export function draftOf(theme: Theme): ThemeDraft {
  return structuredClone(theme);
}

/** A copy of a theme to start a new one from. */
export function duplicateOf(theme: Theme | ThemeDraft): ThemeDraft {
  const { id: _, ...rest } = structuredClone(theme);
  return { ...rest, name: `${theme.name} copy` };
}

/** Drops a font's empty family and file rows; an unused monospace font is left out. */
function cleanFont(font: FontRef | undefined): FontRef | undefined {
  if (!font) return undefined;
  const faces = (font.faces ?? []).filter((face) => face.assetId);
  if (!font.family.trim() && faces.length === 0) return undefined;
  return { family: font.family.trim(), ...(faces.length > 0 && { faces }) };
}

/** The draft as a command payload: `theme.create`'s, or `theme.update`'s with its ID. */
export function themePayload(draft: ThemeDraft) {
  const heading = cleanFont(draft.fonts.heading) ?? { family: "" };
  const body = cleanFont(draft.fonts.body) ?? { family: "" };
  const mono = cleanFont(draft.fonts.mono);
  return {
    name: draft.name.trim(),
    background: draft.background,
    fonts: { heading, body, ...(mono && { mono }) },
    colors: draft.colors,
    safeArea: draft.safeArea ?? null,
    gap: draft.gap ?? null,
    customCss: draft.customCss?.trim() ? draft.customCss : null,
  };
}

/**
 * The state the Theme preview renders: the live show with the draft as its active theme, so
 * it shows what is on air in the new look. With nothing on air, `sample` is shown, if given.
 */
export function themePreviewState(
  state: ShowState,
  draft: ThemeDraft,
  sample?: Instance,
): ShowState {
  const id = draft.id ?? DRAFT_THEME_ID;
  const theme: Theme = { ...draft, id };
  const preview: ShowState = {
    ...state,
    themes: { ...state.themes, [id]: theme },
    activeThemeId: id,
  };
  if (!sample || state.timeline.main || state.timeline.interrupt) return preview;
  return {
    ...preview,
    instances: { ...state.instances, [sample.id]: sample },
    playlist: { items: [], anchorAt: 0 },
    cues: [],
    live: { main: { instanceId: sample.id, startedAt: 0 }, blackout: false },
  };
}
