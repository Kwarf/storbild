import { describe, expect, test } from "bun:test";
import { assetUsers, referencedAssetIds } from "./assets.ts";
import { createInitialState, type ShowState } from "./schema/state.ts";

const id = "a".repeat(64);

function stateWith(changes: Partial<ShowState>): ShowState {
  return { ...createInitialState({ now: 0, newId: () => "theme" }), ...changes };
}

const instance = (name: string, rest: object) => ({
  id: name,
  plugin: "p",
  type: "t",
  name,
  configVersion: 1,
  config: {},
  ...rest,
});

describe("assetUsers", () => {
  test("finds the ID anywhere in an instance config, or as its background", () => {
    const state = stateWith({
      instances: {
        list: instance("list", { config: { images: [{ src: id }] } }),
        bg: instance("bg", { background: { assetId: id, fit: "contain" } }),
        other: instance("other", { config: { text: `${id}!`, n: 1 } }),
      },
    });
    expect(assetUsers(state, id).map((user) => user.id)).toEqual(["list", "bg"]);
  });

  test("finds themes that use the asset as background or font", () => {
    const base = stateWith({});
    const theme = base.themes.theme;
    if (!theme) throw new Error("no theme");
    const state = stateWith({
      themes: {
        image: { ...theme, id: "image", background: { type: "image", assetId: id, fit: "cover" } },
        font: {
          ...theme,
          id: "font",
          fonts: {
            ...theme.fonts,
            mono: { family: "M", faces: [{ assetId: id, weight: 400, style: "normal" }] },
          },
        },
        plain: theme,
      },
    });
    expect(assetUsers(state, id)).toEqual([
      { kind: "theme", id: "image", name: theme.name },
      { kind: "theme", id: "font", name: theme.name },
    ]);
  });
});

describe("referencedAssetIds", () => {
  const meta = (assetId: string) => ({
    id: assetId,
    name: assetId,
    mimeType: "image/png",
    size: 1,
    createdAt: 0,
  });

  test("lists the show's assets that instances and themes use, and nothing else", () => {
    const used = "b".repeat(64);
    const font = "c".repeat(64);
    const unused = "d".repeat(64);
    const base = stateWith({});
    const theme = base.themes.theme;
    if (!theme) throw new Error("no theme");
    const state = stateWith({
      assets: { [id]: meta(id), [used]: meta(used), [font]: meta(font), [unused]: meta(unused) },
      instances: {
        list: instance("list", { config: { images: [id], gone: "e".repeat(64) } }),
        bg: instance("bg", { background: { assetId: used, fit: "cover" } }),
      },
      themes: {
        theme: {
          ...theme,
          fonts: {
            ...theme.fonts,
            body: { family: "B", faces: [{ assetId: font, weight: 400, style: "normal" }] },
          },
        },
      },
    });
    expect([...referencedAssetIds(state)].sort()).toEqual([id, used, font].sort());
  });
});
