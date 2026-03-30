# VS Code Markdown Dual-View Editor — Requirements Document

**Version:** 0.1 (MVP)
**Status:** Draft
**Document Type:** Product & Technical Requirements

---

## 1. Overview

This document defines the requirements for a VS Code extension that provides a dual-view editor for Markdown (`.md`) files. The editor allows the user to toggle between a **WYSIWYG visual editor** and a **raw Markdown source editor**. Both views are fully editable, and changes in either view are immediately reflected in the other. The underlying file on disk is kept in sync at all times.

The extension is delivered as a self-contained installable VS Code extension (`.vsix`) and does not require forking or modifying the VS Code source.

---

## 2. Goals

- Provide an intuitive visual editing experience for Markdown files inside VS Code.
- Eliminate the need to memorize Markdown syntax for everyday editing tasks.
- Keep the raw Markdown source accessible and fully editable for power users.
- Ensure bidirectional sync: the visual view and the source view are always representations of the same underlying document.
- Ship a working, testable MVP with intentionally limited scope. Complexity is deferred, not ignored.

---

## 3. Non-Goals (MVP)

The following are explicitly out of scope for the MVP and are deferred to future versions:

| Feature | Reason Deferred |
|---|---|
| Inline bold / italic formatting | Round-tripping `**word**` inside a paragraph requires tracking inline spans — significant complexity |
| Inline code `` `backtick` `` | Same inline span problem |
| Hyperlinks `[text](url)` | Requires a custom link editor UI to avoid exposing raw syntax in WYSIWYG |
| Images | File path resolution, drag-and-drop, alt text — deserves its own milestone |
| Nested lists | Tree management and indentation logic are non-trivial |
| Tables | High complexity, low MVP value |
| HTML passthrough blocks | Out of scope entirely |
| Strikethrough, highlight, other extended syntax | GFM extensions deferred |
| Multi-cursor / column selection in WYSIWYG | Not supported in MVP |
| Undo/redo history across view switches | Undo history is per-view in MVP |

---

## 4. Extension Architecture

### 4.1 Delivery Mechanism

The feature is built as a **VS Code Custom Editor Extension** using the `CustomTextEditorProvider` API. It does not modify VS Code core and is installable as a standard extension via:

- A local `.vsix` package (`vsce package`)
- The VS Code Marketplace (future)
- Direct folder drop into `~/.vscode/extensions/` for development

### 4.2 File Association

The extension registers as a custom editor for files matching the glob `**/*.md`. The user can choose to open a `.md` file with this editor via the VS Code "Open With..." menu, or it can be set as the default editor for `.md` files in workspace or user settings.

### 4.3 Component Layers

The extension consists of two layers that communicate via the VS Code WebView message-passing API:

**Extension Host** (`src/extension.ts`)
- Runs in VS Code's Node.js process
- Registers the `CustomTextEditorProvider`
- Owns the `TextDocument` (the file on disk)
- Receives document change events and forwards them to the WebView
- Receives edit messages from the WebView and applies them to the document via `WorkspaceEdit`

**WebView** (`webview/`)
- Runs in a sandboxed browser-like iframe context inside VS Code
- Renders the toggle UI, the WYSIWYG editor, and the source editor
- Parses the Markdown document into the internal block model on load
- Serializes the internal block model back to Markdown on every edit
- Sends serialized Markdown to the Extension Host after each change

### 4.4 Source of Truth

The **`TextDocument` managed by VS Code** is the single source of truth. All edits — whether made in the visual view or the source view — are ultimately written back to the `TextDocument`. The WebView never writes directly to disk; it always routes changes through the Extension Host.

---

## 5. Document Model

### 5.1 Block-Based Representation

The document is modeled internally as an **ordered array of blocks**. Every block has exactly one type. There is no nesting of blocks in MVP.

```
Document := Block[]

Block := {
  id:      string          // stable UUID for this block
  type:    BlockType
  text:    string          // plain text content (no inline markup in MVP)
}

BlockType := 
  | "p"           // paragraph
  | "h1"          // heading level 1
  | "h2"          // heading level 2
  | "h3"          // heading level 3
  | "h4"          // heading level 4
  | "h5"          // heading level 5
  | "h6"          // heading level 6
  | "ul"          // unordered list item (semi-nesting based on intentation and class ul1, ul2, ul3, etc. see below)
  | "ol"          // ordered list item (no nesting; o1, o2, o3...display number is text at the start of the line. see below)
  | "blockquote"  // block quote
  | "code"        // fenced code block (treated as verbatim plain text)
  | "hr"          // horizontal rule (text is always empty)
```

