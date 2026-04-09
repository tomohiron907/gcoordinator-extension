import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

export class ScriptWatcher implements vscode.Disposable {
    private watcher:            vscode.FileSystemWatcher | undefined;
    private activeProcess:      cp.ChildProcess | undefined;
    private processTimer:       ReturnType<typeof setTimeout> | undefined;
    private debounceTimer:      ReturnType<typeof setTimeout> | undefined;
    private statusBarItem:      vscode.StatusBarItem;
    private outputChannel:      vscode.OutputChannel;
    private watchedFile:        string | undefined;
    private onComputingChange?: (computing: boolean) => void;
    private disposed = false;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('gcoordinator Live Preview');
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
        this.statusBarItem.command = 'gcoordinator.stopPreview';
    }

    start(fileUri: vscode.Uri, onComputingChange?: (computing: boolean) => void): void {
        this.stop(); // tear down any prior watcher first (idempotent)

        this.onComputingChange = onComputingChange;
        this.watchedFile = fileUri.fsPath;

        const dir  = path.dirname(fileUri.fsPath);
        const base = path.basename(fileUri.fsPath);
        this.watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(dir), base)
        );

        this.watcher.onDidChange(() => {
            if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
            this.debounceTimer = setTimeout(() => { this.runScript(); }, 300);
        });

        this.updateStatusBar();
        this.outputChannel.show(true); // reveal without stealing focus
        this.runScript(); // immediate first run
    }

    stop(): void {
        if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = undefined; }
        this.watcher?.dispose();
        this.watcher = undefined;
        this.killActiveProcess();
        this.onComputingChange?.(false);
        this.onComputingChange = undefined;
        this.clearStatusBar();
        this.watchedFile = undefined;
    }

    dispose(): void {
        this.disposed = true;
        this.stop();
        this.outputChannel.dispose();
        this.statusBarItem.dispose();
    }

    private runScript(): void {
        if (this.disposed || !this.watchedFile) { return; }

        this.killActiveProcess();

        const python  = this.resolvePython();
        const config  = vscode.workspace.getConfiguration('gcoordinator');
        const timeout: number = config.get('livePreviewTimeout', 30);
        // Use workspace folder root as cwd so relative paths in scripts resolve correctly.
        // Fall back to the script's directory if not in a workspace.
        const wsFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.watchedFile));
        const cwd = wsFolder ? wsFolder.uri.fsPath : path.dirname(this.watchedFile);

        this.onComputingChange?.(true);
        this.updateStatusBar(true);
        this.outputChannel.appendLine(
            `\n[${new Date().toLocaleTimeString()}] Running: ${python} ${this.watchedFile}`
        );

        const proc = cp.spawn(python, [this.watchedFile], {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        this.activeProcess = proc;

        proc.stdout?.on('data', (chunk: Buffer) => {
            this.outputChannel.append(chunk.toString());
        });
        proc.stderr?.on('data', (chunk: Buffer) => {
            this.outputChannel.append(chunk.toString());
        });

        this.processTimer = setTimeout(() => {
            this.outputChannel.appendLine(
                `[gcoordinator] Script exceeded ${timeout}s timeout, killing.`
            );
            proc.kill('SIGTERM');
            setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) { /* already dead */ } }, 2000);
        }, timeout * 1000);

        proc.on('exit', (code, signal) => {
            if (this.processTimer) { clearTimeout(this.processTimer); this.processTimer = undefined; }
            if (this.activeProcess === proc) {
                this.activeProcess = undefined;
                this.onComputingChange?.(false);
                this.updateStatusBar(false);
            }
            this.outputChannel.appendLine(
                `[gcoordinator] Script exited (code=${code ?? '-'}, signal=${signal ?? '-'})`
            );
        });

        proc.on('error', (err) => {
            if (this.processTimer) { clearTimeout(this.processTimer); this.processTimer = undefined; }
            if (this.activeProcess === proc) {
                this.activeProcess = undefined;
                this.onComputingChange?.(false);
                this.updateStatusBar(false);
            }
            this.outputChannel.appendLine(`[gcoordinator] Spawn error: ${err.message}`);
            vscode.window.showErrorMessage(`[gcoordinator] Cannot run Python: ${err.message}`);
        });
    }

    private killActiveProcess(): void {
        if (this.processTimer) { clearTimeout(this.processTimer); this.processTimer = undefined; }
        if (this.activeProcess) {
            try { this.activeProcess.kill('SIGTERM'); } catch (_) { /* already dead */ }
            this.activeProcess = undefined;
        }
    }

    private resolvePython(): string {
        // Tier 1: explicit user setting
        const config = vscode.workspace.getConfiguration('gcoordinator');
        const configured: string = config.get('pythonPath', '');
        if (configured.trim()) { return configured.trim(); }

        // Tier 2: ms-python extension API
        try {
            const pythonExt = vscode.extensions.getExtension('ms-python.python');
            if (pythonExt) {
                const api = pythonExt.exports as {
                    settings?: {
                        getExecutionDetails?: (uri?: vscode.Uri) => { execCommand?: string[] };
                    };
                };
                const details = api.settings?.getExecutionDetails?.();
                const cmd = details?.execCommand?.[0];
                if (cmd) { return cmd; }
            }
        } catch (_) { /* Python extension API unavailable */ }

        // Tier 3: platform fallback
        return process.platform === 'win32' ? 'python' : 'python3';
    }

    private updateStatusBar(computing = false): void {
        const name = this.watchedFile ? path.basename(this.watchedFile) : '';
        if (computing) {
            this.statusBarItem.text = `$(sync~spin) Computing: ${name}`;
            this.statusBarItem.tooltip = 'gcoordinator: running script...';
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            this.statusBarItem.text = `$(eye) Watching: ${name}`;
            this.statusBarItem.tooltip = 'gcoordinator Live Preview active — click to stop';
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        }
        this.statusBarItem.show();
    }

    private clearStatusBar(): void {
        this.statusBarItem.hide();
    }
}
