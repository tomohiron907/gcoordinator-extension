/**
 * The contract between `SpaceMouseHost` and the platform-specific readers.
 *
 * There are two, because the platforms differ in kind rather than in detail:
 * macOS has to go through the 3Dconnexion driver (see `spacemouseHelper.ts`),
 * while Windows can read the puck's HID reports directly (`spacemouseHid.ts`).
 */

/** Axis values in the puck's raw HID range, roughly ±350 per axis. */
export interface Axes {
    tx: number; ty: number; tz: number;
    rx: number; ry: number; rz: number;
}

/** What a backend reports back to the host. */
export interface BackendCallbacks {
    /** New axis values, already normalised to the raw HID range. */
    axes(values: Axes): void;
    /** The puck is readable. */
    connected(deviceName: string): void;
    /** Reading failed for good. The message is shown to the user. */
    unavailable(message: string): void;
    /** Verbose diagnostics for the output channel. */
    log(message: string): void;
}

/** A platform-specific way of reading the puck. */
export interface Backend {
    start(): void;
    stop(): void;
    /**
     * VS Code gained or lost focus. Only the macOS backend acts on this, because
     * only there does the driver arbitrate between applications; on Windows the
     * per-panel gate suppresses input instead.
     */
    setActive(active: boolean): void;
}
