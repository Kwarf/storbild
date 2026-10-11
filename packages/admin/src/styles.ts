import { css } from "lit";

/** Controls shared by the admin's components. Colours and sizes come from the tokens. */
export const controls = css`
  :host {
    font-size: var(--sb-text-md);
  }
  button,
  input,
  select {
    font: inherit;
    color: inherit;
  }
  button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    font-weight: var(--sb-weight-strong);
    font-size: var(--sb-text-sm);
    background: var(--sb-field);
    border: 1px solid var(--sb-line-strong);
    border-radius: var(--sb-radius);
    cursor: pointer;
    white-space: nowrap;
  }
  button:hover:not(:disabled) {
    border-color: var(--sb-text);
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  button.primary {
    color: var(--sb-accent-text);
    background: var(--sb-accent);
    border-color: var(--sb-accent);
  }
  button.primary:hover:not(:disabled) {
    border-color: var(--sb-text);
  }
  input[type="text"],
  select {
    padding: 5px 8px;
    background: var(--sb-field);
    border: 1px solid var(--sb-line-strong);
    border-radius: var(--sb-radius);
    min-width: 0;
  }
  input[type="checkbox"] {
    accent-color: var(--sb-accent);
    margin: 0;
  }
  :focus-visible {
    outline: 2px solid var(--sb-accent);
    outline-offset: 1px;
  }
  .num {
    font-variant-numeric: tabular-nums;
  }
  .muted {
    color: var(--sb-muted);
  }
  .error {
    color: var(--sb-error);
    font-size: var(--sb-text-sm);
  }
`;

/** The layout of a content page: heading, hint, and sections divided by hairlines. */
export const page = css`
  :host {
    display: block;
    padding: 20px 24px 40px;
  }
  h1 {
    font-size: var(--sb-text-xl);
    font-weight: var(--sb-weight-strong);
    margin: 0 0 4px;
    letter-spacing: -0.01em;
  }
  h2 {
    font-size: var(--sb-text-lg);
    font-weight: var(--sb-weight-strong);
    margin: 0;
  }
  .hint {
    color: var(--sb-muted);
    font-size: var(--sb-text-sm);
    margin: 2px 0 12px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .badge {
    display: inline-block;
    padding: 0 6px;
    border-radius: var(--sb-radius);
    font-size: var(--sb-text-xs);
    font-weight: var(--sb-weight-strong);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    border: 1px solid currentColor;
    line-height: 18px;
    white-space: nowrap;
  }
  .badge.live {
    color: var(--sb-live);
  }
  .badge.scheduled {
    color: var(--sb-scheduled);
  }
  .badge.error {
    color: var(--sb-error);
  }
  .badge.muted {
    color: var(--sb-muted);
  }
  .notice {
    margin: 0;
    padding: 8px 10px;
    border-left: 3px solid var(--sb-error);
    background: var(--sb-bg-sunken);
    font-size: var(--sb-text-sm);
  }
  .notice.info {
    border-left-color: var(--sb-line-strong);
  }
  button.danger {
    color: var(--sb-error);
  }
  label.field {
    display: grid;
    gap: 4px;
    font-size: var(--sb-text-sm);
    font-weight: var(--sb-weight-strong);
  }
  label.field input {
    font-size: var(--sb-text-md);
    font-weight: var(--sb-weight);
  }
`;
