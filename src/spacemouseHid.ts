import { Backend, BackendCallbacks } from './spacemouseBackend';

/**
 * Windows backend: reads the puck's HID reports directly.
 *
 * Unlike the macOS driver, 3DxWare on Windows does not seize the device, so the
 * raw interface can be opened alongside it and the puck keeps working in other
 * applications. There is no driver-level foreground arbitration on this route
 * though — the device reports whenever it is moved, no matter which window is in
 * front — so `SpaceMouseGate` is what stops a Fusion 360 gesture from also
 * turning the preview.
 */

// ---- Constants ----

/** 3Dconnexion, plus the Logitech IDs the older SpaceNavigator/Traveler ship with. */
const VENDOR_IDS = [0x256f, 0x046d];

/**
 * HID usage of the 6-DoF collection (Generic Desktop / Multi-axis Controller).
 * A SpaceMouse exposes several collections — keyboard, consumer control, a
 * vendor page — and only this one carries the axes.
 */
const USAGE_PAGE_GENERIC_DESKTOP = 0x01;
const USAGE_MULTI_AXIS = 0x08;

/** How long to wait before looking for the device again. */
const RETRY_MS = 2000;

// ---- node-hid shim ----
//
// Required lazily so the native module is only loaded on the platform that uses
// it, and marked external in the esbuild bundle so its prebuilds resolve at
// runtime. Only the parts used here are typed.

interface HidDeviceInfo {
    path?: string;
    product?: string;
    vendorId: number;
    productId: number;
    usagePage?: number;
    usage?: number;
}

interface HidDevice {
    on(event: 'data', listener: (data: Buffer) => void): void;
    on(event: 'error', listener: (err: unknown) => void): void;
    close(): void;
}

interface NodeHid {
    devices(): HidDeviceInfo[];
    HID: new (path: string) => HidDevice;
}

// ---- HidBackend ----

export class HidBackend implements Backend {
    private hid: NodeHid | null = null;
    private device: HidDevice | null = null;
    private stopped = false;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly cb: BackendCallbacks) {}

    start(): void {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            this.hid = require('node-hid') as NodeHid;
        } catch (err) {
            this.cb.unavailable(`could not load the HID module: ${errorText(err)}`);
            return;
        }
        this.open();
    }

    stop(): void {
        this.stopped = true;
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
        const device = this.device;
        this.device = null;
        if (device) {
            try { device.close(); } catch (_) { /* ignore */ }
        }
    }

    /** Nothing to do: focus is handled by the gate, not by the device. */
    setActive(_active: boolean): void { /* no-op */ }

    // ---- Private ----

    private open(): void {
        if (this.stopped || !this.hid) { return; }

        let candidates: HidDeviceInfo[];
        try {
            candidates = this.hid.devices().filter(d => VENDOR_IDS.includes(d.vendorId));
        } catch (err) {
            this.fail(`could not enumerate HID devices: ${errorText(err)}`);
            return;
        }

        const target = pickInterface(candidates);
        if (!target?.path) {
            this.fail('no SpaceMouse found — connect the device and reopen the preview');
            return;
        }

        this.cb.log(`opening ${target.product ?? 'SpaceMouse'} @ ${target.path}`);
        try {
            this.device = new this.hid.HID(target.path);
        } catch (err) {
            this.fail(`could not open ${target.product ?? 'the SpaceMouse'} — ${errorText(err)}`);
            return;
        }

        this.device.on('data', (data) => this.onReport(data));
        this.device.on('error', (err) => this.onError(err));
        this.cb.connected(target.product ?? 'SpaceMouse');
    }

    /**
     * Axes arrive as signed 16-bit little-endian values. Which report carries
     * them depends on the model: newer wireless pucks pack all six into report 1,
     * while the classic layout splits translation (report 1) and rotation
     * (report 2) into separate reports that arrive back to back.
     */
    private onReport(data: Buffer): void {
        const reportId = data[0];
        if (reportId === 1 && data.length >= 13) {
            this.cb.axes({
                tx: data.readInt16LE(1), ty: data.readInt16LE(3), tz: data.readInt16LE(5),
                rx: data.readInt16LE(7), ry: data.readInt16LE(9), rz: data.readInt16LE(11),
            });
        } else if (reportId === 1 && data.length >= 7) {
            this.cb.axes({
                tx: data.readInt16LE(1), ty: data.readInt16LE(3), tz: data.readInt16LE(5),
                rx: 0, ry: 0, rz: 0,
            });
        } else if (reportId === 2 && data.length >= 7) {
            this.cb.axes({
                tx: 0, ty: 0, tz: 0,
                rx: data.readInt16LE(1), ry: data.readInt16LE(3), rz: data.readInt16LE(5),
            });
        }
        // Report 3 is the buttons, which the preview does not use.
    }

    private onError(err: unknown): void {
        if (this.stopped) { return; }
        this.cb.log(`HID error: ${errorText(err)}`);
        // Unplugging surfaces as a read error; drop the handle and look again.
        const device = this.device;
        this.device = null;
        if (device) {
            try { device.close(); } catch (_) { /* ignore */ }
        }
        this.retry();
    }

    /**
     * Report why the puck is not readable, and keep looking for it — a device
     * that is unplugged, or momentarily claimed while another application
     * starts, usually comes back. The host shows the reason once and clears it
     * again on reconnect, so this does not warn every two seconds.
     */
    private fail(message: string): void {
        this.cb.unavailable(message);
        this.retry();
    }

    private retry(): void {
        if (this.stopped || this.retryTimer) { return; }
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.open();
        }, RETRY_MS);
    }
}

// ---- Helpers ----

/**
 * A SpaceMouse shows up as several HID interfaces. Prefer the one that declares
 * itself a multi-axis controller; if the descriptor is not exposed (some drivers
 * hide it), fall back to the first interface so the classic report layout still
 * has a chance of working.
 */
function pickInterface(devices: HidDeviceInfo[]): HidDeviceInfo | undefined {
    const multiAxis = devices.find(
        d => d.usagePage === USAGE_PAGE_GENERIC_DESKTOP && d.usage === USAGE_MULTI_AXIS,
    );
    return multiAxis ?? devices.find(d => !!d.path);
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
