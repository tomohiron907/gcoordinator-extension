import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// ---- Constants ----

const DEADZONE = 10;      // ignore raw values below this threshold

// ---- Per-axis speed multipliers (tune these to taste) ----
// Base scale: raw SpaceMouse value ±500 → raw world units/frame before distance scaling
const SCALE_PAN_LR   = 0.003;  // 左右 pan (Tx)
const SCALE_PAN_UD   = 0.003;  // 上下 pan (Tz)
const SCALE_DOLLY    = 0.009;  // 奥手前 dolly (Ty)  ← SCALE_PAN * 3 相当
const SCALE_YAW      = 0.0003; // ターン / 水平回転 (Rz)
const SCALE_PITCH    = 0.0003; // 見下ろし / 俯仰回転 (Rx)

const REF_DIST     = 150;  // reference camera distance for speed scaling
const SPHERE_SHOW_MS = 1500; // ms after input stops before hiding orbit indicator

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

// ---- Scene context for raycasting (set via setupSpaceMouseScene) ----

const _raycaster    = new THREE.Raycaster();
const _screenCenter = new THREE.Vector2(0, 0);
const _floorPlane   = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const _planeHit     = new THREE.Vector3();
const _vtx          = new THREE.Vector3(); // reused for vertex world-position scan

let _getMeshes: (() => THREE.Mesh[]) | null = null;
let _orbitSphere: THREE.Mesh | null = null;
let _wasActive = false;
let _sphereHideTimer = 0;
const _orbitCenter = new THREE.Vector3(); // fixed orbit pivot (sphere position) for the current gesture
const _orbitOffset = new THREE.Vector3(); // camera offset from _orbitCenter, rotation only (no pan)
const _panAccum    = new THREE.Vector3(); // accumulated pan since gesture start

export function setupSpaceMouseScene(
    scene: THREE.Scene,
    getMeshes: () => THREE.Mesh[]
): void {
    _getMeshes = getMeshes;

    const geo = new THREE.SphereGeometry(2.5, 12, 8);
    const mat = new THREE.MeshBasicMaterial({
        color: 0x00d4ff,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
    });
    _orbitSphere = new THREE.Mesh(geo, mat);
    _orbitSphere.visible = false;
    scene.add(_orbitSphere);
}

/**
 * Scan all visible mesh vertices and return the world-space vertex
 * closest to `reference`. Returns false if no vertices found.
 */
function closestVertexToPoint(meshes: THREE.Mesh[], reference: THREE.Vector3, out: THREE.Vector3): boolean {
    let bestSq = Infinity;
    let found  = false;
    for (const mesh of meshes) {
        const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | null;
        if (!pos) { continue; }
        const mat = mesh.matrixWorld;
        for (let i = 0; i < pos.count; i++) {
            _vtx.fromBufferAttribute(pos, i).applyMatrix4(mat);
            const sq = _vtx.distanceToSquared(reference);
            if (sq < bestSq) { bestSq = sq; out.copy(_vtx); found = true; }
        }
    }
    return found;
}

