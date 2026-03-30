// Main WebView entry point.
// Handles the VS Code message protocol, toggle control, and view lifecycle.

import { Block, BlockType, isUlType, isOlType, isListType, listLevel, listTypeAtLevel, makeBlock } from './model';
import { parse, detectUnsupported } from './parser';
import { serialize } from './serializer';
import { renderBlocks } from './wysiwyg';
import { SourceView } from './source';
import { FindBar } from './find';

// acquireVsCodeApi is injected by VS Code into the WebView context
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

// ── State ─────────────────────────────────────────────────────────────────────

type ActiveView = 'visual' | 'source';
let activeView: ActiveView = 'visual';
let debounceMs = 300;

/** Live block model — the source of truth for the visual view. */
let blocks: Block[] = [];

/** ID of the block element that currently has focus in the visual view. */
let focusedBlockId: string | null = null;

/** Timer handle for the debounced visual-edit sync. */
let inputDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Multi-block selection state. */
let selectedBlockIds: Set<string> = new Set();
let selectionAnchorId: string | null = null;
let mousedownBlockId: string | null = null;

/** Block drag-reorder state. */
let isDraggingBlock = false;
let dragAnchorBlockId: string | null = null;
let dropTargetIndex = -1;

// ── DOM setup ─────────────────────────────────────────────────────────────────

const app = document.getElementById('app')!;

// ── Formatting toolbar (visual mode only) ─────────────────────────────────────

const TOOLBAR_BUTTONS: Array<{ label: string; type: BlockType }> = [
  { label: 'P',              type: 'p' },
  { label: 'H1',             type: 'h1' },
  { label: 'H2',             type: 'h2' },
  { label: 'H3',             type: 'h3' },
  { label: '\u201C',         type: 'blockquote' },
  { label: 'UL',             type: 'ul1' },
  { label: 'OL',             type: 'ol1' },
  { label: '</>',            type: 'code' },
  { label: '\u2014\u2014\u2014', type: 'hr' },
];

const toolbar = document.createElement('div');
toolbar.className = 'toolbar';
toolbar.style.display = 'none';
toolbar.setAttribute('role', 'toolbar');
toolbar.setAttribute('aria-label', 'Block formatting');
app.appendChild(toolbar);

const toolbarBtns: HTMLButtonElement[] = [];
for (const { label, type } of TOOLBAR_BUTTONS) {
  const btn = document.createElement('button');
  btn.className = 'toolbar-btn';
  btn.textContent = label;
  btn.title = type;
  btn.dataset['blockType'] = type;
  btn.setAttribute('role', 'button');
  btn.addEventListener('mousedown', (e) => { e.preventDefault(); });
  btn.addEventListener('click', () => applyBlockType(type));
  toolbar.appendChild(btn);
  toolbarBtns.push(btn);
}

// Indent / Dedent action buttons (list blocks only)
const indentBtn = document.createElement('button');
indentBtn.className = 'toolbar-btn';
indentBtn.textContent = '→';
indentBtn.title = 'Indent list (Tab)';
indentBtn.setAttribute('role', 'button');
indentBtn.addEventListener('mousedown', (e) => { e.preventDefault(); });
indentBtn.addEventListener('click', () => { applyContextAction(false); });
toolbar.appendChild(indentBtn);

const dedentBtn = document.createElement('button');
dedentBtn.className = 'toolbar-btn';
dedentBtn.textContent = '←';
dedentBtn.title = 'Dedent list (Shift+Tab)';
dedentBtn.setAttribute('role', 'button');
dedentBtn.addEventListener('mousedown', (e) => { e.preventDefault(); });
dedentBtn.addEventListener('click', () => { applyContextAction(true); });
toolbar.appendChild(dedentBtn);

// Inline formatting buttons (separator + B / I / ~~ / ` / link)
const inlineSep = document.createElement('span');
inlineSep.style.cssText = 'display:inline-block;width:1px;background:var(--vscode-editorGroup-border,#888);opacity:0.4;align-self:stretch;margin:3px 4px';
toolbar.appendChild(inlineSep);

const INLINE_BUTTONS = [
  { label: 'B',    title: 'Bold (Ctrl+B)',    type: 'bold'          },
  { label: 'I',    title: 'Italic (Ctrl+I)',  type: 'italic'        },
  { label: '~~',   title: 'Strikethrough',    type: 'strikethrough' },
  { label: '`',    title: 'Inline code',      type: 'code'          },
  { label: '[url]',title: 'Insert link',      type: 'link'          },
] as const;

const inlineBtns: HTMLButtonElement[] = [];
for (const { label, title, type } of INLINE_BUTTONS) {
  const btn = document.createElement('button');
  btn.className = 'toolbar-btn';
  btn.textContent = label;
  btn.title = title;
  btn.dataset['inlineType'] = type;
  if (type === 'bold')   { btn.style.fontWeight = 'bold'; }
  if (type === 'italic') { btn.style.fontStyle  = 'italic'; }
  btn.setAttribute('role', 'button');
  btn.addEventListener('mousedown', (e) => { e.preventDefault(); });
  btn.addEventListener('click', () => applyInline(type));
  toolbar.appendChild(btn);
  inlineBtns.push(btn);
}

// Block type indicator label (right end of toolbar)
const blockTypeLabel = document.createElement('span');
blockTypeLabel.className = 'toolbar-type-label';
toolbar.appendChild(blockTypeLabel);

// Unsupported construct warning banner (shown when the document contains
// Markdown that the parser does not handle, e.g. tables or raw HTML)
const warningBanner = document.createElement('div');
warningBanner.className = 'warning-banner';
warningBanner.textContent = '⚠ This file contains Markdown constructs not supported in Visual mode (e.g. tables, HTML). They are preserved as plain text. Click to dismiss.';
warningBanner.style.cursor = 'pointer';
warningBanner.addEventListener('click', () => { warningBanner.style.display = 'none'; });
app.appendChild(warningBanner);

// Visual view container
const visualContainer = document.createElement('div');
visualContainer.className = 'visual-container';
visualContainer.style.display = 'none';
app.appendChild(visualContainer);

// Source view
const sourceContainer = document.createElement('div');
sourceContainer.className = 'source-container';
sourceContainer.style.display = 'none';
app.appendChild(sourceContainer);

const sourceView = new SourceView(sourceContainer, debounceMs);

// Drag handle: floating 2×3 dot icon, shown when a block has focus or is selected
const dragHandle = document.createElement('div');
dragHandle.className = 'drag-handle';
dragHandle.innerHTML = `<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor"><circle cx="2.5" cy="2.5" r="1.8"/><circle cx="7.5" cy="2.5" r="1.8"/><circle cx="2.5" cy="8" r="1.8"/><circle cx="7.5" cy="8" r="1.8"/><circle cx="2.5" cy="13.5" r="1.8"/><circle cx="7.5" cy="13.5" r="1.8"/></svg>`;
dragHandle.style.display = 'none';
app.appendChild(dragHandle);

