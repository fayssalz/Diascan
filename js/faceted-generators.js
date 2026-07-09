/* ============================================================
   faceted-generators.js — Procedural Polished Diamond Geometry
   Generates standard polished diamond cuts as revolution solids
   with accurate crown/pavilion proportions.
   
   Each generator returns { geometry: BufferGeometry, volume: number }
   Volume is in mm³ when dimensions are in mm.
   ============================================================ */

import * as THREE from 'three';

// ── Constants ──────────────────────────────────────────────

const DEG = Math.PI / 180;
const LATHE_SEGMENTS = 64;  // Revolution segments for smooth shapes

// ── Round Brilliant Generator ──────────────────────────────

/**
 * Generate a round brilliant cut diamond (revolution solid).
 * Uses standard GIA proportions by default.
 *
 * @param {Object} opts
 * @param {number} opts.diameter   - Girdle diameter in mm (default 6.5 ≈ 1ct)
 * @param {number} opts.tablePct   - Table diameter as % of girdle (default 57)
 * @param {number} opts.crownAngle - Crown angle in degrees (default 34.5)
 * @param {number} opts.pavAngle   - Pavilion angle in degrees (default 40.75)
 * @param {number} opts.girdlePct  - Girdle thickness as % of diameter (default 2.5)
 * @returns {{ geometry: THREE.BufferGeometry, volume: number }}
 */
export function generateRoundBrilliant(opts = {}) {
  const {
    diameter = 6.5,
    tablePct = 57,
    crownAngle = 34.5,
    pavAngle = 40.75,
    girdlePct = 2.5,
  } = opts;

  const r = diameter / 2;             // girdle radius
  const tableR = r * (tablePct / 100); // table radius
  const girdleH = diameter * (girdlePct / 100); // girdle thickness

  // Crown height from angle: tan(crownAngle) = crownHeight / (r - tableR)
  const crownH = (r - tableR) * Math.tan(crownAngle * DEG);

  // Pavilion depth from angle: tan(pavAngle) = pavDepth / r
  const pavDepth = r * Math.tan(pavAngle * DEG);

  // Culet is a tiny flat at the bottom (0.5% of diameter)
  const culetR = diameter * 0.005;

  // Build 2D profile (x = radius, y = height) from bottom to top
  // Y=0 is at the girdle plane
  const profile = [
    new THREE.Vector2(culetR,  -pavDepth),           // culet point (tiny flat)
    new THREE.Vector2(r,       -girdleH / 2),        // pavilion meets girdle (bottom)
    new THREE.Vector2(r,        girdleH / 2),         // girdle top
    new THREE.Vector2(tableR,   girdleH / 2 + crownH), // table edge
    new THREE.Vector2(0,        girdleH / 2 + crownH), // table center (axis)
  ];

  // We need the profile to go from axis outward — but LatheGeometry
  // revolves around Y axis with x = radius. The profile is traced
  // bottom-to-top.
  const geometry = new THREE.LatheGeometry(profile, LATHE_SEGMENTS);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  // Compute volume of the revolution solid
  const totalH = pavDepth + girdleH + crownH;
  const volume = computeLatheVolume(profile);

  return { geometry, volume };
}

// ── Princess Cut Generator ─────────────────────────────────

/**
 * Generate a princess cut diamond (square outline, brilliant faceting).
 *
 * @param {Object} opts
 * @param {number} opts.size       - Side length in mm (default 5.5)
 * @param {number} opts.crownAngle - Crown angle degrees (default 30)
 * @param {number} opts.pavAngle   - Pavilion angle degrees (default 42)
 * @param {number} opts.girdlePct  - Girdle thickness % (default 2.5)
 * @param {number} opts.tablePct   - Table % of side length (default 70)
 * @returns {{ geometry: THREE.BufferGeometry, volume: number }}
 */
