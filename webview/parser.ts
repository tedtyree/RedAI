// Markdown → Block[] parser.
//
// Line-by-line; does not use a full CommonMark parser.
// Supported constructs: headings, ul/ol lists (with indentation levels),
// blockquotes, fenced code blocks, hr, paragraphs.
// Unsupported constructs are preserved verbatim as 'p' blocks.
// See Requirements §12 and §11.8.

import { Block, BlockType, makeBlock } from './model';

/** Returns true if the markdown contains constructs the parser does not support
 *  (e.g. tables, raw HTML, link reference definitions). */
export function detectUnsupported(markdown: string): boolean {
  for (const line of markdown.split('\n')) {
    const t = line.trim();
    if (t === '') { continue; }
    if (/^\|/.test(t)) { return true; }          // table rows / separators
    if (/^<[a-zA-Z!]/.test(t)) { return true; }  // HTML blocks
    if (/^\[.+\]:/.test(t)) { return true; }      // link reference definitions
  }
  return false;
}

export function parse(markdown: string): Block[] {
  const lines = markdown.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ── Blank line: skip ──────────────────────────────────────────────────
    if (line.trim() === '') {
      i++;
      continue;
    }

    // ── Fenced code block ─────────────────────────────────────────────────
    if (line.trim().startsWith('```')) {
      // Opening fence — optional language hint (e.g. ```json) is discarded on round-trip
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== '```') {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // consume closing ```
      blocks.push(makeBlock('code', codeLines.join('\n')));
      continue;
    }

    // ── HR ────────────────────────────────────────────────────────────────
    if (/^(---|___|\*\*\*)$/.test(line.trim())) {
      blocks.push(makeBlock('hr', ''));
      i++;
      continue;
    }

    // ── Headings ──────────────────────────────────────────────────────────
    const headingMatch = line.match(/^(#{1,6}) (.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push(makeBlock(`h${level}` as BlockType, headingMatch[2]));
      i++;
      continue;
    }

    // ── Blockquote ────────────────────────────────────────────────────────
    if (line.startsWith('> ')) {
      blocks.push(makeBlock('blockquote', line.slice(2)));
      i++;
      continue;
    }

    // ── Unordered list item ───────────────────────────────────────────────
    const ulMatch = line.match(/^( *)([*-]) (.+)/);
    if (ulMatch) {
      const level = Math.min(7, Math.max(1, Math.floor(ulMatch[1].length / 2) + 1));
      blocks.push(makeBlock(`ul${level}` as BlockType, ulMatch[3]));
      i++;
      continue;
    }

    // ── Ordered list item ─────────────────────────────────────────────────
    const olMatch = line.match(/^( *)(\d+\. .+)/);
    if (olMatch) {
      const level = Math.min(7, Math.max(1, Math.floor(olMatch[1].length / 2) + 1));
      // Retain the full "N. text" as the block's text content (per §11.2)
      blocks.push(makeBlock(`ol${level}` as BlockType, olMatch[2]));
      i++;
      continue;
    }

    // ── Empty paragraph sentinel ──────────────────────────────────────────
    if (line.trim() === '&nbsp;') {
      blocks.push(makeBlock('p', ''));
      i++;
      continue;
    }

    // ── Paragraph (multi-line fallback) ───────────────────────────────────
    // Consume consecutive non-blank lines that don't match any block pattern.
    const paraLines: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (next.trim() === '' || next.trim() === '&nbsp;') { break; }
      if (/^(---|___|\*\*\*)$/.test(next.trim())) { break; }
      if (/^#{1,6} /.test(next)) { break; }
      if (next.startsWith('> ')) { break; }
      if (/^( *)([*-]) /.test(next)) { break; }
      if (/^( *)\d+\. /.test(next)) { break; }
      if (next.trim().startsWith('```')) { break; }
      paraLines.push(next);
      i++;
    }
    blocks.push(makeBlock('p', paraLines.join('\n')));
  }

  // Guarantee at least one block
  if (blocks.length === 0) {
    blocks.push(makeBlock('p', ''));
  }

  return blocks;
}
