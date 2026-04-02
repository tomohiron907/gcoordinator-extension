import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { initSpaceMouse, applySpaceMouseToCamera } from './spacemouse';

// ---- Scene setup (same as preview.ts) ----

const container = document.getElementById('canvas-container') as HTMLElement;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setClearColor(0x1e1e1e);
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x1e1e1e, 150, 600);

const camera = new THREE.PerspectiveCamera(
    60,
    container.clientWidth / container.clientHeight,
    0.1,
    10000
);
camera.position.set(150, -80, 120);
camera.up.set(0, 0, 1);
camera.lookAt(100, 100, 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(100, 100, 0);

initSpaceMouse();

const grid = new THREE.GridHelper(200, 20, 0x555555, 0x333333);
grid.rotation.x = Math.PI / 2;
grid.position.set(100, 100, 0);
scene.add(grid);

const axes = new THREE.AxesHelper(50);
scene.add(axes);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.15);
scene.add(ambientLight);

const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight1.position.set(1, -1, 2);
scene.add(dirLight1);

const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.5);
dirLight2.position.set(-1, 1, -1);
scene.add(dirLight2);

// ---- Nozzle cone ----

const NOZZLE_HEIGHT = 10;
const nozzleGeo = new THREE.ConeGeometry(4, NOZZLE_HEIGHT, 16);
const nozzleMat = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
    side: THREE.DoubleSide,
});
const nozzleMesh = new THREE.Mesh(nozzleGeo, nozzleMat);
nozzleMesh.rotation.x = -Math.PI / 2; // tip points down (-Z)
nozzleMesh.visible = false;
scene.add(nozzleMesh);

// ---- Line info overlay ----

const lineInfoEl = document.getElementById('line-info') as HTMLElement;

// ---- Diamond tube geometry builder (identical to preview.ts) ----

const _Z_AXIS = new THREE.Vector3(0, 0, 1);
const _X_AXIS = new THREE.Vector3(1, 0, 0);

function buildDiamondTube(positions: Float32Array, N: number): THREE.BufferGeometry {
    const posOut   = new Float32Array(12 * N);
    const indexOut = new Uint32Array((N - 1) * 24);

    const d     = new THREE.Vector3();
    const right = new THREE.Vector3();
    const up    = new THREE.Vector3();
    const tmp   = new THREE.Vector3();

    for (let i = 0; i < N; i++) {
        const prev = i > 0     ? i - 1 : 0;
        const next = i < N - 1 ? i + 1 : N - 1;

        d.set(
            positions[next * 3]     - positions[prev * 3],
            positions[next * 3 + 1] - positions[prev * 3 + 1],
            positions[next * 3 + 2] - positions[prev * 3 + 2]
        );
        if (d.lengthSq() < 1e-20) { d.set(1, 0, 0); }
        d.normalize();

        right.crossVectors(_Z_AXIS, d);
        if (right.lengthSq() < 1e-10) { right.crossVectors(_X_AXIS, d); }
        right.normalize();

        up.crossVectors(d, right).normalize();

        const px = positions[i * 3];
        const py = positions[i * 3 + 1];
        const pz = positions[i * 3 + 2];
        const base = i * 12;

        tmp.set(px, py, pz).addScaledVector(right, 0.2);
        posOut[base]     = tmp.x; posOut[base + 1] = tmp.y; posOut[base + 2] = tmp.z;

        tmp.set(px, py, pz).addScaledVector(up, 0.1);
        posOut[base + 3] = tmp.x; posOut[base + 4] = tmp.y; posOut[base + 5] = tmp.z;

        tmp.set(px, py, pz).addScaledVector(right, -0.2);
        posOut[base + 6] = tmp.x; posOut[base + 7] = tmp.y; posOut[base + 8] = tmp.z;

        tmp.set(px, py, pz).addScaledVector(up, -0.1);
        posOut[base + 9]  = tmp.x; posOut[base + 10] = tmp.y; posOut[base + 11] = tmp.z;
    }

    let idx = 0;
    for (let i = 0; i < N - 1; i++) {
        const b = i * 4;
        for (let c = 0; c < 4; c++) {
            const c1 = (c + 1) & 3;
            const bi = b + c;
            const ni = b + c1;
            const bj = b + 4 + c;
            const nj = b + 4 + c1;
            indexOut[idx++] = bi; indexOut[idx++] = ni; indexOut[idx++] = nj;
            indexOut[idx++] = bi; indexOut[idx++] = nj; indexOut[idx++] = bj;
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(posOut, 3));
    geo.setIndex(new THREE.BufferAttribute(indexOut, 1));
    return geo;
}

// ---- Helpers ----

function b64ToFloat32Array(b64: string): Float32Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Float32Array(bytes.buffer);
}

function b64ToUint32Array(b64: string): Uint32Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Uint32Array(bytes.buffer);
}

// ---- State ----

interface SegmentMeta {
    isTravel: boolean;
    pointCount: number;
    floatOffset: number;
}

let objects: Array<THREE.Mesh | THREE.Line> = [];
let segmentMetas: SegmentMeta[] = [];
let allCoords: Float32Array = new Float32Array(0);
let lineIdxSeg: Uint32Array = new Uint32Array(0);
let lineIdxPt:  Uint32Array = new Uint32Array(0);
let storedTotalLines = 0;

// ---- Message handler ----

interface GCodeUpdateMsg {
    type: 'gcode-update';
    coords_b64: string;
    segments: SegmentMeta[];
    segIdx_b64: string;
    ptIdx_b64: string;
    totalLines: number;
}

