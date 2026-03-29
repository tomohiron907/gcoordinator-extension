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
// Z-up camera: position above and in front, looking at origin
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

// Axes helper
const axes = new THREE.AxesHelper(50);
scene.add(axes);

// ---- State ----

let pathLines: THREE.Line[] = [];

// ---- Sliders ----

const minSlider = document.getElementById('min-slider') as HTMLInputElement;
const maxSlider = document.getElementById('max-slider') as HTMLInputElement;
const minValLabel = document.getElementById('min-val') as HTMLElement;
const maxValLabel = document.getElementById('max-val') as HTMLElement;
const pathCountLabel = document.getElementById('path-count') as HTMLElement;

function applySliders(): void {
    const lo = parseInt(minSlider.value, 10);
    const hi = parseInt(maxSlider.value, 10);
    minValLabel.textContent = lo.toString();
    maxValLabel.textContent = hi.toString();
    pathLines.forEach((line, i) => {
        line.visible = i >= lo && i <= hi;
    });
}

minSlider.addEventListener('input', () => {
    if (parseInt(minSlider.value, 10) > parseInt(maxSlider.value, 10)) {
        maxSlider.value = minSlider.value;
    }
    applySliders();
});

maxSlider.addEventListener('input', () => {
    if (parseInt(maxSlider.value, 10) < parseInt(minSlider.value, 10)) {
        minSlider.value = maxSlider.value;
    }
    applySliders();
});

// ---- Helpers ----

function b64ToFloat32Array(b64: string): Float32Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Float32Array(bytes.buffer);
}

/**
 * Map a normalized value [0, 1] to an RGB color using HSL (red → green → blue).
 */
function valueToColor(t: number): THREE.Color {
    // hue: 0 (red) at bottom, 240 (blue) at top
    const hue = t * 240 / 360;
    return new THREE.Color().setHSL(hue, 1.0, 0.55);
}

// ---- Message handler ----

interface UpdateMessage {
    type: 'update';
    path_lengths: number[];
    coords_b64: string;
}

window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as UpdateMessage;
    if (msg.type !== 'update') {
        return;
    }

    // Remove old lines from scene
    pathLines.forEach((line) => {
        scene.remove(line);
        line.geometry.dispose();
        (line.material as THREE.Material).dispose();
    });
    pathLines = [];

    const { path_lengths, coords_b64 } = msg;
    const allCoords = b64ToFloat32Array(coords_b64);

    // Compute Z range for color mapping
    let zMin = Infinity;
    let zMax = -Infinity;
    for (let i = 2; i < allCoords.length; i += 3) {
        if (allCoords[i] < zMin) { zMin = allCoords[i]; }
        if (allCoords[i] > zMax) { zMax = allCoords[i]; }
    }
    const zRange = zMax - zMin || 1;

    // Build one THREE.Line per path
    let offset = 0;
    for (let pi = 0; pi < path_lengths.length; pi++) {
        const len = path_lengths[pi];
        const start = offset * 3;
        const end = start + len * 3;
        const positions = allCoords.slice(start, end);

        // Average Z for color
        let zSum = 0;
        for (let i = 2; i < positions.length; i += 3) {
            zSum += positions[i];
        }
        const zAvg = zSum / len;
        const color = valueToColor((zAvg - zMin) / zRange);

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const material = new THREE.LineBasicMaterial({ color });
        const line = new THREE.Line(geometry, material);
        scene.add(line);
        pathLines.push(line);

        offset += len;
    }

    // Reset sliders
    const total = path_lengths.length;
    minSlider.max = String(total - 1);
    maxSlider.max = String(total - 1);
    minSlider.value = '0';
    maxSlider.value = String(total - 1);
    pathCountLabel.textContent = `${total} paths`;
    applySliders();
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
