import * as vscode from 'vscode';
import { PreviewServer } from './server';
import { PreviewPanel } from './previewPanel';

let server: PreviewServer | undefined;

export function activate(context: vscode.ExtensionContext): void {
    const config = vscode.workspace.getConfiguration('gcoordinator');
    const port: number = config.get('port', 5163);

    // Start the local HTTP server that receives data from the Python library
    server = new PreviewServer(port, (data) => {
        // Auto-open the preview panel when data arrives
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
        PreviewPanel.createOrShow(context.extensionUri);
    });

    context.subscriptions.push(openCmd);
}

export function deactivate(): void {
    server?.stop();
}
