/* ============================================================
   scanner-3axis.js — 3-Axis Rough Diamond Photogrammetry Engine
   Reconstructs a watertight 3D CAD rough diamond mesh from
   3 orthogonal photographic views (Front, Side, Top) with
   automatic diamond outline detection, manual polygon drawing,
   and interactive vertex contour editing.
   ============================================================ */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { reconstruct3AxisVisualHull, convexHull2D } from './visualHullMesh.js';

// ── Application State ───────────────────────────────────────

const state = {
  views: {
    front: {
      id: 'front',
      name: 'Front View (X-Y)',
      axisLabel: 'Elevation / Front Face',
      image: null,
      polygon: null,
      rawPoints: [],
      mode: 'auto',              // 'auto' | 'draw' | 'edit'
      threshold: 28,
      invert: false,
      canvas: null,
      ctx: null,
      status: 'Empty',
      history: [],               // Undo stack of polygons
      draggedPointIndex: null,   // Index of vertex currently dragged
      hoveredPointIndex: null,   // Index of vertex hovered
      hoveredEdge: null,         // { index, point: [x,y] }
      currentMousePos: null,     // [x, y] in 400x400 space
      isPointerDown: false
    },
    side: {
      id: 'side',
      name: 'Side View (Z-Y)',
      axisLabel: 'Profile / 90° Turn',
      image: null,
      polygon: null,
      rawPoints: [],
      mode: 'auto',
      threshold: 28,
      invert: false,
      canvas: null,
      ctx: null,
      status: 'Empty',
      history: [],
      draggedPointIndex: null,
      hoveredPointIndex: null,
      hoveredEdge: null,
      currentMousePos: null,
      isPointerDown: false
    },
    top: {
      id: 'top',
      name: 'Top View (X-Z)',
      axisLabel: 'Plan View / Downward',
      image: null,
      polygon: null,
      rawPoints: [],
      mode: 'auto',
      threshold: 28,
      invert: false,
      canvas: null,
      ctx: null,
      status: 'Empty',
      history: [],
      draggedPointIndex: null,
      hoveredPointIndex: null,
      hoveredEdge: null,
      currentMousePos: null,
      isPointerDown: false
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

// ── Polygon Simplification & Geometry Helpers ───────────────

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

function isLoopClosed(poly) {
  if (!poly || poly.length < 3) return false;
  const first = poly[0];
  const last = poly[poly.length - 1];
  return Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-4;
}

function ensureClosedLoop(poly) {
  if (!poly || poly.length < 3) return poly;
  if (!isLoopClosed(poly)) {
    return [...poly, [...poly[0]]];
  }
  return poly;
}

// ── Automatic Outline Detection ─────────────────────────────

export function detectDiamondOutline(imageElement, options = {}) {
  const threshold = options.threshold ?? 28;
  const invert = options.invert ?? false;
  const tolerance = options.tolerance ?? 2.5;

  const targetSize = 400;
  const canvas = document.createElement('canvas');
  canvas.width = targetSize;
  canvas.height = targetSize;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

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

  const boundaryPoints = [];
  let minX = w, maxX = 0, minY = h, maxY = 0;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      let fg = isBackground[p] === 0;
      if (invert) fg = !fg;

      if (fg) {
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
    const pad = 60;
    const defaultPoly = [
      [w / 2, pad],
      [w - pad, h / 2],
      [w / 2, h - pad],
      [pad, h / 2]
    ];
    return {
      polygon: ensureClosedLoop(defaultPoly),
      rawPoints: boundaryPoints,
      bbox: { minX: pad, maxX: w - pad, minY: pad, maxY: h - pad },
      canvas
    };
  }

  const hull = convexHull2D(boundaryPoints);
  const simplified = ramerDouglasPeucker(hull, tolerance);

  return {
    polygon: ensureClosedLoop(simplified),
    rawPoints: boundaryPoints,
    bbox: { minX, maxX, minY, maxY },
    canvas
  };
}

// ── View Canvas Interactive Drawing & Overlay Renderer ──────

/**
 * Draws the view's photograph, neon contour lines, translucent body mask,
 * interactive vertex handles, edge '+' insert indicators, and manual draw lines.
 */
export function redrawView(viewKey) {
  const view = state.views[viewKey];
  const canvas = document.getElementById(`canvas-${viewKey}`);
  if (!canvas || !view) return;

  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  if (!view.image) {
    ctx.fillStyle = '#121420';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#252a3d';
    ctx.setLineDash([6, 6]);
    ctx.strokeRect(14, 14, w - 28, h - 28);
    ctx.setLineDash([]);
    ctx.fillStyle = '#556080';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No image uploaded', w / 2, h / 2 - 10);
    ctx.font = '12px sans-serif';
    ctx.fillText('Upload photo or select test preset', w / 2, h / 2 + 14);
    return;
  }

  // Draw image
  const imgW = view.image.naturalWidth || view.image.width || w;
  const imgH = view.image.naturalHeight || view.image.height || h;
  const scale = Math.min((w * 0.9) / imgW, (h * 0.9) / imgH);
  const dw = imgW * scale;
  const dh = imgH * scale;
  const ox = (w - dw) / 2;
  const oy = (h - dh) / 2;

  ctx.fillStyle = '#10131f';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(view.image, ox, oy, dw, dh);

  const poly = view.polygon;
  const isClosed = isLoopClosed(poly);

  ctx.save();

  // 1. If closed loop, fill diamond body with translucent cyan mask
  if (poly && poly.length >= 3 && isClosed) {
    ctx.beginPath();
    ctx.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i++) {
      ctx.lineTo(poly[i][0], poly[i][1]);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(0, 240, 180, 0.22)';
    ctx.fill();
  }

  // 2. Neon stroke around existing path
  if (poly && poly.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i++) {
      ctx.lineTo(poly[i][0], poly[i][1]);
    }
    if (isClosed) ctx.closePath();

    // Outer neon glow
    ctx.shadowColor = '#00ffc8';
    ctx.shadowBlur = 14;
    ctx.strokeStyle = 'rgba(0, 255, 200, 0.7)';
    ctx.lineWidth = 4;
    ctx.stroke();

    // Crisp inner stroke
    ctx.shadowBlur = 4;
    ctx.strokeStyle = '#00ffc8';
    ctx.lineWidth = 2.2;
    ctx.stroke();

    // Sharp core
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.0;
    ctx.stroke();
  }

  // 3. In Draw mode, draw dashed guide line to current mouse position
  if (view.mode === 'draw' && view.currentMousePos && poly && poly.length > 0 && !isClosed) {
    const last = poly[poly.length - 1];
    const [mx, my] = view.currentMousePos;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(last[0], last[1]);
    ctx.lineTo(mx, my);
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = 'rgba(0, 255, 200, 0.85)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // If mouse is near start point, highlight start point with glowing green ring
    const distToStart = Math.hypot(mx - poly[0][0], my - poly[0][1]);
    if (poly.length >= 3 && distToStart < 18) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(poly[0][0], poly[0][1], 12, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 255, 200, 0.35)';
      ctx.fill();
      ctx.strokeStyle = '#00ffc8';
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // Tooltip text
      ctx.fillStyle = '#00ffc8';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText('Click to Close', poly[0][0] + 16, poly[0][1] - 8);
      ctx.restore();
    }
  }

  // 4. Render vertex handles
  if (poly && poly.length > 0) {
    const numPoints = isClosed ? poly.length - 1 : poly.length;

    for (let i = 0; i < numPoints; i++) {
      const px = poly[i][0];
      const py = poly[i][1];
      const isHovered = view.mode === 'edit' && view.hoveredPointIndex === i;
      const isDragged = view.mode === 'edit' && view.draggedPointIndex === i;
      const isStart = i === 0 && view.mode === 'draw';

      ctx.save();

      if (isDragged) {
        // Dragging vertex
        ctx.beginPath();
        ctx.arc(px, py, 9, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 230, 0, 0.4)';
        ctx.fill();
        ctx.strokeStyle = '#ffff00';
        ctx.lineWidth = 3;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      } else if (isHovered) {
        // Hovered vertex (in edit mode)
        ctx.beginPath();
        ctx.arc(px, py, 8, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 230, 0, 0.35)';
        ctx.fill();
        ctx.strokeStyle = '#ffff00';
        ctx.lineWidth = 2.5;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      } else if (isStart) {
        // First vertex in draw mode
        ctx.beginPath();
        ctx.arc(px, py, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#00ffc8';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        // Regular vertex
        ctx.beginPath();
        ctx.arc(px, py, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = '#00ffc8';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(px, py, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      }

      ctx.restore();
    }
  }

  // 5. If hovering over an edge in Edit mode, draw ghost '+' vertex
  if (view.mode === 'edit' && view.hoveredEdge && view.draggedPointIndex === null) {
    const [gx, gy] = view.hoveredEdge.point;
    ctx.save();
    ctx.beginPath();
    ctx.arc(gx, gy, 7, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 255, 200, 0.85)';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#0e111a';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('+', gx, gy);

    // Callout label
    ctx.fillStyle = 'rgba(10, 16, 26, 0.85)';
    ctx.strokeStyle = 'rgba(0, 255, 200, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(gx + 12, gy - 12, 105, 18, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#00ffc8';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('Click to add point', gx + 16, gy);
    ctx.restore();
  }

  // 6. Corner status badge
  let badgeText = '';
  if (view.mode === 'auto') {
    const count = poly ? (isClosed ? poly.length - 1 : poly.length) : 0;
    badgeText = `🪄 Auto: ${count} facets`;
  } else if (view.mode === 'draw') {
    const count = poly ? poly.length : 0;
    badgeText = isClosed ? `✓ Outline closed (${poly.length - 1} pts)` : `✏️ Click to add point (${count} placed)`;
  } else {
    const count = poly ? (isClosed ? poly.length - 1 : poly.length) : 0;
    badgeText = `🖐️ Edit: ${count} vertices • Drag points`;
  }

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

// ── Interactive Canvas Event Binding ────────────────────────

function attachCanvasInteraction(viewKey) {
  const canvas = document.getElementById(`canvas-${viewKey}`);
  if (!canvas) return;
  const view = state.views[viewKey];

  function getCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.clientX ?? (e.touches && e.touches[0]?.clientX);
    const clientY = e.clientY ?? (e.touches && e.touches[0]?.clientY);
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return [
      Math.max(0, Math.min(canvas.width, (clientX - rect.left) * scaleX)),
      Math.max(0, Math.min(canvas.height, (clientY - rect.top) * scaleY))
    ];
  }

  function pushHistory() {
    if (!view.polygon) return;
    if (!view.history) view.history = [];
    view.history.push(view.polygon.map((p) => [...p]));
    if (view.history.length > 30) view.history.shift();
  }

  function findNearestVertex(x, y, maxDist = 14) {
    const poly = view.polygon;
    if (!poly || poly.length === 0) return -1;
    let bestDist = maxDist;
    let bestIdx = -1;
    const n = isLoopClosed(poly) ? poly.length - 1 : poly.length;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(x - poly[i][0], y - poly[i][1]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  function findNearestEdge(x, y, maxDist = 10) {
    const poly = view.polygon;
    if (!poly || poly.length < 2) return null;
    let bestDist = maxDist;
    let bestEdge = null;
    const n = isLoopClosed(poly) ? poly.length - 1 : poly.length;

    for (let i = 0; i < n; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % poly.length];
      const dx = p2[0] - p1[0];
      const dy = p2[1] - p1[1];
      const lenSq = dx * dx + dy * dy;
      if (lenSq < 1e-4) continue;

      const t = ((x - p1[0]) * dx + (y - p1[1]) * dy) / lenSq;
      if (t >= 0.08 && t <= 0.92) {
        const projX = p1[0] + t * dx;
        const projY = p1[1] + t * dy;
        const d = Math.hypot(x - projX, y - projY);
        if (d < bestDist) {
          bestDist = d;
          bestEdge = { index: i, point: [projX, projY] };
        }
      }
    }
    return bestEdge;
  }

  // Right-click to delete vertex
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (view.mode === 'edit' || view.mode === 'draw') {
      const [x, y] = getCoords(e);
      const idx = findNearestVertex(x, y, 16);
      if (idx !== -1 && view.polygon.length > 4) {
        pushHistory();
        view.polygon.splice(idx, 1);
        if (isLoopClosed(view.polygon)) {
          view.polygon[view.polygon.length - 1] = [...view.polygon[0]];
        }
        redrawView(viewKey);
        triggerReconstruction();
      }
    }
  });

  // Mousedown
  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 2) return;
    view.isPointerDown = true;
    const [x, y] = getCoords(e);

    if (view.mode === 'draw') {
      if (!view.polygon) view.polygon = [];

      // If clicking near start vertex, close the loop!
      if (view.polygon.length >= 3 && Math.hypot(x - view.polygon[0][0], y - view.polygon[0][1]) < 18) {
        pushHistory();
        view.polygon.push([...view.polygon[0]]);
        setMode(viewKey, 'edit');
        redrawView(viewKey);
        triggerReconstruction();
        return;
      }

      pushHistory();
      view.polygon.push([x, y]);
      redrawView(viewKey);
      if (isLoopClosed(view.polygon)) {
        triggerReconstruction();
      }
    } else if (view.mode === 'edit') {
      // Check if clicking existing vertex
      const vIdx = findNearestVertex(x, y, 16);
      if (vIdx !== -1) {
        pushHistory();
        view.draggedPointIndex = vIdx;
        canvas.style.cursor = 'grabbing';
        redrawView(viewKey);
        return;
      }

      // Check if clicking near edge -> insert new vertex
      const edge = findNearestEdge(x, y, 12);
      if (edge) {
        pushHistory();
        view.polygon.splice(edge.index + 1, 0, [x, y]);
        view.draggedPointIndex = edge.index + 1;
        canvas.style.cursor = 'grabbing';
        redrawView(viewKey);
        triggerReconstruction();
        return;
      }
    }
  });

  // Mousemove
  canvas.addEventListener('mousemove', (e) => {
    const [x, y] = getCoords(e);
    view.currentMousePos = [x, y];

    if (view.mode === 'draw') {
      canvas.style.cursor = 'crosshair';
      if (view.isPointerDown) {
        // Freehand lasso drag
        const last = view.polygon[view.polygon.length - 1];
        if (!last || Math.hypot(x - last[0], y - last[1]) > 9) {
          view.polygon.push([x, y]);
          redrawView(viewKey);
        }
      } else {
        redrawView(viewKey);
      }
    } else if (view.mode === 'edit') {
      if (view.draggedPointIndex !== null) {
        canvas.style.cursor = 'grabbing';
        view.polygon[view.draggedPointIndex] = [x, y];
        if (view.draggedPointIndex === 0 && isLoopClosed(view.polygon)) {
          view.polygon[view.polygon.length - 1] = [x, y];
        }
        redrawView(viewKey);
        triggerReconstruction();
      } else {
        const vIdx = findNearestVertex(x, y, 14);
        if (vIdx !== -1) {
          view.hoveredPointIndex = vIdx;
          view.hoveredEdge = null;
          canvas.style.cursor = 'grab';
        } else {
          view.hoveredPointIndex = null;
          const edge = findNearestEdge(x, y, 10);
          view.hoveredEdge = edge;
          canvas.style.cursor = edge ? 'copy' : 'default';
        }
        redrawView(viewKey);
      }
    }
  });

  // Mouseup / Mouseleave
  const handlePointerUp = () => {
    view.isPointerDown = false;

    if (view.mode === 'draw') {
      // If user drew freehand lasso with >= 6 points and released mouse, close it!
      if (view.polygon && view.polygon.length >= 6 && !isLoopClosed(view.polygon)) {
        view.polygon.push([...view.polygon[0]]);
        setMode(viewKey, 'edit');
        triggerReconstruction();
      }
    } else if (view.mode === 'edit') {
      if (view.draggedPointIndex !== null) {
        view.draggedPointIndex = null;
        triggerReconstruction();
      }
      canvas.style.cursor = view.hoveredPointIndex !== null ? 'grab' : (view.hoveredEdge ? 'copy' : 'default');
      redrawView(viewKey);
    }
  };

  canvas.addEventListener('mouseup', handlePointerUp);
  canvas.addEventListener('mouseleave', () => {
    view.currentMousePos = null;
    view.hoveredPointIndex = null;
    view.hoveredEdge = null;
    handlePointerUp();
  });

  // Touch support for tablets / touchscreen
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    const mouseEvt = new MouseEvent('mousedown', {
      clientX: touch.clientX,
      clientY: touch.clientY,
      button: 0
    });
    canvas.dispatchEvent(mouseEvt);
  });

  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    const mouseEvt = new MouseEvent('mousemove', {
      clientX: touch.clientX,
      clientY: touch.clientY
    });
    canvas.dispatchEvent(mouseEvt);
  });

  canvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    const mouseEvt = new MouseEvent('mouseup', {});
    canvas.dispatchEvent(mouseEvt);
  });
}