// Drop indicator: horizontal line shown between blocks during a drag-reorder
const dropIndicator = document.createElement('div');
dropIndicator.className = 'drop-indicator';
dropIndicator.style.display = 'none';
app.appendChild(dropIndicator);

// Find bar: floating search widget (Ctrl+F)
const findBar = new FindBar(app, () =>
  activeView === 'visual' ? visualContainer : sourceView.getElement()
);

// ── Cursor utilities ──────────────────────────────────────────────────────────

/** Returns the start and end character offsets of the current selection within el. */
function getSelectionOffsets(el: HTMLElement): { start: number; end: number } {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) { return { start: 0, end: 0 }; }
  const range = sel.getRangeAt(0);
  const startRange = range.cloneRange();
  startRange.selectNodeContents(el);
  startRange.setEnd(range.startContainer, range.startOffset);
  const start = startRange.toString().length;
  return { start, end: start + range.toString().length };
}

/** Places the cursor at a character offset within el by walking its text nodes.
 *  <br> elements count as 1 character (matching \n in block.text for p blocks). */
function setCursorOffset(el: HTMLElement, offset: number): void {
  const sel = window.getSelection();
  if (!sel) { return; }
  const range = document.createRange();
  let remaining = Math.max(0, offset);
  let placed = false;

  function walk(node: Node): void {
    if (placed) { return; }
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node.textContent ?? '').length;
      if (remaining <= len) {
        range.setStart(node, remaining);
        range.setEnd(node, remaining);
        placed = true;
      } else {
        remaining -= len;
      }
    } else if ((node as Element).tagName === 'BR') {
      // <br> counts as 1 character (the \n it represents)
      if (remaining === 0) {
        range.setStartBefore(node); range.setEndBefore(node); placed = true;
      } else {
        remaining -= 1;
        if (remaining === 0) {
          range.setStartAfter(node); range.setEndAfter(node); placed = true;
        }
      }
    } else {
      for (const child of Array.from(node.childNodes)) { walk(child); }
    }
  }

  walk(el);
  if (!placed) { range.selectNodeContents(el); range.collapse(false); }
  sel.removeAllRanges();
  sel.addRange(range);
}

/** True when the cursor is collapsed at position 0 within el. */
function isAtStart(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.getRangeAt(0).collapsed) { return false; }
  return getSelectionOffsets(el).start === 0;
}

/** True when the cursor is collapsed at the last character position within el. */
function isAtEnd(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.getRangeAt(0).collapsed) { return false; }
  return getSelectionOffsets(el).start === (el.textContent ?? '').length;
}

/** True when the cursor is on the first visual line of el (uses bounding rects). */
function isOnFirstLine(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) { return false; }
  const r = sel.getRangeAt(0).cloneRange();
  r.collapse(true);
  const cr = r.getBoundingClientRect();
  if (!cr || cr.height === 0) { return isAtStart(el); }
  return cr.top < el.getBoundingClientRect().top + cr.height * 1.5;
}

/** True when the cursor is on the last visual line of el (uses bounding rects). */
function isOnLastLine(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) { return false; }
  const r = sel.getRangeAt(0).cloneRange();
  r.collapse(true);
  const cr = r.getBoundingClientRect();
  if (!cr || cr.height === 0) { return isAtEnd(el); }
  return cr.bottom > el.getBoundingClientRect().bottom - cr.height * 1.5;
}

// ── Block DOM helpers ─────────────────────────────────────────────────────────

function getBlockEl(id: string): HTMLElement | null {
  return visualContainer.querySelector(`[data-block-id="${id}"]`) as HTMLElement | null;
}

/** For code blocks the editable node is the inner <code>; all others are the block element itself. */
function getContentEl(blockEl: HTMLElement, type: BlockType): HTMLElement {
  return type === 'code'
    ? ((blockEl.querySelector('code') as HTMLElement) ?? blockEl)
    : blockEl;
}

function focusBlock(id: string, offset: number): void {
  focusedBlockId = id;
  const el = getBlockEl(id);
  if (!el) { return; }
  const block = blocks.find(b => b.id === id);
  if (!block || block.type === 'hr') { return; }
  const contentEl = getContentEl(el, block.type);
  contentEl.focus();
  setCursorOffset(contentEl, offset);
}

function postUpdate(): void {
  vscode.postMessage({ type: 'update', markdown: serialize(blocks) });
}

// ── OL renumbering ────────────────────────────────────────────────────────────

/** Walk all blocks and assign correct 1-based sequence numbers to ol items per level.
 *  Counters reset on any non-list block; higher-level counters reset when a lower level is seen. */
function renumberOl(): void {
  const counters = [0, 0, 0, 0, 0, 0, 0, 0]; // index 0 unused; 1–7 are list levels
  for (const block of blocks) {
    if (!isListType(block.type)) {
      counters.fill(0);
      continue;
    }
    if (!isOlType(block.type)) { continue; } // ul items don't affect ol counters
    const level = listLevel(block.type);
    counters[level]++;
    for (let i = level + 1; i <= 7; i++) { counters[i] = 0; }
    block.text = block.text.replace(/^\d+\.\s*/, `${counters[level]}. `);
  }
}

// ── Shake animation ───────────────────────────────────────────────────────────

/** Briefly shake el to signal a blocked action (e.g. indent at max level). */
function shakeBlock(el: HTMLElement): void {
  el.classList.remove('shake');
  void el.offsetWidth; // force reflow to restart the animation
  el.classList.add('shake');
  el.addEventListener('animationend', () => el.classList.remove('shake'), { once: true });
}

// ── Keyboard handlers ─────────────────────────────────────────────────────────

