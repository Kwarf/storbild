// Browser-only admin part of the SDK (DESIGN.md §6.2, ADR 0010): the form components the
// admin generates plugin forms from, which custom editors use too so they look native.
// Styled with the admin's `--sb-*` tokens, which inherit through shadow DOM.
export type { AssetMeta, Issue } from "@storbild/core";
export { accepts, SbAssetPicker } from "./admin/asset-picker.ts";
export {
  ASSET_SOURCE_REQUEST,
  type AssetSource,
  type AssetSourceRequest,
  CLOCK_REQUEST,
  type ClockRequest,
  type EditorProperties,
  type ValueChangeEvent,
} from "./admin/events.ts";
export { SbField } from "./admin/field.ts";
export { SbForm } from "./admin/form.ts";
export {
  describeForm,
  type Field,
  type FieldKind,
  humanize,
  type InitialOptions,
  initialValue,
  type JsonSchema,
} from "./form-model.ts";
