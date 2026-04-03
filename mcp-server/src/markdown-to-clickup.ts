/**
 * Converts markdown text to ClickUp's comment rich text array format.
 *
 * Supported syntax:
 *   **bold**, *italic*, `inline code`, [text](url)
 *   - bullet lists (with nesting via indentation)
 *   1. ordered lists
 *   ```lang\ncode\n``` fenced code blocks
 *   # headings (rendered as bold)
 */

type Attributes = Record<string, unknown>;

interface CommentBlock {
  text?: string;
  type?: string;
  attributes?: Attributes;
  [key: string]: unknown;
}

export function markdownToClickUp(markdown: string): CommentBlock[] {
  const blocks: CommentBlock[] = [];
  const lines = markdown.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const codeBlockMatch = line.match(/^```(\w*)$/);
    if (codeBlockMatch) {
      const lang = codeBlockMatch[1] || "plain";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].match(/^```$/)) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({
        text: codeLines.join("\n"),
        attributes: {},
      });
      blocks.push({
        text: "\n",
        attributes: { "code-block": { "code-block": lang } },
      });
      continue;
    }

    // Heading (render as bold + newline)
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      blocks.push(...parseInline(headingMatch[1], { bold: true }));
      blocks.push({ text: "\n", attributes: {} });
      i++;
      continue;
    }

    // Bullet list item
    const bulletMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (bulletMatch) {
      const indent = Math.floor(bulletMatch[1].length / 2);
      blocks.push(...parseInline(bulletMatch[2]));
      const attrs: Attributes = { list: "bullet" };
      if (indent > 0) attrs.indent = indent;
      blocks.push({ text: "\n", attributes: attrs });
      i++;
      continue;
    }

    // Ordered list item
    const orderedMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (orderedMatch) {
      const indent = Math.floor(orderedMatch[1].length / 2);
      blocks.push(...parseInline(orderedMatch[2]));
      const attrs: Attributes = { list: "ordered" };
      if (indent > 0) attrs.indent = indent;
      blocks.push({ text: "\n", attributes: attrs });
      i++;
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      blocks.push({ text: "\n", attributes: {} });
      i++;
      continue;
    }

    // Regular paragraph line
    blocks.push(...parseInline(line));
    blocks.push({ text: "\n", attributes: {} });
    i++;
  }

  return blocks;
}

/**
 * Parse inline markdown formatting into CommentBlock spans.
 * Handles: **bold**, *italic*, `code`, [text](url), and combinations.
 */
function parseInline(
  text: string,
  baseAttrs: Attributes = {}
): CommentBlock[] {
  const blocks: CommentBlock[] = [];
  // Regex matches inline patterns in priority order
  const inlineRe =
    /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)|(\[(.+?)\]\((.+?)\))/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlineRe.exec(text)) !== null) {
    // Push any plain text before this match
    if (match.index > lastIndex) {
      const plain = text.slice(lastIndex, match.index);
      blocks.push({ text: plain, attributes: { ...baseAttrs } });
    }

    if (match[1]) {
      // **bold**
      blocks.push({
        text: match[2],
        attributes: { ...baseAttrs, bold: true },
      });
    } else if (match[3]) {
      // *italic*
      blocks.push({
        text: match[4],
        attributes: { ...baseAttrs, italic: true },
      });
    } else if (match[5]) {
      // `code`
      blocks.push({
        text: match[6],
        attributes: { ...baseAttrs, code: true },
      });
    } else if (match[7]) {
      // [text](url)
      blocks.push({
        text: match[8],
        attributes: { ...baseAttrs, link: match[9] },
      });
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining plain text
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex);
    blocks.push({ text: remaining, attributes: { ...baseAttrs } });
  }

  // If nothing was parsed, return the whole text
  if (blocks.length === 0) {
    blocks.push({ text, attributes: { ...baseAttrs } });
  }

  return blocks;
}