export function generatePrincess(opts = {}) {
  const {
    size = 5.5,
    crownAngle = 30,
    pavAngle = 42,
    girdlePct = 2.5,
    tablePct = 70,
  } = opts;

  const half = size / 2;
  const girdleH = size * (girdlePct / 100);
  const tableHalf = half * (tablePct / 100);
  const crownH = (half - tableHalf) * Math.tan(crownAngle * DEG);
  const pavDepth = half * Math.tan(pavAngle * DEG);

  const vertices = [];
  const indices = [];

  // Princess cut is essentially a square pyramid (crown) +
  // inverted square pyramid (pavilion) with a girdle band.

  // Vertices:
  // 0-3: girdle bottom corners
  // 4-7: girdle top corners
  // 8-11: table corners
  // 12: table center (top)
  // 13: culet (bottom center)

  const gb = -girdleH / 2;  // girdle bottom Y
  const gt = girdleH / 2;    // girdle top Y
  const ty = gt + crownH;    // table Y
  const cy = gb - pavDepth;  // culet Y

  // Girdle bottom corners (CCW from top view)
  vertices.push(-half, gb, -half); // 0
  vertices.push( half, gb, -half); // 1
  vertices.push( half, gb,  half); // 2
  vertices.push(-half, gb,  half); // 3

  // Girdle top corners
  vertices.push(-half, gt, -half); // 4
  vertices.push( half, gt, -half); // 5
  vertices.push( half, gt,  half); // 6
  vertices.push(-half, gt,  half); // 7

  // Table corners
  vertices.push(-tableHalf, ty, -tableHalf); // 8
  vertices.push( tableHalf, ty, -tableHalf); // 9
  vertices.push( tableHalf, ty,  tableHalf); // 10
  vertices.push(-tableHalf, ty,  tableHalf); // 11

  // Culet (bottom point)
  vertices.push(0, cy, 0); // 12

  // --- Faces ---

  // Girdle sides (4 quads = 8 triangles)
  pushQuad(indices, 0, 1, 5, 4); // front
  pushQuad(indices, 1, 2, 6, 5); // right
  pushQuad(indices, 2, 3, 7, 6); // back
  pushQuad(indices, 3, 0, 4, 7); // left

  // Crown faces (4 triangles from girdle top to table + table quad)
  pushQuad(indices, 4, 5, 9, 8);   // front crown
  pushQuad(indices, 5, 6, 10, 9);  // right crown
  pushQuad(indices, 6, 7, 11, 10); // back crown
  pushQuad(indices, 7, 4, 8, 11);  // left crown

  // Table (2 triangles)
  indices.push(8, 9, 10);
  indices.push(8, 10, 11);

  // Pavilion (4 triangles from girdle bottom to culet)
  indices.push(12, 1, 0); // front
  indices.push(12, 2, 1); // right
  indices.push(12, 3, 2); // back
  indices.push(12, 0, 3); // left

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  // Volume = crown frustum + pavilion pyramid
  const volume = computeSquareFrustumVolume(half, tableHalf, crownH) +
                 computeSquarePyramidVolume(half, pavDepth) +
                 (size * size * girdleH); // girdle band

  return { geometry, volume };
}

// ── Emerald Cut Generator ──────────────────────────────────

/**
 * Generate an emerald cut (step-cut rectangular with clipped corners).
 *
 * @param {Object} opts
 * @param {number} opts.length     - Length in mm (default 7.0)
 * @param {number} opts.width      - Width in mm (default 5.0)
 * @param {number} opts.crownAngle - Crown angle degrees (default 30)
 * @param {number} opts.pavAngle   - Pavilion angle degrees (default 42)
 * @param {number} opts.girdlePct  - Girdle thickness % (default 2.5)
 * @param {number} opts.tablePct   - Table % (default 65)
 * @param {number} opts.cornerPct  - Corner clip as % of width (default 15)
 * @returns {{ geometry: THREE.BufferGeometry, volume: number }}
 */
