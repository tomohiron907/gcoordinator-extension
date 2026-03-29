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

// ---- State ----

let pathLines: THREE.Line[] = [];
let storedPathLengths: number[] = [];
let currentTopIndex = -1;

// ---- Vertical slider (layer range) ----

const vSlider    = document.getElementById('layer-slider') as HTMLInputElement;
const vValLabel  = document.getElementById('layer-val')   as HTMLElement;
const totalLabel = document.getElementById('layer-total') as HTMLElement;

function applyVerticalSlider(): void {
    const total = pathLines.length;
    if (total === 0) { return; }

    const maxVisible = parseInt(vSlider.value, 10);

    // Restore previous top layer to full draw range before switching
    if (currentTopIndex >= 0 && currentTopIndex < pathLines.length) {
        pathLines[currentTopIndex].geometry.setDrawRange(0, storedPathLengths[currentTopIndex]);
    }

    // Update layer visibility
    vValLabel.textContent = String(maxVisible + 1);
    pathLines.forEach((line, i) => {
        line.visible = i <= maxVisible;
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
    if (currentTopIndex < 0 || pathLines.length === 0) { return; }
    const count = parseInt(hSlider.value, 10);
    pathLines[currentTopIndex].geometry.setDrawRange(0, count);
    hValLabel.textContent = String(count);
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

// ---- Message handler ----

interface UpdateMessage {
    type: 'update';
    path_lengths: number[];
    coords_b64: string;
}

window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as UpdateMessage;
    if (msg.type !== 'update') { return; }

    // Clear old lines
    pathLines.forEach((line) => {
        scene.remove(line);
        line.geometry.dispose();
        (line.material as THREE.Material).dispose();
    });
    pathLines = [];

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

    // Build one THREE.Line per path
    let offset = 0;
    for (let pi = 0; pi < path_lengths.length; pi++) {
        const len = path_lengths[pi];
        const positions = allCoords.slice(offset * 3, (offset + len) * 3);

        let zSum = 0;
        for (let i = 2; i < positions.length; i += 3) { zSum += positions[i]; }
        const color = valueToColor((zSum / len - zMin) / zRange);

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const material = new THREE.LineBasicMaterial({ color });
        const line = new THREE.Line(geometry, material);
        scene.add(line);
        pathLines.push(line);
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
    pathLines.forEach((line, i) => { line.visible = i <= currentTopIndex; });
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
