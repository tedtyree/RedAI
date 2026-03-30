# VS Code Markdown Dual-View Editor — Implementation Plan

**Version:** 0.1 (MVP)

**Status:** Draft

---

## ACTION / To-do

- Bug where inline code is black text on black background (only for one code block)
- How to use the `inline text` feature. 
- Search feature > cntrl-f
- Tables?

---

## 1. Guiding Principles

- Build bottom-up: data model and I/O first, UI last.
- Make the extension host + WebView round-trip work before writing any editor logic.
- Prefer a working but incomplete extension over a complete but unrunnable one at each milestone.

The parser and serializer are pure functions — test them independently before wiring into the UI.

---

## 2. Implementation Order

### Phase 1 — Scaffold

Set up the project skeleton. Nothing visual yet, but `F5` in VS Code launches the extension host.

- `package.json` — extension manifest, activation event, `customEditors` contribution point, esbuild scripts
- `tsconfig.json` — extension host and webview configs (two separate bundles)
- `scripts/build.js` — esbuild build for both bundles
- `src/extension.ts` — register `CustomTextEditorProvider`, stub `resolveCustomTextEditor`
- `webview/index.html` — static shell with placeholder `<div id="app">`

**Exit criteria:** Extension activates, opening a `.md` file shows the blank WebView panel. No errors in the extension host console.

---

### Phase 2 — Round-Trip Core

Wire the document data flow end-to-end. Source editor only. No WYSIWYG yet.

- `webview/model.ts` — `Block` and `BlockType` types
- `webview/parser.ts` — Markdown → `Block[]` (see §12 of Requirements)
- `webview/serializer.ts` — `Block[]` → Markdown (see §10, §11.7)
- `webview/source.ts` — plain `<textarea>`, populates from document, debounced `postMessage` on input
- `webview/editor.ts` — message handler, view toggle stub (Source only for now)
- `src/extension.ts` — handle `update` message via `WorkspaceEdit`; forward `onDidChangeTextDocument` to WebView

**Message protocol (finalized here):**

| Direction | Message type | Payload |

|---|---|---|

| WebView → Host | `update` | `{ markdown: string }` |

| WebView → Host | `ready` | *(none)* |

| Host → WebView | `init` | `{ markdown: string, defaultView: "visual" \| "source" }` |

| Host → WebView | `externalChange` | `{ markdown: string }` |

**Echo-loop guard:** The extension host must ignore `onDidChangeTextDocument` events that it triggered itself (track with a `pendingEdit` flag).

**Exit criteria:** Open a `.md` file, edit in the source `<textarea>`, `Ctrl+S` saves correctly. External edits (e.g. from another editor) refresh the textarea.

---

### Phase 3 — Parser & Serializer Correctness

Before building any WYSIWYG editor, the round-trip must be lossless.

- Write unit tests (or a simple test harness) for `parser.ts` and `serializer.ts`:
  - `serialize(parse(input)) === normalize(input)` for all supported block types
  - List indentation levels (§11.7, §11.8)
  - Code blocks with multi-line content
  - HR detection
  - Unsupported constructs preserved verbatim as `p` blocks

**Exit criteria:** All round-trip tests pass. This is the safety net for all future refactors.

---

### Phase 4 — WYSIWYG Read-Only Rendering

Render the block model visually. No editing yet — just prove the DOM structure is correct.

- `webview/wysiwyg.ts` — `renderBlocks(blocks: Block[]): void`
  - One DOM element per block using correct HTML tags
  - CSS classes `ul1`–`ul7`, `ol1`–`ol7` applied to list blocks
  - `contenteditable="true"` on all except `hr`
  - Bullet `::before` pseudo-element for `ul` types (CSS only)
- `webview/styles.css` — VS Code theme variable bindings, indentation offsets, code block font
- `webview/editor.ts` — toggle control (Visual / Source), switching hides/shows views

**Exit criteria:** Open a `.md` file, switch to Visual tab — all blocks render correctly with appropriate styling. Toggle back to Source — content unchanged.

---

### Phase 5 — WYSIWYG Basic Editing

Character-level editing within a block. No block splits or merges yet.

- Intercept `keydown` in `wysiwyg.ts`
- After each edit, read the block's `textContent` from the DOM, update the block model, serialize, and `postMessage` to host
- Toolbar type-change buttons: read focused block, update type, re-render

**Risk:** Reading cursor offset from a `contenteditable` element before and after DOM manipulation. Use `window.getSelection()` + `Range` to capture offset before any DOM change; restore after re-render using a character-walk.

**Exit criteria:** Typing characters and changing block types via toolbar correctly updates the source view and the saved file.

---

### Phase 6 — Block Split and Merge

The core structural editing operations.

