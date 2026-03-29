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

// ---- Slider ----
// The slider is vertical on the right side.
// slider value 0 (handle at bottom) → show all layers
// slider value N-1 (handle at top)  → show only the bottom layer
// This is achieved by inverting: maxVisibleIndex = totalPaths - 1 - sliderValue

const slider = document.getElementById('layer-slider') as HTMLInputElement;
const sliderValLabel = document.getElementById('layer-val') as HTMLElement;
const totalLabel = document.getElementById('layer-total') as HTMLElement;

function applySlider(): void {
    const total = pathLines.length;
    if (total === 0) { return; }
    // slider value = maxVisible index (top = max = all layers, bottom = 0 = one layer)
    const maxVisible = parseInt(slider.value, 10);
    sliderValLabel.textContent = String(maxVisible + 1);
    pathLines.forEach((line, i) => {
        line.visible = i <= maxVisible;
    });
}

slider.addEventListener('input', applySlider);

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

    // Reset slider
    const total = path_lengths.length;
    slider.min = '0';
    slider.max = String(total - 1);
    slider.value = String(total - 1); // handle at top = show all layers
    totalLabel.textContent = String(total);
    sliderValLabel.textContent = String(total);
    applySlider();
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
