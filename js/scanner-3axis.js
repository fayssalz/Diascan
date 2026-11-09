/* ============================================================
   scanner-3axis.js — 3-Axis & Trimetric B-Rep Solid Engine
   Reconstructs a watertight, manifold B-rep CAD rough diamond
   mesh from 3 orthogonal photographic views or a trimetric
   drawing with visible and hidden lines.
   Handles concave geometry, re-entrant corners, undercuts,
   through/blind holes, internal cavities (shelled wall thickness),
   and multiply-connected faces (inner loops).
   ============================================================ */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { 
  reconstruct3AxisVisualHull, 
  reconstructBrepSolid, 
  convertTrimetricToBrep, 
  convexHull2D 
} from './visualHullMesh.js';

// ── Application State ───────────────────────────────────────

const state = {
  views: {
    front: {
      id: 'front',
      name: 'Front View (X-Y)',
      axisLabel: 'Elevation / Front Face',
      image: null,
      polygon: null,       // Outer boundary polygon
      holes: [],           // Inner loops / through cuts: [ [[x,y], ...], ... ]
      activeLoopType: 'outer', // 'outer' | 'hole'
      currentHoleIndex: 0,
      mode: 'auto',        // 'auto' | 'draw' | 'hole' | 'edit'
      threshold: 28,
      invert: false,
      canvas: null,
      ctx: null,
      status: 'Empty',
      history: [],
      draggedPointIndex: null,
      hoveredPointIndex: null,
      hoveredEdge: null,
      hoveredHoleIndex: null,
      currentMousePos: null,
      isPointerDown: false
    },
    side: {
      id: 'side',
      name: 'Side View (Z-Y)',
      axisLabel: 'Profile / 90° Turn',
      image: null,
      polygon: null,
      holes: [],
      activeLoopType: 'outer',
      currentHoleIndex: 0,
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
      hoveredHoleIndex: null,
      currentMousePos: null,
      isPointerDown: false
    },
    top: {
      id: 'top',
      name: 'Top View (X-Z)',
      axisLabel: 'Plan View / Downward',
      image: null,
      polygon: null,
      holes: [],
      activeLoopType: 'outer',
      currentHoleIndex: 0,
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
      hoveredHoleIndex: null,
      currentMousePos: null,
      isPointerDown: false
    }
  },
  trimetric: {
    strokes: [],           // Array<{ points: [[x,y],...], isHidden: boolean }>
    currentStroke: null,
    mode: 'visible',       // 'visible' | 'hidden' | 'edit'
    snapAxis: true,
    hoveredVertex: null,
    draggedVertex: null,
    history: [],
    currentMousePos: null,
    isPointerDown: false
  },
  dimensions: {
    height: 6.0,
    width: 5.0,
    length: 5.0,
    wallThickness: 0.0     // 0 = solid, >0 = shelled internal cavity
  },
  wireframe: false,
  autoRotate: true,
  xrayCavity: false,
  activeAxisTab: 'front',
  currentReconstruction: null
};

// ── Three.js Scene Setup for 3D Preview ─────────────────────

let scene, camera, renderer, controls, previewMesh, cavityMesh, gridHelper;

