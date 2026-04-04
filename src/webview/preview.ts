import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { initSpaceMouse, applySpaceMouseToCamera, setupSpaceMouseScene } from './spacemouse';

// ---- Scene setup ----

const container = document.getElementById('canvas-container') as HTMLElement;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setClearColor(0x1e1e1e);
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = null;

const camera = new THREE.PerspectiveCamera(
    60,
    container.clientWidth / container.clientHeight,
    0.1,
    10000
);
camera.position.set(50, -180, 120);
camera.up.set(0, 0, 1);
camera.lookAt(0, 0, 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0, 0);

initSpaceMouse();
setupSpaceMouseScene(scene, () => pathMeshes.filter(m => m.visible));

// Grid in XY plane (Z=0 is the printer bed)
const grid = new THREE.GridHelper(200, 20, 0x555555, 0x333333);
grid.rotation.x = Math.PI / 2;
scene.add(grid);

const axes = new THREE.AxesHelper(50);
scene.add(axes);

// Lighting for shading
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

// ---- State ----

let pathMeshes: THREE.Mesh[] = [];
let travelLines: THREE.Line[] = [];
let storedPathLengths: number[] = [];
let storedLayerCoords: Float32Array[] = [];
let storedTravelCoords: Float32Array[] = [];
let storedTravelPathLengths: number[] = [];
let currentTopIndex = -1;

// ---- Vertical slider (layer range) ----

const vSlider    = document.getElementById('layer-slider') as HTMLInputElement;
const vValLabel  = document.getElementById('layer-val')   as HTMLElement;
const totalLabel = document.getElementById('layer-total') as HTMLElement;

function applyVerticalSlider(): void {
    const total = pathMeshes.length;
    if (total === 0) { return; }

    const maxVisible = parseInt(vSlider.value, 10);

    // Restore previous top layer to full draw range before switching
    if (currentTopIndex >= 0 && currentTopIndex < pathMeshes.length) {
        const prevN = storedPathLengths[currentTopIndex];
        pathMeshes[currentTopIndex].geometry.setDrawRange(0, (prevN - 1) * 24);
    }

    // Restore any dimming from curve slider
    dimLowerLayers(false);

    // Update layer visibility
    vValLabel.textContent = String(maxVisible + 1);
    pathMeshes.forEach((mesh, i) => {
        mesh.visible = i <= maxVisible;
    });
    travelLines.forEach((line, i) => {
        const vis = (i + 1) <= maxVisible;
        line.visible = vis;
        if (vis) {
            line.geometry.setDrawRange(0, Infinity); // fully drawn for past travels
        } else {
            line.geometry.setDrawRange(0, 0); // reset any partial draw
        }
    });

    currentTopIndex = maxVisible;

    // Sync horizontal slider to the new top layer (including travel extension if present)
    const topLen = storedPathLengths[maxVisible];
    const travelExtra = (storedTravelPathLengths[maxVisible] ?? 0) > 0
        ? (storedTravelPathLengths[maxVisible] + 1) : 0;
    const totalLen = topLen + travelExtra;
    hSlider.min   = '1';
    hSlider.max   = String(totalLen);
    hSlider.value = String(totalLen);
    hTotalLabel.textContent = String(totalLen);
    applyHorizontalSlider(); // sets hValLabel and nozzle based on current slider value
}

vSlider.addEventListener('input', applyVerticalSlider);

// ---- Horizontal slider (curve range of the top layer) ----

const hSlider      = document.getElementById('curve-slider') as HTMLInputElement;
const hValLabel    = document.getElementById('curve-val')   as HTMLElement;
const hTotalLabel  = document.getElementById('curve-total') as HTMLElement;

function dimLowerLayers(dim: boolean): void {
    pathMeshes.forEach((mesh, i) => {
        if (i < currentTopIndex) {
            (mesh.material as THREE.MeshPhongMaterial).color.setHex(dim ? 0x555555 : 0xffffff);
        }
    });
}

