// Block[] → Markdown serializer.
//
// Deterministic and lossless for all supported block types.
// See Requirements §10 and §11.7.

import { Block, isListType } from './model';

// Indent prefix for list levels (0-indexed: level 1 = index 0)
const UL_PREFIX = ['- ', '  - ', '    - ', '      - ', '        - ', '          - ', '            - '];
const OL_INDENT = ['', '  ', '    ', '      ', '        ', '          ', '            '];

export function serialize(blocks: Block[]): string {
  const parts: string[] = [];
  let i = 0;

  while (i < blocks.length) {
    const block = blocks[i];

    // ── List group ────────────────────────────────────────────────────────
    if (isListType(block.type)) {
      const groupLines: string[] = [];
      while (i < blocks.length && isListType(blocks[i].type)) {
        groupLines.push(serializeListBlock(blocks[i]));
        i++;
      }
      parts.push(groupLines.join('\n') + '\n');
      continue;
    }

    // ── Empty paragraph sentinel (middle blocks only) ─────────────────────
    // Preserves intentional blank lines across save/reload (see §7.9).
    if (block.type === 'p' && block.text === '' && i < blocks.length - 1) {
      parts.push('&nbsp;\n');
      i++;
      continue;
    }

    // ── All other block types ─────────────────────────────────────────────
    parts.push(serializeBlock(block) + '\n');
    i++;
  }

  // Trailing newline per spec
  return parts.join('\n');
}

function serializeListBlock(block: Block): string {
  const level = parseInt(block.type[2], 10) - 1; // 0-indexed
  if (block.type.startsWith('ul')) {
    return UL_PREFIX[level] + block.text;
  } else {
    // ol: text already contains the numeric prefix (e.g. "1. Item")
    return OL_INDENT[level] + block.text;
  }
}

function serializeBlock(block: Block): string {
  switch (block.type) {
    case 'p':          return block.text;
    case 'h1':         return `# ${block.text}`;
    case 'h2':         return `## ${block.text}`;
    case 'h3':         return `### ${block.text}`;
    case 'h4':         return `#### ${block.text}`;
    case 'h5':         return `##### ${block.text}`;
    case 'h6':         return `###### ${block.text}`;
    case 'blockquote': return `> ${block.text}`;
    case 'hr':         return '---';
    case 'code':
      return '```\n' + block.text + '\n```';
    default:
      return block.text;
  }
}