function handleEnter(e: KeyboardEvent, block: Block, idx: number, contentEl: HTMLElement): void {
  // HR: Enter has no effect
  if (block.type === 'hr') { e.preventDefault(); return; }

  // Code block: insert a literal newline instead of splitting
  if (block.type === 'code') {
    e.preventDefault();
    syncDomToBlocks();
    const { start, end } = getSelectionOffsets(contentEl);
    block.text = block.text.slice(0, start) + '\n' + block.text.slice(end);
    renderBlocks(visualContainer, blocks);
    focusBlock(block.id, start + 1);
    postUpdate();
    return;
  }

  // Paragraph blocks: handle '---' shortcut and blank-line splits ourselves;
  // all other Enter presses (inserting a line break) are handled by the browser natively.
  if (block.type === 'p') {
    syncDomToBlocks();
    console.log('[P] innerHTML=', JSON.stringify(contentEl.innerHTML), 'text=', JSON.stringify(block.text));

    // '---' shortcut: entire block text is exactly '---' → convert to hr
    if (block.text.trim() === '---') {
      e.preventDefault();
      block.type = 'hr';
      block.text = '';
      const next = makeBlock('p', '');
      blocks.splice(idx + 1, 0, next);
      renderBlocks(visualContainer, blocks);
      updateToolbarState();
      focusBlock(next.id, 0);
      postUpdate();
      return;
    }

    // Detect "double Enter" → split into a new paragraph.
    // After the first Enter, Chrome wraps each new visual line in a <div>.
    // A second Enter should split when the cursor is:
    //   (a) in a blank <div> (user pressed Enter on an empty line), OR
    //   (b) at position 0 of any <div> (at the start of a Chrome-wrapped line), OR
    //   (c) at position 0 of the first text node AND child <div>s already exist
    //       (cursor stayed in the root text node after Enter at block start).
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const anchorNode = range.startContainer;

      // Walk up from the cursor to find a <div> that is a direct child of this block.
      let divEl: HTMLElement | null = null;
      let node: Node | null = anchorNode;
      while (node && node !== contentEl) {
        if ((node as HTMLElement).tagName === 'DIV' && (node as HTMLElement).parentElement === contentEl) {
          divEl = node as HTMLElement;
          break;
        }
        node = node.parentElement;
      }

      const isBlankDiv   = divEl ? !divEl.textContent?.trim() : false;
      const isAtDivStart = divEl
        ? range.startOffset === 0 && (anchorNode === divEl || anchorNode === divEl.firstChild)
        : false;

      // Case (c): cursor is in a root text node at offset 0, and there is a line-break
      // structure (Chrome <div> or a <br>) before or after the cursor.
      // Fixed: only use `contentEl.children.length` for Chrome-div detection; also handle
      // the case where a <br> immediately precedes the cursor (renderInline \n→<br>).
      const prevSibOfAnchor = anchorNode.previousSibling;
      const isAtRootStart   = !divEl
        && range.startOffset === 0
        && (anchorNode as Node).parentElement === contentEl
        && (
          prevSibOfAnchor?.nodeName === 'BR'                                  // cursor after a <br> in root
          || prevSibOfAnchor?.nodeName === 'DIV'                              // cursor after a Chrome div
          || (prevSibOfAnchor === null
              && Array.from(contentEl.children).some(                         // cursor at block start with line-break structure
                c => c.tagName === 'DIV' || c.tagName === 'BR'))
        );

      // Case (d): cursor is at position 0 of an inline element (<strong>/<em>/etc.)
      // that is a direct child of contentEl AND is immediately preceded by a <br> OR a <div>.
      //   • <br> case: renderInline's \n→<br>, cursor is at visual line start in the raw block.
      //   • <div> case: Chrome carried the inline tag into a new <div> on Enter, then cursor
      //     landed at position 0 of the NEXT same-tag sibling element outside the div.
      let inlineChildEl: HTMLElement | null = null;
      if (!divEl && range.startOffset === 0 && anchorNode.nodeType === Node.TEXT_NODE) {
        const parent = anchorNode.parentElement as HTMLElement | null;
        if (parent && parent.parentElement === contentEl
            && ['STRONG','EM','DEL','CODE','A','B','I','S'].includes(parent.tagName)
            && anchorNode === parent.firstChild) {
          const ps = parent.previousSibling;
          if (ps?.nodeName === 'BR' || ps?.nodeName === 'DIV') {
            inlineChildEl = parent;
          }
        }
      }
      const isAtInlineChildStart = inlineChildEl !== null;

      console.log('[P] divEl=', divEl ? divEl.outerHTML.slice(0, 40) : 'null',
        'isBlankDiv=', isBlankDiv, 'isAtDivStart=', isAtDivStart,
        'isAtRootStart=', isAtRootStart, 'isAtInlineChildStart=', isAtInlineChildStart);

      if (isBlankDiv || isAtDivStart || isAtRootStart || isAtInlineChildStart) {
        e.preventDefault();
        let before: string;
        let after: string;

        if (isAtRootStart) {
          // Cursor is in the leading text node, before all the divs/br → split: '' | full text
          before = '';
          after  = block.text;
        } else if (isAtInlineChildStart) {
          // Cursor is at start of an inline element (e.g. <strong>) that follows a <br> or <div>.
          // Count <br> siblings in contentEl before the inline element (stop at any <div>).
          // When the preceding sibling is a Chrome <div>, that div also added an extra \n to
          // block.text (on top of any renderInline <br>), so skip one extra line in that case.
          let brCount = 0;
          let hasChromeDivBefore = false;
          for (const child of Array.from(contentEl.childNodes)) {
            if (child === inlineChildEl) { break; }
            if (child.nodeName === 'DIV') { hasChromeDivBefore = true; break; }
            if (child.nodeName === 'BR')  { brCount++; }
          }
          const lines = block.text.split('\n');
          before = lines.slice(0, brCount).join('\n');
          // Skip the extra blank line that Chrome's <div> contributed to block.text
          const afterIdx = (hasChromeDivBefore && brCount > 0) ? brCount + 1 : brCount;
          after  = lines.slice(afterIdx).join('\n');
        } else {
          const divs = Array.from(contentEl.children).filter(c => c.tagName === 'DIV') as HTMLElement[];
          const cursorDivIdx = divs.indexOf(divEl!);
          const lines = block.text.split('\n');
          // line 0 = first text node; line N = div[N-1]
          before = lines.slice(0, cursorDivIdx + 1).join('\n');
          // Blank div: skip the blank line itself; non-blank at pos 0: include the div's text
          after = isBlankDiv
            ? lines.slice(cursorDivIdx + 2).join('\n')
            : lines.slice(cursorDivIdx + 1).join('\n');
        }

        console.log('[P] SPLIT before=', JSON.stringify(before), 'after=', JSON.stringify(after));
        block.text = before;
        const next = makeBlock('p', after);
        blocks.splice(idx + 1, 0, next);
        renumberOl();
        renderBlocks(visualContainer, blocks);
        updateToolbarState();
        focusBlock(next.id, 0);
        postUpdate();
        return;
      }
    }

    // Not at a split boundary → let the browser insert its natural line break
    return;
  }

  e.preventDefault();
  syncDomToBlocks();

  const { start, end } = getSelectionOffsets(contentEl);
  const before = block.text.slice(0, start);
  const after  = block.text.slice(end);

  block.text = before;

  // New block type: list blocks inherit type+level; everything else → p
  let newType: BlockType = 'p';
  let newText = after;

  if (isListType(block.type)) {
    newType = block.type;
    if (isOlType(newType)) {
      newText = '1. ' + after.trimStart(); // renumberOl will assign the correct number
    }
  }

  const next = makeBlock(newType, newText);
  blocks.splice(idx + 1, 0, next);
  renumberOl();
  renderBlocks(visualContainer, blocks);
  updateToolbarState();
  const enterCursor = isOlType(next.type)
    ? (next.text.match(/^\d+\.\s*/)?.[0].length ?? 0)
    : 0;
  focusBlock(next.id, enterCursor);
  postUpdate();
}

