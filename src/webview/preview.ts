import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// ---- Scene setup ----

const container = document.getElementById('canvas-container') as HTMLElement;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setClearColor(0x1e1e1e);
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();

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

// ---- State ----

let pathMeshes: THREE.Mesh[] = [];
let storedPathLengths: number[] = [];
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

    // Update layer visibility
    vValLabel.textContent = String(maxVisible + 1);
    pathMeshes.forEach((mesh, i) => {
        mesh.visible = i <= maxVisible;
    });

    currentTopIndex = maxVisible;

    // Sync horizontal slider to the new top layer
    const topLen = storedPathLengths[maxVisible];
    hSlider.min   = '1';
    hSlider.max   = String(topLen);
    hSlider.value = String(topLen); // show full curve by default
    hValLabel.textContent  = String(topLen);
    hTotalLabel.textContent = String(topLen);
}

vSlider.addEventListener('input', applyVerticalSlider);

// ---- Horizontal slider (curve range of the top layer) ----

const hSlider      = document.getElementById('curve-slider') as HTMLInputElement;
const hValLabel    = document.getElementById('curve-val')   as HTMLElement;
const hTotalLabel  = document.getElementById('curve-total') as HTMLElement;

function applyHorizontalSlider(): void {
    if (currentTopIndex < 0 || pathMeshes.length === 0) { return; }
    const pointCount = parseInt(hSlider.value, 10);
    const indexCount = Math.max(0, pointCount - 1) * 24;
    pathMeshes[currentTopIndex].geometry.setDrawRange(0, indexCount);
    hValLabel.textContent = String(pointCount);
}

hSlider.addEventListener('input', applyHorizontalSlider);

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

    const { path_lengths, coords_b64 } = msg;
    storedPathLengths = path_lengths;
    const allCoords = b64ToFloat32Array(coords_b64);

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
        offset += len;
    }

    // Reset vertical slider
    const total = path_lengths.length;
    vSlider.min   = '0';
    vSlider.max   = String(total - 1);
    vSlider.value = String(total - 1); // top = show all
    totalLabel.textContent = String(total);
    vValLabel.textContent  = String(total);
    currentTopIndex = total - 1;

    // Reset horizontal slider for the top layer
    const topLen = path_lengths[total - 1];
    hSlider.min   = '1';
    hSlider.max   = String(topLen);
    hSlider.value = String(topLen);
    hValLabel.textContent  = String(topLen);
    hTotalLabel.textContent = String(topLen);

    // Apply both sliders
    pathMeshes.forEach((mesh, i) => { mesh.visible = i <= currentTopIndex; });
});

// ---- Animation loop ----

function animate(): void {
    requestAnimationFrame(animate);
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
