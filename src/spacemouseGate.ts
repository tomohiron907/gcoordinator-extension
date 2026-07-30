import * as vscode from 'vscode';
import { SpaceMouseState } from './spacemouseHost';

/**
 * Gates SpaceMouse input for a single webview panel.
 *
 * The driver already stops sending data when VS Code loses focus, so this is
 * mostly about the panel: reports must not move a preview the user cannot see,
 * and reports still in flight around a focus change must not leak through.
 */
export class SpaceMouseGate {
    private readonly disposables: vscode.Disposable[] = [];
    private lastState: SpaceMouseState | undefined;
    /** Identifies the last neutral message sent, so it is not resent every report. */
    private zeroedKey: string | undefined;

    constructor(private readonly panel: vscode.WebviewPanel) {
        // The device only reports while it is being moved, so a focus change on
        // its own has to trigger the neutral state — otherwise the webview would
        // keep applying the last non-zero axes forever.
        this.disposables.push(
            vscode.window.onDidChangeWindowState(() => this.sync()),
            this.panel.onDidChangeViewState(() => this.sync()),
        );
    }

    post(state: SpaceMouseState): void {
        this.lastState = state;
        if (!this.allowed()) {
            this.postZero(state);
            return;
        }
        this.zeroedKey = undefined;
        this.panel.webview.postMessage(state);
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this.disposables.length = 0;
    }

    // ---- Private ----

    /**
     * `panel.active` is deliberately not required: the preview sits beside the
     * editor, and the SpaceMouse should still work while typing in the code.
     */
    private allowed(): boolean {
        return this.panel.visible && vscode.window.state.focused;
    }

    private sync(): void {
        if (this.allowed() || !this.lastState) { return; }
        this.postZero(this.lastState);
    }

    private postZero(state: SpaceMouseState): void {
        // Connection changes still have to reach the webview so its connection
        // toast fires even while input is suppressed.
        const key = `${state.connected}:${state.deviceName}`;
        if (this.zeroedKey === key) { return; }
        this.zeroedKey = key;
        this.panel.webview.postMessage({
            ...state,
            tx: 0, ty: 0, tz: 0,
            rx: 0, ry: 0, rz: 0,
        });
    }
}