function handleBackspace(e: KeyboardEvent, block: Block, idx: number, contentEl: HTMLElement): void {
  if (!isAtStart(contentEl)) { return; }
  e.preventDefault();
  syncDomToBlocks();

  // List blocks: demote one level (or exit to p) instead of merging
  if (isListType(block.type)) {
    const level = listLevel(block.type);
    const wasOl = isOlType(block.type);
    if (level > 1) {
      block.type = listTypeAtLevel(block.type, level - 1);
    } else {
      block.type = 'p';
      if (wasOl) { block.text = block.text.replace(/^\d+\.\s*/, ''); }
    }
    renumberOl();
    renderBlocks(visualContainer, blocks);
    updateToolbarState();
    const bsCursor = isOlType(block.type)
      ? (block.text.match(/^\d+\.\s*/)?.[0].length ?? 0)
      : 0;
    focusBlock(block.id, bsCursor);
    postUpdate();
    return;
  }

  if (idx === 0) { return; }

  const prev = blocks[idx - 1];

  // Preceding block is hr: delete the hr, keep this block
  if (prev.type === 'hr') {
    blocks.splice(idx - 1, 1);
    renderBlocks(visualContainer, blocks);
    updateToolbarState();
    focusBlock(block.id, 0);
    postUpdate();
    return;
  }

  // Merge current block into preceding block
  const junction = prev.text.length;
  prev.text += block.text;
  blocks.splice(idx, 1);
  renderBlocks(visualContainer, blocks);
  updateToolbarState();
  focusBlock(prev.id, junction);
  postUpdate();
}

function handleDelete(e: KeyboardEvent, block: Block, idx: number, contentEl: HTMLElement): void {
  if (!isAtEnd(contentEl)) { return; }
  if (idx >= blocks.length - 1) { e.preventDefault(); return; }
  e.preventDefault();
  syncDomToBlocks();

  const next = blocks[idx + 1];
  const junction = block.text.length;

  // Next block is hr: delete the hr
  if (next.type === 'hr') {
    blocks.splice(idx + 1, 1);
    renderBlocks(visualContainer, blocks);
    updateToolbarState();
    focusBlock(block.id, junction);
    postUpdate();
    return;
  }

  // Merge next block into current block
  block.text += next.text;
  blocks.splice(idx + 1, 1);
  renderBlocks(visualContainer, blocks);
  updateToolbarState();
  focusBlock(block.id, junction);
  postUpdate();
}

function handleArrowUp(e: KeyboardEvent, _block: Block, idx: number, contentEl: HTMLElement): void {
  if (idx === 0 || !isOnFirstLine(contentEl)) { return; }
  e.preventDefault();
  // Skip over hr blocks
  let target = idx - 1;
  while (target > 0 && blocks[target].type === 'hr') { target--; }
  const prev = blocks[target];
  if (prev.type === 'hr') { return; }
  const prevEl = getBlockEl(prev.id);
  if (!prevEl) { return; }
  const prevContent = getContentEl(prevEl, prev.type);
  focusedBlockId = prev.id;
  prevContent.focus();
  setCursorOffset(prevContent, (prevContent.textContent ?? '').length);
  updateToolbarState();
}

function handleArrowDown(e: KeyboardEvent, _block: Block, idx: number, contentEl: HTMLElement): void {
  if (idx >= blocks.length - 1 || !isOnLastLine(contentEl)) { return; }
  e.preventDefault();
  // Skip over hr blocks
  let target = idx + 1;
  while (target < blocks.length - 1 && blocks[target].type === 'hr') { target++; }
  const next = blocks[target];
  if (next.type === 'hr') { return; }
  const nextEl = getBlockEl(next.id);
  if (!nextEl) { return; }
  const nextContent = getContentEl(nextEl, next.type);
  focusedBlockId = next.id;
  nextContent.focus();
  setCursorOffset(nextContent, 0);
  updateToolbarState();
}

function handleTab(dedent: boolean, block: Block, _idx: number, contentEl: HTMLElement): void {
  if (!isListType(block.type)) { return; }
  syncDomToBlocks();
  const level = listLevel(block.type);
  const wasOl = isOlType(block.type);

  if (!dedent) {
    // Indent: go deeper, shake if already at max level
    if (level >= 7) {
      shakeBlock(contentEl);
      return;
    }
    block.type = listTypeAtLevel(block.type, level + 1);
    if (wasOl) { block.text = block.text.replace(/^\d+\.\s*/, '1. '); } // renumberOl fixes
  } else {
    // Dedent: go shallower, or exit list entirely at level 1
    if (level <= 1) {
      if (wasOl) { block.text = block.text.replace(/^\d+\.\s*/, ''); }
      block.type = 'p';
    } else {
      block.type = listTypeAtLevel(block.type, level - 1);
    }
  }

  renumberOl();
  renderBlocks(visualContainer, blocks);
  updateToolbarState();
  const finalCursor = isOlType(block.type)
    ? (block.text.match(/^\d+\.\s*/)?.[0].length ?? 0)
    : 0;
  focusBlock(block.id, finalCursor);
  postUpdate();
}

function applyIndent(dedent: boolean): void {
  if (!focusedBlockId) { return; }
  const idx = blocks.findIndex(b => b.id === focusedBlockId);
  if (idx === -1) { return; }
  const block = blocks[idx];
  if (!isListType(block.type)) { return; }
  const el = getBlockEl(block.id);
  if (!el) { return; }
  handleTab(dedent, block, idx, getContentEl(el, block.type));
}

/** Adjust heading level. secondary=false → bigger (+), secondary=true → smaller (−). */
function adjustHeading(secondary: boolean): void {
  if (!focusedBlockId) { return; }
  const block = blocks.find(b => b.id === focusedBlockId);
  if (!block || !block.type.startsWith('h')) { return; }
  const cur = parseInt(block.type[1], 10);
  const next = secondary ? Math.min(6, cur + 1) : Math.max(1, cur - 1);
  if (next === cur) {
    const el = getBlockEl(block.id);
    if (el) { shakeBlock(el); el.focus(); }
    return;
  }
  block.type = `h${next}` as BlockType;
  renderBlocks(visualContainer, blocks);
  focusedBlockId = block.id; // restore before updateToolbarState (renderBlocks clears it via focusout)
  updateToolbarState();
  const el = getBlockEl(block.id);
  if (el) {
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  }
  postUpdate();
}

/** Dispatches the +/→ or −/← button action based on the focused block type. */
function applyContextAction(secondary: boolean): void {
  if (!focusedBlockId) { return; }
  const block = blocks.find(b => b.id === focusedBlockId);
  if (!block) { return; }
  if (isListType(block.type)) {
    applyIndent(secondary);
  } else if (block.type.startsWith('h')) {
    adjustHeading(secondary);
  } else {
    // Button not applicable to this block type — shake and restore focus
    const el = getBlockEl(block.id);
    if (el) { shakeBlock(el); el.focus(); }
  }
}