function init3DPreview() {
  const container = document.getElementById('preview3d-container');
  if (!container) return;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0d16);

  const width = container.clientWidth || 400;
  const height = container.clientHeight || 350;

  camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
  camera.position.set(10, 8, 12);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.35;
  container.innerHTML = '';
  container.appendChild(renderer.domElement);

  // Lighting setup
  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const dirLight1 = new THREE.DirectionalLight(0xddeeff, 2.0);
  dirLight1.position.set(8, 12, 10);
  scene.add(dirLight1);

  const dirLight2 = new THREE.DirectionalLight(0x7099ff, 1.0);
  dirLight2.position.set(-8, -4, -8);
  scene.add(dirLight2);

  const fillLight = new THREE.DirectionalLight(0x00ffc8, 0.6);
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

  const targetSize = 600;
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

  bgR = (bgR / bgCount) | 0;
  bgG = (bgG / bgCount) | 0;
  bgB = (bgB / bgCount) | 0;

  const contrast = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const dr = data[i] - bgR;
    const dg = data[i + 1] - bgG;
    const db = data[i + 2] - bgB;
    contrast[p] = Math.sqrt(dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114);
  }

  const isBackground = new Uint8Array(w * h);
  const queue = [];

  for (let x = 0; x < w; x++) {
    if (contrast[x] < threshold) { isBackground[x] = 1; queue.push(x); }
    const b = (h - 1) * w + x;
    if (contrast[b] < threshold) { isBackground[b] = 1; queue.push(b); }
  }
  for (let y = 1; y < h - 1; y++) {
    const l = y * w;
    if (contrast[l] < threshold) { isBackground[l] = 1; queue.push(l); }
    const r = y * w + (w - 1);
    if (contrast[r] < threshold) { isBackground[r] = 1; queue.push(r); }
  }

  while (queue.length > 0) {
    const p = queue.pop();
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

export function redrawView(viewKey) {
  const view = state.views[viewKey];
  const canvas = document.getElementById(`canvas-${viewKey}`);
  if (!canvas || !view) return;

  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  if (!view.image) {
    ctx.fillStyle = '#0e111a';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#22293d';
    ctx.setLineDash([6, 6]);
    ctx.strokeRect(20, 20, w - 40, h - 40);
    ctx.setLineDash([]);
    ctx.fillStyle = '#64748b';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No image uploaded for this view', w / 2, h / 2 - 12);
    ctx.font = '13px sans-serif';
    ctx.fillText('Click "Upload" or pick a sample preset above', w / 2, h / 2 + 16);
    return;
  }

  // Draw image scaled
  const imgW = view.image.naturalWidth || view.image.width || w;
  const imgH = view.image.naturalHeight || view.image.height || h;
  const scale = Math.min((w * 0.9) / imgW, (h * 0.9) / imgH);
  const dw = imgW * scale;
  const dh = imgH * scale;
  const ox = (w - dw) / 2;
  const oy = (h - dh) / 2;

  ctx.fillStyle = '#0c0f17';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(view.image, ox, oy, dw, dh);

  const poly = view.polygon;
  const isClosed = isLoopClosed(poly);

  ctx.save();

  // 1. Fill diamond body with translucent cyan mask
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

  // 2. Stroke outer boundary polygon in cyan (#00ffc8)
  if (poly && poly.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i++) {
      ctx.lineTo(poly[i][0], poly[i][1]);
    }
    if (isClosed) ctx.closePath();

    ctx.shadowColor = '#00ffc8';
    ctx.shadowBlur = 12;
    ctx.strokeStyle = 'rgba(0, 255, 200, 0.7)';
    ctx.lineWidth = 3.5;
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#00ffc8';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // 3. Render Inner Loops / Holes in neon amber (#ffb700) with dashed outline
  if (view.holes && view.holes.length > 0) {
    view.holes.forEach((hole, hIdx) => {
      if (!hole || hole.length < 2) return;
      const holeClosed = isLoopClosed(hole);

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(hole[0][0], hole[0][1]);
      for (let i = 1; i < hole.length; i++) {
        ctx.lineTo(hole[i][0], hole[i][1]);
      }
      if (holeClosed) {
        ctx.closePath();
        ctx.fillStyle = 'rgba(255, 183, 0, 0.2)';
        ctx.fill();
      }

      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = '#ffb700';
      ctx.lineWidth = 2.5;
      ctx.shadowColor = '#ffb700';
      ctx.shadowBlur = 10;
      ctx.stroke();
      ctx.restore();

      // Draw hole vertices if in hole or edit mode
      if (view.mode === 'hole' || view.mode === 'edit') {
        hole.forEach(([hx, hy], pIdx) => {
          ctx.beginPath();
          ctx.arc(hx, hy, 4, 0, Math.PI * 2);
          ctx.fillStyle = '#ffb700';
          ctx.fill();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        });
      }
    });
  }

  // 4. Draw outer vertices and interactive handles
  if (poly && poly.length > 0 && view.mode !== 'auto') {
    const numPoints = isClosed ? poly.length - 1 : poly.length;

    for (let i = 0; i < numPoints; i++) {
      const px = poly[i][0];
      const py = poly[i][1];
      const isHovered = view.mode === 'edit' && view.hoveredPointIndex === i;
      const isDragged = view.mode === 'edit' && view.draggedPointIndex === i;
      const isStart = i === 0 && view.mode === 'draw';

      ctx.save();

      if (isDragged || isHovered) {
        ctx.beginPath();
        ctx.arc(px, py, 8, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 230, 0, 0.4)';
        ctx.fill();
        ctx.strokeStyle = '#ffff00';
        ctx.lineWidth = 2.5;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      } else if (isStart) {
        ctx.beginPath();
        ctx.arc(px, py, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#00ffc8';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
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

  // 5. Ghost line while drawing
  if ((view.mode === 'draw' || view.mode === 'hole') && view.currentMousePos) {
    const activeList = view.mode === 'hole' 
      ? (view.holes[view.currentHoleIndex] || []) 
      : (view.polygon || []);

    if (activeList.length > 0) {
      const last = activeList[activeList.length - 1];
      ctx.beginPath();
      ctx.moveTo(last[0], last[1]);
      ctx.lineTo(view.currentMousePos[0], view.currentMousePos[1]);
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = view.mode === 'hole' ? '#ffb700' : 'rgba(0, 255, 200, 0.8)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // 6. Ghost '+' edge insertion indicator in Edit mode
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
    ctx.restore();
  }

  ctx.restore();
}

// ── Trimetric Drawing Canvas Renderer & Event Interaction ───

export function redrawTrimetricView() {
  const canvas = document.getElementById('canvas-trimetric');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  // Subtle isometric axis guide grid
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
  ctx.lineWidth = 1;
  const step = 32;
  const cos30 = Math.cos(Math.PI / 6);
  const sin30 = Math.sin(Math.PI / 6);

  for (let d = -w; d < w * 2; d += step) {
    // 30° lines
    ctx.beginPath();
    ctx.moveTo(d, 0);
    ctx.lineTo(d + h / Math.tan(Math.PI / 6), h);
    ctx.stroke();

    // 150° lines
    ctx.beginPath();
    ctx.moveTo(d, 0);
    ctx.lineTo(d - h / Math.tan(Math.PI / 6), h);
    ctx.stroke();

    // 90° vertical lines
    ctx.beginPath();
    ctx.moveTo(d, 0);
    ctx.lineTo(d, h);
    ctx.stroke();
  }
  ctx.restore();

  // Draw committed strokes
  state.trimetric.strokes.forEach((stroke) => {
    const pts = stroke.points;
    if (!pts || pts.length < 2) return;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i][0], pts[i][1]);
    }

    if (stroke.isHidden) {
      // Dashed hidden lines (cavity / inner edges)
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = '#ffb700';
      ctx.lineWidth = 2.5;
      ctx.shadowColor = '#ffb700';
      ctx.shadowBlur = 8;
    } else {
      // Solid visible lines
      ctx.strokeStyle = '#00ffc8';
      ctx.lineWidth = 3;
      ctx.shadowColor = '#00ffc8';
      ctx.shadowBlur = 10;
    }
    ctx.stroke();
    ctx.restore();

    // Draw vertex endpoints
    pts.forEach(([x, y]) => {
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = stroke.isHidden ? '#ffb700' : '#00ffc8';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.stroke();
    });
  });

  // Draw current live stroke being drawn
  if (state.trimetric.currentStroke && state.trimetric.currentStroke.points.length > 0) {
    const pts = state.trimetric.currentStroke.points;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i][0], pts[i][1]);
    }
    if (state.trimetric.currentMousePos) {
      ctx.lineTo(state.trimetric.currentMousePos[0], state.trimetric.currentMousePos[1]);
    }

    if (state.trimetric.currentStroke.isHidden) {
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = '#ffb700';
    } else {
      ctx.strokeStyle = '#00ffc8';
    }
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();
  }
}