### 5.2 Inline Formatting (MVP Deferral)

In MVP, **all text within a block is treated as plain text**. Bold, italic, inline code, and links are not parsed or rendered. If the raw Markdown source contains inline markup (e.g., `**bold**`), it is displayed verbatim as literal characters in the WYSIWYG view and is preserved as-is in the source. It is not interpreted or lost.

This makes the round-trip parser trivially correct for MVP and eliminates the largest source of WYSIWYG complexity.

---

## 6. View Toggle

### 6.1 Toggle Control

A persistent toggle control is anchored to the top of the editor panel. It is always visible regardless of scroll position (fixed/sticky positioning). The toggle has two states:

- **Visual** — renders the WYSIWYG block editor
- **Source** — renders the raw Markdown text editor

The toggle is implemented as a segmented button control (two labeled buttons, one active at a time).

### 6.2 Toggle Behavior

When the user switches views:

1. The currently active view's content is serialized to Markdown.
2. That Markdown is set as the new content of the inactive view.
3. The inactive view becomes visible; the active view is hidden (not destroyed).
4. The document is **not saved** on toggle — the toggle is a view change, not a save event.

### 6.3 Scroll Position

Scroll position is not synchronized between views in MVP. Each view maintains its own scroll position independently.

---

## 7. WYSIWYG Editor

### 7.1 Rendering

Each block in the document model is rendered as a distinct DOM element using the appropriate HTML tag (`<p>`, `<h1>`–`<h6>`, `<li>`, `<blockquote>`, `<pre>`, `<hr>`). All block elements have `contenteditable="true"` (except `<hr>`, which is not editable).

Blocks are rendered with VS Code's theme CSS variables so the editor respects the user's chosen VS Code color theme (light, dark, high contrast).

### 7.2 Block Type Toolbar

A formatting toolbar appears below the toggle control. It contains buttons for each block type. Clicking a button changes the type of the block that currently contains the cursor.

**Toolbar buttons (MVP):**

`P` | `H1` | `H2` | `H3` | `H4` | `H5` | `H6` | `" "` (blockquote) | `UL` | `OL` | `</>` (code) | `---` (hr)

**Type-change behavior:** When the user clicks a block type button, the **entire block** containing the cursor is converted to that type. There is no partial-block type assignment. The block's text content is preserved.

### 7.3 Keyboard Editing Rules

These rules define how standard keyboard interactions map to operations on the block array:

**Enter key (carriage return)**

Pressing Enter while the cursor is within a block (at any position — beginning, middle, or end) **splits the block at the cursor position** into two blocks:

- The text before the cursor becomes a new block of the **same type** as the original.
- The text after the cursor becomes a new block of type `p` (paragraph), except:
  - If the original block was `ul` or `ol`, the new block inherits `ul` or `ol` respectively.
  - If the original block was `hr`, Enter has no effect.
  - If the original block was `code`, Enter inserts a literal newline within the code block (code blocks are multi-line).

The cursor is placed at the start of the newly created second block.

**Backspace at start of block**

When the cursor is at the **very beginning** of a block (position 0) and Backspace is pressed:

- The current block is merged into the **preceding block**.
- The resulting merged block takes on the **type of the preceding block**.
- The text content of both blocks is concatenated (preceding text + current text).
- The cursor is placed at the junction point (the position where the two text contents meet).
- If there is no preceding block, Backspace has no effect.

**Delete at end of block**

When the cursor is at the **very end** of a block and the Delete key is pressed:

- The **next block** is merged into the current block.
- The resulting merged block takes on the **type of the current block**.
- If there is no next block, Delete has no effect.

**All other keystrokes**

Standard character insertion, deletion, and navigation behave normally within a block's text content. The block array is not modified.

### 7.4 Block Selection and Focus

Only one block has keyboard focus at a time. Clicking anywhere within a block focuses it and places the cursor at the clicked position. Arrow keys navigate within the text of the focused block; at the top/bottom edge of a block, arrow keys move focus to the adjacent block.

### 7.5 Code Blocks

Code blocks (`type: "code"`) are rendered as `<pre><code contenteditable="true">`. They are exempt from the Enter-to-split rule — the Enter key inserts a literal newline within the code block. The Backspace-at-start rule still applies (pressing Backspace at the very beginning of a code block merges it with the preceding block).

Code blocks display their text in a monospace font. No syntax highlighting in MVP.