// ── View Mode Switching & Tool Actions ──────────────────────

export function setMode(viewKey, mode) {
  const view = state.views[viewKey];
  if (!view) return;

  view.mode = mode;

  // Update mode tabs
  ['auto', 'draw', 'edit'].forEach((m) => {
    const tab = document.getElementById(`tab-${m}-${viewKey}`);
    if (tab) tab.classList.toggle('active', m === mode);
  });

  // Toggle control panels
  const autoControls = document.getElementById(`controls-auto-${viewKey}`);
  const manualControls = document.getElementById(`controls-manual-${viewKey}`);
  const hintText = document.getElementById(`hint-text-${viewKey}`);

  if (autoControls) autoControls.style.display = mode === 'auto' ? 'flex' : 'none';
  if (manualControls) manualControls.style.display = mode !== 'auto' ? 'flex' : 'none';

  if (hintText) {
    if (mode === 'draw') {
      hintText.textContent = 'Click around perimeter to add points • Click start point to close • Drag to trace';
    } else if (mode === 'edit') {
      hintText.textContent = 'Drag points to tweak • Click line to add (+) • Right-click to delete';
    }
  }

  // Update canvas cursor
  const canvas = document.getElementById(`canvas-${viewKey}`);
  if (canvas) {
    canvas.style.cursor = mode === 'draw' ? 'crosshair' : (mode === 'edit' ? 'grab' : 'default');
  }

  redrawView(viewKey);
}