// ── Multi-block selection helpers ────────────────────────────────────────────

function isMultiSelectActive(): boolean {
  return selectedBlockIds.size > 0;
}

function setBlockSelection(anchorId: string, extentId: string): void {
  const anchorIdx = blocks.findIndex(b => b.id === anchorId);
  const extentIdx = blocks.findIndex(b => b.id === extentId);
  if (anchorIdx === -1 || extentIdx === -1) { return; }
  const start = Math.min(anchorIdx, extentIdx);
  const end   = Math.max(anchorIdx, extentIdx);
  for (const el of Array.from(visualContainer.querySelectorAll('.block-selected'))) {
    (el as HTMLElement).classList.remove('block-selected');
  }
  selectedBlockIds = new Set();
  for (let i = start; i <= end; i++) {
    selectedBlockIds.add(blocks[i].id);
    const el = getBlockEl(blocks[i].id);
    if (el) { el.classList.add('block-selected'); }
  }
  visualContainer.classList.add('multi-select-mode');
  const anchorEl = getBlockEl(anchorId);
  if (anchorEl) { positionDragHandle(anchorEl); }
}

function exitMultiSelectMode(): void {
  for (const el of Array.from(visualContainer.querySelectorAll('.block-selected'))) {
    (el as HTMLElement).classList.remove('block-selected');
  }
  selectedBlockIds = new Set();
  visualContainer.classList.remove('multi-select-mode');
}

function copySelectedBlocks(): void {
  const selected = blocks.filter(b => selectedBlockIds.has(b.id));
  if (selected.length === 0) { return; }
  navigator.clipboard.writeText(serialize(selected));
}

function deleteSelectedBlocks(): void {
  syncDomToBlocks();
  blocks = blocks.filter(b => !selectedBlockIds.has(b.id));
  if (blocks.length === 0) { blocks = [makeBlock('p', '')]; }
  exitMultiSelectMode();
  selectionAnchorId = null;
  renumberOl();
  renderBlocks(visualContainer, blocks);
  updateToolbarState();
  postUpdate();
}

// ── Drag handle helpers ───────────────────────────────────────────────────────

function positionDragHandle(blockEl: HTMLElement): void {
  const rect = blockEl.getBoundingClientRect();
  dragHandle.style.top  = `${rect.top + rect.height / 2 - 8}px`;
  dragHandle.style.left = `${rect.left - 22}px`;
  dragHandle.style.display = 'flex';
}

function computeAndShowDropIndicator(mouseY: number): void {
  const children = Array.from(visualContainer.children) as HTMLElement[];
  if (children.length === 0) { return; }
  let insertBefore = children.length;
  for (let i = 0; i < children.length; i++) {
    const r = children[i].getBoundingClientRect();
    if (mouseY < r.top + r.height / 2) { insertBefore = i; break; }
  }
  dropTargetIndex = insertBefore;
  const cr = visualContainer.getBoundingClientRect();
  if (insertBefore === 0) {
    const r = children[0].getBoundingClientRect();
    dropIndicator.style.top = `${r.top - 2}px`;
  } else {
    const r = children[insertBefore - 1].getBoundingClientRect();
    dropIndicator.style.top = `${r.bottom + 1}px`;
  }
  dropIndicator.style.left  = `${cr.left}px`;
  dropIndicator.style.width = `${cr.width}px`;
}

function executeDrop(): void {
  if (dropTargetIndex === -1 || !dragAnchorBlockId) { return; }
  syncDomToBlocks();

  const draggedIds = selectedBlockIds.size > 0
    ? new Set(selectedBlockIds)
    : new Set([dragAnchorBlockId]);

  const dragged = blocks.filter(b => draggedIds.has(b.id));
  const rest    = blocks.filter(b => !draggedIds.has(b.id));

  // Adjust insertion index to account for removed blocks
  const firstDraggedIdx = blocks.findIndex(b => draggedIds.has(b.id));
  let insertIdx = dropTargetIndex;
  if (insertIdx > firstDraggedIdx) { insertIdx -= dragged.length; }
  insertIdx = Math.max(0, Math.min(insertIdx, rest.length));

  blocks = [...rest.slice(0, insertIdx), ...dragged, ...rest.slice(insertIdx)];
  renumberOl();
  renderBlocks(visualContainer, blocks);

  if (draggedIds.size > 1 || selectedBlockIds.size > 0) {
    // Restore selection highlight on moved blocks
    for (const id of draggedIds) {
      const el = getBlockEl(id);
      if (el) { el.classList.add('block-selected'); }
    }
    visualContainer.classList.add('multi-select-mode');
    const anchorEl = getBlockEl(dragAnchorBlockId);
    if (anchorEl) { positionDragHandle(anchorEl); }
  } else {
    focusBlock(dragAnchorBlockId, 0);
  }

  updateToolbarState();
  postUpdate();
  dragAnchorBlockId = null;
  dropTargetIndex = -1;
}

// ── Visual view event handlers ────────────────────────────────────────────────

visualContainer.addEventListener('focusin', (e) => {
  const blockEl = (e.target as HTMLElement).closest('[data-block-id]') as HTMLElement | null;
  focusedBlockId = blockEl?.dataset['blockId'] ?? null;
  updateToolbarState();
  if (blockEl) { positionDragHandle(blockEl); }
});

visualContainer.addEventListener('focusout', (e) => {
  const related = e.relatedTarget as HTMLElement | null;
  if (!visualContainer.contains(related) && !toolbar.contains(related)) {
    focusedBlockId = null;
    updateToolbarState();
    if (!isDraggingBlock && !isMultiSelectActive()) {
      dragHandle.style.display = 'none';
    }
  }
});

visualContainer.addEventListener('input', () => {
  findBar.clearHighlights();
  if (inputDebounceTimer) { clearTimeout(inputDebounceTimer); }
  inputDebounceTimer = setTimeout(() => {
    syncDomToBlocks();
    vscode.postMessage({ type: 'update', markdown: serialize(blocks) });
    inputDebounceTimer = null;
  }, debounceMs);
});