### 7.6 Horizontal Rules

Horizontal rules (`type: "hr"`) are rendered as a non-editable `<hr>` element. They cannot receive focus or be edited. They can be deleted by placing the cursor at the start of the following block and pressing Backspace, or at the end of the preceding block and pressing Delete. They can be inserted by clicking the `---` toolbar button (which converts the current empty block to `hr`, or inserts a new `hr` block if the current block has content).

---

## 8. Source Editor

### 8.1 Rendering

The source editor displays the raw Markdown text of the document. In MVP, this is rendered as a plain `<textarea>` element styled to fill the available space.

Future versions may replace the `<textarea>` with an embedded CodeMirror or Monaco instance for syntax highlighting and richer editing UX.

### 8.2 Sync Behavior

Changes made in the source editor are synced to the Extension Host (and thus to the `TextDocument`) using a **debounced input event** with a 300ms delay. This prevents excessive round-trips while the user is actively typing.

When the source editor is active, the WYSIWYG view is not updated in real time. The WYSIWYG view is rebuilt from the source content at the moment the user **switches back to the Visual tab**.

---

## 9. Bidirectional Sync Protocol

### 9.1 WYSIWYG → Source

After every block-model-mutating event in the WYSIWYG editor (keystroke, Enter, Backspace-merge, toolbar click), the block array is serialized to Markdown (see Section 10) and sent to the Extension Host via `postMessage`. The Extension Host applies the Markdown as a full-document replacement to the `TextDocument` using `WorkspaceEdit`.

### 9.2 Source → WYSIWYG

After every debounced input event in the source editor, the raw Markdown text is sent to the Extension Host via `postMessage`. The Extension Host applies it to the `TextDocument`.

When the user switches from Source to Visual, the WebView requests the current document content from the Extension Host, parses it into the block model, and re-renders the WYSIWYG view.

### 9.3 External Changes

If the underlying file is modified by an external process (e.g., a `git pull` or another editor), VS Code fires a `TextDocumentChangeEvent`. The Extension Host forwards the new content to the WebView, which rebuilds the active view.

### 9.4 Save

Saving (`Ctrl+S` / `Cmd+S`) is handled by VS Code's standard save mechanism. The Extension Host triggers a `TextDocument.save()`. No special behavior is required in the WebView for save.

---

## 10. Markdown Serialization Rules

The following rules define how the internal block model serializes to Markdown text. This serializer must be **deterministic and lossless** for the block types it supports.

| Block Type | Serialization |
|---|---|
| `p` | Plain text, no prefix. Followed by one blank line. |
| `h1` | `# text` followed by one blank line. |
| `h2` | `## text` followed by one blank line. |
| `h3` | `### text` followed by one blank line. |
| `h4` | `#### text` followed by one blank line. |
| `h5` | `##### text` followed by one blank line. |
| `h6` | `###### text` followed by one blank line. |
| `ul` | `- text`. Consecutive `ul` blocks are grouped without blank lines between them. One blank line after the last item in the group. |
| `ol` | `N. text` where N is the 1-based index within the consecutive run of `ol` blocks. Same grouping rules as `ul`. |
| `blockquote` | `> text` followed by one blank line. |
| `code` | ` ``` ` on its own line, then the verbatim text content, then ` ``` ` on its own line, followed by one blank line. |
| `hr` | `---` followed by one blank line. |

**Trailing newline:** The serialized document always ends with a single newline character.

---
# New Section to Add to Requirements Document

Insert this as **Section 11** and renumber the existing sections 11–17 to 12–18.

---

## 11. List Block Behavior

### 11.1 Block Types

Unordered and ordered lists are represented as flat block types in the document model. There is no tree structure. Each list item is a self-contained block whose visual indentation level is encoded in its type. Ten block types cover all list items:

| Block Type | Description |
|---|---|
| `ul1` | Unordered list item, indent level 1 |
| `ul2` | Unordered list item, indent level 2 |
| `ul3` | Unordered list item, indent level 3 |
| `ul4` | Unordered list item, indent level 4 |
| `ul5` | Unordered list item, indent level 5 (maximum) |
| `ol1` | Ordered list item, indent level 1 |
| `ol2` | Ordered list item, indent level 2 |
| `ol3` | Ordered list item, indent level 3 |
| `ol4` | Ordered list item, indent level 4 |
| `ol5` | Ordered list item, indent level 5 (maximum) |

The `BlockType` union in Section 5.1 is updated to include these ten types in place of the previous `ul` and `ol` entries.