- **Enter** — split block at cursor offset; special cases for `code`, `hr`, `---` text shortcut (§7.3, §7.6)
- **Backspace at position 0** — merge with preceding block; list-specific: demote level first (§11.6)
- **Delete at end** — merge next block into current (§7.3)
- **Arrow key edge navigation** — move focus to adjacent block at top/bottom edge (§7.4)

**Exit criteria:** All keyboard rules from §7.3, §11.6 behave correctly. Cursor lands at the correct position after every split/merge.

---

### Phase 7 — List Behavior

- Tab / Shift-Tab indent/dedent (§11.5)
- Toolbar Indent `→` / Dedent `←` buttons
- `ol` auto-increment on Enter (§11.2)
- `ol` auto-renumber walk on structural changes (§11.2)
- Visual shake animation when indent limit (level 7) is reached

**Risk:** Auto-renumber walk — ensure it stops correctly at non-`ol` blocks and at shallower-level `ol` blocks without over-running.

**Exit criteria:** Full list behavior as specified in §11. Manual edits to numeric prefixes do not trigger renumbering.

---

### Phase 8 — HR and Code Block Polish

- HR toolbar button inserts `hr` after current block (§7.6)
- `---` text shortcut conversion on Enter (§7.6)
- Backspace/Delete deletion of `hr` blocks (§7.6)
- Code block Enter inserts literal newline; Backspace-at-start merges (§7.5)

---

### Phase 9 — Settings, Edge Cases, Accessibility

- Register the three settings from §14 (`defaultView`, `syncDebounceMs`, `makeDefaultEditor`)
- New empty file: single empty `p` block, cursor focused (§13.1)
- Unsupported construct warning banner (§13.2)
- Basic ARIA roles: `role="toolbar"`, `role="button"` on toolbar items (§18 Q4)

---

### Phase 10 — Package and Test

- `vsce package` → `.vsix`
- Install locally and smoke-test end to end
- Verify external-change handling (`onDidChangeTextDocument`)
- Verify save behavior (`Ctrl+S`)

---

## 3. High-Risk Areas (Address Early)

| Risk | Mitigation |

|---|---|

| `contenteditable` cursor position tracking | Implement a robust `getCursorOffset(el)` / `setCursorOffset(el, offset)` utility in Phase 5 before any block operations depend on it. Test it in isolation. |

| Echo loop on `onDidChangeTextDocument` | Implement the `pendingEdit` flag in Phase 2 before any real editing exists. Validate it works under rapid typing. |

| `ol` auto-renumber walk correctness | Write unit tests for the walk logic in Phase 3 alongside parser/serializer tests. |

| WebView state loss on panel hide | VS Code may destroy and recreate the WebView when the tab is hidden. Implement `getState`/`setState` (VS Code WebView persistence API) early to avoid re-parsing the document on every tab show. |

---

---

### Phase 11 — Multi-Block Selection & Block Drag Reordering

Add two interrelated features to the visual editor: the ability to select and operate on multiple blocks at once, and a drag handle for reordering blocks (or groups of blocks) within the document.

**11A — Multi-Block Selection**

- Add state: `selectedBlockIds: Set<string>`, `selectionAnchorId`, `mousedownBlockId`
- Add helpers: `setBlockSelection(anchorId, extentId)`, `exitMultiSelectMode()`, `copySelectedBlocks()`, `deleteSelectedBlocks()`
- `mousedown` on visualContainer: handle shift-click (range select with `e.preventDefault()`) and plain click (set anchor, exit prior selection)
- `mousemove` on visualContainer: detect cross-block drag while button held; kill text selection and switch to block-highlight mode using `setBlockSelection`
- HR fallback: `pointer-events: none` means HR elements are invisible to `elementFromPoint`; fall back to iterating `visualContainer.children` and matching `getBoundingClientRect` to `e.clientY`
- `document mouseup`: finalize selection anchor; `document mousedown`: exit selection on click outside container
- Keyboard: at top of existing `keydown` handler — Ctrl+C copies selected markdown, Delete/Backspace deletes selected blocks, Escape clears selection; `document keydown` handles Escape when no block has focus
- CSS: `.block-selected` highlight, `.visual-container.multi-select-mode { user-select: none }`

**11B — Block Drag Handle & Reordering**

