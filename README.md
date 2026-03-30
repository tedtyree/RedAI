# RedAI

A VS Code extension that lets you toggle between a WYSIWYG visual editor and raw Markdown source for any `.md` file — without leaving VS Code.

Open Source - MIT License

Built using Claude Code and Windsurf.

---

Got ideas? Let's talk.  linkedin.com/in/tedtyree

PLEASE CONSIDER HELPING BREAK THE CYCLE OF POVERTY

un0.org/donate

---

## Philosophy

MD First - Although this is intended to be a WYSIWYG editor, the goal is to edit markdown and not create a web page or formatted document. All design decisions were centered around building a tool for techs who manage/read markdown.

Features:

- RedAI setting to make it your default viewer/editor for .md files.
- Toggle between visual and source view (icons in top right of panel)
- Multi-block highlight with drag-drop

---

## Building from Source

**Prerequisites:** Node.js 18+ and npm.

```

# 1. Install dependencies (one-time)

npm install

# 2. Build

npm run build

```

The build compiles two bundles into `dist/`:

- `dist/extension.js` — the VS Code extension host
- `dist/webview.js` — the editor UI running inside the WebView panel

**Watch mode** (rebuilds automatically on file changes):

```
npm run watch
```

---

## Installing the Extension

### Option A — Run in development (no install needed)

Open this folder in VS Code and press **F5**. A new Extension Development Host window opens with the extension already active. Open any `.md` file in that window and use "Open With..." to select **RedAI**.

### Option B — Package and install as a `.vsix`

```

npm run package

```

This produces `redai-0.0.1.vsix` in the project root. Install it:

- **Via VS Code UI:** `Extensions` panel → `···` menu (top-right) → `Install from VSIX...` → select the file.
- **Via command line:**

```
  code --install-extension redai-0.0.1.vsix
```

Restart VS Code after installing.

### Option C — Drop into the extensions folder (development shortcut)

Copy (or symlink) this folder into your VS Code extensions directory, then restart VS Code:

| Platform | Path |

|---|---|

| Windows | `%USERPROFILE%\.vscode\extensions\redai` |

| macOS / Linux | `~/.vscode/extensions/redai` |

---

## Updating the Extension

No need to uninstall first — VS Code replaces the existing installation by matching the extension ID.

**Fastest workflow:**

```

npm run build && npm run package

code --install-extension redai-0.0.1.vsix

```

Then reload VS Code: `Ctrl+Shift+P` → **Reload Window**.

**Via UI:** `Extensions` panel → `···` → `Install from VSIX...` → select the new file.

> **Tip:** Bump the version in `package.json` before packaging a new release so VS Code shows a proper update notification:

> ```json

> "version": "0.0.2"

> ```

---

## Opening a File with the Editor

By default the extension registers as an **optional** editor. To open a file:

1. Right-click any `.md` file in the Explorer panel.
2. Select **Open With...** → **RedAI**.

---

## Making It the Default Editor for All `.md` Files

### Option 1 — VS Code setting (recommended)

Add this to your VS Code **User Settings** (`Ctrl+,` → open `settings.json`):

```
"workbench.editorAssociations": {
  "*.md": "redai.editor"
}
```

To revert, remove that line or set it to `"default"`.

### Option 2 — Extension setting

Set `redai.makeDefaultEditor` to `true` in VS Code settings. The extension will automatically configure the editor association on activation and remove it when set back to `false`.

---

## Settings

| Setting | Type | Default | Description |

|---|---|---|---|

| `redai.defaultView` | `"visual"` \| `"source"` | `"visual"` | Which view opens first |

| `redai.syncDebounceMs` | number | `300` | Delay (ms) before source edits sync to disk |

| `redai.makeDefaultEditor` | boolean | `false` | Automatically use this editor for all `.md` files |
