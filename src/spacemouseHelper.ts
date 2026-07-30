import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as readline from 'readline';
import { Backend, BackendCallbacks } from './spacemouseBackend';

/**
 * macOS backend: reads the puck through the bundled `spacemoused` helper, which
 * registers with the 3Dconnexion driver via 3DconnexionClient.framework and
 * prints one JSON object per line.
 *
 * Going through the driver is not a shortcut — its DriverKit extension seizes
 * the physical HID device, so raw HID opens fail whether or not they ask for
 * exclusive access, and the client API is the only way in. It is also the better
 * way in: the driver keeps serving every other application, so the puck still
 * works in Fusion 360 while a preview is open, and the extension never has to
 * touch the driver.
 */

const DEVICE_NAME = 'SpaceMouse';

/** Helper exit codes that mean "the driver is not usable", not "it crashed". */
const EXIT_NO_DRIVER = 2;
const EXIT_NO_SYMBOLS = 3;

/**
 * The driver applies its own sensitivity settings and reports a wider range than
 * the puck's raw HID interface (peaks around ±512 against ±350). Values are
 * brought back to the raw range here so both backends speak the same units.
 */
const AXIS_SCALE = 350 / 512;

/** How long to let the helper exit on its own after stdin closes. */
const SHUTDOWN_MS = 500;

export class HelperBackend implements Backend {
    private proc: ChildProcessWithoutNullStreams | null = null;
    private stopped = false;
    private active = false;

    /**
     * @param helperPath Absolute path to the bundled `spacemoused` binary.
     */
    constructor(
        private readonly helperPath: string,
        private readonly cb: BackendCallbacks,
    ) {}

    start(): void {
        if (!fs.existsSync(this.helperPath)) {
            this.cb.unavailable(`helper binary is missing: ${this.helperPath}`);
            return;
        }

        this.cb.log(`spawning helper: ${this.helperPath}`);
        try {
            this.proc = spawn(this.helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (err) {
            this.cb.unavailable(`could not start the SpaceMouse helper: ${errorText(err)}`);
            return;
        }

        readline.createInterface({ input: this.proc.stdout })
            .on('line', (line) => this.onLine(line));
        this.proc.stderr.on('data', (chunk: Buffer) => {
            this.cb.log(`helper stderr: ${chunk.toString().trimEnd()}`);
        });
        this.proc.on('error', (err) => this.cb.unavailable(errorText(err)));
        this.proc.on('exit', (code, signal) => this.onExit(code, signal));

        // The helper only starts reading stdin once its client is registered, so
        // the pipe buffers this until it is ready.
        if (this.active) { this.send('activate'); }
    }

    /** Release the puck. The 3Dconnexion driver is never touched. */
    stop(): void {
        this.stopped = true;
        const proc = this.proc;
        this.proc = null;
        if (!proc) { return; }
        // Closing stdin makes the helper deactivate, unregister and exit cleanly,
        // handing the puck straight back to the driver.
        try { proc.stdin.end(); } catch (_) { /* ignore */ }
        setTimeout(() => { try { proc.kill('SIGTERM'); } catch (_) { /* ignore */ } }, SHUTDOWN_MS);
    }

    /**
     * The helper registers as a "manual" client, so the driver only routes data
     * here while this is true — while it is false the puck goes to whatever
     * application is in front instead. That arbitration is what lets VS Code and
     * Fusion 360 share the device.
     */
    setActive(active: boolean): void {
        this.active = active;
        this.send(active ? 'activate' : 'deactivate');
    }

    private onLine(line: string): void {
        let msg: Record<string, unknown>;
        try {
            msg = JSON.parse(line) as Record<string, unknown>;
        } catch (_) {
            this.cb.log(`helper: ${line}`);
            return;
        }

        if (msg.t === 'state') {
            this.cb.axes({
                tx: axis(msg.tx), ty: axis(msg.ty), tz: axis(msg.tz),
                rx: axis(msg.rx), ry: axis(msg.ry), rz: axis(msg.rz),
            });
            return;
        }
        // "ready", "added", "removed" and errors are all diagnostics; only the
        // registration matters, and it is what marks the device as connected.
        this.cb.log(`helper: ${line}`);
        if (msg.t === 'ready') { this.cb.connected(DEVICE_NAME); }
    }

    private onExit(code: number | null, signal: string | null): void {
        this.proc = null;
        if (this.stopped) { return; }
        this.cb.log(`helper exited code=${code} signal=${signal}`);
        if (code === EXIT_NO_DRIVER) {
            this.cb.unavailable('the 3Dconnexion driver (3DxWare) is not installed');
        } else if (code === EXIT_NO_SYMBOLS) {
            this.cb.unavailable('the installed 3Dconnexion driver is too old');
        } else {
            this.cb.unavailable(`the SpaceMouse helper exited unexpectedly (code ${code})`);
        }
    }

    private send(command: 'activate' | 'deactivate'): void {
        if (!this.proc) { return; }
        try { this.proc.stdin.write(`${command}\n`); } catch (_) { /* ignore */ }
    }
}

function axis(value: unknown): number {
    return typeof value === 'number' ? Math.round(value * AXIS_SCALE) : 0;
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