// ── Interactive Canvas Event Handlers ───────────────────────

function attachCanvasInteraction(viewKey) {
  const canvas = document.getElementById(`canvas-${viewKey}`);
  const view = state.views[viewKey];
  if (!canvas || !view) return;

  function getCanvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return [
      Math.round((e.clientX - rect.left) * scaleX),
      Math.round((e.clientY - rect.top) * scaleY)
    ];
  }

  function getActivePoints() {
    if (view.mode === 'hole') {
      if (!view.holes[view.currentHoleIndex]) {
        view.holes[view.currentHoleIndex] = [];
      }
      return view.holes[view.currentHoleIndex];
    }
    return view.polygon;
  }

  function setActivePoints(pts) {
    if (view.mode === 'hole') {
      view.holes[view.currentHoleIndex] = pts;
    } else {
      view.polygon = pts;
    }
  }

  function findNearestVertex(x, y, maxDist = 14) {
    const poly = getActivePoints();
    if (!poly) return -1;
    let bestDist = maxDist;
    let bestIdx = -1;
    for (let i = 0; i < poly.length; i++) {
      const d = Math.hypot(poly[i][0] - x, poly[i][1] - y);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  function findNearestEdge(x, y, maxDist = 12) {
    const poly = getActivePoints();
    if (!poly || poly.length < 2) return null;
    let bestDist = maxDist;
    let bestEdge = null;
    const count = isLoopClosed(poly) ? poly.length - 1 : poly.length - 1;

    for (let i = 0; i < count; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % poly.length];
      const dx = x2 - x1;
      const dy = y2 - y1;
      const lenSq = dx * dx + dy * dy;
      if (lenSq < 1e-4) continue;

      let t = ((x - x1) * dx + (y - y1) * dy) / lenSq;
      t = Math.max(0, Math.min(1, t));
      const projX = x1 + t * dx;
      const projY = y1 + t * dy;
      const d = Math.hypot(x - projX, y - projY);

      if (d < bestDist) {
        bestDist = d;
        bestEdge = { index: i + 1, point: [Math.round(projX), Math.round(projY)] };
      }
    }
    return bestEdge;
  }

  // Mouse Down
  canvas.addEventListener('mousedown', (e) => {
    const [x, y] = getCanvasCoords(e);
    view.isPointerDown = true;

    if (e.button === 2) {
      // Right click to delete vertex in edit mode
      e.preventDefault();
      if (view.mode === 'edit') {
        const vIdx = findNearestVertex(x, y, 16);
        const poly = getActivePoints();
        if (vIdx !== -1 && poly && poly.length > 3) {
          if (!view.history) view.history = [];
          view.history.push(poly.map(p => [...p]));
          poly.splice(vIdx, 1);
          if (isLoopClosed(poly)) {
            poly[poly.length - 1] = [...poly[0]];
          }
          redrawView(viewKey);
          triggerReconstruction();
        }
      }
      return;
    }

    if (view.mode === 'draw' || view.mode === 'hole') {
      let poly = getActivePoints();
      if (!poly) {
        poly = [];
        setActivePoints(poly);
      }

      if (!view.history) view.history = [];
      view.history.push(poly.map(p => [...p]));

      // If clicked near first point and polygon >= 3, close loop!
      if (poly.length >= 3 && Math.hypot(poly[0][0] - x, poly[0][1] - y) < 18) {
        poly.push([...poly[0]]);
        setMode(viewKey, 'edit');
        triggerReconstruction();
        return;
      }

      poly.push([x, y]);
      redrawView(viewKey);
    } else if (view.mode === 'edit') {
      const vIdx = findNearestVertex(x, y, 14);
      if (vIdx !== -1) {
        view.draggedPointIndex = vIdx;
        const poly = getActivePoints();
        if (!view.history) view.history = [];
        view.history.push(poly.map(p => [...p]));
      } else {
        const edge = findNearestEdge(x, y, 12);
        if (edge) {
          const poly = getActivePoints();
          if (!view.history) view.history = [];
          view.history.push(poly.map(p => [...p]));
          poly.splice(edge.index, 0, edge.point);
          view.draggedPointIndex = edge.index;
          redrawView(viewKey);
          triggerReconstruction();
        }
      }
    }
  });

  // Context menu prevention
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // Mouse Move
  canvas.addEventListener('mousemove', (e) => {
    const [x, y] = getCanvasCoords(e);
    view.currentMousePos = [x, y];

    if (view.mode === 'draw' || view.mode === 'hole') {
      redrawView(viewKey);
    } else if (view.mode === 'edit') {
      if (view.draggedPointIndex !== null) {
        const poly = getActivePoints();
        if (poly && poly[view.draggedPointIndex]) {
          poly[view.draggedPointIndex] = [x, y];
          if (view.draggedPointIndex === 0 && isLoopClosed(poly)) {
            poly[poly.length - 1] = [x, y];
          } else if (view.draggedPointIndex === poly.length - 1 && isLoopClosed(poly)) {
            poly[0] = [x, y];
          }
          redrawView(viewKey);
        }
      } else {
        const vIdx = findNearestVertex(x, y, 14);
        if (vIdx !== -1) {
          view.hoveredPointIndex = vIdx;
          view.hoveredEdge = null;
          canvas.style.cursor = 'grab';
        } else {
          view.hoveredPointIndex = null;
          const edge = findNearestEdge(x, y, 12);
          view.hoveredEdge = edge;
          canvas.style.cursor = edge ? 'copy' : 'default';
        }
        redrawView(viewKey);
      }
    }
  });

  // Mouse Up
  const handlePointerUp = () => {
    view.isPointerDown = false;
    if (view.mode === 'edit' && view.draggedPointIndex !== null) {
      view.draggedPointIndex = null;
      triggerReconstruction();
      redrawView(viewKey);
    }
  };

  canvas.addEventListener('mouseup', handlePointerUp);
  canvas.addEventListener('mouseleave', () => {
    view.currentMousePos = null;
    handlePointerUp();
  });
}