visualContainer.addEventListener('paste', (e: ClipboardEvent) => {
  const blockEl = (e.target as HTMLElement).closest('[data-block-id]') as HTMLElement | null;
  if (!blockEl) { return; }
  const blockId = blockEl.dataset['blockId']!;
  const idx = blocks.findIndex(b => b.id === blockId);
  if (idx === -1) { return; }
  const block = blocks[idx];

  e.preventDefault();
  const rawText = e.clipboardData?.getData('text/plain') ?? '';
  if (!rawText) { return; }

  syncDomToBlocks();
  const contentEl = getContentEl(blockEl, block.type);
  const { start, end } = getSelectionOffsets(contentEl);

  // Code blocks: insert text literally without markdown parsing
  if (block.type === 'code') {
    block.text = block.text.slice(0, start) + rawText + block.text.slice(end);
    renderBlocks(visualContainer, blocks);
    focusBlock(block.id, start + rawText.length);
    postUpdate();
    return;
  }

  const before = block.text.slice(0, start);
  const after  = block.text.slice(end);

  const pastedBlocks = parse(rawText);
  // Guard: empty or whitespace-only paste produces a single empty p
  if (pastedBlocks.length === 1 && pastedBlocks[0].type === 'p' && pastedBlocks[0].text === '') { return; }

  // Give all pasted blocks fresh IDs
  const inserted = pastedBlocks.map(b => makeBlock(b.type, b.text));

  // Merge the text before the cursor into the first inserted block
  if (inserted[0].type !== 'hr') {
    inserted[0].text = before + inserted[0].text;
  } else if (before) {
    inserted.unshift(makeBlock('p', before));
  }

  // Merge the text after the cursor into the last inserted block
  const lastInserted = inserted[inserted.length - 1];
  let cursorOffset: number;
  if (lastInserted.type !== 'hr') {
    cursorOffset = lastInserted.text.length; // cursor lands after pasted content
    lastInserted.text = lastInserted.text + after;
  } else {
    cursorOffset = 0;
    if (after) { inserted.push(makeBlock('p', after)); }
  }

  // Replace the current block with the inserted blocks
  blocks.splice(idx, 1, ...inserted);
  renumberOl();
  renderBlocks(visualContainer, blocks);
  updateToolbarState();

  // Focus at end of pasted content in the last pasted block
  const focusTarget = lastInserted.type !== 'hr' ? lastInserted : inserted[inserted.length - 1];
  if (focusTarget.type !== 'hr') { focusBlock(focusTarget.id, cursorOffset); }

  postUpdate();
});

visualContainer.addEventListener('keydown', (e: KeyboardEvent) => {
  // Clear find highlights before any structural edit so htmlToText never sees <span> tags
  const isModifier = ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key);
  if (!isModifier && !(e.ctrlKey || e.metaKey)) { findBar.clearHighlights(); }

  // Multi-block selection keyboard shortcuts (handled before single-block logic)
  if (selectedBlockIds.size > 0) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      e.preventDefault(); copySelectedBlocks(); return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault(); deleteSelectedBlocks(); return;
    }
    if (e.key === 'Escape') { exitMultiSelectMode(); return; }
    const isModifierOnly = ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key);
    if (!e.ctrlKey && !e.metaKey && !isModifierOnly) { exitMultiSelectMode(); } // fall through to normal handling
  }

  const blockEl = (e.target as HTMLElement).closest('[data-block-id]') as HTMLElement | null;
  if (!blockEl) { return; }
  const blockId = blockEl.dataset['blockId']!;
  const idx = blocks.findIndex(b => b.id === blockId);
  if (idx === -1) { return; }
  const block = blocks[idx];
  const contentEl = getContentEl(blockEl, block.type);

  // Inline formatting keyboard shortcuts (Ctrl+B / Ctrl+I in p blocks)
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && block.type === 'p') {
    if (e.key === 'b') { e.preventDefault(); applyInline('bold');   return; }
    if (e.key === 'i') { e.preventDefault(); applyInline('italic'); return; }
  }

  // Only intercept unmodified keys (let Ctrl/Meta shortcuts pass through)
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey;

  switch (e.key) {
    case 'Enter':    if (plain || e.shiftKey) { handleEnter(e, block, idx, contentEl); } break;
    case 'Backspace': if (plain) { handleBackspace(e, block, idx, contentEl); } break;
    case 'Delete':   if (plain) { handleDelete(e, block, idx, contentEl); } break;
    case 'ArrowUp':  if (plain) { handleArrowUp(e, block, idx, contentEl); } break;
    case 'ArrowDown': if (plain) { handleArrowDown(e, block, idx, contentEl); } break;
    case 'Tab':
      if (isListType(block.type)) {
        e.preventDefault();
        handleTab(e.shiftKey, block, idx, contentEl);
      }
      break;
  }
});

// ── Multi-block selection event handlers ─────────────────────────────────────

visualContainer.addEventListener('mousedown', (e: MouseEvent) => {
  if (dragHandle.contains(e.target as Node)) { return; } // drag handle has its own handler
  const blockEl = (e.target as HTMLElement).closest('[data-block-id]') as HTMLElement | null;
  if (!blockEl) { exitMultiSelectMode(); return; }
  const blockId = blockEl.dataset['blockId']!;

  if (e.shiftKey && selectionAnchorId) {
    e.preventDefault(); // prevent focus change on shift-click
    setBlockSelection(selectionAnchorId, blockId);
    return;
  }

  mousedownBlockId = blockId;
  if (isMultiSelectActive()) { exitMultiSelectMode(); }
  selectionAnchorId = blockId;
});

visualContainer.addEventListener('mousemove', (e: MouseEvent) => {
  if (e.buttons !== 1 || !mousedownBlockId || isDraggingBlock) { return; }
  let el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
  let blockEl = el?.closest('[data-block-id]') as HTMLElement | null;
  // HR fallback: pointer-events:none makes HR invisible to elementFromPoint
  if (!blockEl) {
    for (const child of Array.from(visualContainer.children) as HTMLElement[]) {
      const r = child.getBoundingClientRect();
      if (e.clientY >= r.top && e.clientY <= r.bottom && e.clientX >= r.left && e.clientX <= r.right) {
        blockEl = child;
        break;
      }
    }
  }
  if (!blockEl) { return; }
  const blockId = blockEl.dataset['blockId']!;
  if (blockId === mousedownBlockId && !isMultiSelectActive()) { return; }
  window.getSelection()?.removeAllRanges();
  setBlockSelection(mousedownBlockId, blockId);
});

document.addEventListener('mouseup', () => {
  if (isMultiSelectActive() && mousedownBlockId) {
    selectionAnchorId = mousedownBlockId;
  }
  if (isDraggingBlock) {
    isDraggingBlock = false;
    document.body.style.cursor = '';
    dropIndicator.style.display = 'none';
    executeDrop();
  }
  mousedownBlockId = null;
});

document.addEventListener('mousedown', (e: MouseEvent) => {
  const target = e.target as Node;
  if (!visualContainer.contains(target) && !dragHandle.contains(target) && !toolbar.contains(target)) {
    if (isMultiSelectActive()) { exitMultiSelectMode(); dragHandle.style.display = 'none'; }
  }
});

document.addEventListener('keydown', (e: KeyboardEvent) => {
  // Ctrl+F / Cmd+F — open find bar
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    findBar.open();
    return;
  }

  if (e.key === 'Escape') {
    if (findBar.isOpen()) { findBar.close(); return; }
    if (isMultiSelectActive()) { exitMultiSelectMode(); }
  }
});

// ── Block drag handle events ──────────────────────────────────────────────────

