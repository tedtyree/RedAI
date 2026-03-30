// Block model — the internal representation of a Markdown document.
// This is the single source of truth in the WebView; the extension host
// owns the TextDocument on disk.

export type BlockType =
  | 'p'
  | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  | 'ul1' | 'ul2' | 'ul3' | 'ul4' | 'ul5' | 'ul6' | 'ul7'
  | 'ol1' | 'ol2' | 'ol3' | 'ol4' | 'ol5' | 'ol6' | 'ol7'
  | 'blockquote'
  | 'code'
  | 'hr';

export interface Block {
  id: string;
  type: BlockType;
  /** Plain text content. For ol blocks, includes the numeric prefix (e.g. "1. "). */
  text: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function isListType(type: BlockType): boolean {
  return type.startsWith('ul') || type.startsWith('ol');
}

export function isUlType(type: BlockType): boolean {
  return type.startsWith('ul');
}

export function isOlType(type: BlockType): boolean {
  return type.startsWith('ol');
}

/** Returns the indent level (1–7) for a list block type, or 0 for non-list. */
export function listLevel(type: BlockType): number {
  if (isListType(type)) return parseInt(type.slice(2), 10);
  return 0;
}

/** Returns a list block type at the given level, preserving ul/ol prefix. */
export function listTypeAtLevel(type: BlockType, level: number): BlockType {
  const prefix = type.slice(0, 2); // "ul" or "ol"
  const clamped = Math.max(1, Math.min(7, level));
  return `${prefix}${clamped}` as BlockType;
}

/** Generate a simple unique ID (not cryptographically random — sufficient for block identity). */
export function newId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function makeBlock(type: BlockType, text = ''): Block {
  return { id: newId(), type, text };
}
