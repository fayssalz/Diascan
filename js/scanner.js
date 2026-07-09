import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
// FIX: switched from voxel/marching-cubes carving to an exact polyhedral
// visual-hull reconstruction — see visualHullMesh.js for what this trades
// off (no blockiness/smoothing needed, but the result is always convex).
import { carveConvexVisualHullMesh } from './visualHullMesh.js';

// ── Configuration ──────────────────────────────────────────────────────────
const SCAN_DURATION_S   = 10;  // Duration of EACH tilt pass, in seconds.
const FRAMES_PER_PASS    = 60; // Silhouette frames captured per pass.

// FIX: Multi-axis capture. The old version only ever rotated the object
// around Y, so the carving data never actually constrained the top/bottom
// of the stone — that geometry was just whatever the equatorial silhouettes
// happened to leave behind. Each entry here is a physical tilt (in degrees,
// rotation around the camera-facing X axis) that you rotate the object to
// by hand before that pass starts; a full 360° turntable spin is captured
// at each tilt. Add more passes (e.g. ±45) for a rounder top/bottom.
const TILT_PASSES_DEG = [0, 25, -25];

// ── UI Elements ────────────────────────────────────────────────────────────
const uiOverlay             = document.getElementById('ui-overlay');
const startBtn               = document.getElementById('startScanBtn');
const progressBarContainer   = document.getElementById('progressBarContainer');
const progressBar            = document.getElementById('progressBar');
const progressText           = document.getElementById('progressText');
const video                   = document.getElementById('webcam');
const videoFeed               = document.getElementById('webcamFeed');
const thresholdSlider         = document.getElementById('thresholdSlider');
const thresholdValue          = document.getElementById('thresholdValue');
const silhouettePreviewCanvas = document.getElementById('silhouettePreview');
const silhouettePreviewCtx    = silhouettePreviewCanvas.getContext('2d');

// ── Three.js Scene Setup ───────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0d1a);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 2, 8);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
document.body.appendChild(renderer.domElement);

// Lighting
scene.add(new THREE.AmbientLight(0xffffff, 1.0));
const dirLight = new THREE.DirectionalLight(0xffffff, 2.0);
dirLight.position.set(5, 10, 7.5);
scene.add(dirLight);
const fillLight = new THREE.DirectionalLight(0x88aaff, 0.8);
fillLight.position.set(-4, 2, -4);
scene.add(fillLight);

// Grid for reference
const grid = new THREE.GridHelper(10, 20, 0x222233, 0x1a1a2a);
grid.position.y = -1.8;
scene.add(grid);

// OrbitControls
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor  = 0.08;
controls.enabled = false; // disabled until scan is done

// ── Webcam Processing Canvas ───────────────────────────────────────────────
const processingCanvas = document.createElement('canvas');
const ctx = processingCanvas.getContext('2d', { willReadFrequently: true });

let activeRoughMesh = null;
let livePreviewHandle = null;

// ── Camera Initialisation ──────────────────────────────────────────────────
async function initCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
            audio: false
        });
        video.srcObject    = stream;
        videoFeed.srcObject = stream;
        await video.play();

        await new Promise(resolve => {
            if (video.readyState >= 1) { resolve(); return; }
            video.onloadedmetadata = resolve;
        });

        processingCanvas.width  = video.videoWidth  || 640;
        processingCanvas.height = video.videoHeight || 480;
        console.log(`Camera ready: ${processingCanvas.width}×${processingCanvas.height}`);
        startLivePreview();
    } catch (err) {
        console.error('Camera error:', err);
        progressText.textContent = '⚠ Camera error: ' + err.message;
        startBtn.disabled = true;
    }
}

// ── Silhouette Helpers ─────────────────────────────────────────────────────

/**
 * FIX: Border flood-fill segmentation, replacing the old per-pixel brightness
 * threshold. A rough diamond refracts light, so a plain brightness cutoff
 * will misclassify internal sparkle/glints as "background" — punching false
 * holes straight through solid material during carving. Flood-filling in
 * from the four image edges means only bright regions that are actually
 * *connected to the background* get marked as background; a bright glint
 * sitting in the middle of the stone's silhouette stays foreground because
 * it isn't reachable from the border without crossing dark (true-foreground)
 * pixels.
 *
 * For this to work well you still want good physical setup: backlight the
 * object against a diffuse white/bright panel so the true silhouette edge is
 * a clean, unbroken boundary. This function makes segmentation robust to
 * internal reflections — it can't fix a silhouette edge that's genuinely
 * broken by glare in the capture itself.
 */
