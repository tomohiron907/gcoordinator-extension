import * as vscode from 'vscode';
import { PathData } from './server';

export class PreviewPanel {
    static instance: PreviewPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;

    private constructor(extensionUri: vscode.Uri) {
        this.extensionUri = extensionUri;
        this.panel = vscode.window.createWebviewPanel(
            'gcoordinatorPreview',
            'gcoordinator Preview',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
                retainContextWhenHidden: true,
            }
        );
        this.panel.webview.html = this.buildHtml();
        this.panel.onDidDispose(() => {
            PreviewPanel.instance = undefined;
        });
    }

    static createOrShow(extensionUri: vscode.Uri): PreviewPanel {
        if (PreviewPanel.instance) {
            PreviewPanel.instance.panel.reveal(vscode.ViewColumn.Beside, true);
            return PreviewPanel.instance;
        }
        PreviewPanel.instance = new PreviewPanel(extensionUri);
        return PreviewPanel.instance;
    }

    postData(data: PathData): void {
        // VSCode postMessage serializes via JSON, so TypedArrays must be encoded.
        // Encode the binary coord buffer as a base64 string.
        const coordsBase64 = Buffer.from(data.coords).toString('base64');
        this.panel.webview.postMessage({
            type: 'update',
            path_lengths: data.path_lengths,
            coords_b64: coordsBase64,
        });
    }

    private buildHtml(): string {
        const webview = this.panel.webview;
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'preview.bundle.js')
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'preview.css')
        );

        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src ${webview.cspSource};
             style-src ${webview.cspSource} 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>gcoordinator Preview</title>
</head>
<body>
  <div id="canvas-container"></div>
  <div id="slider-panel">
    <span id="layer-total">0</span>
    <input type="range" id="layer-slider" min="0" max="0" value="0">
    <span id="layer-val">0</span>
  </div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}
