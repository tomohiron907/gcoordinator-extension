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
let spaceMouseLog: vscode.OutputChannel | undefined;

// Set during activate(). The panel callbacks below are passed to the panels as
// bare functions and never see the ExtensionContext, so the path is kept here.
let spaceMouseHelperPath = '';

// Track how many panels are open to manage the device lifecycle
let openPanelCount = 0;

function logSpaceMouse(message: string): void {
    const t = new Date().toISOString().slice(11, 23);
    spaceMouseLog?.appendLine(`[${t}] ${message}`);
}

function onPanelOpened(): void {
    openPanelCount++;
    if (openPanelCount === 1) {
        // First panel opened — start reading the SpaceMouse. The 3Dconnexion
        // driver is left running throughout, so the puck keeps working in
        // Fusion 360 and elsewhere.
        spaceMouse = new SpaceMouseHost(
            spaceMouseHelperPath,
            (message) => {
                logSpaceMouse(`STATUS: ${message}`);
                vscode.window.showWarningMessage(
                    `[gcoordinator] SpaceMouse: ${message}`,
                    'Show log',
                ).then((pick) => {
                    if (pick === 'Show log') { spaceMouseLog?.show(true); }
                });
            },
            logSpaceMouse,
        );
        spaceMouse.addListener(forwardToWebviews);
        spaceMouse.setActive(vscode.window.state.focused);
        spaceMouse.start();
    }
}

function onPanelClosed(): void {
    openPanelCount--;
    if (openPanelCount <= 0) {
        openPanelCount = 0;
        scriptWatcher?.stop();
        releaseSpaceMouse();
    }
}

/** Stop the helper and hand the puck back to the driver. */
function releaseSpaceMouse(): void {
    if (!spaceMouse) { return; }
    spaceMouse.removeListener(forwardToWebviews);
    spaceMouse.stop();
    spaceMouse = undefined;
}

function forwardToWebviews(state: SpaceMouseState): void {
    PreviewPanel.instance?.postSpaceMouse(state);
    GCodePreviewPanel.instance?.postSpaceMouse(state);
}

export function activate(context: vscode.ExtensionContext): void {
    const config = vscode.workspace.getConfiguration('gcoordinator');
    const port: number = config.get('port', 5163);

    // SpaceMouse helper diagnostics — View > Output > "gcoordinator SpaceMouse"
    spaceMouseLog = vscode.window.createOutputChannel('gcoordinator SpaceMouse');
    context.subscriptions.push(spaceMouseLog);

    spaceMouseHelperPath = vscode.Uri.joinPath(
        context.extensionUri, 'bin', 'spacemoused',
    ).fsPath;

    // The helper is a "manual" 3Dconnexion client: it only receives data while
    // it says it is in the foreground. Releasing it when VS Code loses focus is
    // what lets the driver hand the puck back to whatever app is in front.
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState((state) => {
            spaceMouse?.setActive(state.focused);
        }),
    );

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
    releaseSpaceMouse();
}
