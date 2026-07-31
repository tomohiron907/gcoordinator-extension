import * as vscode from 'vscode';
import * as path from 'path';
import { PreviewServer, startWithTakeover } from './server';
import { PreviewPanel } from './previewPanel';
import { GCodePreviewPanel } from './gcodePreviewPanel';
import { SpaceMouseHost, SpaceMouseState } from './spacemouseHost';
import { ScriptWatcher } from './scriptWatcher';

let server: PreviewServer | undefined;
let spaceMouse: SpaceMouseHost | undefined;
let scriptWatcher: ScriptWatcher | undefined;
let spaceMouseLog: vscode.OutputChannel | undefined;

// Every window activates this extension and races for the same port, but only
// the holder receives a script's output. The focused window therefore takes the
// port, so `python script.py` in a terminal previews in the window it was run
// from instead of in whichever window happened to boot first.
let ownsPort = false;
let port = 5163; // set from configuration in activate()
let claimChain: Promise<void> = Promise.resolve();
let focusClaimTimer: ReturnType<typeof setTimeout> | undefined;

// Alt-tabbing across several windows would otherwise hand the port down the
// whole chain; only the window the user settles on needs it.
const FOCUS_CLAIM_DELAY_MS = 150;

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

/**
 * Hand the port to the window the user just moved to. A watcher running here is
 * deliberately left alone: saving a file in this window focuses it, which claims
 * the port back long before the script finishes, so its preview still lands here.
 */
function releasePort(): void {
    ownsPort = false;
    server?.stop();
}

/**
 * Take the preview port for this window. A script POSTs to a fixed port with no
 * way to say which window ran it, so ownership is the only thing that decides
 * where a preview appears — and the window the user is looking at is the window
 * that ran the script.
 */
function claimPort(): Promise<void> {
    // Serialised: focus can flip faster than a handover completes, and two
    // overlapping listen() attempts on one server would fight each other.
    const claim = claimChain.then(async () => {
        if (ownsPort) { return; }
        await startWithTakeover(server!, port);
        ownsPort = true;
    });
    // A failed claim (something else is on the port) must not poison the chain
    // and block every later attempt. Callers report the failure if they care.
    claimChain = claim.catch(() => { /* handled by the caller */ });
    return claim;
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
    port = config.get('port', 5163);

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
            if (!state.focused) { return; }
            // Claim on focus, not on blur: whoever the user leaves for might not
            // be a VS Code window at all, and the port has to end up somewhere.
            if (focusClaimTimer) { clearTimeout(focusClaimTimer); }
            focusClaimTimer = setTimeout(() => {
                // Silent: another program sitting on the port is reported when
                // the user actually asks for a preview, not on every focus.
                claimPort().catch(() => { /* reported by startPreview */ });
            }, FOCUS_CLAIM_DELAY_MS);
        }),
    );

    // Start the local HTTP server that receives data from the Python library
    server = new PreviewServer(
        port,
        (data) => {
            PreviewPanel.createOrShow(context.extensionUri, onPanelOpened, onPanelClosed);
            PreviewPanel.instance?.postData(data);
        },
        () => releasePort(),
    );

    // A window that loses the race is the normal case with several windows open,
    // so it stays quiet. The focused one takes the port off the winner right
    // away; the rest wait for the user to switch to them.
    if (vscode.window.state.focused) {
        claimPort().catch(() => { /* reported by startPreview */ });
    } else {
        server.start().then(
            () => { ownsPort = true; },
            (err) => {
                if (err?.code === 'EADDRINUSE') { return; }
                vscode.window.showErrorMessage(
                    `[gcoordinator] Failed to start preview server on port ${port}: ${err.message}`
                );
            },
        );
    }

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

    const startLiveCmd = vscode.commands.registerCommand('gcoordinator.startPreview', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('[gcoordinator] Open a Python file first.');
            return;
        }
        if (!editor.document.fileName.endsWith('.py')) {
            vscode.window.showWarningMessage('[gcoordinator] Active file is not a .py file.');
            return;
        }

        // Take the port before opening anything: without it the script's output
        // would be rendered by another window and the panel here would sit empty.
        try {
            await claimPort();
        } catch (err) {
            vscode.window.showErrorMessage(
                `[gcoordinator] Port ${port} is in use by another process. `
                + `Change "gcoordinator.port" and reload the window. `
                + `(${(err as Error).message})`
            );
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
    if (focusClaimTimer) { clearTimeout(focusClaimTimer); focusClaimTimer = undefined; }
    server?.stop();
    scriptWatcher?.dispose();
    releaseSpaceMouse();
}