dragHandle.addEventListener('mousedown', (e: MouseEvent) => {
  e.preventDefault(); // keep block focused; prevent text selection
  const anchorId = isMultiSelectActive() ? selectionAnchorId : focusedBlockId;
  if (!anchorId) { return; }
  dragAnchorBlockId = anchorId;
  // If the anchor is not part of an active selection, collapse to single-block drag
  if (!isMultiSelectActive() || !selectedBlockIds.has(anchorId)) {
    exitMultiSelectMode();
  }
  isDraggingBlock = true;
  document.body.style.cursor = 'grabbing';
  dropIndicator.style.display = 'block';
  computeAndShowDropIndicator(e.clientY);
});

document.addEventListener('mousemove', (e: MouseEvent) => {
  if (!isDraggingBlock) { return; }
  computeAndShowDropIndicator(e.clientY);
  dragHandle.style.top  = `${e.clientY - 8}px`;
  dragHandle.style.left = `${e.clientX - 8}px`;
});

// ── Toolbar state ─────────────────────────────────────────────────────────────

function updateToolbarState(): void {
  const block = focusedBlockId ? (blocks.find(b => b.id === focusedBlockId) ?? null) : null;
  for (const btn of toolbarBtns) {
    const btnType = btn.dataset['blockType'] as BlockType;
    const isActive = block !== null && (
      btnType === block.type ||
      (btnType === 'ul1' && isUlType(block.type)) ||
      (btnType === 'ol1' && isOlType(block.type))
    );
    btn.classList.toggle('active', isActive);
  }
  const isHeading = block !== null && block.type.startsWith('h');

  if (isHeading) {
    indentBtn.textContent = '+';
    indentBtn.title       = 'Increase heading size';
    indentBtn.disabled    = false;
    dedentBtn.textContent = '\u2212'; // −
    dedentBtn.title       = 'Decrease heading size';
    dedentBtn.disabled    = false;
  } else {
    indentBtn.textContent = '\u2192'; // →
    indentBtn.title       = 'Indent list (Tab)';
    indentBtn.disabled    = false;
    dedentBtn.textContent = '\u2190'; // ←
    dedentBtn.title       = 'Dedent list (Shift+Tab)';
    dedentBtn.disabled    = false;
  }

  blockTypeLabel.textContent = block ? block.type : '';
}

// ── Inline formatting (toolbar click / keyboard shortcut) ─────────────────────

/** Shrinks a Range so that leading/trailing whitespace in text nodes falls
 *  outside the selected span.  Only adjusts within a single or adjacent text
 *  nodes — leaves complex multi-element selections alone. */