### 11.2 Ordered List Numbering

The numeric prefix of an ordered list item (e.g. 1., 2., 3.) is part of the block's plain text content, not computed or managed by the renderer. This gives the user full control while keeping the model simple.
Auto-increment on Enter: When the user presses Enter at the end of an ol block, the newly created block inherits the same indent level and its text is pre-populated with the previous block's number incremented by one, followed by a period and a space (e.g. if the previous block's text begins with 3. , the new block begins with 4. ). The cursor is placed after the prefix, ready to type. The auto-increment logic reads the leading numeric token from the previous block's text. If no numeric prefix is found, the new block defaults to 1. .
First block in a sequence: If the user creates a new ol block via the toolbar (not via Enter), and there is no preceding ol block of the same level immediately above, the block's text is pre-populated with 1. .
Auto-renumber on structural change: After any operation that inserts, deletes, or changes the type/level of an ol block, the extension attempts to renumber subsequent blocks at the same indent level. The renumbering walk works as follows:

Starting from the position of the changed block, walk forward through the block array.
For each subsequent block:

If it is an ol block at the same indent level as the changed block, renumber it by reading the current block's number and incrementing by one. Continue walking.
If it is an ol block at a deeper indent level, skip it without modification. Continue walking.
If it is any other block type — including p, h1–h6, ul of any level, or an ol block at a shallower indent level — stop the renumbering walk immediately.


The changed block itself is also renumbered if it was not a deletion (i.e. its number is set to one greater than the nearest preceding ol block at the same level, or 1 if none exists).

No renumber on manual text edit: If the user manually edits the numeric prefix text of an ol block directly, no automatic renumbering is triggered. Auto-renumber only fires on structural operations (Enter, Backspace/demote, toolbar type change, block deletion).

### 11.3 Visual Rendering

In the WYSIWYG view, each list block type maps to a CSS class that controls left margin indentation. Unordered list items are rendered with a bullet character (•) injected via CSS ::before pseudo-element (not stored in the text content). Ordered list items render their text as-is, including the user-managed numeric prefix.
Indentation uses a consistent per-level offset (suggested: 24px per level). The CSS classes ul1–ul5 and ol1–ol5 are applied to <div contenteditable="true"> elements.
No enforcement is applied to list structure. A ul3 block may appear directly after a p block with no ul1 or ul2 above it. A ul2 may be followed immediately by an ol2. These are permitted, consistent with CommonMark's permissive approach to list structure.

### 11.4 Toolbar Controls

The formatting toolbar (Section 7.2) is updated to include the following list controls:

| Control | Action |
|---|---|
| `UL` button | Converts the current block to `ul1` (or `ul1` if not currently a list block). If the block is already a `ul` type, it remains at its current level. |
| `OL` button | Converts the current block to `ol1` (or `ol1` if not currently a list block). If the block is already an `ol` type, it remains at its current level. |
| `→` (Indent) button | Increases the indent level of the current block by one (see Section 11.5). Equivalent to pressing Tab. |
| `←` (Dedent) button | Decreases the indent level of the current block by one (see Section 11.5). Equivalent to pressing Shift-Tab. |

The indent and dedent buttons are only active (not greyed out) when the focused block is a `ul` or `ol` type.

### 11.5 Indent and Dedent Rules

**Tab key / Indent button**

When the cursor is in a `ul` or `ol` block and the user presses Tab (or clicks the indent button):

- The block's type increments one level (e.g. `ul2` → `ul3`, `ol1` → `ol2`).
- The text content is unchanged.
- If the block is already at level 5 (`ul5` or `ol5`), the indent action is blocked and a brief visual shake animation is applied to the block to indicate the limit has been reached. No audio is required in MVP.
- Tab has no special indent behavior outside of `ul`/`ol` blocks (it does not insert a tab character; standard VS Code WebView behavior applies).

**Shift-Tab key / Dedent button**

When the cursor is in a `ul` or `ol` block and the user presses Shift-Tab (or clicks the dedent button):

- The block's type decrements one level (e.g. `ul3` → `ul2`, `ol2` → `ol1`).
- The text content is unchanged.
- If the block is at level 1 (`ul1` or `ol1`), it is converted to a `p` block. The text content is preserved.

### 11.6 Keyboard Editing Rules for List Blocks

These rules extend (and in some cases override) the general keyboard rules in Section 7.3.

**Enter key**

Pressing Enter within a `ul` or `ol` block splits the block at the cursor position. The new block inherits the **same type** (same list type and same indent level) as the original. For `ol` blocks, the new block's text is pre-populated using the auto-increment rule described in Section 11.2.