export function generateEmerald(opts = {}) {
  const {
    length = 7.0,
    width = 5.0,
    crownAngle = 30,
    pavAngle = 42,
    girdlePct = 2.5,
    tablePct = 65,
    cornerPct = 15,
  } = opts;

  const hL = length / 2;
  const hW = width / 2;
  const corner = width * (cornerPct / 100);
  const girdleH = width * (girdlePct / 100);
  const tableScale = tablePct / 100;

  // Crown/pavilion heights from the shorter dimension
  const crownH = (hW * (1 - tableScale)) * Math.tan(crownAngle * DEG);
  const pavDepth = hW * Math.tan(pavAngle * DEG) * 0.7; // Emeralds have shallower pav

  const gb = -girdleH / 2;
  const gt = girdleH / 2;
  const ty = gt + crownH;
  const cy = gb - pavDepth;

  // Octagonal girdle outline (clipped corners)
  // Starting from top-right, going CCW
  const girdleOutline = [
    [hL - corner, hW],
    [hL, hW - corner],
    [hL, -(hW - corner)],
    [hL - corner, -hW],
    [-(hL - corner), -hW],
    [-hL, -(hW - corner)],
    [-hL, hW - corner],
    [-(hL - corner), hW],
  ];

  // Table outline (scaled down)
  const tableOutline = girdleOutline.map(([x, z]) => [x * tableScale, z * tableScale]);

  const vertices = [];
  const indices = [];
  let vi = 0;

  // Girdle bottom octagon (0-7)
  for (const [x, z] of girdleOutline) {
    vertices.push(x, gb, z);
  }
  vi += 8;

  // Girdle top octagon (8-15)
  for (const [x, z] of girdleOutline) {
    vertices.push(x, gt, z);
  }
  vi += 8;

  // Table octagon (16-23)
  for (const [x, z] of tableOutline) {
    vertices.push(x, ty, z);
  }
  vi += 8;

  // Culet point (24)
  vertices.push(0, cy, 0);
  vi += 1;

  // Girdle sides
  for (let i = 0; i < 8; i++) {
    const next = (i + 1) % 8;
    pushQuad(indices, i, next, 8 + next, 8 + i);
  }

  // Crown trapezoids
  for (let i = 0; i < 8; i++) {
    const next = (i + 1) % 8;
    pushQuad(indices, 8 + i, 8 + next, 16 + next, 16 + i);
  }

  // Table (fan from center) — we need a center vertex
  vertices.push(0, ty, 0); // 25
  for (let i = 0; i < 8; i++) {
    const next = (i + 1) % 8;
    indices.push(25, 16 + i, 16 + next);
  }

  // Pavilion (fan from culet)
  for (let i = 0; i < 8; i++) {
    const next = (i + 1) % 8;
    indices.push(24, next, i);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  // Approximate volume
  const girdleArea = approximateOctagonArea(girdleOutline);
  const tableArea = approximateOctagonArea(tableOutline);
  const volume = (girdleArea * girdleH) +
                 ((girdleArea + tableArea + Math.sqrt(girdleArea * tableArea)) / 3 * crownH) +
                 (girdleArea / 3 * pavDepth);

  return { geometry, volume };
}

// ── Cushion Cut Generator ──────────────────────────────────

/**
 * Generate a cushion cut (rounded-corner square brilliant).
 *
 * @param {Object} opts
 * @param {number} opts.size       - Side length in mm (default 6.0)
 * @param {number} opts.crownAngle - Crown angle degrees (default 33)
 * @param {number} opts.pavAngle   - Pavilion angle degrees (default 41)
 * @param {number} opts.girdlePct  - Girdle thickness % (default 2.5)
 * @param {number} opts.tablePct   - Table % (default 60)
 * @param {number} opts.cornerRadius - Corner rounding radius ratio (default 0.25)
 * @returns {{ geometry: THREE.BufferGeometry, volume: number }}
 */
export function generateCushion(opts = {}) {
  const {
    size = 6.0,
    crownAngle = 33,
    pavAngle = 41,
    girdlePct = 2.5,
    tablePct = 60,
    cornerRadius = 0.25,
  } = opts;

  const half = size / 2;
  const cr = half * cornerRadius;
  const girdleH = size * (girdlePct / 100);
  const tableScale = tablePct / 100;

  // Build rounded-square outline
  const segments = 8; // segments per corner
  const girdleOutline = buildRoundedSquare(half, cr, segments);
  const tableOutline = girdleOutline.map(([x, z]) => [x * tableScale, z * tableScale]);

  const gb = -girdleH / 2;
  const gt = girdleH / 2;
  const crownH = (half * (1 - tableScale)) * Math.tan(crownAngle * DEG);
  const pavDepth = half * Math.tan(pavAngle * DEG);
  const ty = gt + crownH;
  const cy = gb - pavDepth;

  const n = girdleOutline.length;
  const vertices = [];
  const indices = [];

  // Girdle bottom
  for (const [x, z] of girdleOutline) vertices.push(x, gb, z);
  // Girdle top
  for (const [x, z] of girdleOutline) vertices.push(x, gt, z);
  // Table
  for (const [x, z] of tableOutline) vertices.push(x, ty, z);
  // Culet
  vertices.push(0, cy, 0);
  const culetIdx = n * 3;
  // Table center
  vertices.push(0, ty, 0);
  const tableCenterIdx = n * 3 + 1;

  // Girdle sides
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    pushQuad(indices, i, next, n + next, n + i);
  }
  // Crown
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    pushQuad(indices, n + i, n + next, 2 * n + next, 2 * n + i);
  }
  // Table
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    indices.push(tableCenterIdx, 2 * n + i, 2 * n + next);
  }
  // Pavilion
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    indices.push(culetIdx, next, i);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const girdleArea = approximatePolygonArea(girdleOutline);
  const volume = girdleArea * (girdleH + crownH / 3 + pavDepth / 3);

  return { geometry, volume };
}

