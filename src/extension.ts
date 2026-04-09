import * as vscode from 'vscode';
import * as path from 'path';
import { PreviewServer } from './server';
import { PreviewPanel } from './previewPanel';
import { GCodePreviewPanel } from './gcodePreviewPanel';
import { SpaceMouseHost, SpaceMouseState } from './spacemouseHost';
import { ScriptWatcher } from './scriptWatcher';

let server: PreviewServer | undefined;
let spaceMouse: SpaceMouseHost | undefined;
let scriptWatcher: ScriptWatcher | undefined;

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
        scriptWatcher?.stop();
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

    scriptWatcher = new ScriptWatcher();
    context.subscriptions.push(scriptWatcher);

    const startLiveCmd = vscode.commands.registerCommand('gcoordinator.startPreview', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('[gcoordinator] Open a Python file first.');
            return;
        }
        if (!editor.document.fileName.endsWith('.py')) {
            vscode.window.showWarningMessage('[gcoordinator] Active file is not a .py file.');
            return;
        }
        PreviewPanel.createOrShow(context.extensionUri, onPanelOpened, onPanelClosed);
        scriptWatcher!.start(editor.document.uri, (computing) => {
            PreviewPanel.instance?.postComputing(computing);
        });
        vscode.window.showInformationMessage(
            `[gcoordinator] Live Preview started for ${path.basename(editor.document.fileName)}`
        );
    });
    context.subscriptions.push(startLiveCmd);

    const stopLiveCmd = vscode.commands.registerCommand('gcoordinator.stopPreview', () => {
        scriptWatcher!.stop();
        vscode.window.showInformationMessage('[gcoordinator] Live Preview stopped.');
    });
    context.subscriptions.push(stopLiveCmd);
}

export function deactivate(): void {
    server?.stop();
    scriptWatcher?.dispose();
    if (spaceMouse) {
        spaceMouse.removeListener(forwardToWebviews);
        spaceMouse.stop().catch(() => { /* ignore */ });
        spaceMouse = undefined;
    }
}