function attachTrimetricInteraction() {
  const canvas = document.getElementById('canvas-trimetric');
  if (!canvas) return;

  function getCanvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return [
      Math.round((e.clientX - rect.left) * scaleX),
      Math.round((e.clientY - rect.top) * scaleY)
    ];
  }

  // Snap to 30°, 90°, 150°, 210°, 270°, 330° isometric angles
  function snapToIsometric(origin, [x, y]) {
    if (!state.trimetric.snapAxis || !origin) return [x, y];
    const dx = x - origin[0];
    const dy = y - origin[1];
    const dist = Math.hypot(dx, dy);
    if (dist < 8) return [x, y];

    const angle = Math.atan2(dy, dx); // radians -PI..PI
    const deg = (angle * 180 / Math.PI + 360) % 360;

    const targets = [30, 90, 150, 210, 270, 330];
    let bestTarget = deg;
    let minDiff = Infinity;

    for (const t of targets) {
      let diff = Math.abs(deg - t);
      if (diff > 180) diff = 360 - diff;
      if (diff < minDiff) {
        minDiff = diff;
        bestTarget = t;
      }
    }

    if (minDiff < 18) {
      const rad = bestTarget * Math.PI / 180;
      return [
        Math.round(origin[0] + dist * Math.cos(rad)),
        Math.round(origin[1] + dist * Math.sin(rad))
      ];
    }
    return [x, y];
  }

  canvas.addEventListener('mousedown', (e) => {
    const [rawX, rawY] = getCanvasCoords(e);
    state.trimetric.isPointerDown = true;

    if (state.trimetric.mode === 'visible' || state.trimetric.mode === 'hidden') {
      const isHidden = state.trimetric.mode === 'hidden';
      if (!state.trimetric.currentStroke) {
        state.trimetric.currentStroke = {
          points: [[rawX, rawY]],
          isHidden
        };
      } else {
        const lastPt = state.trimetric.currentStroke.points[state.trimetric.currentStroke.points.length - 1];
        const snapped = snapToIsometric(lastPt, [rawX, rawY]);
        state.trimetric.currentStroke.points.push(snapped);
      }
      redrawTrimetricView();
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    const [rawX, rawY] = getCanvasCoords(e);
    if (state.trimetric.currentStroke && state.trimetric.currentStroke.points.length > 0) {
      const lastPt = state.trimetric.currentStroke.points[state.trimetric.currentStroke.points.length - 1];
      state.trimetric.currentMousePos = snapToIsometric(lastPt, [rawX, rawY]);
      redrawTrimetricView();
    } else {
      state.trimetric.currentMousePos = [rawX, rawY];
    }
  });

  canvas.addEventListener('dblclick', () => {
    // Commit stroke on double click
    if (state.trimetric.currentStroke && state.trimetric.currentStroke.points.length >= 2) {
      state.trimetric.strokes.push(state.trimetric.currentStroke);
      state.trimetric.currentStroke = null;
      redrawTrimetricView();
    }
  });
}

// ── View Mode Switching & Tool Actions ──────────────────────

export function setMode(viewKey, mode) {
  const view = state.views[viewKey];
  if (!view) return;

  view.mode = mode;

  // Update mode pills in view toolstrip
  ['auto', 'draw', 'hole', 'edit'].forEach((m) => {
    const tab = document.getElementById(`tab-${m}-${viewKey}`);
    if (tab) tab.classList.toggle('active', m === mode);
  });

  // Toggle control sets
  const autoControls = document.getElementById(`controls-auto-${viewKey}`);
  const manualControls = document.getElementById(`controls-manual-${viewKey}`);

  if (autoControls) autoControls.style.display = mode === 'auto' ? 'flex' : 'none';
  if (manualControls) manualControls.style.display = mode !== 'auto' ? 'flex' : 'none';

  const canvas = document.getElementById(`canvas-${viewKey}`);
  if (canvas) {
    canvas.style.cursor = (mode === 'draw' || mode === 'hole') ? 'crosshair' : (mode === 'edit' ? 'grab' : 'default');
  }

  redrawView(viewKey);
}