interface GCodeSeekMsg {
    type: 'gcode-seek';
    segIdx: number;
    pointIdx: number;
    lineNum: number;
    totalLines: number;
}

interface GCodeShowAllMsg {
    type: 'gcode-show-all';
}

window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as GCodeUpdateMsg | GCodeSeekMsg | GCodeShowAllMsg;

    if (msg.type === 'gcode-update') {
        // Clear old objects
        objects.forEach((obj) => {
            scene.remove(obj);
            obj.geometry.dispose();
            if (Array.isArray(obj.material)) {
                obj.material.forEach(m => m.dispose());
            } else {
                (obj.material as THREE.Material).dispose();
            }
        });
        objects = [];

        allCoords     = b64ToFloat32Array(msg.coords_b64);
        segmentMetas  = msg.segments;
        lineIdxSeg    = b64ToUint32Array(msg.segIdx_b64);
        lineIdxPt     = b64ToUint32Array(msg.ptIdx_b64);
        storedTotalLines = msg.totalLines;

        // Build Three.js objects for each segment — all start hidden
        for (const seg of segmentMetas) {
            const coords = allCoords.subarray(seg.floatOffset, seg.floatOffset + seg.pointCount * 3);

            if (!seg.isTravel) {
                // Extrusion: diamond tube mesh
                const geo = buildDiamondTube(coords, seg.pointCount);
                geo.setDrawRange(0, 0);
                const mat = new THREE.MeshPhongMaterial({
                    color: 0xffffff,
                    side: THREE.FrontSide,
                    flatShading: true,
                    shininess: 60,
                });
                const mesh = new THREE.Mesh(geo, mat);
                mesh.visible = false;
                scene.add(mesh);
                objects.push(mesh);
            } else {
                // Travel: thin line
                const geo = new THREE.BufferGeometry();
                geo.setAttribute('position', new THREE.BufferAttribute(coords.slice(), 3));
                geo.setDrawRange(0, 0);
                const mat = new THREE.LineBasicMaterial({
                    color: 0xffffff,
                    opacity: 0.15,
                    transparent: true,
                });
                const line = new THREE.Line(geo, mat);
                line.visible = false;
                scene.add(line);
                objects.push(line);
            }
        }

    } else if (msg.type === 'gcode-seek') {
        applySeek(msg.segIdx, msg.pointIdx, msg.lineNum, msg.totalLines);
    } else if (msg.type === 'gcode-show-all') {
        applyShowAll();
    }
});

function applyShowAll(): void {
    nozzleMesh.visible = false;
    for (let i = 0; i < objects.length; i++) {
        const obj = objects[i];
        const meta = segmentMetas[i];
        const N = meta.pointCount;
        obj.visible = true;
        obj.geometry.setDrawRange(0, meta.isTravel ? N : (N - 1) * 24);
        (obj.material as THREE.MeshPhongMaterial | THREE.LineBasicMaterial).color.setHex(0xffffff);
    }
    lineInfoEl.textContent = '';
}

function applySeek(segIdx: number, pointIdx: number, lineNum: number, totalLines: number): void {
    const count = objects.length;
    if (count === 0) { return; }

    // Clamp
    const si = Math.min(segIdx, count - 1);

    // Determine current Z height for layer dimming
    const curMeta = segmentMetas[si];
    const curPi = Math.min(pointIdx, curMeta.pointCount - 1);
    const currentZ = curPi >= 0 ? allCoords[curMeta.floatOffset + curPi * 3 + 2] : 0;

    for (let i = 0; i < count; i++) {
        const obj = objects[i];
        const meta = segmentMetas[i];
        const N = meta.pointCount;

        if (i < si) {
            // Fully visible
            obj.visible = true;
            if (!meta.isTravel) {
                obj.geometry.setDrawRange(0, (N - 1) * 24);
            } else {
                obj.geometry.setDrawRange(0, N);
            }
            // Dim segments below the current layer
            const segZ = allCoords[meta.floatOffset + 2];
            const dim = segZ < currentZ - 0.001;
            (obj.material as THREE.MeshPhongMaterial | THREE.LineBasicMaterial).color.setHex(dim ? 0x555555 : 0xffffff);
        } else if (i === si) {
            // Current segment: always bright
            (obj.material as THREE.MeshPhongMaterial | THREE.LineBasicMaterial).color.setHex(0xffffff);
            // Partial: show up to pointIdx
            const pi = Math.min(pointIdx, N - 1);
            if (pi <= 0) {
                obj.visible = false;
            } else {
                obj.visible = true;
                if (!meta.isTravel) {
                    obj.geometry.setDrawRange(0, pi * 24);
                } else {
                    obj.geometry.setDrawRange(0, pi + 1);
                }
                // Update nozzle to current point
                const base = meta.floatOffset + pi * 3;
                nozzleMesh.position.set(
                    allCoords[base],
                    allCoords[base + 1],
                    allCoords[base + 2] + NOZZLE_HEIGHT / 2
                );
                nozzleMesh.visible = true;
            }
        } else {
            // Hidden
            obj.visible = false;
        }
    }

    lineInfoEl.textContent = `Line ${lineNum + 1} / ${totalLines}`;
}

// ---- Animation loop ----

function animate(): void {
    requestAnimationFrame(animate);
    applySpaceMouseToCamera(camera, controls);
    controls.update();
    const camDist = camera.position.distanceTo(controls.target);
    const fog = scene.fog as THREE.Fog;
    fog.near = camDist * 0.3;
    fog.far  = camDist * 2.0;
    renderer.render(scene, camera);
}
animate();

// ---- Resize handler ----

window.addEventListener('resize', () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
});
