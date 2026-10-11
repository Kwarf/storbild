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
