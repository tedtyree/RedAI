// Find bar — floating search widget activated by Ctrl+F.
// Highlights all case-insensitive text matches in the active view and supports
// next/prev navigation via Enter / Shift+Enter / ↑↓ buttons.

export class FindBar {
  private readonly bar: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly counter: HTMLSpanElement;

  /** All current highlight spans, in document order. */
  private matches: HTMLElement[] = [];
  private currentIndex = -1;

  constructor(
    app: HTMLElement,
    private readonly getSearchRoot: () => HTMLElement | null,
  ) {
    // ── Build DOM ────────────────────────────────────────────────────────────

    this.bar = document.createElement('div');
    this.bar.className = 'find-bar';
    this.bar.style.display = 'none';

    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 'find-input';
    this.input.placeholder = 'Find';
    this.input.setAttribute('spellcheck', 'false');

    this.counter = document.createElement('span');
    this.counter.className = 'find-counter';

    const prevBtn  = this.makeBtn('↑', 'Previous match (Shift+Enter)', () => this.navigate(-1));
    const nextBtn  = this.makeBtn('↓', 'Next match (Enter)',           () => this.navigate(1));
    const closeBtn = this.makeBtn('✕', 'Close (Escape)',               () => this.close());
    closeBtn.classList.add('find-close');

    this.bar.append(this.input, this.counter, prevBtn, nextBtn, closeBtn);
    app.appendChild(this.bar);

    // ── Events ───────────────────────────────────────────────────────────────

    this.input.addEventListener('input', () => this.search());

    this.input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        this.navigate(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });

    // Prevent clicks on the bar from stealing focus away from the input
    this.bar.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.target !== this.input) { e.preventDefault(); }
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  open(): void {
    this.bar.style.display = 'flex';
    this.input.select();
    this.input.focus();
    // Re-run search so highlights appear immediately if there's already a query
    if (this.input.value) { this.search(); }
  }

  close(): void {
    this.bar.style.display = 'none';
    this.clearHighlights();
  }

  isOpen(): boolean {
    return this.bar.style.display !== 'none';
  }

  /**
   * Remove all highlight spans and restore the original text nodes.
   * Must be called before any operation that reads innerHTML / innerText
   * from the editor DOM to avoid leaking <span> tags into the document.
   */
  clearHighlights(): void {
    for (const span of this.matches) {
      const parent = span.parentNode;
      if (!parent) { continue; }
      parent.replaceChild(document.createTextNode(span.textContent ?? ''), span);
      parent.normalize();
    }
    this.matches = [];
    this.currentIndex = -1;
    this.updateCounter();
  }

  navigate(direction: 1 | -1): void {
    if (this.matches.length === 0) { return; }
    this.matches[this.currentIndex]?.classList.remove('find-match-active');
    this.currentIndex =
      (this.currentIndex + direction + this.matches.length) % this.matches.length;
    this.activateCurrent();
    this.updateCounter();
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private makeBtn(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'find-btn';
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', onClick);
    return btn;
  }

  private search(): void {
    this.clearHighlights();
    const query = this.input.value;
    if (!query) { return; }

    const root = this.getSearchRoot();
    if (!root) { return; }

    const lowerQuery = query.toLowerCase();

    // Collect text nodes first — modifying the DOM inside the loop would
    // invalidate the TreeWalker's internal cursor.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      textNodes.push(node as Text);
    }

    for (const textNode of textNodes) {
      const text   = textNode.nodeValue ?? '';
      const lowerText = text.toLowerCase();
      let lastIndex = 0;
      const fragments: Node[] = [];

      let idx: number;
      while ((idx = lowerText.indexOf(lowerQuery, lastIndex)) !== -1) {
        if (idx > lastIndex) {
          fragments.push(document.createTextNode(text.slice(lastIndex, idx)));
        }
        const span = document.createElement('span');
        span.className = 'find-match';
        span.textContent = text.slice(idx, idx + query.length);
        fragments.push(span);
        this.matches.push(span);
        lastIndex = idx + query.length;
      }

      if (fragments.length === 0) { continue; }

      if (lastIndex < text.length) {
        fragments.push(document.createTextNode(text.slice(lastIndex)));
      }

      // Replace the original text node with the fragments
      const parent = textNode.parentNode!;
      const anchor = textNode.nextSibling;
      parent.removeChild(textNode);
      for (const frag of fragments) {
        parent.insertBefore(frag, anchor);
      }
    }

    if (this.matches.length > 0) {
      this.currentIndex = 0;
      this.activateCurrent();
    }
    this.updateCounter();
  }

  private activateCurrent(): void {
    const match = this.matches[this.currentIndex];
    if (!match) { return; }
    match.classList.add('find-match-active');
    match.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  private updateCounter(): void {
    if (this.matches.length === 0) {
      this.counter.textContent = this.input.value ? 'No results' : '';
    } else {
      this.counter.textContent = `${this.currentIndex + 1} / ${this.matches.length}`;
    }
  }
}
