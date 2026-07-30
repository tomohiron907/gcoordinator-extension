import * as vscode from 'vscode';
import { PathData } from './server';
import { SpaceMouseState } from './spacemouseHost';
import { SpaceMouseGate } from './spacemouseGate';
import { previewViewColumn, trackPreviewPanel } from './previewLayout';

export class PreviewPanel {
    static instance: PreviewPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private readonly spaceMouseGate: SpaceMouseGate;

    private constructor(
        extensionUri: vscode.Uri,
        onOpened: () => void,
        onClosed: () => void,
    ) {
        this.extensionUri = extensionUri;
        this.panel = vscode.window.createWebviewPanel(
            'gcoordinatorPreview',
            'gcoordinator Preview',
            { viewColumn: previewViewColumn(), preserveFocus: true },
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
                retainContextWhenHidden: true,
            }
        );
        trackPreviewPanel(this.panel);
        this.panel.webview.html = this.buildHtml();
        this.spaceMouseGate = new SpaceMouseGate(this.panel);
        this.panel.onDidDispose(() => {
            PreviewPanel.instance = undefined;
            this.spaceMouseGate.dispose();
            onClosed();
        });
        onOpened();
    }

    // onOpened/onClosed drive the SpaceMouse lifecycle, so every caller must
    // pass them — a caller that skips them leaves the panel without a puck.
    static createOrShow(
        extensionUri: vscode.Uri,
        onOpened: () => void,
        onClosed: () => void,
    ): PreviewPanel {
        if (PreviewPanel.instance) {
            // No column argument: keep the panel in the group it already lives
            // in instead of dragging it beside whatever is active right now.
            PreviewPanel.instance.panel.reveal(undefined, true);
            return PreviewPanel.instance;
        }
        PreviewPanel.instance = new PreviewPanel(extensionUri, onOpened, onClosed);
        return PreviewPanel.instance;
    }

    postSpaceMouse(state: SpaceMouseState): void {
        this.spaceMouseGate.post(state);
    }

    postComputing(computing: boolean): void {
        this.panel.webview.postMessage({ type: 'computing', computing });
    }

    postData(data: PathData): void {
        // VSCode postMessage serializes via JSON, so TypedArrays must be encoded.
        // Encode the binary coord buffer as a base64 string.
        const coordsBase64 = Buffer.from(data.coords).toString('base64');
        const travelCoordsBase64 = data.travel_coords
            ? Buffer.from(data.travel_coords).toString('base64')
            : '';
        const config = vscode.workspace.getConfiguration('gcoordinator');
        const nozzleSize: number = config.get('nozzleSize', 0.4);
        const pathColor: string  = config.get('pathColor', '#ffffff');
        const travelColor: string = config.get('travelColor', '#ffffff');
        this.panel.webview.postMessage({
            type: 'update',
            path_lengths: data.path_lengths,
            coords_b64: coordsBase64,
            travel_path_lengths: data.travel_path_lengths ?? [],
            travel_coords_b64: travelCoordsBase64,
            nozzleSize,
            pathColor,
            travelColor,
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
  <div id="main">
    <div id="canvas-container">
      <div id="computing-overlay">
        <div id="computing-badge">
          <div class="computing-spinner"></div>
          Computing...
        </div>
      </div>
    </div>
    <div id="hslider-panel">
      <span id="curve-val">0</span>
      <input type="range" id="curve-slider" min="1" max="1" value="1">
      <span id="curve-total">0</span>
    </div>
  </div>
  <div id="vslider-panel">
    <span id="layer-total">0</span>
    <input type="range" id="layer-slider" min="0" max="0" value="0">
    <span id="layer-val">0</span>
  </div>
  <div id="spacemouse-overlay">
    <div id="sm-status">SpaceMouse: starting...</div>
    <table>
      <tr><td>Tx</td><td id="sm-tx">0</td><td>Rx</td><td id="sm-rx">0</td></tr>
      <tr><td>Ty</td><td id="sm-ty">0</td><td>Ry</td><td id="sm-ry">0</td></tr>
      <tr><td>Tz</td><td id="sm-tz">0</td><td>Rz</td><td id="sm-rz">0</td></tr>
    </table>
  </div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}
