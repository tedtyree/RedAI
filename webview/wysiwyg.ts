// WYSIWYG view renderer.
// Phase 4: correct DOM structure — one element per block, proper HTML tags,
// contenteditable on all editable blocks.
// Phase 5+ adds editing event handlers.

import { Block } from './model';

/** Replace container contents with rendered block elements. */
export function renderBlocks(container: HTMLElement, blocks: Block[]): void {
  container.innerHTML = '';
  for (const block of blocks) {
    container.appendChild(createBlockEl(block));
  }
}

function createBlockEl(block: Block): HTMLElement {
  switch (block.type) {
    case 'p':
      return editable(document.createElement('p'), block);

    case 'h1': case 'h2': case 'h3':
    case 'h4': case 'h5': case 'h6':
      return editable(document.createElement(block.type), block);

    case 'blockquote':
      return editable(document.createElement('blockquote'), block);

    case 'code': {
      // <pre class="block block-code"><code contenteditable>…</code></pre>
      const pre = document.createElement('pre');
      pre.className = 'block block-code';
      pre.dataset['blockId'] = block.id;
      const code = document.createElement('code');
      code.contentEditable = 'true';
      code.textContent = block.text;
      pre.appendChild(code);
      return pre;
    }

    case 'hr': {
      const hr = document.createElement('hr');
      hr.className = 'block block-hr';
      hr.dataset['blockId'] = block.id;
      return hr;
    }

    default:
      // ul1–ul5, ol1–ol5
      return editable(document.createElement('div'), block);
  }
}

/** Renders inline Markdown as HTML: bold, italic, strikethrough, inline code, links.
 *  Also converts \n → <br> for multi-line paragraph blocks. */
export function renderInline(text: string): string {
  // 1. HTML-escape raw text
  let s = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 2. Extract inline code spans first (protect interior from other patterns)
  const codeChunks: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_, inner) => {
    const idx = codeChunks.length;
    codeChunks.push(`<code class="inline-code">${inner}</code>`);
    return `\x00CODE${idx}\x00`;
  });

  // 3. Bold+Italic (must precede bold-only and italic-only)
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');

  // 4. Bold
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');

  // 5. Italic — * version (any position); _ version (word-boundary only, avoids file_name_here)
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  s = s.replace(/(?<![a-zA-Z0-9])_([^_\n]+)_(?![a-zA-Z0-9])/g, '<em>$1</em>');

  // 6. Strikethrough
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  // 7. Links — tabindex=-1 prevents Tab-key navigation into the <a>
  s = s.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g,
    '<a href="$2" class="inline-link" tabindex="-1">$1</a>');

  // 8. Restore inline code placeholders
  s = s.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeChunks[+i]);

  // 9. Newlines → <br> (for p blocks with multiple visual lines)
  s = s.replace(/\n/g, '<br>');

  return s;
}

function editable(el: HTMLElement, block: Block): HTMLElement {
  el.className = `block block-${block.type}`;
  el.contentEditable = 'true';
  // p blocks: render inline Markdown as HTML (bold, italic, etc.) + <br> for line breaks.
  // Other blocks: raw text — their keyboard handlers rely on textContent for offset math.
  if (block.type === 'p') {
    el.innerHTML = renderInline(block.text);
  } else {
    el.textContent = block.text;
  }
  el.dataset['blockId'] = block.id;
  return el;
}