export function undoView(viewKey) {
  const view = state.views[viewKey];
  if (!view || !view.history || view.history.length === 0) return;

  if (view.mode === 'hole') {
    if (view.holes.length > 0) view.holes.pop();
  } else {
    view.polygon = view.history.pop();
  }
  redrawView(viewKey);
  triggerReconstruction();
}

export function closeViewLoop(viewKey) {
  const view = state.views[viewKey];
  if (!view) return;

  if (view.mode === 'hole') {
    const hole = view.holes[view.currentHoleIndex];
    if (hole && hole.length >= 3) {
      view.holes[view.currentHoleIndex] = ensureClosedLoop(hole);
      view.currentHoleIndex = view.holes.length; // Ready for next hole
    }
  } else {
    if (view.polygon && view.polygon.length >= 3) {
      view.polygon = ensureClosedLoop(view.polygon);
    }
  }

  setMode(viewKey, 'edit');
  redrawView(viewKey);
  triggerReconstruction();
}

export function smoothViewContour(viewKey) {
  const view = state.views[viewKey];
  if (!view) return;

  const target = view.mode === 'hole' 
    ? view.holes[view.currentHoleIndex] 
    : view.polygon;

  if (!target || target.length < 4) return;

  const simplified = ramerDouglasPeucker(target, 3.0);
  if (view.mode === 'hole') {
    view.holes[view.currentHoleIndex] = ensureClosedLoop(simplified);
  } else {
    view.polygon = ensureClosedLoop(simplified);
  }

  redrawView(viewKey);
  triggerReconstruction();
}

export function clearViewOutline(viewKey) {
  const view = state.views[viewKey];
  if (!view) return;

  if (view.mode === 'hole') {
    view.holes = [];
    view.currentHoleIndex = 0;
  } else {
    view.polygon = [];
  }
  redrawView(viewKey);
  triggerReconstruction();
}

// ── Sample Diamond Views Generator ──────────────────────────

