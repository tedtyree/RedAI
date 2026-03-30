import * as vscode from 'vscode';

const VIEW_TYPE = 'redai.editor';
const ASSOCIATIONS_KEY = 'workbench.editorAssociations';
const MD_GLOB = '*.md';

export function activate(context: vscode.ExtensionContext) {
  const provider = new MarkdownDualViewProvider(context);

  // Apply makeDefaultEditor on activation and whenever the setting changes
  syncDefaultEditorSetting();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('redai.makeDefaultEditor')) {
        syncDefaultEditorSetting();
      }
    })
  );

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      VIEW_TYPE,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('redai.showVisual', () => provider.setView('visual')),
    vscode.commands.registerCommand('redai.showSource', () => provider.setView('source')),
  );
}

export function deactivate() {}

async function syncDefaultEditorSetting(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('redai');
  const makeDefault = cfg.get<boolean>('makeDefaultEditor', false);

  const wbCfg = vscode.workspace.getConfiguration();
  const associations = wbCfg.get<Record<string, string>>(ASSOCIATIONS_KEY, {});

  const currentlySet = associations[MD_GLOB] === VIEW_TYPE;

  if (makeDefault && !currentlySet) {
    associations[MD_GLOB] = VIEW_TYPE;
    await wbCfg.update(ASSOCIATIONS_KEY, associations, vscode.ConfigurationTarget.Global);
  } else if (!makeDefault && currentlySet) {
    delete associations[MD_GLOB];
    await wbCfg.update(ASSOCIATIONS_KEY, associations, vscode.ConfigurationTarget.Global);
  }
}

type ActiveView = 'visual' | 'source';

class MarkdownDualViewProvider implements vscode.CustomTextEditorProvider {
  private readonly panelViews = new Map<vscode.WebviewPanel, ActiveView>();
  private activePanel: vscode.WebviewPanel | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Called by toolbar button commands */
  setView(view: ActiveView): void {
    if (!this.activePanel) { return; }
    this.panelViews.set(this.activePanel, view);
    this.activePanel.webview.postMessage({ type: 'setView', view });
    vscode.commands.executeCommand('setContext', 'redai.view', view);
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('redai');
    const defaultView = cfg.get<string>('defaultView', 'visual') as ActiveView;

    this.panelViews.set(webviewPanel, defaultView);
    // New panels are active — set context immediately
    this.activePanel = webviewPanel;
    vscode.commands.executeCommand('setContext', 'redai.view', defaultView);

    webviewPanel.webview.options = { enableScripts: true };
    webviewPanel.webview.html = this.buildHtml(webviewPanel.webview);

    // Update active panel + context when switching tabs
    const onViewState = webviewPanel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        this.activePanel = e.webviewPanel;
        const view = this.panelViews.get(e.webviewPanel) ?? 'visual';
        vscode.commands.executeCommand('setContext', 'redai.view', view);
      }
    });

    let pendingEdit = false;

    const onMessage = webviewPanel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready': {
          const view = this.panelViews.get(webviewPanel) ?? defaultView;
          const debounceMs = cfg.get<number>('syncDebounceMs', 300);
          webviewPanel.webview.postMessage({
            type: 'init',
            markdown: document.getText(),
            defaultView: view,
            debounceMs,
          });
          break;
        }

        case 'viewChanged': {
          // Webview reports a view switch (e.g. user clicked in-webview toggle)
          const view = msg.view as ActiveView;
          this.panelViews.set(webviewPanel, view);
          if (webviewPanel.active) {
            vscode.commands.executeCommand('setContext', 'redai.view', view);
          }
          break;
        }

        case 'update': {
          pendingEdit = true;
          const edit = new vscode.WorkspaceEdit();
          const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
          );
          edit.replace(document.uri, fullRange, msg.markdown);
          await vscode.workspace.applyEdit(edit);
          pendingEdit = false;
          break;
        }
      }
    });

    const onDocChange = vscode.workspace.onDidChangeTextDocument((e) => {
      if (
        e.document.uri.toString() === document.uri.toString() &&
        !pendingEdit
      ) {
        webviewPanel.webview.postMessage({
          type: 'externalChange',
          markdown: e.document.getText(),
        });
      }
    });

    webviewPanel.onDidDispose(() => {
      this.panelViews.delete(webviewPanel);
      if (this.activePanel === webviewPanel) {
        this.activePanel = undefined;
      }
      onViewState.dispose();
      onMessage.dispose();
      onDocChange.dispose();
    });
  }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'styles.css')
    );
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource};
             script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>RedAI</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