// ── Oval Cut Generator ─────────────────────────────────────

/**
 * Generate an oval brilliant cut diamond.
 *
 * @param {Object} opts
 * @param {number} opts.length     - Length in mm (default 8.0)
 * @param {number} opts.width      - Width in mm (default 5.5)
 * @param {number} opts.crownAngle - Crown angle degrees (default 33)
 * @param {number} opts.pavAngle   - Pavilion angle degrees (default 41)
 * @param {number} opts.girdlePct  - Girdle thickness % (default 2.5)
 * @param {number} opts.tablePct   - Table % (default 58)
 * @returns {{ geometry: THREE.BufferGeometry, volume: number }}
 */
export function generateOval(opts = {}) {
  const {
    length = 8.0,
    width = 5.5,
    crownAngle = 33,
    pavAngle = 41,
    girdlePct = 2.5,
    tablePct = 58,
  } = opts;

  const hL = length / 2;
  const hW = width / 2;
  const girdleH = width * (girdlePct / 100);
  const tableScale = tablePct / 100;
  const crownH = (hW * (1 - tableScale)) * Math.tan(crownAngle * DEG);
  const pavDepth = hW * Math.tan(pavAngle * DEG);

  const gb = -girdleH / 2;
  const gt = girdleH / 2;
  const ty = gt + crownH;
  const cy = gb - pavDepth;

  // Elliptical outline
  const segments = 48;
  const girdleOutline = [];
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    girdleOutline.push([hL * Math.cos(angle), hW * Math.sin(angle)]);
  }
  const tableOutline = girdleOutline.map(([x, z]) => [x * tableScale, z * tableScale]);

  const n = segments;
  const vertices = [];
  const indices = [];

  // Girdle bottom
  for (const [x, z] of girdleOutline) vertices.push(x, gb, z);
  // Girdle top
  for (const [x, z] of girdleOutline) vertices.push(x, gt, z);
  // Table
  for (const [x, z] of tableOutline) vertices.push(x, ty, z);
  // Culet
  vertices.push(0, cy, 0);
  const culetIdx = n * 3;
  // Table center
  vertices.push(0, ty, 0);
  const tableCenterIdx = n * 3 + 1;

  // Girdle sides
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    pushQuad(indices, i, next, n + next, n + i);
  }
  // Crown
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    pushQuad(indices, n + i, n + next, 2 * n + next, 2 * n + i);
  }
  // Table
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    indices.push(tableCenterIdx, 2 * n + i, 2 * n + next);
  }
  // Pavilion
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    indices.push(culetIdx, next, i);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const girdleArea = Math.PI * hL * hW;
  const volume = girdleArea * (girdleH + crownH / 3 + pavDepth / 3);

  return { geometry, volume };
}

