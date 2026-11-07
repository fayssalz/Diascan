/* ============================================================
   scanner-3axis.js — 3-Axis Rough Diamond Photogrammetry Engine
   Reconstructs a watertight 3D CAD rough diamond mesh from
   3 orthogonal photographic views (Front, Side, Top) with
   automatic diamond outline detection and neon highlighting.
   ============================================================ */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { reconstruct3AxisVisualHull, convexHull2D } from './visualHullMesh.js';

// ── State ───────────────────────────────────────────────────

const state = {
  views: {
    front: {
      id: 'front',
      name: 'Front View (X-Y)',
      axisLabel: 'Elevation / Front Face',
      image: null,
      polygon: null,
      rawPoints: [],
      threshold: 28,
      invert: false,
      canvas: null,
      ctx: null,
      status: 'Empty'
    },
    side: {
      id: 'side',
      name: 'Side View (Z-Y)',
      axisLabel: 'Profile / 90° Turn',
      image: null,
      polygon: null,
      rawPoints: [],
      threshold: 28,
      invert: false,
      canvas: null,
      ctx: null,
      status: 'Empty'
    },
    top: {
      id: 'top',
      name: 'Top View (X-Z)',
      axisLabel: 'Plan View / Downward',
      image: null,
      polygon: null,
      rawPoints: [],
      threshold: 28,
      invert: false,
      canvas: null,
      ctx: null,
      status: 'Empty'
    }
  },
  dimensions: {
    height: 6.0,
    width: 5.0,
    length: 5.0
  },
  wireframe: false,
  autoRotate: true,
  currentReconstruction: null
};

// ── Three.js Scene Setup for 3D Preview ─────────────────────

let scene, camera, renderer, controls, previewMesh, gridHelper;

function init3DPreview() {
  const container = document.getElementById('preview3d-container');
  if (!container) return;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e111a);

  const width = container.clientWidth || 400;
  const height = container.clientHeight || 350;

  camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
  camera.position.set(10, 8, 12);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3;
  container.innerHTML = '';
  container.appendChild(renderer.domElement);

  // Lighting
  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const dirLight1 = new THREE.DirectionalLight(0xddeeff, 2.0);
  dirLight1.position.set(8, 12, 10);
  scene.add(dirLight1);

  const dirLight2 = new THREE.DirectionalLight(0x7099ff, 1.0);
  dirLight2.position.set(-8, -4, -8);
  scene.add(dirLight2);

  const fillLight = new THREE.DirectionalLight(0x00ffc8, 0.5);
  fillLight.position.set(0, -10, 5);
  scene.add(fillLight);

  // Grid
  gridHelper = new THREE.GridHelper(14, 14, 0x2e3b55, 0x182033);
  gridHelper.position.y = -3.2;
  scene.add(gridHelper);

  // OrbitControls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = state.autoRotate;
  controls.autoRotateSpeed = 1.5;

  window.addEventListener('resize', () => {
    if (!container) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });

  animate();
}

function animate() {
  requestAnimationFrame(animate);
  if (controls) {
    controls.autoRotate = state.autoRotate;
    controls.update();
  }
  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}

// ── Polygon Simplification (Ramer-Douglas-Peucker) ───────────

function ramerDouglasPeucker(points, epsilon) {
  if (!points || points.length <= 2) return points || [];
  let dmax = 0;
  let index = 0;
  const end = points.length - 1;
  const [x1, y1] = points[0];
  const [x2, y2] = points[end];
  const lineLen = Math.hypot(x2 - x1, y2 - y1);

  for (let i = 1; i < end; i++) {
    const [x0, y0] = points[i];
    let d = 0;
    if (lineLen < 1e-6) {
      d = Math.hypot(x0 - x1, y0 - y1);
    } else {
      d = Math.abs((y2 - y1) * x0 - (x2 - x1) * y0 + x2 * y1 - y2 * x1) / lineLen;
    }
    if (d > dmax) {
      index = i;
      dmax = d;
    }
  }

  if (dmax > epsilon) {
    const rec1 = ramerDouglasPeucker(points.slice(0, index + 1), epsilon);
    const rec2 = ramerDouglasPeucker(points.slice(index), epsilon);
    return rec1.slice(0, rec1.length - 1).concat(rec2);
  } else {
    return [points[0], points[end]];
  }
}