function extractSilhouetteFloodFill(imgData, width, height, threshold) {
    const d = imgData.data;
    const n = width * height;

    const isBright = new Uint8Array(n);
    for (let p = 0; p < n; p++) {
        const i = p * 4;
        const brightness = (d[i] + d[i + 1] + d[i + 2]) / 3;
        isBright[p] = brightness > threshold ? 1 : 0;
    }

    const isBackground = new Uint8Array(n);
    const stack = [];

    const idx = (x, y) => y * width + x;
    const seed = (x, y) => {
        const p = idx(x, y);
        if (isBright[p] && !isBackground[p]) {
            isBackground[p] = 1;
            stack.push(p);
        }
    };

    for (let x = 0; x < width; x++) { seed(x, 0); seed(x, height - 1); }
    for (let y = 0; y < height; y++) { seed(0, y); seed(width - 1, y); }

    while (stack.length) {
        const p = stack.pop();
        const x = p % width;
        const y = (p / width) | 0;
        if (x > 0)          seed(x - 1, y);
        if (x < width - 1)  seed(x + 1, y);
        if (y > 0)          seed(x, y - 1);
        if (y < height - 1) seed(x, y + 1);
    }

    for (let p = 0; p < n; p++) {
        const i = p * 4;
        const v = isBackground[p] ? 255 : 0; // background -> white, foreground -> black
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
    }
}

function thresholdToSilhouette(threshold) {
    if (video.readyState < video.HAVE_ENOUGH_DATA) return;
    ctx.drawImage(video, 0, 0, processingCanvas.width, processingCanvas.height);
    const imgData = ctx.getImageData(0, 0, processingCanvas.width, processingCanvas.height);
    extractSilhouetteFloodFill(imgData, processingCanvas.width, processingCanvas.height, threshold);
    ctx.putImageData(imgData, 0, 0);
}

function captureFrameCanvas(threshold) {
    thresholdToSilhouette(threshold);
    const f = document.createElement('canvas');
    f.width  = processingCanvas.width;
    f.height = processingCanvas.height;
    f.getContext('2d').drawImage(processingCanvas, 0, 0);
    return f;
}

// ── Live Preview Loop ──────────────────────────────────────────────────────
function startLivePreview() {
    function loop() {
        livePreviewHandle = requestAnimationFrame(loop);
        const threshold = parseInt(thresholdSlider.value, 10);
        thresholdValue.textContent = threshold;
        thresholdToSilhouette(threshold);
        silhouettePreviewCtx.drawImage(
            processingCanvas, 0, 0,
            silhouettePreviewCanvas.width, silhouettePreviewCanvas.height
        );
    }
    loop();
}

// ── FIX: pause-for-tilt helper ──────────────────────────────────────────────
// Between tilt passes we need the person to physically re-orient the stone.
// This creates (once) a simple floating "continue" button and resolves when
// clicked. Style it however fits your existing UI — this just needs to work
// without requiring new markup in your HTML.
function waitForContinue(promptText) {
    return new Promise(resolve => {
        progressText.textContent = promptText;

        let btn = document.getElementById('tiltContinueBtn');
        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'tiltContinueBtn';
            btn.textContent = "I've repositioned the stone — Continue";
            btn.style.cssText = `
                position: fixed; bottom: 32px; left: 50%; transform: translateX(-50%);
                z-index: 9999; padding: 14px 28px; font-size: 16px; font-weight: 600;
                border: none; border-radius: 8px; cursor: pointer;
                background: #3a6ea5; color: white;
            `;
            document.body.appendChild(btn);
        }
        btn.style.display = 'block';
        btn.onclick = () => {
            btn.style.display = 'none';
            resolve();
        };
    });
}

