import * as vscode from 'vscode';
import { parseGCode, GCodeParseResult } from './gcodeParser';

export class GCodePreviewPanel {
    static instance: GCodePreviewPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private document: vscode.TextDocument | undefined;
    private parseResult: GCodeParseResult | undefined;
    private selectionDisposable: vscode.Disposable | undefined;
    private seekTimer: ReturnType<typeof setTimeout> | null = null;
    private lastSeekTime = 0;
    private disposed = false;

    private constructor(extensionUri: vscode.Uri) {
        this.extensionUri = extensionUri;
        this.panel = vscode.window.createWebviewPanel(
            'gcodePreview',
            'G-code Preview',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
                retainContextWhenHidden: true,
            }
        );
        this.panel.webview.html = this.buildHtml();
        this.panel.onDidDispose(() => {
            this.disposed = true;
            this.selectionDisposable?.dispose();
            if (this.seekTimer) { clearTimeout(this.seekTimer); }
            GCodePreviewPanel.instance = undefined;
        });
    }

    static async createOrShow(extensionUri: vscode.Uri, document: vscode.TextDocument): Promise<void> {
        if (GCodePreviewPanel.instance) {
            GCodePreviewPanel.instance.panel.reveal(vscode.ViewColumn.Beside, true);
            if (GCodePreviewPanel.instance.document?.uri.toString() !== document.uri.toString()) {
                await GCodePreviewPanel.instance.loadDocument(document);
            }
            return;
        }
        const panel = new GCodePreviewPanel(extensionUri);
        GCodePreviewPanel.instance = panel;
        await panel.loadDocument(document);
    }

    private async loadDocument(document: vscode.TextDocument): Promise<void> {
        this.document = document;
        this.parseResult = undefined;

        // Register selection change listener (replace previous if any)
        this.selectionDisposable?.dispose();
        this.selectionDisposable = vscode.window.onDidChangeTextEditorSelection(
            e => this.handleSelectionChange(e)
        );

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Parsing G-code...',
                cancellable: false,
            },
            async () => {
                const lines = document.getText().split('\n');
                const result = await parseGCode(lines);
                if (this.disposed) { return; }
                this.parseResult = result;
                this.postUpdate(result, lines.length);

                // Seek to current cursor position
                const editor = vscode.window.activeTextEditor;
                if (editor && editor.document === document) {
                    const line = editor.selection.active.line;
                    this.doSeek(line, lines.length);
                }
            }
        );
    }

    private postUpdate(result: GCodeParseResult, totalLines: number): void {
        if (this.disposed) { return; }

        // Pack all segment coords into one large Float32Array
        let totalPoints = 0;
        for (const seg of result.segments) { totalPoints += seg.pointCount; }

        const allCoords = new Float32Array(totalPoints * 3);
        const segMeta: { isTravel: boolean; pointCount: number; floatOffset: number }[] = [];
        let floatOffset = 0;
        for (const seg of result.segments) {
            segMeta.push({ isTravel: seg.isTravel, pointCount: seg.pointCount, floatOffset });
            allCoords.set(seg.coords, floatOffset);
            floatOffset += seg.coords.length;
        }

        // Pack lineIndex as two Uint32Arrays
        const segIdxArr = new Uint32Array(result.lineIndex.map(p => p.segIdx));
        const ptIdxArr  = new Uint32Array(result.lineIndex.map(p => p.pointIdx));

        this.panel.webview.postMessage({
            type: 'gcode-update',
            coords_b64:   Buffer.from(allCoords.buffer).toString('base64'),
            segments:     segMeta,
            segIdx_b64:   Buffer.from(segIdxArr.buffer).toString('base64'),
            ptIdx_b64:    Buffer.from(ptIdxArr.buffer).toString('base64'),
            totalLines,
        });
    }

    private postSeek(segIdx: number, pointIdx: number, lineNum: number, totalLines: number): void {
        if (this.disposed) { return; }
        this.panel.webview.postMessage({
            type: 'gcode-seek',
            segIdx,
            pointIdx,
            lineNum,
            totalLines,
        });
    }

    private handleSelectionChange(event: vscode.TextEditorSelectionChangeEvent): void {
        if (!this.parseResult || !this.document) { return; }
        if (event.textEditor.document !== this.document) { return; }
        const line = event.textEditor.selection.active.line;
        const now = Date.now();
        const elapsed = now - this.lastSeekTime;
        if (this.seekTimer) { clearTimeout(this.seekTimer); }
        if (elapsed >= 50) {
            this.lastSeekTime = now;
            this.doSeek(line, this.parseResult.lineIndex.length);
        } else {
            this.seekTimer = setTimeout(() => {
                this.lastSeekTime = Date.now();
                this.doSeek(line, this.parseResult!.lineIndex.length);
            }, 50 - elapsed);
        }
    }

    private doSeek(line: number, totalLines: number): void {
        if (!this.parseResult) { return; }
        const idx = Math.min(line, this.parseResult.lineIndex.length - 1);
        if (idx < 0) { return; }
        const pos = this.parseResult.lineIndex[idx];
        this.postSeek(pos.segIdx, pos.pointIdx, line, totalLines);
    }

    private buildHtml(): string {
        const webview = this.panel.webview;
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'gcodePreview.bundle.js')
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'gcodePreview.css')
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
  <title>G-code Preview</title>
</head>
<body>
  <div id="main">
    <div id="canvas-container"></div>
    <div id="line-info">Line 0</div>
  </div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}
