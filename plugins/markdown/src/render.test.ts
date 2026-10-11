import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "./render.ts";

describe("renderMarkdown", () => {
  test("headings, emphasis and lists", () => {
    const html = renderMarkdown("# Rules\n\nBe **nice** and *quiet*.\n\n- one\n- two");
    expect(html).toContain("<h1>Rules</h1>");
    expect(html).toContain("<strong>nice</strong>");
    expect(html).toContain("<em>quiet</em>");
    expect(html).toContain("<li>one</li>");
  });

  test("a single newline is a line break", () => {
    expect(renderMarkdown("first\nsecond")).toBe("<p>first<br>second</p>\n");
  });

  test("GFM tables", () => {
    const html = renderMarkdown("| Time | Event |\n|---|---|\n| 20:00 | Demo |");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>Demo</td>");
  });

  test("raw HTML passes through for the viewer to sanitize", () => {
    expect(renderMarkdown('<span class="x">hi</span>')).toContain('<span class="x">hi</span>');
  });
});