function updateOrbitCenter(camera: THREE.PerspectiveCamera, controls: OrbitControls): void {
    if (!_getMeshes) { return; }

    _raycaster.setFromCamera(_screenCenter, camera);

    const meshes = _getMeshes();
    const hits = meshes.length > 0 ? _raycaster.intersectObjects(meshes, false) : [];

    if (hits.length > 0) {
        _orbitCenter.copy(hits[0].point);
    } else {
        // Fallback: Z=0 plane intersection, then snap to the nearest object vertex.
        // This prevents choosing a pivot that is far from all geometry.
        if (_raycaster.ray.intersectPlane(_floorPlane, _planeHit)) {
            if (meshes.length > 0 && closestVertexToPoint(meshes, _planeHit, _orbitCenter)) {
                // _orbitCenter now holds the nearest vertex on any visible mesh
            } else {
                _orbitCenter.copy(_planeHit);
            }
        } else {
            _orbitCenter.copy(controls.target);
        }
    }

    // Keep controls.target (and thus camera look-direction) unchanged so there
    // is no visual jump when a new gesture session starts.
    // _panAccum absorbs the difference between the new _orbitCenter and the
    // current controls.target so that the invariant holds:
    //   camera.position === _orbitCenter + _orbitOffset + _panAccum
    //   controls.target  === _orbitCenter + _panAccum
    _panAccum.subVectors(controls.target, _orbitCenter);
    _orbitOffset.subVectors(camera.position, _orbitCenter).sub(_panAccum);

    if (_orbitSphere) {
        _orbitSphere.position.copy(_orbitCenter);
        _orbitSphere.visible = true;
    }
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
    controls: OrbitControls,
    delta: number  // frame interval in ms (for sphere hide timer)
): void {
    if (!state.connected) { return; }

    const tx = dz(state.tx) * SCALE_PAN_LR;
    const ty = dz(state.ty) * SCALE_DOLLY;
    const tz = dz(state.tz) * SCALE_PAN_UD;
    const rx = dz(state.rx) * SCALE_PITCH;
    const rz = dz(state.rz) * SCALE_YAW;

    const isActive = tx !== 0 || ty !== 0 || tz !== 0 || rx !== 0 || rz !== 0;

    if (!isActive) {
        if (_orbitSphere && _orbitSphere.visible) {
            _sphereHideTimer -= delta;
            if (_sphereHideTimer <= 0) {
                _orbitSphere.visible = false;
            }
        }
        _wasActive = false;
        return;
    }

    // On gesture start (idle → active): update orbit center via raycasting
    if (!_wasActive) {
        updateOrbitCenter(camera, controls);
    }
    _wasActive = true;
    _sphereHideTimer = SPHERE_SHOW_MS;

    // Distance-dependent speed scaling (Fusion-style: closer = slower)
    const dist = camera.position.distanceTo(_orbitCenter);
    const distScale = Math.max(0.05, dist / REF_DIST);

    const scaledTx = tx * distScale;
    const scaledTy = ty * distScale;
    const scaledTz = tz * distScale;
    // Rotation is only partially scaled by distance (40% blend) for a comfortable feel
    const rotScale = 1.0 + (distScale - 1.0) * 0.4;
    const scaledRx = rx * rotScale;
    const scaledRz = rz * rotScale;


    // _forward/_right are based on the quaternion set by controls.update() last frame
    // (i.e., the direction the user currently sees)
    camera.getWorldDirection(_forward);
    _right.crossVectors(_forward, camera.up).normalize();

    // 1. Orbit: rotate _orbitOffset only (pan is tracked separately in _panAccum)
    if (scaledRx !== 0) {
        _pitchQ.setFromAxisAngle(_right, -scaledRx);
        _orbitOffset.applyQuaternion(_pitchQ);
    }
    if (scaledRz !== 0) {
        _yawQ.setFromAxisAngle(_worldZ, scaledRz);
        _orbitOffset.applyQuaternion(_yawQ);
    }

    // Reconstruct camera position from components
    camera.position.copy(_orbitCenter).add(_orbitOffset).add(_panAccum);
    camera.up.set(0, 0, 1);

    // 2. Pan: move camera AND controls.target together by the same delta.
    //    This keeps the camera-to-target offset intact so OrbitControls.update()
    //    does NOT rotate the camera to look back at a fixed point.
    camera.getWorldDirection(_forward);
    _right.crossVectors(_forward, camera.up).normalize();

    if (scaledTx !== 0) {
        const d = -scaledTx;
        camera.position.addScaledVector(_right, d);
        controls.target.addScaledVector(_right, d);
        _panAccum.addScaledVector(_right, d);
    }
    if (scaledTz !== 0) {
        camera.position.addScaledVector(_worldZ, scaledTz);
        controls.target.addScaledVector(_worldZ, scaledTz);
        _panAccum.addScaledVector(_worldZ, scaledTz);
    }

    // 3. Dolly: move camera along forward; update _orbitOffset so rotation
    //    stays consistent after zoom
    if (scaledTy !== 0) {
        camera.position.addScaledVector(_forward, scaledTy);
        _orbitOffset.addScaledVector(_forward, scaledTy);
    }

    // Sphere stays fixed at _orbitCenter — no position update needed here
}