// ── Main Scan Function ─────────────────────────────────────────────────────
async function startScan() {
    if (livePreviewHandle) {
        cancelAnimationFrame(livePreviewHandle);
        livePreviewHandle = null;
    }

    if (activeRoughMesh) {
        scene.remove(activeRoughMesh);
        activeRoughMesh.geometry?.dispose();
        activeRoughMesh.material?.dispose();
        activeRoughMesh = null;
    }

    startBtn.disabled = true;
    startBtn.style.display = 'none';
    progressBarContainer.style.display = 'block';
    videoFeed.style.display = 'block';

    const threshold       = parseInt(thresholdSlider.value, 10);
    const captureInterval = (SCAN_DURATION_S * 1000) / FRAMES_PER_PASS;
    const totalFrames      = FRAMES_PER_PASS * TILT_PASSES_DEG.length;
    const frames           = [];

    const tiltAxis = new THREE.Vector3(1, 0, 0);
    const yAxis    = new THREE.Vector3(0, 1, 0);

    // ── Phase 1: Capture frames across each tilt pass ──────────────────────
    for (let passIdx = 0; passIdx < TILT_PASSES_DEG.length; passIdx++) {
        const tiltDeg = TILT_PASSES_DEG[passIdx];

        if (passIdx > 0 || tiltDeg !== 0) {
            await waitForContinue(
                `Tilt the stone to about ${tiltDeg}° from level, then continue.`
            );
        }

        const tiltQuat = new THREE.Quaternion().setFromAxisAngle(
            tiltAxis, THREE.MathUtils.degToRad(tiltDeg)
        );

        progressText.textContent = `Pass ${passIdx + 1}/${TILT_PASSES_DEG.length} (tilt ${tiltDeg}°): rotate the stone smoothly!`;

        for (let i = 0; i < FRAMES_PER_PASS; i++) {
            const turntableAngle = (i / FRAMES_PER_PASS) * Math.PI * 2;
            const turntableQuat  = new THREE.Quaternion().setFromAxisAngle(yAxis, turntableAngle);

            // FIX: compose tilt (physical, per-pass) then turntable (per-frame)
            // into a single orientation, instead of a single Y-axis angle.
            const rotation = turntableQuat.clone().multiply(tiltQuat);

            const frameCanvas = captureFrameCanvas(threshold);
            frames.push({ canvas: frameCanvas, rotation });

            const framesDone = passIdx * FRAMES_PER_PASS + i + 1;
            const pct = Math.round((framesDone / totalFrames) * 50); // 0→50%
            progressText.textContent = `Pass ${passIdx + 1}/${TILT_PASSES_DEG.length} — capturing ${i + 1}/${FRAMES_PER_PASS}`;
            progressBar.style.width = `${pct}%`;

            await new Promise(resolve => setTimeout(resolve, captureInterval));
        }
    }

    videoFeed.style.display = 'none';
    progressText.textContent = 'Processing… Building 3D model…';
    progressBar.style.width  = '50%';

    // ── Phase 2: Build the carving camera ─────────────────────────────────
    const carvingCamera = new THREE.PerspectiveCamera(
        75,
        processingCanvas.width / processingCanvas.height,
        0.1,
        1000
    );
    carvingCamera.position.set(0, 0, 5);
    carvingCamera.lookAt(0, 0, 0);
    carvingCamera.updateProjectionMatrix();
    carvingCamera.updateMatrixWorld(true);

    // ── Phase 3: Carve + mesh ─────────────────────────────────────────────
    let result;
    try {
        result = await carveConvexVisualHullMesh(frames, carvingCamera, (pct) => {
            const mapped = 50 + Math.round(pct * 0.5); // 50→100%
            progressText.textContent = `Reconstructing… ${pct}%`;
            progressBar.style.width  = `${mapped}%`;
        }, { boxHalfSize: 2.0 }); // must comfortably contain the stone in your rig's units
    } catch (err) {
        console.error('Carving error:', err);
        progressText.textContent = '⚠ Error during reconstruction: ' + err.message;
        startBtn.disabled = false;
        startBtn.style.display = '';
        progressBarContainer.style.display = 'none';
        return;
    }

    const { mesh: roughMesh, geometry } = result;

    // ── Phase 4: Display the mesh ──────────────────────────────────────────
    scene.add(roughMesh);
    activeRoughMesh = roughMesh;

    controls.enabled = true;
    controls.update();

    // ── Phase 5: Serialise and send to parent / localStorage ───────────────
    if (geometry && geometry.attributes?.position?.count > 0) {
        const exportGeom = geometry.clone();
        exportGeom.applyMatrix4(roughMesh.matrixWorld);
        exportGeom.computeVertexNormals();

        const positions = Array.from(exportGeom.attributes.position.array);
        const indices   = exportGeom.index ? Array.from(exportGeom.index.array) : null;
        const serialized = { positions, indices };

        try {
            localStorage.setItem('scanned_rough_geometry', JSON.stringify(serialized));
            console.log('Geometry saved to localStorage. Vertex count:', exportGeom.attributes.position.count);
        } catch (e) {
            console.warn('localStorage save failed:', e);
        }

        const msg = { type: 'SCANNED_MODEL', geometry: serialized };
        if (window.parent && window.parent !== window) {
            window.parent.postMessage(msg, '*');
        }
        if (window.opener) {
            window.opener.postMessage(msg, '*');
        }

        progressBar.style.width  = '100%';
        progressText.innerHTML   = '✅ Scan complete! Loading into CAD editor…';
        progressBarContainer.style.backgroundColor = '#1a3a1a';

        setTimeout(() => {
            if (window.parent && window.parent !== window) {
                window.parent.postMessage({ type: 'SCAN_DONE' }, '*');
            } else {
                uiOverlay.classList.add('hidden');
            }
        }, 2000);
    } else {
        progressText.textContent = '⚠ No geometry was captured. Check your silhouette and try again.';
        progressBar.style.backgroundColor = '#aa3300';
        startBtn.disabled = false;
        startBtn.style.display = '';
        progressBarContainer.style.display = 'none';
    }
}

// ── Animation Loop ─────────────────────────────────────────────────────────
function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

// ── Resize Handler ─────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// ── Boot ───────────────────────────────────────────────────────────────────
startBtn.addEventListener('click', startScan);
initCamera();
animate();
