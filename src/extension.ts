import * as vscode from 'vscode';
import { PreviewServer } from './server';
import { PreviewPanel } from './previewPanel';
import { GCodePreviewPanel } from './gcodePreviewPanel';
import { SpaceMouseHost, SpaceMouseState } from './spacemouseHost';

let server: PreviewServer | undefined;
let spaceMouse: SpaceMouseHost | undefined;

// Track how many panels are open to manage driver lifecycle
let openPanelCount = 0;

function onPanelOpened(): void {
    openPanelCount++;
    if (openPanelCount === 1) {
        // First panel opened — stop 3DconnexionHelper and start reading
        spaceMouse = new SpaceMouseHost();
        spaceMouse.addListener(forwardToWebviews);
        spaceMouse.start().catch(() => { /* ignore startup errors */ });
    }
}

function onPanelClosed(): void {
    openPanelCount--;
    if (openPanelCount <= 0) {
        openPanelCount = 0;
        // Last panel closed — release device and restart 3DconnexionHelper
        if (spaceMouse) {
            spaceMouse.removeListener(forwardToWebviews);
            spaceMouse.stop().catch(() => { /* ignore */ });
            spaceMouse = undefined;
        }
    }
}

function forwardToWebviews(state: SpaceMouseState): void {
    PreviewPanel.instance?.postSpaceMouse(state);
    GCodePreviewPanel.instance?.postSpaceMouse(state);
}

export function activate(context: vscode.ExtensionContext): void {
    const config = vscode.workspace.getConfiguration('gcoordinator');
    const port: number = config.get('port', 5163);

    // Start the local HTTP server that receives data from the Python library
    server = new PreviewServer(port, (data) => {
        PreviewPanel.createOrShow(context.extensionUri);
        PreviewPanel.instance?.postData(data);
    });

    server.start().catch((err) => {
        vscode.window.showErrorMessage(
            `[gcoordinator] Failed to start preview server on port ${port}: ${err.message}`
        );
    });

    // Command to manually open the preview panel
    const openCmd = vscode.commands.registerCommand('gcoordinator.openPreview', () => {
        PreviewPanel.createOrShow(context.extensionUri, onPanelOpened, onPanelClosed);
    });
    context.subscriptions.push(openCmd);

    // Command to preview the currently open G-code file
    const gcodeCmd = vscode.commands.registerCommand('gcoordinator.previewGCode', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('Open a .gcode file first.');
            return;
        }
        if (!editor.document.fileName.match(/\.gcode$/i)) {
            vscode.window.showWarningMessage('Active file is not a .gcode file.');
            return;
        }
        await GCodePreviewPanel.createOrShow(
            context.extensionUri, editor.document, onPanelOpened, onPanelClosed
        );
    });
    context.subscriptions.push(gcodeCmd);
}

export function deactivate(): void {
    server?.stop();
    if (spaceMouse) {
        spaceMouse.removeListener(forwardToWebviews);
        spaceMouse.stop().catch(() => { /* ignore */ });
        spaceMouse = undefined;
    }
}