// ── Automatic Diamond Outline Detection & Segmentation ──────

/**
 * Automatically isolates the rough diamond from the background using
 * edge-border flood fill and multi-channel color/luminance contrast.
 */
export function detectDiamondOutline(imageElement, options = {}) {
  const threshold = options.threshold ?? 28;
  const invert = options.invert ?? false;
  const tolerance = options.tolerance ?? 2.5;

  const targetSize = 400;
  const canvas = document.createElement('canvas');
  canvas.width = targetSize;
  canvas.height = targetSize;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // Fit image inside targetSize x targetSize preserving aspect ratio with centering
  const imgW = imageElement.naturalWidth || imageElement.width || targetSize;
  const imgH = imageElement.naturalHeight || imageElement.height || targetSize;
  const scale = Math.min((targetSize * 0.88) / imgW, (targetSize * 0.88) / imgH);
  const drawW = imgW * scale;
  const drawH = imgH * scale;
  const offsetX = (targetSize - drawW) / 2;
  const offsetY = (targetSize - drawH) / 2;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, targetSize, targetSize);
  ctx.drawImage(imageElement, offsetX, offsetY, drawW, drawH);

  const imgData = ctx.getImageData(0, 0, targetSize, targetSize);
  const data = imgData.data;
  const w = targetSize;
  const h = targetSize;

  // Sample perimeter border (12px band) to determine dominant background color
  let bgR = 0, bgG = 0, bgB = 0, bgCount = 0;
  const borderDepth = 12;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < borderDepth || x >= w - borderDepth || y < borderDepth || y >= h - borderDepth) {
        const idx = (y * w + x) * 4;
        bgR += data[idx];
        bgG += data[idx + 1];
        bgB += data[idx + 2];
        bgCount++;
      }
    }
  }

  bgR = bgCount > 0 ? bgR / bgCount : 240;
  bgG = bgCount > 0 ? bgG / bgCount : 240;
  bgB = bgCount > 0 ? bgB / bgCount : 240;
  const bgLuma = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB;

  // Compute contrast score for every pixel
  const numPixels = w * h;
  const contrast = new Float32Array(numPixels);

  for (let p = 0; p < numPixels; p++) {
    const idx = p * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    const colDist = Math.hypot(r - bgR, g - bgG, b - bgB);
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const lumaDist = Math.abs(luma - bgLuma);
    contrast[p] = Math.max(colDist / 4.41, lumaDist / 2.55);
  }

  // Border-seeded flood fill to mark connected background
  const isBackground = new Uint8Array(numPixels);
  const queue = [];

  const seed = (x, y) => {
    const p = y * w + x;
    if (!isBackground[p] && contrast[p] < threshold * 1.35) {
      isBackground[p] = 1;
      queue.push(p);
    }
  };

  for (let x = 0; x < w; x++) {
    seed(x, 0);
    seed(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    seed(0, y);
    seed(w - 1, y);
  }

  let head = 0;
  while (head < queue.length) {
    const p = queue[head++];
    const x = p % w;
    const y = (p / w) | 0;

    const neighbors = [
      x > 0 ? p - 1 : -1,
      x < w - 1 ? p + 1 : -1,
      y > 0 ? p - w : -1,
      y < h - 1 ? p + w : -1
    ];

    for (let i = 0; i < 4; i++) {
      const np = neighbors[i];
      if (np !== -1 && !isBackground[np] && contrast[np] < threshold) {
        isBackground[np] = 1;
        queue.push(np);
      }
    }
  }

  // Extract foreground boundary points
  const boundaryPoints = [];
  let minX = w, maxX = 0, minY = h, maxY = 0;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      let fg = isBackground[p] === 0;
      if (invert) fg = !fg;

      if (fg) {
        // Boundary test: at least one neighbor is background
        if (
          isBackground[p - 1] ||
          isBackground[p + 1] ||
          isBackground[p - w] ||
          isBackground[p + w]
        ) {
          boundaryPoints.push([x, y]);
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
  }

  if (boundaryPoints.length < 8) {
    console.warn('Insufficient diamond outline points detected. Returning default box.');
    const pad = 60;
    const defaultPoly = [
      [w / 2, pad],
      [w - pad, h / 2],
      [w / 2, h - pad],
      [pad, h / 2]
    ];
    return {
      polygon: defaultPoly,
      rawPoints: boundaryPoints,
      bbox: { minX: pad, maxX: w - pad, minY: pad, maxY: h - pad },
      canvas,
      imageW: drawW,
      imageH: drawH,
      offsetX,
      offsetY
    };
  }

  // 2D Convex Hull
  const hull = convexHull2D(boundaryPoints);

  // Polygon simplification for clean diamond crystal facets
  const simplified = ramerDouglasPeucker(hull, tolerance);

  // Ensure closed loop
  if (
    simplified.length > 2 &&
    (simplified[0][0] !== simplified[simplified.length - 1][0] ||
      simplified[0][1] !== simplified[simplified.length - 1][1])
  ) {
    simplified.push([...simplified[0]]);
  }

  return {
    polygon: simplified,
    rawPoints: boundaryPoints,
    bbox: { minX, maxX, minY, maxY },
    canvas,
    imageW: drawW,
    imageH: drawH,
    offsetX,
    offsetY
  };
}

// ── Outline Highlighting & Overlay Rendering ────────────────

/**
 * Draws the photo on targetCanvas with glowing neon outline and translucent diamond tint.
 */
export function drawHighlightedSilhouette(targetCanvas, imageElement, outlineResult) {
  if (!targetCanvas) return;
  const ctx = targetCanvas.getContext('2d');
  const w = targetCanvas.width;
  const h = targetCanvas.height;

  ctx.clearRect(0, 0, w, h);

  if (!imageElement) {
    // Empty state placeholder
    ctx.fillStyle = '#121420';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#252a3d';
    ctx.setLineDash([6, 6]);
    ctx.strokeRect(12, 12, w - 24, h - 24);
    ctx.setLineDash([]);
    ctx.fillStyle = '#556080';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No image uploaded', w / 2, h / 2 - 10);
    ctx.font = '12px sans-serif';
    ctx.fillText('Drop image or click below', w / 2, h / 2 + 14);
    return;
  }

  // Draw scaled photo
  const imgW = imageElement.naturalWidth || imageElement.width || w;
  const imgH = imageElement.naturalHeight || imageElement.height || h;
  const scale = Math.min((w * 0.9) / imgW, (h * 0.9) / imgH);
  const dw = imgW * scale;
  const dh = imgH * scale;
  const ox = (w - dw) / 2;
  const oy = (h - dh) / 2;

  // Dark studio backdrop
  ctx.fillStyle = '#10131f';
  ctx.fillRect(0, 0, w, h);

  // Draw image
  ctx.drawImage(imageElement, ox, oy, dw, dh);

  const poly = outlineResult?.polygon;
  if (!poly || poly.length < 3) return;

  // Scale detected polygon to match target canvas viewport
  const srcCanvas = outlineResult.canvas;
  const scaleX = w / (srcCanvas?.width || 400);
  const scaleY = h / (srcCanvas?.height || 400);

  ctx.save();

  // 1. Fill detected diamond with translucent luminous cyan/emerald tint
  ctx.beginPath();
  ctx.moveTo(poly[0][0] * scaleX, poly[0][1] * scaleY);
  for (let i = 1; i < poly.length; i++) {
    ctx.lineTo(poly[i][0] * scaleX, poly[i][1] * scaleY);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(0, 240, 180, 0.22)';
  ctx.fill();

  // 2. Wide glowing outer neon stroke
  ctx.shadowColor = '#00ffc8';
  ctx.shadowBlur = 14;
  ctx.strokeStyle = 'rgba(0, 255, 200, 0.65)';
  ctx.lineWidth = 4;
  ctx.stroke();

  // 3. Crisp inner neon stroke
  ctx.shadowBlur = 4;
  ctx.strokeStyle = '#00ffc8';
  ctx.lineWidth = 2.2;
  ctx.stroke();

  // 4. Fine white core outline
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.0;
  ctx.stroke();

  // 5. Draw glowing facet corner vertices
  for (let i = 0; i < poly.length - 1; i++) {
    const px = poly[i][0] * scaleX;
    const py = poly[i][1] * scaleY;

    // Outer glow ring
    ctx.beginPath();
    ctx.arc(px, py, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#00ffc8';
    ctx.fill();

    // Inner bright white dot
    ctx.beginPath();
    ctx.arc(px, py, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }

  // 6. Outline metadata badge overlay
  const facetCount = Math.max(3, poly.length - 1);
  const badgeText = `✓ Outline: ${facetCount} facets`;
  ctx.font = 'bold 11px sans-serif';
  const textWidth = ctx.measureText(badgeText).width;

  ctx.fillStyle = 'rgba(10, 18, 28, 0.85)';
  ctx.strokeStyle = 'rgba(0, 255, 200, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(10, h - 28, textWidth + 18, 20, 4);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#00ffc8';
  ctx.textAlign = 'left';
  ctx.fillText(badgeText, 18, h - 14);

  ctx.restore();
}

// ── Synthetic Diamond Sample Presets ────────────────────────

/**
 * Creates high-fidelity realistic rough diamond images for immediate 1-click testing.
 */
export function generateSampleDiamondViews(preset = 'octahedron') {
  const size = 400;

  function createViewCanvas(drawFn) {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');

    // Realistic gradient photography background (clean jeweler white-to-gray paper)
    const bg = ctx.createRadialGradient(size / 2, size / 2, 40, size / 2, size / 2, size / 1.3);
    bg.addColorStop(0, '#f2f4f8');
    bg.addColorStop(0.7, '#e2e6f0');
    bg.addColorStop(1, '#c5ccdc');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);

    // Subtle soft contact drop shadow underneath
    ctx.save();
    const shadow = ctx.createRadialGradient(size / 2, size / 2 + 105, 10, size / 2, size / 2 + 105, 120);
    shadow.addColorStop(0, 'rgba(30, 40, 60, 0.45)');
    shadow.addColorStop(0.6, 'rgba(60, 70, 90, 0.18)');
    shadow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = shadow;
    ctx.beginPath();
    ctx.ellipse(size / 2, size / 2 + 105, 110, 26, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    drawFn(ctx, size);
    return c;
  }

  // Helper to draw faceted rough crystal polygon with shading & trigons
  function drawDiamondPolygon(ctx, vertices, facetColor = '#7ca8c4', highlightColor = '#edf5fa') {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(vertices[0][0], vertices[0][1]);
    for (let i = 1; i < vertices.length; i++) {
      ctx.lineTo(vertices[i][0], vertices[i][1]);
    }
    ctx.closePath();

    // Realistic diamond body gradient
    const grad = ctx.createLinearGradient(size / 2 - 80, size / 2 - 100, size / 2 + 80, size / 2 + 100);
    grad.addColorStop(0, highlightColor);
    grad.addColorStop(0.3, facetColor);
    grad.addColorStop(0.7, '#486884');
    grad.addColorStop(1, '#2c4055');
    ctx.fillStyle = grad;
    ctx.fill();

    // Internal crystal facet lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Crystal facet ridges
    const cx = size / 2;
    const cy = size / 2;
    for (let i = 0; i < vertices.length; i += 2) {
      ctx.beginPath();
      ctx.moveTo(vertices[i][0], vertices[i][1]);
      ctx.lineTo(cx, cy);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.stroke();
    }

    // Natural rough diamond surface luster & trigons
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.beginPath();
    ctx.moveTo(cx - 20, cy - 20);
    ctx.lineTo(cx + 20, cy - 20);
    ctx.lineTo(cx, cy + 15);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  if (preset === 'macle') {
    // Macle Twin Rough: Flat triangular twinned diamond
    const front = createViewCanvas((ctx) => {
      // Triangle with re-entrant twin notch
      const poly = [
        [size / 2, 80],
        [320, 290],
        [280, 310],
        [size / 2, 280],
        [120, 310],
        [80, 290]
      ];
      drawDiamondPolygon(ctx, poly, '#6c9dbd');
    });

    const side = createViewCanvas((ctx) => {
      // Thin twinned plate profile
      const poly = [
        [size / 2, 85],
        [size / 2 + 45, 180],
        [size / 2 + 50, 305],
        [size / 2 - 50, 305],
        [size / 2 - 45, 180]
      ];
      drawDiamondPolygon(ctx, poly, '#6090b0');
    });

    const top = createViewCanvas((ctx) => {
      // Broad triangular plan view
      const poly = [
        [size / 2, 90],
        [315, 300],
        [85, 300]
      ];
      drawDiamondPolygon(ctx, poly, '#78a6c5');
    });

    return { front, side, top, dims: { height: 4.2, width: 6.8, length: 6.5 } };
  } else if (preset === 'makeable') {
    // Alluvial Makeable: Organic, slightly asymmetric natural river rough
    const front = createViewCanvas((ctx) => {
      const poly = [
        [190, 75],
        [270, 110],
        [325, 195],
        [295, 285],
        [210, 325],
        [120, 290],
        [85, 180],
        [115, 105]
      ];
      drawDiamondPolygon(ctx, poly, '#5d8fae');
    });

    const side = createViewCanvas((ctx) => {
      const poly = [
        [205, 80],
        [280, 130],
        [300, 220],
        [260, 310],
        [165, 315],
        [100, 230],
        [110, 125]
      ];
      drawDiamondPolygon(ctx, poly, '#5684a0');
    });

    const top = createViewCanvas((ctx) => {
      const poly = [
        [200, 95],
        [295, 130],
        [320, 225],
        [275, 305],
        [185, 315],
        [95, 250],
        [90, 155]
      ];
      drawDiamondPolygon(ctx, poly, '#669bb8');
    });

    return { front, side, top, dims: { height: 6.2, width: 5.6, length: 5.2 } };
  } else {
    // Classic Natural Octahedral Crystal
    const front = createViewCanvas((ctx) => {
      // Classic bipyramid profile with slight chamfer
      const poly = [
        [size / 2, 70],
        [305, 185],
        [315, 215],
        [size / 2, 330],
        [85, 215],
        [95, 185]
      ];
      drawDiamondPolygon(ctx, poly, '#7aa6c2');
    });

    const side = createViewCanvas((ctx) => {
      // Orthogonal side bipyramid profile
      const poly = [
        [size / 2, 75],
        [300, 190],
        [310, 210],
        [size / 2, 325],
        [90, 210],
        [100, 190]
      ];
      drawDiamondPolygon(ctx, poly, '#729ebc');
    });

    const top = createViewCanvas((ctx) => {
      // Square crystal cross-section with beveled dodecahedral edges
      const poly = [
        [size / 2, 85],
        [295, 105],
        [315, size / 2],
        [295, 295],
        [size / 2, 315],
        [105, 295],
        [85, size / 2],
        [105, 105]
      ];
      drawDiamondPolygon(ctx, poly, '#84b0cc');
    });

    return { front, side, top, dims: { height: 6.0, width: 5.0, length: 5.0 } };
  }
}

// ── 3D Reconstruction Pipeline ──────────────────────────────

export function triggerReconstruction() {
  const v = state.views;
  if (!v.front.polygon && !v.side.polygon && !v.top.polygon) {
    console.warn('No polygons available for reconstruction.');
    return;
  }

  // Ensure all 3 views have polygons (fallback to existing view if missing)
  const frontPoly = v.front.polygon || v.side.polygon || v.top.polygon;
  const sidePoly = v.side.polygon || v.front.polygon || v.top.polygon;
  const topPoly = v.top.polygon || v.front.polygon || v.side.polygon;

  const dims = state.dimensions;
  const result = reconstruct3AxisVisualHull(frontPoly, sidePoly, topPoly, dims);

  if (!result || !result.geometry) {
    console.error('Reconstruction failed to produce geometry.');
    return;
  }

  state.currentReconstruction = result;

  // Update Three.js 3D Viewport
  if (previewMesh) {
    scene.remove(previewMesh);
    previewMesh.geometry?.dispose();
    previewMesh.material?.dispose();
    previewMesh = null;
  }

  const mat = new THREE.MeshStandardMaterial({
    color: 0x98d4f0,
    roughness: 0.15,
    metalness: 0.08,
    flatShading: true,
    wireframe: state.wireframe
  });

  previewMesh = new THREE.Mesh(result.geometry, mat);
  scene.add(previewMesh);

  // Position grid beneath the reconstructed stone
  result.geometry.computeBoundingBox();
  const box = result.geometry.boundingBox;
  if (box && gridHelper) {
    gridHelper.position.y = box.min.y - 0.5;
  }

  // Calculate stats
  const vertexCount = result.geometry.attributes.position.count;
  const faceCount = result.geometry.index ? result.geometry.index.count / 3 : vertexCount / 3;
  const volumeMm3 = result.volume || (dims.width * dims.height * dims.length * 0.45);
  // Diamond density ~3.52 g/cm3 => 3.52 mg/mm3. 1 carat = 200 mg.
  const carats = volumeMm3 * 3.52 * 0.005;

  // Update UI Stats
  const statFaces = document.getElementById('stat-faces');
  const statVerts = document.getElementById('stat-verts');
  const statCarats = document.getElementById('stat-carats');
  const statDims = document.getElementById('stat-dims');
  const applyBtn = document.getElementById('btn-apply-cad');

  if (statFaces) statFaces.textContent = `${Math.round(faceCount)} crystal facets`;
  if (statVerts) statVerts.textContent = `${vertexCount} vertices`;
  if (statCarats) statCarats.textContent = `${carats.toFixed(2)} ct`;
  if (statDims) statDims.textContent = `${dims.width.toFixed(1)} × ${dims.height.toFixed(1)} × ${dims.length.toFixed(1)} mm`;

  if (applyBtn) {
    applyBtn.disabled = false;
    applyBtn.classList.remove('btn-disabled');
  }
}

// ── Image Loading & View Processing ─────────────────────────

export function processViewImage(viewKey, imageElement) {
  const view = state.views[viewKey];
  if (!view) return;

  view.image = imageElement;
  const outline = detectDiamondOutline(imageElement, {
    threshold: view.threshold,
    invert: view.invert
  });

  view.polygon = outline.polygon;
  view.rawPoints = outline.rawPoints;
  view.status = 'Ready';

  // Render highlighted outline onto slot canvas
  const canvas = document.getElementById(`canvas-${viewKey}`);
  if (canvas) {
    drawHighlightedSilhouette(canvas, imageElement, outline);
  }

  // Update status badge in card
  const badge = document.getElementById(`badge-${viewKey}`);
  if (badge) {
    const count = outline.polygon ? outline.polygon.length - 1 : 0;
    badge.textContent = `✓ Detected: ${count} pts`;
    badge.className = 'view-badge active';
  }

  // Automatically trigger 3D reconstruction
  triggerReconstruction();
}

export function loadSamplePreset(presetKey) {
  const sample = generateSampleDiamondViews(presetKey);
  if (sample.dims) {
    Object.assign(state.dimensions, sample.dims);
  }

  // Process all 3 views
  processViewImage('front', sample.front);
  processViewImage('side', sample.side);
  processViewImage('top', sample.top);

  // Update dimension inputs if present
  const dimH = document.getElementById('dim-height');
  const dimW = document.getElementById('dim-width');
  const dimL = document.getElementById('dim-length');
  if (dimH) dimH.value = state.dimensions.height;
  if (dimW) dimW.value = state.dimensions.width;
  if (dimL) dimL.value = state.dimensions.length;
}

// ── Camera Snapshot Modal ───────────────────────────────────

let webcamStream = null;
let activeWebcamTarget = 'front';

async function openCameraSnapshot(viewKey) {
  activeWebcamTarget = viewKey;
  const modal = document.getElementById('camera-modal');
  const video = document.getElementById('camera-video');
  if (!modal || !video) return;

  try {
    webcamStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    video.srcObject = webcamStream;
    await video.play();
    modal.style.display = 'flex';
  } catch (err) {
    console.error('Camera access error:', err);
    alert('Unable to access camera: ' + err.message + '. Please use image upload instead.');
  }
}

function closeCameraSnapshot() {
  const modal = document.getElementById('camera-modal');
  const video = document.getElementById('camera-video');
  if (video && webcamStream) {
    webcamStream.getTracks().forEach((track) => track.stop());
    webcamStream = null;
  }
  if (modal) modal.style.display = 'none';
}

function captureCameraSnapshot() {
  const video = document.getElementById('camera-video');
  if (!video || !webcamStream) return;

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const img = new Image();
  img.onload = () => {
    processViewImage(activeWebcamTarget, img);
    closeCameraSnapshot();
  };
  img.src = canvas.toDataURL('image/jpeg', 0.95);
}

// ── Transfer to Diamond CAD Main Workspace ──────────────────

function applyToDiamondCAD() {
  if (!state.currentReconstruction?.geometry) {
    alert('Please complete the 3-axis scan before applying to CAD.');
    return;
  }

  const { geometry } = state.currentReconstruction;
  const exportGeom = geometry.clone();
  exportGeom.computeVertexNormals();

  const positions = Array.from(exportGeom.attributes.position.array);
  const indices = exportGeom.index ? Array.from(exportGeom.index.array) : null;
  const serialized = { positions, indices };

  // Save to localStorage for persistence
  try {
    localStorage.setItem('scanned_rough_geometry', JSON.stringify(serialized));
    console.log('3-Axis rough diamond saved to localStorage.');
  } catch (e) {
    console.warn('localStorage error:', e);
  }

  const msg = {
    type: 'SCANNED_MODEL',
    geometry: serialized,
    roughParams: { ...state.dimensions }
  };

  if (window.parent && window.parent !== window) {
    window.parent.postMessage(msg, '*');
    window.parent.postMessage({ type: 'SCAN_DONE' }, '*');
  } else if (window.opener) {
    window.opener.postMessage(msg, '*');
    window.opener.postMessage({ type: 'SCAN_DONE' }, '*');
  } else {
    alert('Model generated and saved! In Diamond CAD, select Makeable shape.');
  }
}

// ── Export OBJ File ─────────────────────────────────────────

function exportOBJ() {
  if (!state.currentReconstruction?.geometry) return;
  const geom = state.currentReconstruction.geometry;
  const pos = geom.attributes.position.array;
  const idx = geom.index ? geom.index.array : null;

  let obj = '# 3-Axis Rough Diamond Reconstruction\n';
  obj += `# Generated by Diamond CAD Photogrammetry Studio\n`;

  for (let i = 0; i < pos.length; i += 3) {
    obj += `v ${pos[i].toFixed(4)} ${pos[i + 1].toFixed(4)} ${pos[i + 2].toFixed(4)}\n`;
  }

  if (idx) {
    for (let i = 0; i < idx.length; i += 3) {
      obj += `f ${idx[i] + 1} ${idx[i + 1] + 1} ${idx[i + 2] + 1}\n`;
    }
  }

  const blob = new Blob([obj], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `rough_diamond_${Date.now()}.obj`;
  a.click();
}

// ── Bind UI Events ──────────────────────────────────────────

function setupUI() {
  // Bind Preset Buttons
  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const preset = btn.getAttribute('data-preset');
      loadSamplePreset(preset);
    });
  });

  // Setup View Cards (Front, Side, Top)
  ['front', 'side', 'top'].forEach((key) => {
    const fileInput = document.getElementById(`input-${key}`);
    const uploadBtn = document.getElementById(`btn-upload-${key}`);
    const cameraBtn = document.getElementById(`btn-cam-${key}`);
    const slider = document.getElementById(`slider-${key}`);
    const invertBtn = document.getElementById(`btn-invert-${key}`);
    const dropZone = document.getElementById(`card-${key}`);

    if (uploadBtn && fileInput) {
      uploadBtn.addEventListener('click', () => fileInput.click());
    }

    if (cameraBtn) {
      cameraBtn.addEventListener('click', () => openCameraSnapshot(key));
    }

    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
          const reader = new FileReader();
          reader.onload = (ev) => {
            const img = new Image();
            img.onload = () => processViewImage(key, img);
            img.src = ev.target.result;
          };
          reader.readAsDataURL(file);
        }
      });
    }

    // Drag and drop onto card
    if (dropZone && fileInput) {
      dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
      });
      dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
      });
      dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file && file.type.startsWith('image/')) {
          const reader = new FileReader();
          reader.onload = (ev) => {
            const img = new Image();
            img.onload = () => processViewImage(key, img);
            img.src = ev.target.result;
          };
          reader.readAsDataURL(file);
        }
      });
    }

    // Sensitivity Slider
    if (slider) {
      slider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        state.views[key].threshold = val;
        const valLabel = document.getElementById(`val-${key}`);
        if (valLabel) valLabel.textContent = val;

        if (state.views[key].image) {
          processViewImage(key, state.views[key].image);
        }
      });
    }

    // Invert Background Toggle
    if (invertBtn) {
      invertBtn.addEventListener('click', () => {
        state.views[key].invert = !state.views[key].invert;
        invertBtn.classList.toggle('active', state.views[key].invert);
        if (state.views[key].image) {
          processViewImage(key, state.views[key].image);
        }
      });
    }
  });

  // Dimension inputs
  ['height', 'width', 'length'].forEach((dim) => {
    const input = document.getElementById(`dim-${dim}`);
    if (input) {
      input.addEventListener('change', (e) => {
        state.dimensions[dim] = parseFloat(e.target.value) || 5.0;
        triggerReconstruction();
      });
    }
  });

  // 3D Preview Toggles
  const wireBtn = document.getElementById('btn-toggle-wireframe');
  if (wireBtn) {
    wireBtn.addEventListener('click', () => {
      state.wireframe = !state.wireframe;
      wireBtn.classList.toggle('active', state.wireframe);
      if (previewMesh) {
        previewMesh.material.wireframe = state.wireframe;
      }
    });
  }

  const rotateBtn = document.getElementById('btn-toggle-rotate');
  if (rotateBtn) {
    rotateBtn.addEventListener('click', () => {
      state.autoRotate = !state.autoRotate;
      rotateBtn.classList.toggle('active', state.autoRotate);
    });
  }

  // Primary Actions
  const applyBtn = document.getElementById('btn-apply-cad');
  if (applyBtn) {
    applyBtn.addEventListener('click', applyToDiamondCAD);
  }

  const exportBtn = document.getElementById('btn-export-obj');
  if (exportBtn) {
    exportBtn.addEventListener('click', exportOBJ);
  }

  // Camera modal close/capture
  const closeCamBtn = document.getElementById('btn-close-camera');
  if (closeCamBtn) closeCamBtn.addEventListener('click', closeCameraSnapshot);

  const captureBtn = document.getElementById('btn-snap-camera');
  if (captureBtn) captureBtn.addEventListener('click', captureCameraSnapshot);
}

// ── Initialize ──────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  init3DPreview();
  setupUI();
  // Pre-load default natural octahedral rough crystal
  loadSamplePreset('octahedron');
});
