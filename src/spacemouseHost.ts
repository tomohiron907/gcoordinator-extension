import { execFile } from 'child_process';

// ---- node-hid (native module, external in esbuild) ----
// Use require so esbuild leaves it as-is (marked --external:node-hid).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeHid = require('node-hid') as {
    devices: (vid: number, pid: number) => Array<{
        path?: string;
        product?: string;
        productId?: number;
    }>;
    HID: new (path: string) => {
        on(event: 'data',  listener: (data: Buffer) => void): void;
        on(event: 'error', listener: (err: unknown) => void): void;
        close(): void;
    };
};

// ---- Constants ----

const VENDOR_ID = 0x256f; // 3Dconnexion

const HELPER_APP  = '/Applications/3DconnexionHelper.app';
const HELPER_PROC = '3DconnexionHelper';

// ---- Types ----

export interface SpaceMouseState {
    type: 'spacemouse';
    tx: number; ty: number; tz: number;
    rx: number; ry: number; rz: number;
    connected: boolean;
    deviceName: string;
}

type Listener = (state: SpaceMouseState) => void;

// ---- SpaceMouseHost ----

export class SpaceMouseHost {
    private device: ReturnType<typeof nodeHid.HID> | null = null;
    private deviceName = '';
    private state: SpaceMouseState = {
        type: 'spacemouse',
        tx: 0, ty: 0, tz: 0,
        rx: 0, ry: 0, rz: 0,
        connected: false,
        deviceName: '',
    };
    private listeners: Listener[] = [];
    private disposed = false;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;

    // ---- Lifecycle ----

    /** Stop 3DconnexionHelper then open the SpaceMouse directly. */
    async start(): Promise<void> {
        await this.stopHelper();
        // Wait for the driver to release the device
        await this.delay(600);
        this.openDevice();
    }

    /** Close HID device and restart 3DconnexionHelper. */
    async stop(): Promise<void> {
        this.disposed = true;
        if (this.retryTimer) { clearTimeout(this.retryTimer); }
        this.closeDevice();
        await this.startHelper();
    }

    // ---- Listeners ----

    addListener(fn: Listener): void {
        this.listeners.push(fn);
        // Immediately send current state to new listener
        fn({ ...this.state });
    }

    removeListener(fn: Listener): void {
        this.listeners = this.listeners.filter(l => l !== fn);
    }

    // ---- Private ----

    private openDevice(): void {
        if (this.disposed) { return; }
        const devs = nodeHid.devices(VENDOR_ID, 0)
            .filter(d => d.product === 'SpaceMouse Wireless' || d.product?.includes('SpaceMouse'));

        // Use the first unique path
        const seen = new Set<string>();
        const unique = devs.filter(d => {
            if (!d.path || seen.has(d.path)) { return false; }
            seen.add(d.path);
            return true;
        });

        if (unique.length === 0) {
            this.scheduleRetry();
            return;
        }

        try {
            this.device = new nodeHid.HID(unique[0].path!);
            this.deviceName = unique[0].product ?? 'SpaceMouse';
            this.updateState({ connected: true, deviceName: this.deviceName });

            this.device.on('data', (data: Buffer) => {
                const reportId = data[0];
                if (reportId === 1 && data.length >= 13) {
                    // SpaceMouse Wireless: all 6 axes in one 13-byte report
                    this.updateState({
                        tx: data.readInt16LE(1),
                        ty: data.readInt16LE(3),
                        tz: data.readInt16LE(5),
                        rx: data.readInt16LE(7),
                        ry: data.readInt16LE(9),
                        rz: data.readInt16LE(11),
                    });
                } else if (reportId === 1 && data.length >= 7) {
                    // Classic format (SpaceMouse Compact/Pro): translation only
                    this.updateState({
                        tx: data.readInt16LE(1),
                        ty: data.readInt16LE(3),
                        tz: data.readInt16LE(5),
                    });
                } else if (reportId === 2 && data.length >= 7) {
                    // Classic format: rotation only
                    this.updateState({
                        rx: data.readInt16LE(1),
                        ry: data.readInt16LE(3),
                        rz: data.readInt16LE(5),
                    });
                }
            });

            this.device.on('error', (_err: unknown) => {
                this.closeDevice();
                this.scheduleRetry();
            });
        } catch (_err) {
            this.scheduleRetry();
        }
    }

    private closeDevice(): void {
        if (this.device) {
            try { this.device.close(); } catch (_) { /* ignore */ }
            this.device = null;
        }
        this.updateState({ connected: false, tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 });
    }

    private scheduleRetry(): void {
        if (this.disposed) { return; }
        this.retryTimer = setTimeout(() => this.openDevice(), 2000);
    }

    private updateState(patch: Partial<SpaceMouseState>): void {
        Object.assign(this.state, patch);
        const snapshot = { ...this.state };
        this.listeners.forEach(fn => fn(snapshot));
    }

    // ---- Driver helpers ----

    private stopHelper(): Promise<void> {
        return new Promise((resolve) => {
            execFile('pkill', ['-f', HELPER_PROC], () => resolve());
            // Ignore exit code — process may not be running
        });
    }

    private startHelper(): Promise<void> {
        return new Promise((resolve) => {
            execFile('open', [HELPER_APP], () => resolve());
        });
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