export function undoView(viewKey) {
  const view = state.views[viewKey];
  if (!view || !view.history || view.history.length === 0) return;

  view.polygon = view.history.pop();
  redrawView(viewKey);
  triggerReconstruction();
}

export function closeViewLoop(viewKey) {
  const view = state.views[viewKey];
  if (!view || !view.polygon || view.polygon.length < 3) return;

  if (!view.history) view.history = [];
  view.history.push(view.polygon.map((p) => [...p]));

  view.polygon = ensureClosedLoop(view.polygon);
  setMode(viewKey, 'edit');
  redrawView(viewKey);
  triggerReconstruction();
}

export function smoothViewContour(viewKey) {
  const view = state.views[viewKey];
  if (!view || !view.polygon || view.polygon.length < 4) return;

  if (!view.history) view.history = [];
  view.history.push(view.polygon.map((p) => [...p]));

  // Snaps/smooths the hand-drawn points to clean planar crystal facets
  const hull = convexHull2D(view.polygon);
  const simplified = ramerDouglasPeucker(hull, 2.5);
  view.polygon = ensureClosedLoop(simplified);

  redrawView(viewKey);
  triggerReconstruction();
}

export function clearViewOutline(viewKey) {
  const view = state.views[viewKey];
  if (!view) return;

  if (view.polygon && view.polygon.length > 0) {
    if (!view.history) view.history = [];
    view.history.push(view.polygon.map((p) => [...p]));
  }

  view.polygon = [];
  setMode(viewKey, 'draw');
  redrawView(viewKey);
  triggerReconstruction();
}