function applyHorizontalSlider(): void {
    if (currentTopIndex < 0 || pathMeshes.length === 0) { return; }
    const pointCount = parseInt(hSlider.value, 10);
    const mainLen    = storedPathLengths[currentTopIndex];
    const maxPoints  = parseInt(hSlider.max, 10);

    if (pointCount <= mainLen) {
        // ---- Main path phase ----
        const indexCount = Math.max(0, pointCount - 1) * 24;
        pathMeshes[currentTopIndex].geometry.setDrawRange(0, indexCount);
        // Hide travel line for this path while still printing
        const tl = travelLines[currentTopIndex];
        if (tl) { tl.visible = false; tl.geometry.setDrawRange(0, 0); }
        hValLabel.textContent = String(pointCount);
        dimLowerLayers(pointCount < maxPoints);
        updateNozzle(currentTopIndex, pointCount - 1);
    } else {
        // ---- Travel phase ----
        // Show main path in full
        pathMeshes[currentTopIndex].geometry.setDrawRange(0, (mainLen - 1) * 24);
        // travelStep: 1-based index into travel pts array (pts[0] = end of main path)
        const travelStep = pointCount - mainLen;
        const tl   = travelLines[currentTopIndex];
        const tPts = storedTravelCoords[currentTopIndex];
        if (tl && tPts) {
            tl.visible = true;
            tl.geometry.setDrawRange(0, travelStep + 1); // show pts[0..travelStep]
            nozzleMesh.position.set(
                tPts[travelStep * 3],
                tPts[travelStep * 3 + 1],
                tPts[travelStep * 3 + 2] + NOZZLE_HEIGHT / 2
            );
            nozzleMesh.visible = true;
        }
        hValLabel.textContent = String(pointCount);
        dimLowerLayers(true);
    }
}

hSlider.addEventListener('input', applyHorizontalSlider);

// ---- Nozzle update ----

