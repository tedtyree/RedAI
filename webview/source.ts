// Source view — contenteditable div showing raw Markdown as plain text.
// No textbox chrome; inherits VS Code theme variables like any other element.

export class SourceView {
  private readonly el: HTMLDivElement;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private onChangeCallback: ((markdown: string) => void) | null = null;
  private debounceMs: number;

  constructor(container: HTMLElement, debounceMs: number) {
    this.debounceMs = debounceMs;
    this.el = document.createElement('div');
    this.el.className = 'source-editor';
    this.el.contentEditable = 'true';
    this.el.spellcheck = false;
    this.el.setAttribute('autocorrect', 'off');
    this.el.setAttribute('autocapitalize', 'off');
    container.appendChild(this.el);

    this.el.addEventListener('input', () => {
      if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.onChangeCallback?.(this.getValue());
      }, this.debounceMs);
    });

    // Prevent Tab from moving focus; insert two spaces instead.
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        document.execCommand('insertText', false, '  ');
      }
    });
  }

  onChange(cb: (markdown: string) => void): void {
    this.onChangeCallback = cb;
  }

  getValue(): string {
    // innerText correctly converts <div>/<br> line separators back to \n
    return this.el.innerText;
  }

  setValue(markdown: string): void {
    // innerText correctly renders \n as visual line breaks
    this.el.innerText = markdown;
  }

  setDebounce(ms: number): void {
    this.debounceMs = ms;
  }

  focus(): void {
    this.el.focus();
  }

  getElement(): HTMLElement {
    return this.el;
  }
}