// ── Pear Cut Generator ─────────────────────────────────────

/**
 * Generate a pear (teardrop) cut diamond.
 *
 * @param {Object} opts
 * @param {number} opts.length     - Length in mm (default 9.0)
 * @param {number} opts.width      - Width in mm (default 5.5)
 * @param {number} opts.crownAngle - Crown angle degrees (default 33)
 * @param {number} opts.pavAngle   - Pavilion angle degrees (default 41)
 * @param {number} opts.girdlePct  - Girdle thickness % (default 2.5)
 * @param {number} opts.tablePct   - Table % (default 56)
 * @returns {{ geometry: THREE.BufferGeometry, volume: number }}
 */
export function generatePear(opts = {}) {
  const {
    length = 9.0,
    width = 5.5,
    crownAngle = 33,
    pavAngle = 41,
    girdlePct = 2.5,
    tablePct = 56,
  } = opts;

  const hL = length / 2;
  const hW = width / 2;
  const girdleH = width * (girdlePct / 100);
  const tableScale = tablePct / 100;
  const crownH = (hW * (1 - tableScale)) * Math.tan(crownAngle * DEG);
  const pavDepth = hW * Math.tan(pavAngle * DEG);

  const gb = -girdleH / 2;
  const gt = girdleH / 2;
  const ty = gt + crownH;
  const cy = gb - pavDepth;

  // Pear outline: a teardrop shape
  // Uses a modified superellipse that tapers to a point at one end
  const segments = 48;
  const girdleOutline = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    // Parametric pear shape
    const taper = 0.5 + 0.5 * Math.cos(t); // 1 at top (point), 0 at bottom (round)
    const x = hL * Math.cos(t) * (0.3 + 0.7 * (1 - taper * 0.6));
    const z = hW * Math.sin(t) * (1 - taper * 0.3);
    girdleOutline.push([x, z]);
  }

  // Shift so the widest part is centered
  const tableOutline = girdleOutline.map(([x, z]) => [x * tableScale, z * tableScale]);

  const n = segments;
  const vertices = [];
  const indices = [];

  // Girdle bottom
  for (const [x, z] of girdleOutline) vertices.push(x, gb, z);
  // Girdle top
  for (const [x, z] of girdleOutline) vertices.push(x, gt, z);
  // Table
  for (const [x, z] of tableOutline) vertices.push(x, ty, z);
  // Culet
  vertices.push(0, cy, 0);
  const culetIdx = n * 3;
  // Table center
  vertices.push(0, ty, 0);
  const tableCenterIdx = n * 3 + 1;

  // Girdle sides
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    pushQuad(indices, i, next, n + next, n + i);
  }
  // Crown
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    pushQuad(indices, n + i, n + next, 2 * n + next, 2 * n + i);
  }
  // Table
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    indices.push(tableCenterIdx, 2 * n + i, 2 * n + next);
  }
  // Pavilion
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    indices.push(culetIdx, next, i);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const girdleArea = approximatePolygonArea(girdleOutline);
  const volume = girdleArea * (girdleH + crownH / 3 + pavDepth / 3);

  return { geometry, volume };
}


// ── Utility: Quad helper ───────────────────────────────────

function pushQuad(indices, a, b, c, d) {
  indices.push(a, b, c);
  indices.push(a, c, d);
}

// ── Utility: Rounded square outline ────────────────────────

function buildRoundedSquare(halfSize, cornerRadius, segmentsPerCorner) {
  const points = [];
  const straight = halfSize - cornerRadius;

  // Four corners: top-right, bottom-right, bottom-left, top-left
  const corners = [
    { cx: straight, cz: straight, startAngle: 0 },
    { cx: straight, cz: -straight, startAngle: -Math.PI / 2 },
    { cx: -straight, cz: -straight, startAngle: -Math.PI },
    { cx: -straight, cz: straight, startAngle: -3 * Math.PI / 2 },
  ];

  for (const { cx, cz, startAngle } of corners) {
    for (let i = 0; i <= segmentsPerCorner; i++) {
      const angle = startAngle + (i / segmentsPerCorner) * (Math.PI / 2);
      points.push([
        cx + cornerRadius * Math.cos(angle),
        cz + cornerRadius * Math.sin(angle),
      ]);
    }
  }

  return points;
}