This behavior applies regardless of whether the block is empty. An Enter on an empty `ul2` block creates another empty `ul2` block. There is no automatic level-promotion or list-exit on empty list items.

**Backspace at start of block**

When the cursor is at position 0 of a `ul` or `ol` block and Backspace is pressed, the behavior depends on the current indent level:

- **Level 2–5:** The block is demoted one level (equivalent to Shift-Tab / Dedent). Text content is unchanged. The block is **not** merged with the previous block.
- **Level 1 (`ul1` or `ol1`):** The block is converted to a `p` block. Text content is unchanged. The block is **not** merged with the previous block.

The full three-step sequence for a user pressing Backspace repeatedly at position 0:

1. `ul3` → `ul2` (demote)
2. `ul2` → `ul1` (demote)
3. `ul1` → `p` (exit list)
4. `p` at position 0 → merge with previous block (standard merge rule from Section 7.3)
5. At steps 1–3, if the block being demoted or converted was an ol type, the auto-renumber walk fires from that position per Section 11.2.

**Delete at end of block**

Standard behavior from Section 7.3 applies. The next block is merged into the current block, and the current block's type is preserved.

### 11.7 Markdown Serialization for List Blocks

List blocks serialize using CommonMark-style indentation: **2 spaces per indent level** (level 1 = 0 extra spaces, level 2 = 2 spaces, level 3 = 4 spaces, etc.).

| Block Type | Serialized Prefix |
|---|---|
| `ul1` | `- ` |
| `ul2` | `  - ` |
| `ul3` | `    - ` |
| `ul4` | `      - ` |
| `ul5` | `        - ` |
| `ol1` | *(text as-is, e.g. `1. Item`)* |
| `ol2` | `  ` + text (e.g. `  2. Item`) |
| `ol3` | `    ` + text |
| `ol4` | `      ` + text |
| `ol5` | `        ` + text |

Consecutive list blocks of any `ul` or `ol` type are serialized without blank lines between them. A single blank line is emitted after the last list block in a consecutive run, before the next non-list block.

### 11.8 Markdown Parsing for List Blocks

The parser detects list blocks by line prefix using the following rules, applied in order:

1. Count the number of leading spaces on the line. Divide by 2 (integer division) to determine indent level (minimum 1, maximum 5).
2. If the non-whitespace content begins with `- ` or `* `, the block is a `ul` block at the computed level.
3. If the non-whitespace content begins with one or more digits followed by `. `, the block is an `ol` block at the computed level. The full `N. ` prefix is retained as part of the block's text content.
4. Indentation that does not map cleanly to a 2-space multiple is rounded down to the nearest level.

---

## 11. Markdown Parser Rules

The parser converts raw Markdown text into the internal block model. It is a **line-by-line parser** that identifies block types by line prefixes and delimiter patterns. It does not use a full CommonMark-compliant parser in MVP; it uses a purpose-built parser tuned for the supported block types.

**Parser rules:**

- Blank lines are separators between blocks and are discarded.
- A line beginning with `#` through `######` followed by a space is a heading block; the prefix is stripped to produce the text.
- A line beginning with `- ` or `* ` is a `ul` block; the prefix is stripped.
- A line beginning with a digit, a period, and a space (e.g., `1. `) is an `ol` block; the prefix is stripped. The original number is discarded; display numbers are recomputed from position.
- A line beginning with `> ` is a `blockquote` block; the prefix is stripped.
- A line that is exactly `---`, `***`, or `___` (with optional surrounding blank lines) is an `hr` block.
- A line that is exactly ` ``` ` begins a code block. All subsequent lines until the closing ` ``` ` are the code block's text content (newlines preserved).
- All other lines are `p` blocks.

**Parser fidelity note:** The parser is intentionally simple. Markdown features not enumerated above (e.g., inline formatting, links, images, HTML) are not parsed. Lines containing these constructs are treated as `p` blocks with their raw text preserved verbatim. This ensures no content is lost.

---

## 12. File Handling & Edge Cases

### 12.1 New Empty Files

A new empty `.md` file opens in the Visual view with a single empty `p` block, cursor focused.

### 12.2 Large Files

No explicit file size limit in MVP. If performance degrades on very large files, a warning may be surfaced to the user. Virtualized rendering (only rendering visible blocks) is a future optimization.

### 12.3 Unsupported Markdown Content