- Create a single shared `div.drag-handle` (SVG: 6 dots, 2 wide × 3 tall) and `div.drop-indicator` (horizontal line), both `position: fixed`, appended to `#app`
- **Show/hide on focus only** (not hover): extend existing `focusin` handler to call `positionDragHandle(blockEl)` when a block receives focus; extend `focusout` to hide handle when focus leaves the container; also show handle when multi-select becomes active (positioned at anchor block)
- Add drag state: `isDraggingBlock`, `dragAnchorBlockId`, `dropTargetIndex`
- `dragHandle mousedown`: set drag state; if dragged block not in selection, clear selection (single-block drag); `document.body.style.cursor = 'grabbing'`
- `document mousemove` during drag: compute `dropTargetIndex` (midpoint comparison across all block rects), position drop indicator line between blocks
- `document mouseup` during drag: call `executeDrop()` — extract dragged blocks from array, splice into new position, re-render, restore selection highlight if multi-select was active
- CSS: `.drag-handle { position: fixed; cursor: grab; ... }`, `.drop-indicator { position: fixed; height: 2px; background: focusBorder; pointer-events: none }`

**Exit criteria:** Single and multi-block selection work via drag and shift-click. Ctrl+C and Delete operate on the selection. Drag handle appears when a block is focused or blocks are selected. Dragging the handle moves the block(s) to the drop position with a visible indicator line. OL renumbering fires correctly after reorder.

### Test for Multi-select, copy, and drop-drop

#### Multi-block selection:

1. Open any .md file in Visual mode, click into a paragraph to focus it
2. Click and drag downward past the block boundary — blocks should highlight as you cross them
3. Release; then Shift+click a different block — selection should extend to it
4. Press Ctrl+C, paste in another editor — should get the selected blocks as markdown
5. With blocks selected, press Delete — selected blocks disappear
6. Press Escape at any point — selection clears

#### Drag handle & reorder:

1. Click into any block — a small ⠿ icon should appear in the left margin next to it
2. Grab the icon and drag up/down — a blue horizontal line should track between blocks
3. Release — block should land at the indicated position
4. Select 3 blocks (drag-select or shift-click), then grab the handle on the anchor block — all 3 move together

#### Edge cases worth checking:

1. Drag-select through an --- (HR) block — it should be included in the range
2. Reorder an OL list block — numbers should renumber correctly after the drop
3. Click outside the editor — selection and handle should disappear

---

### Phase 12 — Multi-line Paragraphs & Empty Paragraph Preservation

Improve Markdown fidelity in the visual editor by aligning paragraph behavior with how Markdown source actually works.

**12A — Multi-line Paragraph Parsing**

- Update `parser.ts`: the paragraph fallback now consumes consecutive non-blank lines into one `p` block, joining them with `\n`. Any line matching another block pattern (heading, HR, list, blockquote, code fence) terminates the paragraph.
- This means `Hello\nWorld\n\nNext` parses to two blocks — `{p:'Hello\nWorld'}` and `{p:'Next'}` — rather than three.

**12B — Hard Line Breaks Within Paragraphs**

- Add `white-space: pre-wrap` to `.block-p` in `styles.css` so that `\n` in `block.text` renders as a visual line break.
- Add `margin-top: 0.9em` to `.block-p` for visual paragraph separation (mirrors rendered Markdown spacing).
- Update `handleEnter` in `editor.ts` for `p` blocks only:
  - If cursor is on a **blank visual line** (the current line has no text) → split into two paragraph blocks (double-Enter = new paragraph).
  - Otherwise → insert `\n` at cursor (hard line break within the block, stays one block).
  - All other block types (headings, lists, blockquote, code, hr) keep existing split behavior.

**12C — Empty Paragraph Preservation (`&nbsp;` sentinel)**

- Update `serializer.ts`: a `p` block with empty text that is **not the last block** serializes as `&nbsp;` instead of an empty string. This preserves intentional blank lines across file close/reopen.
- Update `parser.ts`: a line whose trimmed content is exactly `&nbsp;` creates an empty `p` block (strips the entity; model stores `''`).
- The visual editor shows an empty editable block; the Markdown source shows `&nbsp;` as the placeholder.

**Exit criteria:** Single Enter in a paragraph inserts a hard line break; double Enter creates a new paragraph block. Blank lines between paragraphs survive save/reload. Existing Markdown files with multi-line paragraphs (consecutive non-blank lines) open as single blocks. The `---` text shortcut and all other block types behave as before.

### Test for Phase 12

1. Type a paragraph, press Enter once → cursor moves to next visual line within the same block
2. Press Enter again (on the blank line) → new paragraph block created below
3. Type in two separate paragraph blocks; add a blank line between them (Enter twice in one block), save, close, reopen → blank line should still be there
4. Switch to source view → `&nbsp;` appears on its own line between paragraphs; multi-line paragraphs show consecutive lines with no blank line between them
5. Open an existing Markdown file that has two consecutive non-blank paragraph lines → they should open as one block with a visible line break
6. Arrow Up/Down through a multi-line paragraph block navigates line by line correctly
7. `---` text shortcut still works (type `---` in a fresh block, press Enter → converts to HR)

---

## 4. Out of Scope (MVP)

See Requirements §3 and §17. Do not implement inline formatting, links, images, or tables.
