// Helpers and styles shared by the form components.
import type { Issue } from "@storbild/core";
import { css } from "lit";

export const changed = (target: EventTarget, value: unknown) =>
  target.dispatchEvent(new CustomEvent("change", { detail: { value } }));

export const issuesBelow = (issues: Issue[], key: string | number) =>
  issues
    .filter((issue) => issue.path[0] === key)
    .map((issue) => ({ ...issue, path: issue.path.slice(1) }));

export const fieldStyles = css`
  :host {
    display: block;
    color: var(--sb-text, inherit);
    font-size: var(--sb-text-md, 15px);
  }
  input,
  select,
  textarea,
  button {
    font: inherit;
    color: inherit;
  }
  input:not([type="checkbox"]):not([type="color"]),
  select,
  textarea {
    box-sizing: border-box;
    width: 100%;
    padding: 5px 8px;
    background: var(--sb-field, #fff);
    border: 1px solid var(--sb-line-strong, #c4bfb5);
    border-radius: var(--sb-radius, 3px);
    min-width: 0;
  }
  textarea {
    resize: vertical;
    line-height: 1.45;
  }
  textarea.code {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: var(--sb-text-sm, 13px);
  }
  input[type="checkbox"] {
    accent-color: var(--sb-accent, #145f8a);
    margin: 0;
  }
  input[type="color"] {
    width: 36px;
    height: 30px;
    padding: 2px;
    background: var(--sb-field, #fff);
    border: 1px solid var(--sb-line-strong, #c4bfb5);
    border-radius: var(--sb-radius, 3px);
    flex: none;
  }
  input[type="number"],
  .num {
    font-variant-numeric: tabular-nums;
  }
  :focus-visible {
    outline: 2px solid var(--sb-accent, #145f8a);
    outline-offset: 1px;
  }
  button {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    font-size: var(--sb-text-sm, 13px);
    font-weight: var(--sb-weight-strong, 600);
    background: var(--sb-field, #fff);
    border: 1px solid var(--sb-line-strong, #c4bfb5);
    border-radius: var(--sb-radius, 3px);
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    border-color: var(--sb-text, #1c1a17);
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .field {
    display: grid;
    gap: 4px;
  }
  .head {
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  label,
  .label {
    font-size: var(--sb-text-sm, 13px);
    font-weight: var(--sb-weight-strong, 600);
  }
  .optional,
  .description {
    color: var(--sb-muted, #67625a);
    font-size: var(--sb-text-xs, 12px);
    font-weight: var(--sb-weight, 400);
  }
  .description {
    margin: 0;
  }
  .check {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .inline {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .error {
    margin: 0;
    color: var(--sb-error, #b3261e);
    font-size: var(--sb-text-sm, 13px);
  }
  .group {
    display: grid;
    gap: 14px;
  }
  .nested {
    padding-left: 12px;
    border-left: 1px solid var(--sb-line, #dedad2);
  }
  .list {
    display: grid;
    gap: 0;
    border-top: 1px solid var(--sb-line, #dedad2);
  }
  .item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid var(--sb-line, #dedad2);
  }
  .item .actions {
    display: flex;
    gap: 4px;
    align-items: flex-start;
  }
  .add {
    justify-self: start;
    margin-top: 8px;
  }
`;
