import { Marked } from "marked";

const markdown = new Marked({ gfm: true, breaks: true, async: false });

/**
 * Renders markdown to HTML. The result is not sanitized: raw HTML passes through, and the viewer
 * cleans it with DOMPurify before it reaches the page (ADR 0015).
 */
export function renderMarkdown(text: string): string {
  return markdown.parse(text, { async: false });
}
