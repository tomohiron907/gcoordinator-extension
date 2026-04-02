import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// ---- Constants ----

const SCALE_T  = 0.003;   // translation: raw ±500 → world units/frame
const SCALE_R  = 0.0003;  // rotation: raw ±500 → radians/frame
const DEADZONE = 10;      // ignore raw values below this threshold

// ---- State (updated by postMessage from extension host) ----

interface SpaceMouseState {
    type: 'spacemouse';
    tx: number; ty: number; tz: number;
    rx: number; ry: number; rz: number;
    connected: boolean;
    deviceName: string;
}

const state: SpaceMouseState = {
    type: 'spacemouse',
    tx: 0, ty: 0, tz: 0,
    rx: 0, ry: 0, rz: 0,
    connected: false,
    deviceName: '',
};

// ---- DOM references (set in initSpaceMouse) ----

let statusEl: HTMLElement | null = null;

function updateOverlay(): void {
    const ids = ['sm-tx', 'sm-ty', 'sm-tz', 'sm-rx', 'sm-ry', 'sm-rz'] as const;
    const vals = [state.tx, state.ty, state.tz, state.rx, state.ry, state.rz];
    ids.forEach((id, i) => {
        const el = document.getElementById(id);
        if (el) { el.textContent = String(vals[i]); }
    });
    if (statusEl) {
        if (state.connected) {
            statusEl.textContent = `SpaceMouse: ${state.deviceName}`;
            statusEl.style.color = '#6bff6b';
        } else {
            statusEl.textContent = 'SpaceMouse: searching...';
            statusEl.style.color = '#ffaa44';
        }
    }
}

// ---- Public init ----

export function initSpaceMouse(): void {
    statusEl = document.getElementById('sm-status');

    // Receive SpaceMouse data forwarded from extension host via postMessage
    window.addEventListener('message', (event: MessageEvent) => {
        const msg = event.data as SpaceMouseState;
        if (msg.type !== 'spacemouse') { return; }

        state.tx = msg.tx; state.ty = msg.ty; state.tz = msg.tz;
        state.rx = msg.rx; state.ry = msg.ry; state.rz = msg.rz;
        state.connected  = msg.connected;
        state.deviceName = msg.deviceName;
        updateOverlay();
    });

    updateOverlay();
}

// ---- Camera application ----
// Called every frame from animate(). Applies SpaceMouse input to Three.js camera.
//
// Axis mapping (Camera Mode, Z-up scene):
//   Tx (Pan Right/Left)  → pan along camera-right vector
//   Tz (Pan Up/Down)     → pan along world Z axis
//   Ty (Zoom)            → dolly along camera-forward (changes orbit radius)
//   Rx (Tilt/Pitch)      → orbit pitch around camera-right axis
//   Rz (Spin/Yaw)        → orbit yaw around world Z axis
//   Ry (Roll)            → not implemented

// Reuse Vector3/Quaternion instances to avoid GC pressure in the animation loop
const _forward = new THREE.Vector3();
const _right   = new THREE.Vector3();
const _worldZ  = new THREE.Vector3(0, 0, 1);
const _offset  = new THREE.Vector3();
const _pitchQ  = new THREE.Quaternion();
const _yawQ    = new THREE.Quaternion();

function dz(v: number): number {
    return Math.abs(v) < DEADZONE ? 0 : v;
}

export function applySpaceMouseToCamera(
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls
): void {
    if (!state.connected) { return; }

    const tx = dz(state.tx) * SCALE_T;
    const ty = dz(state.ty) * SCALE_T;
    const tz = dz(state.tz) * SCALE_T;
    const rx = dz(state.rx) * SCALE_R;
    const rz = dz(state.rz) * SCALE_R;

    if (tx === 0 && ty === 0 && tz === 0 && rx === 0 && rz === 0) { return; }

    // Camera-right: forward × up (then normalize)
    camera.getWorldDirection(_forward);
    _right.crossVectors(_forward, camera.up).normalize();

    // 1. Pan: move camera and target together (preserves orbit center)
    //    Tx → along camera-right; Tz → along world Z
    camera.position.addScaledVector(_right, -tx);
    controls.target.addScaledVector(_right, -tx);
    camera.position.addScaledVector(_worldZ, tz);
    controls.target.addScaledVector(_worldZ, tz);

    // 2. Dolly: move camera along forward only (changes distance to target)
    //    Ty positive = push away from screen → camera moves toward scene
    camera.position.addScaledVector(_forward, ty);

    // 3. Orbit: rotate offset vector around target
    _offset.subVectors(camera.position, controls.target);

    if (rx !== 0) {
        _pitchQ.setFromAxisAngle(_right, -rx);
        _offset.applyQuaternion(_pitchQ);
    }
    if (rz !== 0) {
        _yawQ.setFromAxisAngle(_worldZ, rz);
        _offset.applyQuaternion(_yawQ);
    }

    camera.position.copy(controls.target).add(_offset);

    // Re-assert Z-up after rotation to prevent OrbitControls drift
    camera.up.set(0, 0, 1);
}
