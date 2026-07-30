import { Axes, Backend } from './spacemouseBackend';
import { HelperBackend } from './spacemouseHelper';
import { HidBackend } from './spacemouseHid';

/**
 * Reads a 3Dconnexion SpaceMouse and publishes its state to listeners.
 *
 * How the puck is read differs by platform, so the actual reading lives in a
 * backend (`spacemouseHelper.ts` on macOS, `spacemouseHid.ts` on Windows) and
 * this class owns everything that does not: the published state, the listeners,
 * and the release detection. Whichever backend is in use, the 3Dconnexion driver
 * is never touched, so the puck keeps working in Fusion 360 and elsewhere.
 */

// ---- Constants ----

/**
 * The puck streams continuously while it is displaced and stops when it
 * re-centres. It normally sends a zero frame on release, but if one is ever
 * dropped the webview would keep applying the last non-zero axes every frame, so
 * a stall is treated as "released".
 */
const IDLE_MS = 250;

// ---- Types ----

export interface SpaceMouseState extends Axes {
    type: 'spacemouse';
    connected: boolean;
    deviceName: string;
}

type Listener = (state: SpaceMouseState) => void;

/** Called when the SpaceMouse cannot be read, so the reason reaches the user. */
type StatusListener = (message: string) => void;

/** Verbose diagnostics sink (an output channel), separate from user-facing status. */
type Logger = (message: string) => void;

// ---- SpaceMouseHost ----

export class SpaceMouseHost {
    private backend: Backend | null = null;
    private stopped = false;
    /** Set while a failure has been shown, so a retrying backend only warns once. */
    private reported = false;
    private active = false;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private listeners: Listener[] = [];
    private state: SpaceMouseState = {
        type: 'spacemouse',
        tx: 0, ty: 0, tz: 0,
        rx: 0, ry: 0, rz: 0,
        connected: false,
        deviceName: '',
    };

    /**
     * @param helperPath Absolute path to the bundled `spacemoused` binary (macOS).
     */
    constructor(
        private readonly helperPath: string,
        private readonly onStatus: StatusListener,
        private readonly log: Logger,
    ) {}

    // ---- Lifecycle ----

    start(): void {
        const callbacks = {
            axes: (values: Axes) => this.onAxes(values),
            connected: (deviceName: string) => {
                this.reported = false;
                this.updateState({ connected: true, deviceName });
            },
            unavailable: (message: string) => this.unavailable(message),
            log: this.log,
        };

        if (process.platform === 'darwin') {
            this.backend = new HelperBackend(this.helperPath, callbacks);
        } else if (process.platform === 'win32') {
            this.backend = new HidBackend(callbacks);
        } else {
            // Linux would need udev rules, and spacenavd may hold the device.
            this.unavailable(`SpaceMouse support is not available on ${process.platform}`);
            return;
        }

        this.backend.setActive(this.active);
        this.backend.start();
    }

    /** Release the puck. The 3Dconnexion driver is never touched. */
    stop(): void {
        this.stopped = true;
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
        this.backend?.stop();
        this.backend = null;
    }

    /** Follow VS Code window focus. See `Backend.setActive`. */
    setActive(active: boolean): void {
        if (active === this.active) { return; }
        this.active = active;
        this.backend?.setActive(active);
        if (!active) { this.zeroAxes(); }
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

    private onAxes(values: Axes): void {
        this.updateState(values);
        if (this.idleTimer) { clearTimeout(this.idleTimer); }
        this.idleTimer = setTimeout(() => this.zeroAxes(), IDLE_MS);
    }

    private zeroAxes(): void {
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
        this.updateState({ tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 });
    }

    private unavailable(message: string): void {
        if (this.stopped || this.reported) { return; }
        this.reported = true;
        this.log(`SpaceMouse unavailable: ${message}`);
        this.updateState({ connected: false, deviceName: '', tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 });
        this.onStatus(message);
    }

    private updateState(patch: Partial<SpaceMouseState>): void {
        Object.assign(this.state, patch);
        const snapshot = { ...this.state };
        this.listeners.forEach(fn => fn(snapshot));
    }
}