function trimRangeWhitespace(range: Range, sel: Selection): void {
  // Walk start forward past leading spaces
  if (range.startContainer.nodeType === Node.TEXT_NODE) {
    const text = range.startContainer.textContent ?? '';
    let start = range.startOffset;
    while (start < text.length && text[start] === ' ') { start++; }
    if (start !== range.startOffset) {
      range.setStart(range.startContainer, start);
    }
  }
  // Walk end backward past trailing spaces
  if (range.endContainer.nodeType === Node.TEXT_NODE) {
    const text = range.endContainer.textContent ?? '';
    let end = range.endOffset;
    while (end > 0 && text[end - 1] === ' ') { end--; }
    if (end !== range.endOffset) {
      range.setEnd(range.endContainer, end);
    }
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

function applyInline(type: 'bold' | 'italic' | 'strikethrough' | 'code' | 'link'): void {
  if (!focusedBlockId) { return; }
  const block = blocks.find(b => b.id === focusedBlockId);
  if (!block || block.type !== 'p') { return; }  // inline formatting only in p blocks

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) { return; }

  if (type === 'bold' || type === 'italic') {
    // Trim leading/trailing whitespace from the selection before applying the
    // command so that spaces end up outside the <strong>/<em> markers.
    const range = sel.getRangeAt(0);
    trimRangeWhitespace(range, sel);
    if (type === 'bold')   { document.execCommand('bold'); }
    else                   { document.execCommand('italic'); }
  } else {
    // For strikethrough, code, and links: insert an HTML element directly so the
    // formatted result appears immediately without a re-render round-trip.
    const range = sel.getRangeAt(0);
    const selectedText = range.toString();
    let node: Node;

    if (type === 'strikethrough') {
      const del = document.createElement('del');
      del.textContent = selectedText;
      node = del;
    } else if (type === 'code') {
      const code = document.createElement('code');
      code.className = 'inline-code';
      code.textContent = selectedText;
      node = code;
    } else { // link
      const url = prompt('Enter URL:', 'https://');
      if (!url) { return; }
      const a = document.createElement('a');
      a.href = url;
      a.className = 'inline-link';
      a.setAttribute('tabindex', '-1');
      a.textContent = selectedText || url;
      node = a;
    }

    range.deleteContents();
    range.insertNode(node);
    // Move cursor to after the inserted element
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  syncDomToBlocks();
  postUpdate();
}

// ── Block type conversion (toolbar click) ─────────────────────────────────────

function applyBlockType(newType: BlockType): void {
  if (!focusedBlockId) { return; }
  const block = blocks.find(b => b.id === focusedBlockId);
  if (!block) { return; }

  const oldType = block.type;
  if (newType === 'ul1' && isUlType(oldType)) { return; }
  if (newType === 'ol1' && isOlType(oldType)) { return; }
  if (newType === oldType) { return; }

  syncDomToBlocks();

  // HR: smart insertion (§7.6)
  if (newType === 'hr') {
    const idx = blocks.findIndex(b => b.id === block.id);
    const isLastBlock = idx === blocks.length - 1;
    const isBlank = block.text.trim() === '';

    if (isBlank) {
      // Blank line: insert HR *before* current block so the blank line stays below it.
      // This lets the user type immediately after the HR without extra navigation.
      blocks.splice(idx, 0, makeBlock('hr', ''));
      renumberOl();
      renderBlocks(visualContainer, blocks);
      updateToolbarState();
      focusBlock(block.id, 0);
    } else if (isLastBlock) {
      // Last non-blank block: insert HR then a new blank paragraph so the user
      // can keep typing without having to drag or navigate back.
      const newP = makeBlock('p', '');
      blocks.splice(idx + 1, 0, makeBlock('hr', ''), newP);
      renumberOl();
      renderBlocks(visualContainer, blocks);
      updateToolbarState();
      focusBlock(newP.id, 0);
    } else {
      // Middle of document: insert HR after current block, keep cursor where it was.
      const curEl = getBlockEl(block.id);
      const cursorOffset = curEl ? getSelectionOffsets(getContentEl(curEl, block.type)).start : 0;
      blocks.splice(idx + 1, 0, makeBlock('hr', ''));
      renderBlocks(visualContainer, blocks);
      focusedBlockId = block.id;
      updateToolbarState();
      const el = getBlockEl(block.id);
      if (el) { const target = getContentEl(el, block.type); target.focus(); setCursorOffset(target, cursorOffset); }
    }
    postUpdate();
    return;
  }

  if (isOlType(oldType) && !isOlType(newType)) { block.text = block.text.replace(/^\d+\.\s*/, ''); }
  if (isOlType(newType) && !isOlType(oldType)) { block.text = '1. ' + block.text; }

  block.type = newType;
  renumberOl();
  renderBlocks(visualContainer, blocks);
  focusedBlockId = block.id; // restore before updateToolbarState (renderBlocks clears it via focusout)
  updateToolbarState();

  const el = getBlockEl(block.id); // use block.id — focusedBlockId may have been nulled by focusout
  if (el) {
    const target = newType === 'code' ? ((el.querySelector('code') as HTMLElement) ?? el) : el;
    target.focus();
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  }

  postUpdate();
}

// ── View helpers ──────────────────────────────────────────────────────────────

function setVisualVisible(visible: boolean): void {
  visualContainer.style.display = visible ? 'block' : 'none';
  toolbar.style.display = visible ? 'flex' : 'none';
  if (!visible) { warningBanner.style.display = 'none'; }
}

// ── Toggle logic ──────────────────────────────────────────────────────────────

function switchTo(view: ActiveView): void {
  if (view === activeView) { return; }

  activeView = view;
  vscode.postMessage({ type: 'viewChanged', view: activeView });

  if (view === 'source') {
    if (inputDebounceTimer) { clearTimeout(inputDebounceTimer); inputDebounceTimer = null; }
    syncDomToBlocks();
    sourceView.setValue(serialize(blocks));
    setVisualVisible(false);
    sourceContainer.style.display = 'block';
    sourceView.focus();
  } else {
    renderVisual(sourceView.getValue());
    sourceContainer.style.display = 'none';
    setVisualVisible(true);
  }
}

// ── Visual view ───────────────────────────────────────────────────────────────

function renderVisual(markdown: string): void {
  blocks = parse(markdown);
  renderBlocks(visualContainer, blocks);
  updateToolbarState();
  warningBanner.style.display = detectUnsupported(markdown) ? 'flex' : 'none';
}

/** Convert browser contenteditable innerHTML back to \n-based plain Markdown for block.text.
 *  Reverses inline HTML tags to Markdown syntax first, then handles Chrome's line-wrap divs. */
function htmlToText(html: string): string {
  let text = html;

  // ── Strip Chrome artifact: inline element wrapping only <br> ──────────────
  // When Enter is pressed at a cursor inside <strong>/<em>/etc., Chrome carries the
  // inline tag into the new <div>: e.g. <div><strong><br></strong></div>. These are
  // structural artifacts, not real formatted content — strip to bare <br>.
  text = text.replace(/<(strong|em|del|code|b|i|s)\b[^>]*>(\s*<br\s*\/?>\s*)+<\/\1>/gi, '<br>');
  text = text.replace(/<a\b[^>]*>(\s*<br\s*\/?>\s*)+<\/a>/gi, '<br>');

  // ── Reverse inline formatting tags → Markdown ─────────────────────────────
  // Links: <a href="url">label</a> → [label](url)
  text = text.replace(/<a\b[^>]*\shref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_, url, label) => `[${label}](${url})`);
  // Inline code: <code ...>text</code> → `text`
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  // Bold+Italic combined (check before bold-only / italic-only)
  text = text.replace(/<strong[^>]*><em[^>]*>([\s\S]*?)<\/em><\/strong>/gi, '***$1***');
  text = text.replace(/<em[^>]*><strong[^>]*>([\s\S]*?)<\/strong><\/em>/gi, '***$1***');
  // Bold (<strong> or <b> — execCommand may produce either)
  text = text.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  text = text.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
  // Italic (<em> or <i>)
  text = text.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
  text = text.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');
  // Strikethrough (<del> or <s>)
  text = text.replace(/<del[^>]*>([\s\S]*?)<\/del>/gi, '~~$1~~');
  text = text.replace(/<s[^>]*>([\s\S]*?)<\/s>/gi, '~~$1~~');

  // ── Chrome contenteditable line wrapping → \n ──────────────────────────────
  text = text
    .replace(/\n/g, '')                        // strip browser-inserted literal newlines
    .replace(/<div><br\s*\/?><\/div>/gi, '\n') // empty <div><br></div> → \n
    .replace(/<div>/gi, '\n')                  // <div> open tag → \n (new line)
    .replace(/<\/div>/gi, '')                  // </div> close tag → nothing
    .replace(/<br\s*\/?>/gi, '\n');            // standalone <br> → \n

  // ── HTML entity decode ─────────────────────────────────────────────────────
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

  return text.replace(/^\n+|\n+$/g, '');      // trim leading/trailing newlines
}

function syncDomToBlocks(): void {
  for (const el of Array.from(visualContainer.children) as HTMLElement[]) {
    const id = el.dataset['blockId'];
    if (!id) { continue; }
    const block = blocks.find(b => b.id === id);
    if (!block || block.type === 'hr') { continue; }
    if (block.type === 'code') {
      const code = el.querySelector('code');
      block.text = code ? (code.textContent ?? '') : '';
    } else if (block.type === 'p') {
      block.text = htmlToText(el.innerHTML);
    } else {
      block.text = el.textContent ?? '';
    }
  }
}

// ── Source view sync ──────────────────────────────────────────────────────────

sourceView.onChange((markdown) => {
  vscode.postMessage({ type: 'update', markdown });
});

sourceView.getElement().addEventListener('input', () => findBar.clearHighlights());

// ── Extension host message handling ───────────────────────────────────────────

window.addEventListener('message', (event) => {
  const msg = event.data as {
    type: string;
    markdown?: string;
    defaultView?: ActiveView;
    view?: ActiveView;
    debounceMs?: number;
  };

  switch (msg.type) {
    case 'init': {
      const markdown = msg.markdown ?? '';
      const view = msg.defaultView ?? 'visual';
      debounceMs = msg.debounceMs ?? 300;
      sourceView.setDebounce(debounceMs);
      if (view === 'source') {
        sourceView.setValue(markdown);
        activeView = 'source';
        sourceContainer.style.display = 'block';
        setVisualVisible(false);
      } else {
        renderVisual(markdown);
        activeView = 'visual';
        setVisualVisible(true);
        sourceContainer.style.display = 'none';
        // Auto-focus on empty file (§13.1)
        if (blocks.length === 1 && blocks[0].type === 'p' && blocks[0].text === '') {
          focusBlock(blocks[0].id, 0);
        }
      }
      break;
    }
    case 'setView': {
      if (msg.view) { switchTo(msg.view); }
      break;
    }
    case 'externalChange': {
      const markdown = msg.markdown ?? '';
      if (activeView === 'source') {
        sourceView.setValue(markdown);
      } else {
        renderVisual(markdown);
      }
      break;
    }
  }
});

// ── Signal ready to the extension host ───────────────────────────────────────

vscode.postMessage({ type: 'ready' });