export function toggleExpandCard(viewKey) {
  const card = document.getElementById(`card-${viewKey}`);
  const btn = document.getElementById(`btn-expand-${viewKey}`);
  if (!card) return;

  const isExpanded = card.classList.toggle('expanded');
  if (btn) btn.classList.toggle('active', isExpanded);

  // Redraw canvas with updated bounds
  setTimeout(() => redrawView(viewKey), 100);
}

// ── Synthetic Diamond Sample Presets ────────────────────────

export function generateSampleDiamondViews(preset = 'octahedron') {
  const size = 400;

  function createViewCanvas(drawFn) {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');

    const bg = ctx.createRadialGradient(size / 2, size / 2, 40, size / 2, size / 2, size / 1.3);
    bg.addColorStop(0, '#f2f4f8');
    bg.addColorStop(0.7, '#e2e6f0');
    bg.addColorStop(1, '#c5ccdc');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);

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

  function drawDiamondPolygon(ctx, vertices, facetColor = '#7ca8c4', highlightColor = '#edf5fa') {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(vertices[0][0], vertices[0][1]);
    for (let i = 1; i < vertices.length; i++) {
      ctx.lineTo(vertices[i][0], vertices[i][1]);
    }
    ctx.closePath();

    const grad = ctx.createLinearGradient(size / 2 - 80, size / 2 - 100, size / 2 + 80, size / 2 + 100);
    grad.addColorStop(0, highlightColor);
    grad.addColorStop(0.3, facetColor);
    grad.addColorStop(0.7, '#486884');
    grad.addColorStop(1, '#2c4055');
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const cx = size / 2;
    const cy = size / 2;
    for (let i = 0; i < vertices.length; i += 2) {
      ctx.beginPath();
      ctx.moveTo(vertices[i][0], vertices[i][1]);
      ctx.lineTo(cx, cy);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.stroke();
    }

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
    const front = createViewCanvas((ctx) => {
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
      const poly = [
        [size / 2, 90],
        [315, 300],
        [85, 300]
      ];
      drawDiamondPolygon(ctx, poly, '#78a6c5');
    });

    return { front, side, top, dims: { height: 4.2, width: 6.8, length: 6.5 } };
  } else if (preset === 'makeable') {
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
    const front = createViewCanvas((ctx) => {
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

  // Filter closed or valid polygons
  const frontPoly = v.front.polygon && v.front.polygon.length >= 3 ? v.front.polygon : null;
  const sidePoly = v.side.polygon && v.side.polygon.length >= 3 ? v.side.polygon : null;
  const topPoly = v.top.polygon && v.top.polygon.length >= 3 ? v.top.polygon : null;

  if (!frontPoly && !sidePoly && !topPoly) {
    return;
  }

  const effectiveFront = frontPoly || sidePoly || topPoly;
  const effectiveSide = sidePoly || frontPoly || topPoly;
  const effectiveTop = topPoly || frontPoly || sidePoly;

  const dims = state.dimensions;
  const result = reconstruct3AxisVisualHull(effectiveFront, effectiveSide, effectiveTop, dims);

  if (!result || !result.geometry) {
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

  result.geometry.computeBoundingBox();
  const box = result.geometry.boundingBox;
  if (box && gridHelper) {
    gridHelper.position.y = box.min.y - 0.5;
  }

  const vertexCount = result.geometry.attributes.position.count;
  const faceCount = result.geometry.index ? result.geometry.index.count / 3 : vertexCount / 3;
  const volumeMm3 = result.volume || (dims.width * dims.height * dims.length * 0.45);
  const carats = volumeMm3 * 3.52 * 0.005;

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

// ── Image Loading & Processing ──────────────────────────────

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
  view.history = [outline.polygon.map((p) => [...p])];

  const badge = document.getElementById(`badge-${viewKey}`);
  if (badge) {
    const count = outline.polygon ? (isLoopClosed(outline.polygon) ? outline.polygon.length - 1 : outline.polygon.length) : 0;
    badge.textContent = `✓ ${count} pts`;
    badge.className = 'view-badge active';
  }

  redrawView(viewKey);
  triggerReconstruction();
}

export function loadSamplePreset(presetKey) {
  const sample = generateSampleDiamondViews(presetKey);
  if (sample.dims) {
    Object.assign(state.dimensions, sample.dims);
  }

  processViewImage('front', sample.front);
  processViewImage('side', sample.side);
  processViewImage('top', sample.top);

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
    // Mode tabs
    ['auto', 'draw', 'edit'].forEach((mode) => {
      const tab = document.getElementById(`tab-${mode}-${key}`);
      if (tab) {
        tab.addEventListener('click', () => {
          if (mode === 'auto' && state.views[key].image) {
            // Re-detect with auto
            processViewImage(key, state.views[key].image);
          }
          setMode(key, mode);
        });
      }
    });

    // Expand toggle
    const expandBtn = document.getElementById(`btn-expand-${key}`);
    if (expandBtn) {
      expandBtn.addEventListener('click', () => toggleExpandCard(key));
    }

    // Manual Tool Buttons
    const undoBtn = document.getElementById(`btn-undo-${key}`);
    if (undoBtn) undoBtn.addEventListener('click', () => undoView(key));

    const closeBtn = document.getElementById(`btn-close-${key}`);
    if (closeBtn) closeBtn.addEventListener('click', () => closeViewLoop(key));

    const smoothBtn = document.getElementById(`btn-smooth-${key}`);
    if (smoothBtn) smoothBtn.addEventListener('click', () => smoothViewContour(key));

    const clearBtn = document.getElementById(`btn-clear-${key}`);
    if (clearBtn) clearBtn.addEventListener('click', () => clearViewOutline(key));

    // Upload & Camera
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

        if (state.views[key].image && state.views[key].mode === 'auto') {
          processViewImage(key, state.views[key].image);
        }
      });
    }

    // Invert Background Toggle
    if (invertBtn) {
      invertBtn.addEventListener('click', () => {
        state.views[key].invert = !state.views[key].invert;
        invertBtn.classList.toggle('active', state.views[key].invert);
        if (state.views[key].image && state.views[key].mode === 'auto') {
          processViewImage(key, state.views[key].image);
        }
      });
    }

    // Attach interactive drawing/editing to canvas
    attachCanvasInteraction(key);
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
  loadSamplePreset('octahedron');
});