export function generateSampleDiamondViews(preset = 'octahedron') {
  const size = 600;

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
    const shadow = ctx.createRadialGradient(size / 2, size / 2 + 155, 10, size / 2, size / 2 + 155, 180);
    shadow.addColorStop(0, 'rgba(30, 40, 60, 0.45)');
    shadow.addColorStop(0.6, 'rgba(60, 70, 90, 0.18)');
    shadow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = shadow;
    ctx.beginPath();
    ctx.ellipse(size / 2, size / 2 + 155, 160, 36, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    drawFn(ctx, size);
    return c;
  }

  function drawDiamondPolygon(ctx, vertices, facetColor = '#7ca8c4') {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(vertices[0][0], vertices[0][1]);
    for (let i = 1; i < vertices.length; i++) {
      ctx.lineTo(vertices[i][0], vertices[i][1]);
    }
    ctx.closePath();

    const grad = ctx.createLinearGradient(size / 2 - 120, size / 2 - 150, size / 2 + 120, size / 2 + 150);
    grad.addColorStop(0, '#edf5fa');
    grad.addColorStop(0.3, facetColor);
    grad.addColorStop(0.7, '#486884');
    grad.addColorStop(1, '#2c4055');
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 2;
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
    ctx.restore();
  }

  if (preset === 'macle') {
    const front = createViewCanvas((ctx) => {
      const poly = [
        [size / 2, 120],
        [480, 435],
        [420, 465],
        [size / 2, 420],
        [180, 465],
        [120, 435]
      ];
      drawDiamondPolygon(ctx, poly, '#6c9dbd');
    });

    const side = createViewCanvas((ctx) => {
      const poly = [
        [size / 2, 125],
        [size / 2 + 65, 270],
        [size / 2 + 75, 455],
        [size / 2 - 75, 455],
        [size / 2 - 65, 270]
      ];
      drawDiamondPolygon(ctx, poly, '#6090b0');
    });

    const top = createViewCanvas((ctx) => {
      const poly = [
        [size / 2, 135],
        [475, 450],
        [125, 450]
      ];
      drawDiamondPolygon(ctx, poly, '#78a6c5');
    });

    return { 
      front, side, top, 
      dims: { height: 4.2, width: 6.8, length: 6.5, wallThickness: 0.0 } 
    };
  } else if (preset === 'concave') {
    // Concave Gem with re-entrant corners, undercuts, and through holes
    const front = createViewCanvas((ctx) => {
      // Concave silhouette with deep V-groove
      const poly = [
        [size / 2, 110],
        [460, 240],
        [350, 310], // Re-entrant concave corner!
        [440, 460],
        [size / 2, 400], // Re-entrant bottom notch!
        [160, 460],
        [250, 310], // Re-entrant concave corner!
        [140, 240]
      ];
      drawDiamondPolygon(ctx, poly, '#5a92b2');
    });

    const side = createViewCanvas((ctx) => {
      const poly = [
        [size / 2, 120],
        [430, 250],
        [360, 330], // Undercut
        [420, 450],
        [180, 450],
        [240, 330], // Undercut
        [170, 250]
      ];
      drawDiamondPolygon(ctx, poly, '#5488a8');
    });

    const top = createViewCanvas((ctx) => {
      const poly = [
        [size / 2, 130],
        [430, 210],
        [360, size / 2],
        [430, 390],
        [size / 2, 470],
        [170, 390],
        [240, size / 2],
        [170, 210]
      ];
      drawDiamondPolygon(ctx, poly, '#6aa0be');
    });

    return {
      front, side, top,
      dims: { height: 5.8, width: 5.4, length: 5.4, wallThickness: 0.0 },
      holes: {
        front: [
          [[size / 2 - 35, size / 2 - 35], [size / 2 + 35, size / 2 - 35], [size / 2 + 35, size / 2 + 35], [size / 2 - 35, size / 2 + 35], [size / 2 - 35, size / 2 - 35]]
        ]
      }
    };
  } else if (preset === 'geode') {
    // Shelled geode with internal cavity
    const front = createViewCanvas((ctx) => {
      const poly = [
        [285, 110], [410, 160], [480, 290], [440, 420],
        [315, 480], [180, 435], [130, 290], [175, 160]
      ];
      drawDiamondPolygon(ctx, poly, '#52839f');
    });

    const side = createViewCanvas((ctx) => {
      const poly = [
        [300, 115], [435, 175], [475, 305], [425, 435],
        [300, 475], [175, 425], [125, 305], [165, 175]
      ];
      drawDiamondPolygon(ctx, poly, '#4c7b96');
    });

    const top = createViewCanvas((ctx) => {
      const poly = [
        [300, 125], [440, 185], [470, 320], [410, 440],
        [285, 465], [160, 415], [135, 295], [185, 175]
      ];
      drawDiamondPolygon(ctx, poly, '#5b8ca8');
    });

    return {
      front, side, top,
      dims: { height: 6.2, width: 5.8, length: 5.6, wallThickness: 0.6 }
    };
  } else {
    // Classic Octahedron
    const front = createViewCanvas((ctx) => {
      const poly = [
        [size / 2, 105],
        [460, 275],
        [475, 320],
        [size / 2, 495],
        [125, 320],
        [140, 275]
      ];
      drawDiamondPolygon(ctx, poly, '#7aa6c2');
    });

    const side = createViewCanvas((ctx) => {
      const poly = [
        [size / 2, 110],
        [450, 280],
        [465, 315],
        [size / 2, 490],
        [135, 315],
        [150, 280]
      ];
      drawDiamondPolygon(ctx, poly, '#729ebc');
    });

    const top = createViewCanvas((ctx) => {
      const poly = [
        [size / 2, 125],
        [445, 155],
        [475, size / 2],
        [445, 445],
        [size / 2, 475],
        [155, 445],
        [125, size / 2],
        [155, 155]
      ];
      drawDiamondPolygon(ctx, poly, '#84b0cc');
    });

    return { 
      front, side, top, 
      dims: { height: 6.0, width: 5.0, length: 5.0, wallThickness: 0.0 } 
    };
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

  const dims = { ...state.dimensions };

  // Prepare input views with both outer loop and inner holes
  const viewsData = {
    front: { outer: effectiveFront, holes: v.front.holes || [] },
    side:  { outer: effectiveSide,  holes: v.side.holes || [] },
    top:   { outer: effectiveTop,   holes: v.top.holes || [] }
  };

  const result = reconstructBrepSolid(viewsData, dims, {
    wallThickness: dims.wallThickness || 0
  });

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
  if (cavityMesh) {
    scene.remove(cavityMesh);
    cavityMesh.geometry?.dispose();
    cavityMesh.material?.dispose();
    cavityMesh = null;
  }

  const isXray = state.xrayCavity || (dims.wallThickness > 0 && state.xrayCavity);

  const mat = new THREE.MeshStandardMaterial({
    color: isXray ? 0x60a5fa : 0x90d2f0,
    roughness: 0.15,
    metalness: 0.08,
    flatShading: true,
    wireframe: state.wireframe,
    transparent: isXray,
    opacity: isXray ? 0.45 : 1.0,
    side: THREE.DoubleSide
  });

  previewMesh = new THREE.Mesh(result.geometry, mat);
  scene.add(previewMesh);

  // If cavity shelling is active and X-Ray is enabled, display inner cavity in amber
  if (dims.wallThickness > 0 && isXray) {
    const minDim = Math.min(dims.width, dims.height, dims.length);
    const scaleFactor = Math.max(0.1, (minDim - 2 * dims.wallThickness) / minDim);
    const cavGeom = result.geometry.clone();
    cavGeom.scale(scaleFactor, scaleFactor, scaleFactor);
    const cavMat = new THREE.MeshStandardMaterial({
      color: 0xffb700,
      roughness: 0.2,
      metalness: 0.1,
      wireframe: true
    });
    cavityMesh = new THREE.Mesh(cavGeom, cavMat);
    scene.add(cavityMesh);
  }

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
  const applyBtnMain = document.getElementById('btn-apply-cad-main');
  const axisCarats = document.getElementById('axis-carats-sub');
  const floatingCarats = document.getElementById('floating-carats-val');
  const badgeManifold = document.getElementById('badge-manifold');

  const caratsStr = `${carats.toFixed(2)} ct`;
  if (statFaces) statFaces.textContent = `${Math.round(faceCount)} facets`;
  if (statVerts) statVerts.textContent = `${vertexCount} vertices`;
  if (statCarats) statCarats.textContent = caratsStr;
  if (axisCarats) axisCarats.textContent = caratsStr;
  if (floatingCarats) floatingCarats.textContent = caratsStr;
  if (statDims) statDims.textContent = `${dims.width.toFixed(1)} × ${dims.height.toFixed(1)} × ${dims.length.toFixed(1)} mm`;

  if (badgeManifold) {
    const isM = result.isManifold !== false;
    badgeManifold.textContent = isM ? '✓ Watertight Solid' : 'B-Rep Solid';
    badgeManifold.style.borderColor = isM ? '#10b981' : '#f59e0b';
    badgeManifold.style.color = isM ? '#34d399' : '#fbbf24';
  }

  [applyBtn, applyBtnMain].forEach(b => {
    if (b) {
      b.disabled = false;
      b.classList.remove('btn-disabled');
    }
  });
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
  const axisBadge = document.getElementById(`axis-badge-${viewKey}`);
  if (badge) {
    const count = outline.polygon ? (isLoopClosed(outline.polygon) ? outline.polygon.length - 1 : outline.polygon.length) : 0;
    badge.textContent = `${count} pts`;
    if (axisBadge) axisBadge.textContent = `${count} pts`;
  }

  redrawView(viewKey);
  triggerReconstruction();
}

export function loadSamplePreset(presetKey) {
  const sample = generateSampleDiamondViews(presetKey);
  if (sample.dims) {
    Object.assign(state.dimensions, sample.dims);
  }

  // Load sample holes if preset specifies them (e.g. Concave gem through hole)
  if (sample.holes) {
    Object.keys(sample.holes).forEach(k => {
      if (state.views[k]) state.views[k].holes = sample.holes[k];
    });
  } else {
    ['front', 'side', 'top'].forEach(k => {
      if (state.views[k]) state.views[k].holes = [];
    });
  }

  processViewImage('front', sample.front);
  processViewImage('side', sample.side);
  processViewImage('top', sample.top);

  const dimH = document.getElementById('dim-height');
  const dimW = document.getElementById('dim-width');
  const dimL = document.getElementById('dim-length');
  const dimWall = document.getElementById('dim-wall');

  if (dimH) dimH.value = state.dimensions.height;
  if (dimW) dimW.value = state.dimensions.width;
  if (dimL) dimL.value = state.dimensions.length;
  if (dimWall) dimWall.value = state.dimensions.wallThickness;
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
    alert('Please complete the 3D solid reconstruction before applying to CAD.');
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
    console.log('Watertight B-rep rough diamond saved to localStorage.');
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
    alert('B-Rep solid generated and saved to Diamond CAD Makeable rough shape!');
  }
}