function updateNozzle(layerIndex: number, pointIndex: number): void {
    const coords = storedLayerCoords[layerIndex];
    if (!coords) { nozzleMesh.visible = false; return; }

    nozzleMesh.position.set(
        coords[pointIndex * 3],
        coords[pointIndex * 3 + 1],
        coords[pointIndex * 3 + 2] + NOZZLE_HEIGHT / 2
    );
    nozzleMesh.visible = true;
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

function valueToColor(t: number): THREE.Color {
    // hue: red (0°) at bottom → blue (240°) at top
    return new THREE.Color().setHSL((t * 240) / 360, 1.0, 0.55);
}

// ---- Diamond tube geometry builder ----

const _Z_AXIS = new THREE.Vector3(0, 0, 1);
const _X_AXIS = new THREE.Vector3(1, 0, 0);

function buildDiamondTube(positions: Float32Array, N: number): THREE.BufferGeometry {
    const posOut   = new Float32Array(12 * N);
    const indexOut = new Uint32Array((N - 1) * 24);

    // Reuse Vector3 instances to avoid GC pressure in the hot loop
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

        // right tip (+0.2 * right)
        tmp.set(px, py, pz).addScaledVector(right, 0.2);
        posOut[base]     = tmp.x; posOut[base + 1] = tmp.y; posOut[base + 2] = tmp.z;

        // top tip (+0.1 * up)
        tmp.set(px, py, pz).addScaledVector(up, 0.1);
        posOut[base + 3] = tmp.x; posOut[base + 4] = tmp.y; posOut[base + 5] = tmp.z;

        // left tip (-0.2 * right)
        tmp.set(px, py, pz).addScaledVector(right, -0.2);
        posOut[base + 6] = tmp.x; posOut[base + 7] = tmp.y; posOut[base + 8] = tmp.z;

        // bottom tip (-0.1 * up)
        tmp.set(px, py, pz).addScaledVector(up, -0.1);
        posOut[base + 9]  = tmp.x; posOut[base + 10] = tmp.y; posOut[base + 11] = tmp.z;
    }

    // Build index buffer: 4 quads per segment, 2 triangles per quad (CCW from outside)
    let idx = 0;
    for (let i = 0; i < N - 1; i++) {
        const b = i * 4;
        for (let c = 0; c < 4; c++) {
            const c1 = (c + 1) & 3; // modulo 4
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

// ---- Message handler ----

interface UpdateMessage {
    type: 'update';
    path_lengths: number[];
    coords_b64: string;
    travel_path_lengths: number[];
    travel_coords_b64: string;
}

window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as UpdateMessage;
    if (msg.type !== 'update') { return; }

    // Clear old meshes
    pathMeshes.forEach((mesh) => {
        scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
    });
    pathMeshes = [];
    travelLines.forEach((line) => {
        scene.remove(line);
        line.geometry.dispose();
        (line.material as THREE.Material).dispose();
    });
    travelLines = [];
    storedLayerCoords = [];
    storedTravelCoords = [];

    const { path_lengths, coords_b64, travel_path_lengths, travel_coords_b64 } = msg;
    storedTravelPathLengths = travel_path_lengths || [];
    storedPathLengths = path_lengths;
    const allCoords = b64ToFloat32Array(coords_b64);
    const travelCoords = travel_coords_b64 ? b64ToFloat32Array(travel_coords_b64) : new Float32Array(0);

    // Z range for color mapping
    let zMin = Infinity, zMax = -Infinity;
    for (let i = 2; i < allCoords.length; i += 3) {
        if (allCoords[i] < zMin) { zMin = allCoords[i]; }
        if (allCoords[i] > zMax) { zMax = allCoords[i]; }
    }
    const zRange = zMax - zMin || 1;

    // Build one diamond-tube Mesh per path
    let offset = 0;
    for (let pi = 0; pi < path_lengths.length; pi++) {
        const len = path_lengths[pi];
        const positions = allCoords.slice(offset * 3, (offset + len) * 3);

        let zSum = 0;
        for (let i = 2; i < positions.length; i += 3) { zSum += positions[i]; }
        const geometry = buildDiamondTube(positions, len);
        const material = new THREE.MeshPhongMaterial({ color: 0xffffff, side: THREE.FrontSide, flatShading: true, shininess: 60 });
        const mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh);
        pathMeshes.push(mesh);
        storedLayerCoords.push(positions);
        offset += len;
    }

    // Build travel lines between consecutive paths
    let travelOffset = 0;
    for (let pi = 0; pi < path_lengths.length - 1; pi++) {
        const endCoords   = storedLayerCoords[pi];
        const startCoords = storedLayerCoords[pi + 1];
        const endLen = path_lengths[pi];
        const wayCount = (travel_path_lengths && travel_path_lengths[pi]) ? travel_path_lengths[pi] : 0;

        const pts: number[] = [
            endCoords[(endLen - 1) * 3],
            endCoords[(endLen - 1) * 3 + 1],
            endCoords[(endLen - 1) * 3 + 2],
        ];
        for (let wi = 0; wi < wayCount; wi++) {
            pts.push(
                travelCoords[(travelOffset + wi) * 3],
                travelCoords[(travelOffset + wi) * 3 + 1],
                travelCoords[(travelOffset + wi) * 3 + 2],
            );
        }
        pts.push(startCoords[0], startCoords[1], startCoords[2]);

        const ptsArray = new Float32Array(pts);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(ptsArray, 3));
        const mat = new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.1, transparent: true });
        const line = new THREE.Line(geo, mat);
        scene.add(line);
        travelLines.push(line);
        storedTravelCoords.push(ptsArray);
        travelOffset += wayCount;
    }

    // Reset vertical slider
    const total = path_lengths.length;
    vSlider.min   = '0';
    vSlider.max   = String(total - 1);
    vSlider.value = String(total - 1); // top = show all
    totalLabel.textContent = String(total);
    vValLabel.textContent  = String(total);
    currentTopIndex = total - 1;

    // Reset horizontal slider for the top layer (including travel extension if present)
    const topLen = path_lengths[total - 1];
    const initTravelExtra = (storedTravelPathLengths[total - 1] ?? 0) > 0
        ? (storedTravelPathLengths[total - 1] + 1) : 0;
    hSlider.min   = '1';
    hSlider.max   = String(topLen + initTravelExtra);
    hSlider.value = String(topLen + initTravelExtra);
    hTotalLabel.textContent = String(topLen + initTravelExtra);

    // Apply layer visibility
    pathMeshes.forEach((mesh, i) => { mesh.visible = i <= currentTopIndex; });
    travelLines.forEach((line, i) => {
        const vis = (i + 1) <= currentTopIndex;
        line.visible = vis;
        if (vis) { line.geometry.setDrawRange(0, Infinity); }
        else      { line.geometry.setDrawRange(0, 0); }
    });
    applyHorizontalSlider(); // sets hValLabel and nozzle based on current slider value
});

// ---- Animation loop ----

let _lastFrameTime = performance.now();

function animate(): void {
    requestAnimationFrame(animate);
    const now = performance.now();
    const delta = now - _lastFrameTime;
    _lastFrameTime = now;
    applySpaceMouseToCamera(camera, controls, delta);
    controls.update();
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
