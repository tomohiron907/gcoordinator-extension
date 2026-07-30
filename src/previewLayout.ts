import * as vscode from 'vscode';

// All 3D previews share one editor group, so the window stays split as
// "code on the left / previews on the right". Without this every panel opened
// with ViewColumn.Beside would split off yet another group to the right.
let previewColumn: vscode.ViewColumn | undefined;
let openPreviews = 0;

/** Column a preview panel should be created in. */
export function previewViewColumn(): vscode.ViewColumn {
    return previewColumn ?? vscode.ViewColumn.Beside;
}

/**
 * Remember where a preview panel lives so the next one joins it. Follows the
 * panel if the user drags it to another group, and forgets the column once the
 * last preview is closed.
 */
export function trackPreviewPanel(panel: vscode.WebviewPanel): void {
    openPreviews++;
    if (panel.viewColumn) { previewColumn = panel.viewColumn; }
    panel.onDidChangeViewState(() => {
        if (panel.viewColumn) { previewColumn = panel.viewColumn; }
    });
    panel.onDidDispose(() => {
        openPreviews--;
        if (openPreviews <= 0) {
            openPreviews = 0;
            previewColumn = undefined;
        }
    });
}