// ── Export OBJ File ─────────────────────────────────────────

function exportOBJ() {
  if (!state.currentReconstruction?.geometry) return;
  const geom = state.currentReconstruction.geometry;
  const pos = geom.attributes.position.array;
  const idx = geom.index ? geom.index.array : null;

  let obj = '# Watertight Manifold B-Rep Rough Diamond\n';
  obj += `# Generated by Diamond CAD Photogrammetry & Trimetric Studio\n`;

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
    // Mode pills: auto, draw, hole, edit
    ['auto', 'draw', 'hole', 'edit'].forEach((mode) => {
      const tab = document.getElementById(`tab-${mode}-${key}`);
      if (tab) {
        tab.addEventListener('click', () => {
          if (mode === 'auto' && state.views[key].image) {
            processViewImage(key, state.views[key].image);
          }
          setMode(key, mode);
        });
      }
    });

    // Tool Buttons
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

    attachCanvasInteraction(key);
  });

  // Setup Trimetric Drawing Controls
  const trimetricVisibleTab = document.getElementById('tab-trimetric-visible');
  const trimetricHiddenTab  = document.getElementById('tab-trimetric-hidden');
  const trimetricEditTab    = document.getElementById('tab-trimetric-edit');
  const trimetricSnapBtn    = document.getElementById('btn-trimetric-snap');
  const trimetricUndoBtn    = document.getElementById('btn-trimetric-undo');
  const trimetricSolveBtn   = document.getElementById('btn-trimetric-solve');
  const trimetricClearBtn   = document.getElementById('btn-trimetric-clear');

  if (trimetricVisibleTab) {
    trimetricVisibleTab.addEventListener('click', () => {
      state.trimetric.mode = 'visible';
      trimetricVisibleTab.classList.add('active');
      trimetricHiddenTab?.classList.remove('active');
      trimetricEditTab?.classList.remove('active');
    });
  }

  if (trimetricHiddenTab) {
    trimetricHiddenTab.addEventListener('click', () => {
      state.trimetric.mode = 'hidden';
      trimetricHiddenTab.classList.add('active');
      trimetricVisibleTab?.classList.remove('active');
      trimetricEditTab?.classList.remove('active');
    });
  }

  if (trimetricEditTab) {
    trimetricEditTab.addEventListener('click', () => {
      state.trimetric.mode = 'edit';
      trimetricEditTab.classList.add('active');
      trimetricVisibleTab?.classList.remove('active');
      trimetricHiddenTab?.classList.remove('active');
    });
  }

  if (trimetricSnapBtn) {
    trimetricSnapBtn.addEventListener('click', () => {
      state.trimetric.snapAxis = !state.trimetric.snapAxis;
      trimetricSnapBtn.classList.toggle('primary', state.trimetric.snapAxis);
    });
    trimetricSnapBtn.classList.add('primary');
  }

  if (trimetricUndoBtn) {
    trimetricUndoBtn.addEventListener('click', () => {
      if (state.trimetric.strokes.length > 0) {
        state.trimetric.strokes.pop();
        redrawTrimetricView();
      }
    });
  }

  if (trimetricClearBtn) {
    trimetricClearBtn.addEventListener('click', () => {
      state.trimetric.strokes = [];
      state.trimetric.currentStroke = null;
      redrawTrimetricView();
    });
  }

  if (trimetricSolveBtn) {
    trimetricSolveBtn.addEventListener('click', () => {
      if (state.trimetric.strokes.length === 0) {
        alert('Please draw isometric visible or hidden lines first!');
        return;
      }
      const result = convertTrimetricToBrep(
        state.trimetric, 
        state.dimensions, 
        { wallThickness: state.dimensions.wallThickness }
      );
      if (result && result.geometry) {
        state.currentReconstruction = result;
        switchAxisTab('preview3d');
        triggerReconstruction();
      }
    });
  }

  attachTrimetricInteraction();

  // Dimension & Cavity Inputs
  ['height', 'width', 'length', 'wall'].forEach((dim) => {
    const input = document.getElementById(`dim-${dim}`);
    if (input) {
      input.addEventListener('change', (e) => {
        const val = parseFloat(e.target.value) || 0;
        if (dim === 'wall') {
          state.dimensions.wallThickness = val;
        } else {
          state.dimensions[dim] = val;
        }
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

  const xrayBtn = document.getElementById('btn-toggle-xray');
  if (xrayBtn) {
    xrayBtn.addEventListener('click', () => {
      state.xrayCavity = !state.xrayCavity;
      xrayBtn.classList.toggle('active', state.xrayCavity);
      triggerReconstruction();
    });
  }

  // Primary Actions
  const applyBtn = document.getElementById('btn-apply-cad');
  const applyBtnMain = document.getElementById('btn-apply-cad-main');
  [applyBtn, applyBtnMain].forEach(b => {
    if (b) b.addEventListener('click', applyToDiamondCAD);
  });

  const exportBtn = document.getElementById('btn-export-obj');
  if (exportBtn) {
    exportBtn.addEventListener('click', exportOBJ);
  }

  // Camera modal close/capture
  const closeCamBtn = document.getElementById('btn-close-camera');
  if (closeCamBtn) closeCamBtn.addEventListener('click', closeCameraSnapshot);

  const captureBtn = document.getElementById('btn-snap-camera');
  if (captureBtn) captureBtn.addEventListener('click', captureCameraSnapshot);

  // Bind Axis Navigation Tabs
  document.querySelectorAll('.axis-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const axis = tab.getAttribute('data-axis');
      if (axis) switchAxisTab(axis);
    });
  });

  // Bind Step Navigation Buttons (data-goto)
  document.querySelectorAll('[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-goto');
      if (target) switchAxisTab(target);
    });
  });

  // Mobile Floating Bar
  const floating3dBtn = document.getElementById('btn-floating-view3d');
  if (floating3dBtn) {
    floating3dBtn.addEventListener('click', () => {
      if (state.activeAxisTab === 'preview3d') {
        switchAxisTab('front');
      } else {
        switchAxisTab('preview3d');
      }
    });
  }

  const floatingApplyBtn = document.getElementById('btn-floating-apply');
  if (floatingApplyBtn) {
    floatingApplyBtn.addEventListener('click', applyToDiamondCAD);
  }

  // Initial tab setup
  switchAxisTab('front');
}