If the source Markdown contains constructs the parser does not support (e.g., tables, footnotes, HTML), those lines are rendered as literal-text `p` blocks in the WYSIWYG view. They are serialized back as plain text. This is safe because the MVP serializer preserves their text content; however, their original Markdown syntax may not be preserved if they were complex multi-line constructs. A warning banner should be shown in the WYSIWYG view when unsupported constructs are detected.

### 12.4 Encoding

All file I/O uses UTF-8. No special handling for other encodings in MVP.

---

## 13. Settings & Configuration

The following settings are exposed in VS Code's settings UI under the extension's namespace (e.g., `mdDualView.*`):

| Setting | Type | Default | Description |
|---|---|---|---|
| `mdDualView.defaultView` | `"visual"` \| `"source"` | `"visual"` | Which view is shown when a file is first opened |
| `mdDualView.syncDebounceMs` | number | `300` | Debounce delay (ms) for source-to-host sync |
| `mdDualView.makeDefaultEditor` | boolean | `false` | If true, registers as the default editor for `.md` files |

---

## 14. Project Structure

```
md-dual-view/
├── package.json              # Extension manifest
├── tsconfig.json
├── src/
│   └── extension.ts          # Extension host: registers CustomTextEditorProvider
├── webview/
│   ├── index.html            # WebView shell
│   ├── editor.ts             # Main WebView entry point
│   ├── model.ts              # Block model types and operations
│   ├── parser.ts             # Markdown → block model parser
│   ├── serializer.ts         # Block model → Markdown serializer
│   ├── wysiwyg.ts            # WYSIWYG view renderer and event handlers
│   ├── source.ts             # Source view (textarea) renderer and event handlers
│   └── styles.css            # Editor styles using VS Code CSS variables
└── scripts/
    └── build.js              # Bundles webview/ for production
```

---

## 15. Technology Choices

| Concern | Choice | Rationale |
|---|---|---|
| Extension language | TypeScript | Standard for VS Code extensions; strong API typings |
| WebView UI framework | Vanilla TypeScript (no framework) | Minimizes bundle size and complexity for MVP; no virtual DOM needed |
| Markdown parser | Purpose-built (see Section 11) | Avoids dependency on a full CommonMark parser whose output model may not match our block model |
| Markdown serializer | Purpose-built (see Section 10) | Full control over whitespace and output format |
| Bundler | esbuild | Fast; handles both extension host and webview bundles |
| Package/publish tool | `@vscode/vsce` | Standard VS Code extension packaging |

---

## 16. OUT OF SCOPE

- Block-based WYSIWYG editing. Full bidirectional sync. No inline formatting.

- Inline Formatting: Bold (`**`), italic (`*`), and inline code (`` ` ``). Requires inline span model and `contenteditable` selection tracking.

- Links: Hyperlink insertion via a small popover UI. Link editing and removal.

- Lists: Nesting - Tab/Shift-Tab to indent/outdent list items. Multi-level `ul` and `ol`.

- Images: Drag-and-drop image insertion. Relative and absolute path support. Alt text editing.

- Tables: Table block type with row/column editing UI.

---

## 17. Open Questions

1. **Conflict resolution:** If the file is modified externally while the user has unsaved changes in the WebView, how should conflicts be handled? (Options: last-write-wins, show a diff, prompt the user.)
ANSWER: defer to VS Code's native behavior and don't reinvent it. You get it for free. The only work on your end is making sure your WebView responds correctly to the onDidChangeTextDocument event so the visual view doesn't go stale after a silent reload.

2. **Code block language tag:** Should the fenced code block support a language specifier (e.g., ` ```javascript `)? If so, how is it exposed in the WYSIWYG toolbar?
ANSWER: No. Not for MVP.

3. **Undo/redo:** Should Ctrl+Z in the WYSIWYG view undo block-model operations, or delegate to the browser's built-in `contenteditable` undo? The latter is simpler but may behave unexpectedly at block boundaries (merge/split).
ANSWER: For MVP start with the simple approach.

4. **Accessibility:** What ARIA roles and keyboard navigation patterns are required for the toolbar and block editor for screen reader compatibility?
ANSWER: For MVP, focus on basic ARIA roles like `role="toolbar"` and `role="button"`. Keyboard navigation should follow standard patterns (Tab for focus, Enter for activation). Keep it simple. This is just MVP.

5. **Multi-root workspaces:** Are there any special considerations for resolving relative image paths in multi-root workspaces? (Relevant for v0.5.)
ANSWER: For MVP, assume a single root workspace. Multi-root support can be added later.