// ── Utility: Polygon area (shoelace formula) ───────────────

function approximatePolygonArea(outline) {
  let area = 0;
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = outline[i];
    const [x2, y2] = outline[(i + 1) % n];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

function approximateOctagonArea(outline) {
  return approximatePolygonArea(outline);
}

// ── Utility: LatheGeometry volume (Pappus theorem) ─────────

/**
 * Compute volume of a solid of revolution from a 2D profile.
 * Uses the disk/washer method integrated along Y.
 */
function computeLatheVolume(profile) {
  let volume = 0;
  for (let i = 0; i < profile.length - 1; i++) {
    const r1 = profile[i].x;
    const y1 = profile[i].y;
    const r2 = profile[i + 1].x;
    const y2 = profile[i + 1].y;
    const dy = Math.abs(y2 - y1);
    if (dy < 1e-10) continue;
    // Volume of a conical frustum
    volume += (Math.PI * dy / 3) * (r1 * r1 + r1 * r2 + r2 * r2);
  }
  return volume;
}

// ── Utility: Simple volume calculations ────────────────────

function computeSquarePyramidVolume(baseHalf, height) {
  const baseArea = (2 * baseHalf) * (2 * baseHalf);
  return (baseArea * height) / 3;
}

function computeSquareFrustumVolume(bottomHalf, topHalf, height) {
  const a = (2 * bottomHalf) * (2 * bottomHalf);
  const b = (2 * topHalf) * (2 * topHalf);
  return (height / 3) * (a + b + Math.sqrt(a * b));
}

// ── Shape Registry ─────────────────────────────────────────

/**
 * Map of all available faceted shape generators.
 * Each entry: { name, icon, generator, defaultOpts }
 */
export const FACETED_SHAPES = {
  'round': {
    name: 'Round Brilliant',
    icon: '💎',
    generator: generateRoundBrilliant,
    defaultOpts: { diameter: 6.5, tablePct: 57, crownAngle: 34.5, pavAngle: 40.75, girdlePct: 2.5 },
  },
  'princess': {
    name: 'Princess',
    icon: '🔶',
    generator: generatePrincess,
    defaultOpts: { size: 5.5, crownAngle: 30, pavAngle: 42, girdlePct: 2.5, tablePct: 70 },
  },
  'emerald': {
    name: 'Emerald',
    icon: '⬜',
    generator: generateEmerald,
    defaultOpts: { length: 7.0, width: 5.0, crownAngle: 30, pavAngle: 42, girdlePct: 2.5, tablePct: 65, cornerPct: 15 },
  },
  'cushion': {
    name: 'Cushion',
    icon: '🔷',
    generator: generateCushion,
    defaultOpts: { size: 6.0, crownAngle: 33, pavAngle: 41, girdlePct: 2.5, tablePct: 60, cornerRadius: 0.25 },
  },
  'oval': {
    name: 'Oval',
    icon: '⚪',
    generator: generateOval,
    defaultOpts: { length: 8.0, width: 5.5, crownAngle: 33, pavAngle: 41, girdlePct: 2.5, tablePct: 58 },
  },
  'pear': {
    name: 'Pear',
    icon: '💧',
    generator: generatePear,
    defaultOpts: { length: 9.0, width: 5.5, crownAngle: 33, pavAngle: 41, girdlePct: 2.5, tablePct: 56 },
  },
};

/**
 * Generate a faceted shape by key.
 * @param {string} shapeKey - Key from FACETED_SHAPES
 * @param {Object} [opts] - Override options
 * @returns {{ geometry: THREE.BufferGeometry, volume: number }}
 */
export function generateFacetedShape(shapeKey, opts = {}) {
  const shape = FACETED_SHAPES[shapeKey];
  if (!shape) {
    console.warn(`Unknown faceted shape: ${shapeKey}, falling back to round`);
    return generateRoundBrilliant(opts);
  }
  const mergedOpts = { ...shape.defaultOpts, ...opts };
  return shape.generator(mergedOpts);
}