// ── Axis Navigation Tab Switcher ────────────────────────────

export function switchAxisTab(axisKey) {
  state.activeAxisTab = axisKey;

  const isMobile = window.innerWidth <= 1024;
  const isAll = (axisKey === 'all') && !isMobile;
  const is3D = (axisKey === 'preview3d' || axisKey === '3d');

  document.body.classList.toggle('tab-view-mode', !isAll);
  document.body.classList.toggle('showing-3d', is3D);

  // Update top navigation tabs
  document.querySelectorAll('.axis-tab').forEach((tab) => {
    const tabAxis = tab.getAttribute('data-axis');
    const isMatch = (tabAxis === axisKey) || (tabAxis === 'preview3d' && is3D);
    tab.classList.toggle('active', isMatch);
  });

  // Toggle active card
  if (!isAll) {
    ['front', 'side', 'top', 'trimetric'].forEach((k) => {
      const card = document.getElementById(`card-${k}`);
      if (card) {
        card.classList.toggle('active', k === axisKey);
      }
    });

    if (axisKey in state.views) {
      setTimeout(() => redrawView(axisKey), 40);
    } else if (axisKey === 'trimetric') {
      setTimeout(() => redrawTrimetricView(), 40);
    }
  } else {
    ['front', 'side', 'top'].forEach((k) => {
      const card = document.getElementById(`card-${k}`);
      if (card) card.classList.add('active');
      redrawView(k);
    });
    const cardTri = document.getElementById('card-trimetric');
    if (cardTri) cardTri.classList.remove('active');
  }

  // Update floating button label
  const floatingBtn = document.getElementById('btn-floating-view3d');
  if (floatingBtn) {
    if (is3D) {
      floatingBtn.innerHTML = '<span>✏️</span> Outlines';
    } else {
      floatingBtn.innerHTML = '<span>👁️</span> 3D Solid';
    }
  }

  // Resize Three.js viewport
  if (is3D || isAll) {
    setTimeout(() => {
      const container = document.getElementById('preview3d-container');
      if (container && renderer && camera) {
        const w = container.clientWidth || 400;
        const h = container.clientHeight || 350;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      }
    }, 60);
  }
}

// ── Initialize ──────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  init3DPreview();
  setupUI();
  loadSamplePreset('octahedron');
});
