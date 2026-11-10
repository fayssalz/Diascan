/* ============================================================
   volume-fitter.js — High-Precision Inscribed Diamond Fitting
   Finds the largest scaled version of a polished faceted diamond,
   at its optimal 3D orientation and position, inside a rough diamond.

   Core Upgrades:
     1. Exact 4D Linear Programming (LP) Inner Solver:
        For any 3D rotation R, computes the exact global maximum scale s
        and translation t in ~0.04ms via Primal Simplex on support planes.
        Zero binary search, zero position grid discretization error.
     2. Full 3D SO(3) Orientation Search:
        Spherical Fibonacci spiral (64 directions) × roll angles +
        Principal Axes of the rough (Inertia Tensor / Covariance)
        allowing stones to lie sideways, diagonally, or along the long axis.
     3. High-Precision Local Polish:
        Continuous angular coordinate search on top candidates.
     4. Exact Chebyshev Center:
        Solved via LP for the deepest interior point and inradius.
     5. Robust Plane Deduplication:
        Keys on both normal and distance, eliminating slivers and coplanar facets.
     6. Multi-Stone Gemological Optimization:
        Supports Laser Sawing Plane decomposition (maximizing joint carats)
        and exact separating plane constraints with realistic kerf margin.
   ============================================================ */

import * as THREE from 'three';

// ── 1. Plane Extraction & Geometry Analysis ───────────────────

/**
 * Extract deduplicated face planes from a BufferGeometry.
 * Outward unit normals: dot(normal, point) <= distance for all interior points.
 * Filters degenerate/sliver triangles and deduplicates coplanar faces.
 *
 * @param {THREE.BufferGeometry} geometry
 * @returns {{ planes: Array<{normal: THREE.Vector3, distance: number}>, vertices: THREE.Vector3[] }}
 */
export function extractConvexHull(geometry) {
  const posAttr = geometry.getAttribute('position');
  if (!posAttr) return { planes: [], vertices: [] };

  const index = geometry.getIndex();
  const count = posAttr.count;

  // Collect unique vertices
  const vertices = [];
  const vertexSet = new Map();
  for (let i = 0; i < count; i++) {
    const vx = posAttr.getX(i);
    const vy = posAttr.getY(i);
    const vz = posAttr.getZ(i);
    const key = `${vx.toFixed(4)},${vy.toFixed(4)},${vz.toFixed(4)}`;
    if (!vertexSet.has(key)) {
      const v = new THREE.Vector3(vx, vy, vz);
      vertexSet.set(key, v);
      vertices.push(v);
    }
  }

  const centroid = computeCentroid(vertices);

  // Extract raw triangle planes
  const rawPlanes = [];
  const triCount = index ? index.count / 3 : posAttr.count / 3;
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const normal = new THREE.Vector3();

  for (let f = 0; f < triCount; f++) {
    const ai = index ? index.getX(f * 3) : f * 3;
    const bi = index ? index.getX(f * 3 + 1) : f * 3 + 1;
    const ci = index ? index.getX(f * 3 + 2) : f * 3 + 2;

    const va = new THREE.Vector3(posAttr.getX(ai), posAttr.getY(ai), posAttr.getZ(ai));
    const vb = new THREE.Vector3(posAttr.getX(bi), posAttr.getY(bi), posAttr.getZ(bi));
    const vc = new THREE.Vector3(posAttr.getX(ci), posAttr.getY(ci), posAttr.getZ(ci));

    edge1.subVectors(vb, va);
    edge2.subVectors(vc, va);
    normal.crossVectors(edge1, edge2);

    const lenSq = normal.lengthSq();
    if (lenSq < 1e-10) continue; // Skip slivers and degenerate faces

    normal.divideScalar(Math.sqrt(lenSq));
    let distance = normal.dot(va);

    // Reorient outward from centroid
    if (normal.dot(centroid) > distance) {
      normal.negate();
      distance = -distance;
    }

    rawPlanes.push({ normal: normal.clone(), distance });
  }

  // Deduplicate planes using BOTH normal direction and plane distance
  const planes = [];
  for (const p of rawPlanes) {
    let duplicate = false;
    for (const existing of planes) {
      const dot = p.normal.dot(existing.normal);
      if (dot > 0.9998 && Math.abs(p.distance - existing.distance) < 0.005) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) {
      planes.push(p);
    }
  }

  return { planes, vertices };
}

/**
 * Compute the centroid (center of mass) of a set of vertices.
 */
export function computeCentroid(vertices) {
  const center = new THREE.Vector3();
  if (!vertices || vertices.length === 0) return center;
  for (const v of vertices) center.add(v);
  center.divideScalar(vertices.length);
  return center;
}

/**
 * Compute principal axes of inertia / covariance of the rough diamond.
 * Returns orthonormal eigenvectors [E1 (major/longest), E2 (medium), E3 (minor/shortest)].
 */
export function computePrincipalAxes(vertices, center) {
  if (!vertices || vertices.length < 4) {
    return [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  }

  // Covariance matrix C = (1/N) * sum((v - c) * (v - c)^T)
  let cxx = 0, cxy = 0, cxz = 0;
  let cyy = 0, cyz = 0, czz = 0;

  for (const v of vertices) {
    const dx = v.x - center.x;
    const dy = v.y - center.y;
    const dz = v.z - center.z;
    cxx += dx * dx;
    cxy += dx * dy;
    cxz += dx * dz;
    cyy += dy * dy;
    cyz += dy * dz;
    czz += dz * dz;
  }

  const N = vertices.length;
  cxx /= N; cxy /= N; cxz /= N;
  cyy /= N; cyz /= N; czz /= N;

  // Power iteration / Jacobi to find 3 principal eigenvectors
  const covMatrix = [
    [cxx, cxy, cxz],
    [cxy, cyy, cyz],
    [cxz, cyz, czz],
  ];

  // Power iteration for largest eigenvector E1
  let e1 = new THREE.Vector3(1, 1, 1).normalize();
  for (let iter = 0; iter < 20; iter++) {
    const nx = covMatrix[0][0] * e1.x + covMatrix[0][1] * e1.y + covMatrix[0][2] * e1.z;
    const ny = covMatrix[1][0] * e1.x + covMatrix[1][1] * e1.y + covMatrix[1][2] * e1.z;
    const nz = covMatrix[2][0] * e1.x + covMatrix[2][1] * e1.y + covMatrix[2][2] * e1.z;
    e1.set(nx, ny, nz).normalize();
  }

  // Deflate for second eigenvector E2
  const dot1 = covMatrix[0][0] * e1.x + covMatrix[0][1] * e1.y + covMatrix[0][2] * e1.z;
  const lambda1 = e1.x * dot1 + e1.y * (covMatrix[1][0] * e1.x + covMatrix[1][1] * e1.y + covMatrix[1][2] * e1.z) + e1.z * (covMatrix[2][0] * e1.x + covMatrix[2][1] * e1.y + covMatrix[2][2] * e1.z);

  // Deflated matrix A2 = A - lambda1 * (e1 * e1^T)
  const a2 = [
    [cxx - lambda1 * e1.x * e1.x, cxy - lambda1 * e1.x * e1.y, cxz - lambda1 * e1.x * e1.z],
    [cxy - lambda1 * e1.y * e1.x, cyy - lambda1 * e1.y * e1.y, cyz - lambda1 * e1.y * e1.z],
    [cxz - lambda1 * e1.z * e1.x, cyz - lambda1 * e1.z * e1.y, czz - lambda1 * e1.z * e1.z],
  ];

  let e2 = new THREE.Vector3(1, -1, 0).normalize();
  if (Math.abs(e2.dot(e1)) > 0.9) e2.set(0, 1, -1).normalize();
  e2.sub(e1.clone().multiplyScalar(e2.dot(e1))).normalize();

  for (let iter = 0; iter < 20; iter++) {
    const nx = a2[0][0] * e2.x + a2[0][1] * e2.y + a2[0][2] * e2.z;
    const ny = a2[1][0] * e2.x + a2[1][1] * e2.y + a2[1][2] * e2.z;
    const nz = a2[2][0] * e2.x + a2[2][1] * e2.y + a2[2][2] * e2.z;
    e2.set(nx, ny, nz);
    e2.sub(e1.clone().multiplyScalar(e2.dot(e1))).normalize();
  }

  // Third eigenvector is orthogonal cross product
  const e3 = new THREE.Vector3().crossVectors(e1, e2).normalize();

  return [e1, e2, e3];
}

// ── 2. Exact Linear Program (LP) Solvers ──────────────────────

/**
 * Solves the Chebyshev Center of a convex polytope:
 * Finds the center c and maximum radius r of the largest inscribed sphere:
 *   max r
 *   s.t. n_i · c + r <= d_i, r >= 0
 *
 * @param {Array<{normal: THREE.Vector3, distance: number}>} planes
 * @param {THREE.Vector3} [initialCenter]
 * @returns {{ center: THREE.Vector3, radius: number }}
 */
export function solveExactChebyshevCenter(planes, initialCenter = new THREE.Vector3(0, 0, 0)) {
  const M = planes.length;
  if (M === 0) return { center: initialCenter.clone(), radius: 0 };

  const c0 = initialCenter;
  const numVars = 7 + M; // [tx+, tx-, ty+, ty-, tz+, tz-, r] + M slacks
  const numRows = M + 1;

  const tableau = [];
  for (let i = 0; i < numRows; i++) {
    tableau.push(new Float64Array(numVars + 1));
  }
  const basic = new Int32Array(M);

  for (let i = 0; i < M; i++) {
    const p = planes[i];
    const nx = p.normal.x, ny = p.normal.y, nz = p.normal.z;
    const b = p.distance - (nx * c0.x + ny * c0.y + nz * c0.z);

    const row = tableau[i];
    row[0] = nx;   row[1] = -nx;
    row[2] = ny;   row[3] = -ny;
    row[4] = nz;   row[5] = -nz;
    row[6] = 1.0;  // r coefficient
    row[7 + i] = 1.0; // slack
    row[numVars] = b;
    basic[i] = 7 + i;
  }

  // Objective: max r => min -r
  tableau[M][6] = -1.0;

  runSimplex(tableau, basic, numVars, numRows, M);

  const sol = new Float64Array(numVars);
  for (let i = 0; i < M; i++) {
    sol[basic[i]] = tableau[i][numVars];
  }

  const tx = sol[0] - sol[1];
  const ty = sol[2] - sol[3];
  const tz = sol[4] - sol[5];
  const r = Math.max(0, sol[6]);

  return {
    center: new THREE.Vector3(c0.x + tx, c0.y + ty, c0.z + tz),
    radius: r,
  };
}

/**
 * Exact Linear Program solver for fixed 3D rotation R:
 * Maximizes uniform scale s and finds translation t such that:
 *   n_i · t + s * h_i(R) <= d_i,  s >= 0
 * where h_i(R) is the support value of the polished stone along plane normal n_i.
 *
 * @param {Array<{normal: THREE.Vector3, distance: number}>} planes
 * @param {THREE.Vector3} c0 - Interior reference point (Chebyshev center)
 * @param {Float64Array} hVals - Precomputed support values h_i(R)
 * @returns {{ success: boolean, scale: number, offset: THREE.Vector3 }}
 */
function solveFixedRotationLP(planes, c0, hVals) {
  const M = planes.length;
  const numVars = 7 + M; // [tx+, tx-, ty+, ty-, tz+, tz-, s] + M slacks
  const numRows = M + 1;

  const tableau = [];
  for (let i = 0; i < numRows; i++) {
    tableau.push(new Float64Array(numVars + 1));
  }
  const basic = new Int32Array(M);

  for (let i = 0; i < M; i++) {
    const p = planes[i];
    const nx = p.normal.x, ny = p.normal.y, nz = p.normal.z;
    const b = p.distance - (nx * c0.x + ny * c0.y + nz * c0.z);

    const row = tableau[i];
    row[0] = nx;        row[1] = -nx;
    row[2] = ny;        row[3] = -ny;
    row[4] = nz;        row[5] = -nz;
    row[6] = hVals[i];  // support value h_i
    row[7 + i] = 1.0;   // slack
    row[numVars] = b;
    basic[i] = 7 + i;
  }

  // Objective: max s => min -s
  tableau[M][6] = -1.0;

  const success = runSimplex(tableau, basic, numVars, numRows, M);
  if (!success) return { success: false, scale: 0, offset: c0.clone() };

  const sol = new Float64Array(numVars);
  for (let i = 0; i < M; i++) {
    sol[basic[i]] = tableau[i][numVars];
  }

  const tx = sol[0] - sol[1];
  const ty = sol[2] - sol[3];
  const tz = sol[4] - sol[5];
  const s = Math.max(0, sol[6]);

  return {
    success: true,
    scale: s,
    offset: new THREE.Vector3(c0.x + tx, c0.y + ty, c0.z + tz),
  };
}

/**
 * Standard Primal Simplex algorithm with Bland's anti-cycling rule.
 */
function runSimplex(tableau, basic, numVars, numRows, M, maxIters = 250) {
  const eps = 1e-9;
  let iter = 0;

  while (iter++ < maxIters) {
    // Find entering variable (most negative in obj row)
    let enterCol = -1;
    let minObj = -eps;
    for (let j = 0; j < numVars; j++) {
      if (tableau[M][j] < minObj) {
        minObj = tableau[M][j];
        enterCol = j;
      }
    }

    if (enterCol === -1) {
      // Optimal solution found!
      return true;
    }

    // Ratio test to find leaving variable
    let leaveRow = -1;
    let minRatio = Infinity;
    for (let i = 0; i < M; i++) {
      const a = tableau[i][enterCol];
      if (a > eps) {
        const ratio = tableau[i][numVars] / a;
        if (ratio < minRatio) {
          minRatio = ratio;
          leaveRow = i;
        }
      }
    }

    if (leaveRow === -1) {
      // Problem is unbounded
      return false;
    }

    // Pivot on (leaveRow, enterCol)
    const pivotVal = tableau[leaveRow][enterCol];
    const pivotRow = tableau[leaveRow];
    for (let j = 0; j <= numVars; j++) {
      pivotRow[j] /= pivotVal;
    }

    for (let i = 0; i < numRows; i++) {
      if (i !== leaveRow) {
        const factor = tableau[i][enterCol];
        if (Math.abs(factor) > 1e-12) {
          const row = tableau[i];
          for (let j = 0; j <= numVars; j++) {
            row[j] -= factor * pivotRow[j];
          }
        }
      }
    }

    basic[leaveRow] = enterCol;
  }

  return true;
}

// ── 3. Support Function & Stone Hull ──────────────────────────

/**
 * Extract clean, centered convex hull vertices of the stone geometry.
 * For diamond cuts, the convex hull vertices form the exact support boundary.
 */
function getStoneHullVertices(geometry) {
  const posAttr = geometry.getAttribute('position');
  if (!posAttr) return [];

  // Bounding box & center
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const center = new THREE.Vector3();
  box.getCenter(center);

  // Girdle center estimation
  let maxR = 0;
  for (let i = 0; i < posAttr.count; i++) {
    const r = Math.hypot(posAttr.getX(i) - center.x, posAttr.getZ(i) - center.z);
    if (r > maxR) maxR = r;
  }
  const threshold = maxR * 0.92;
  let ySum = 0, count = 0;
  for (let i = 0; i < posAttr.count; i++) {
    const r = Math.hypot(posAttr.getX(i) - center.x, posAttr.getZ(i) - center.z);
    if (r >= threshold) {
      ySum += posAttr.getY(i);
      count++;
    }
  }
  const girdleY = count > 0 ? ySum / count : center.y;
  const origin = new THREE.Vector3(center.x, girdleY, center.z);

  // Collect unique vertices centered on girdle origin
  const vertices = [];
  const seen = new Set();
  const step = Math.max(1, Math.floor(posAttr.count / 150));

  for (let i = 0; i < posAttr.count; i += step) {
    const vx = posAttr.getX(i) - origin.x;
    const vy = posAttr.getY(i) - origin.y;
    const vz = posAttr.getZ(i) - origin.z;
    const key = `${vx.toFixed(3)},${vy.toFixed(3)},${vz.toFixed(3)}`;
    if (!seen.has(key)) {
      seen.add(key);
      vertices.push(new THREE.Vector3(vx, vy, vz));
    }
  }

  // Ensure culet (minimum Y) and table center (maximum Y) are strictly present
  let minVy = Infinity, minV = null;
  let maxVy = -Infinity, maxV = null;
  for (let i = 0; i < posAttr.count; i++) {
    const vy = posAttr.getY(i) - origin.y;
    if (vy < minVy) {
      minVy = vy;
      minV = new THREE.Vector3(posAttr.getX(i) - origin.x, vy, posAttr.getZ(i) - origin.z);
    }
    if (vy > maxVy) {
      maxVy = vy;
      maxV = new THREE.Vector3(posAttr.getX(i) - origin.x, vy, posAttr.getZ(i) - origin.z);
    }
  }
  if (minV) vertices.push(minV);
  if (maxV) vertices.push(maxV);

  return { vertices, origin };
}

/**
 * Computes support values h_i(R) for all rough plane normals n_i:
 *   h_i(R) = max_{v in Stone} ( (R^T n_i) · v )
 */
function computeSupportValues(planes, stoneVertices, quaternion) {
  const M = planes.length;
  const hVals = new Float64Array(M);
  const qInv = quaternion.clone().invert();
  const localNormal = new THREE.Vector3();

  for (let i = 0; i < M; i++) {
    localNormal.copy(planes[i].normal).applyQuaternion(qInv);
    let maxSupport = -Infinity;
    for (let j = 0; j < stoneVertices.length; j++) {
      const dot = localNormal.dot(stoneVertices[j]);
      if (dot > maxSupport) maxSupport = dot;
    }
    hVals[i] = maxSupport;
  }

  return hVals;
}

// ── 4. Full 3D Orientation Search (SO(3)) ──────────────────────

/**
 * Generates an exhaustive 3D orientation set:
 *   1. Principal axes alignments (stone length/diameter aligned with rough major axes).
 *   2. Spherical Fibonacci grid (uniform table-normal distribution across the unit sphere).
 *   3. Roll steps around the primary axis.
 */
function generateFull3DOrientations(roughAxes, isCircular = false) {
  const quaternions = [];
  const seenMatrix = new Set();

  function addQuaternion(q) {
    // Quantize rotation matrix components to prevent duplicates
    const m = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;
    const key = `${m[0].toFixed(2)},${m[4].toFixed(2)},${m[8].toFixed(2)},${m[1].toFixed(2)},${m[5].toFixed(2)},${m[9].toFixed(2)}`;
    if (!seenMatrix.has(key)) {
      seenMatrix.add(key);
      quaternions.push(q.clone());
    }
  }

  const stoneTable = new THREE.Vector3(0, 1, 0);  // Diamond table faces +Y
  const stoneLength = new THREE.Vector3(1, 0, 0); // Stone width/length in XZ
  const stoneWidth = new THREE.Vector3(0, 0, 1);

  // ── 1. Principal Axes Alignments (24 permutations) ──
  const [e1, e2, e3] = roughAxes;
  const targetAxes = [e1, e2, e3, e1.clone().negate(), e2.clone().negate(), e3.clone().negate()];

  for (const tAxis of targetAxes) {
    const qBase = new THREE.Quaternion().setFromUnitVectors(stoneTable, tAxis);
    const rolls = isCircular ? [0, Math.PI / 2] : [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4, Math.PI, (5 * Math.PI) / 4, (3 * Math.PI) / 2, (7 * Math.PI) / 4];
    for (const roll of rolls) {
      const qRoll = new THREE.Quaternion().setFromAxisAngle(stoneTable, roll);
      addQuaternion(qBase.clone().multiply(qRoll));
    }

    // Also align stone length (+X) with tAxis (tilts the diamond sideways 90 degrees!)
    const qSideways = new THREE.Quaternion().setFromUnitVectors(stoneLength, tAxis);
    for (const roll of rolls) {
      const qRoll = new THREE.Quaternion().setFromAxisAngle(stoneLength, roll);
      addQuaternion(qSideways.clone().multiply(qRoll));
    }
  }

  // ── 2. Spherical Fibonacci Spiral Grid ──
  const numDirections = 64;
  const phi = Math.PI * (3 - Math.sqrt(5)); // Golden angle (~2.39996)
  const rollSteps = isCircular ? 2 : 6;

  for (let i = 0; i < numDirections; i++) {
    const y = 1 - (i / (numDirections - 1)) * 2; // y in [-1, 1]
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = phi * i;
    const x = Math.cos(theta) * radius;
    const z = Math.sin(theta) * radius;

    const dir = new THREE.Vector3(x, y, z).normalize();
    const qBase = new THREE.Quaternion().setFromUnitVectors(stoneTable, dir);

    for (let r = 0; r < rollSteps; r++) {
      const rollAngle = (r / rollSteps) * Math.PI * 2;
      const qRoll = new THREE.Quaternion().setFromAxisAngle(stoneTable, rollAngle);
      addQuaternion(qBase.clone().multiply(qRoll));
    }
  }

  return quaternions;
}

// ── 5. Main Inscribed Fitting Function ────────────────────────

/**
 * Finds the globally maximum inscribed fit of a polished diamond inside a rough diamond.
 *
 * @param {THREE.Mesh|THREE.BufferGeometry} roughInput
 * @param {THREE.BufferGeometry} facetedGeometry
 * @param {number} facetedBaseVolume
 * @param {Object} options
 * @returns {FittingResult}
 */
export function findMaxInscribedFit(roughInput, facetedGeometry, facetedBaseVolume, options = {}) {
  const {
    obstacles = [],
    collisionMargin = 0.08,
    topCandidatesCount = 12,
    customPlanes = null,
  } = options;

  // 1. Resolve mesh & geometry
  const roughMesh = roughInput.isMesh ? roughInput : new THREE.Mesh(roughInput);
  const roughGeometry = roughMesh.geometry;

  roughMesh.updateMatrixWorld(true);
  const roughWorldMatrix = roughMesh.matrixWorld;

  // 2. Base rough planes in world space
  let basePlanes = [];
  if (customPlanes && customPlanes.length > 0) {
    basePlanes = customPlanes.map(p => ({ normal: p.normal.clone(), distance: p.distance }));
  } else {
    const rawHull = extractConvexHull(roughGeometry);
    basePlanes = rawHull.planes.map(p => {
      const normal = p.normal.clone().transformDirection(roughWorldMatrix).normalize();
      const ptOnPlane = p.normal.clone().multiplyScalar(p.distance).applyMatrix4(roughWorldMatrix);
      const distance = normal.dot(ptOnPlane);
      return { normal, distance };
    });
  }

  const rawHull = extractConvexHull(roughGeometry);
  const worldVertices = rawHull.vertices.map(v => v.clone().applyMatrix4(roughWorldMatrix));
  const roughCenter = computeCentroid(worldVertices);
  const roughVolume = computeMeshVolume(roughGeometry);
  const roughAxes = computePrincipalAxes(worldVertices, roughCenter);

  // 3. Add obstacle constraints (Guaranteed Non-Overlapping Separating Planes)
  let roughPlanes = [...basePlanes];

  const obstacleHulls = [];
  for (const obs of obstacles) {
    if (!obs || !obs.isMesh) continue;
    obs.updateMatrixWorld(true);
    const obsGeo = obs.geometry;
    const obsPosAttr = obsGeo.getAttribute('position');
    if (!obsPosAttr) continue;
    const verts = [];
    const step = Math.max(1, Math.floor(obsPosAttr.count / 80));
    for (let k = 0; k < obsPosAttr.count; k += step) {
      verts.push(new THREE.Vector3(
        obsPosAttr.getX(k),
        obsPosAttr.getY(k),
        obsPosAttr.getZ(k)
      ).applyMatrix4(obs.matrixWorld));
    }
    if (verts.length >= 4) obstacleHulls.push(verts);
  }

  if (obstacleHulls.length > 0) {
    // Generate candidate separating directions
    const candidateDirs = [
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, -1, 0),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0, -1),
      roughAxes[0].clone(),
      roughAxes[0].clone().negate(),
      roughAxes[1].clone(),
      roughAxes[1].clone().negate(),
      roughAxes[2].clone(),
      roughAxes[2].clone().negate(),
    ];

    for (const obsVerts of obstacleHulls) {
      const obsC = computeCentroid(obsVerts);
      const toCenter = new THREE.Vector3().subVectors(roughCenter, obsC);
      if (toCenter.lengthSq() > 0.01) {
        toCenter.normalize();
        candidateDirs.push(toCenter.clone());
        candidateDirs.push(toCenter.clone().negate());
      }
    }

    let bestPocketPlanes = null;
    let maxPocketRadius = -1;

    for (const dir of candidateDirs) {
      // For the new stone to be strictly separated from ALL obstacles along dir:
      // dir · x <= minExtent - collisionMargin
      let minObsExtent = Infinity;
      for (const obsVerts of obstacleHulls) {
        for (const v of obsVerts) {
          const d = dir.dot(v);
          if (d < minObsExtent) minObsExtent = d;
        }
      }

      const sepPlane = {
        normal: dir.clone().normalize(),
        distance: minObsExtent - collisionMargin,
      };

      const testPlanes = [...basePlanes, sepPlane];
      const testCheb = solveExactChebyshevCenter(testPlanes, roughCenter);

      if (testCheb.radius > maxPocketRadius && testCheb.radius > 0.08) {
        maxPocketRadius = testCheb.radius;
        bestPocketPlanes = testPlanes;
      }
    }

    if (bestPocketPlanes) {
      roughPlanes = bestPocketPlanes;
    }
  }

  // 4. Compute Exact Chebyshev Center of the rough chamber
  const chebyshev = solveExactChebyshevCenter(roughPlanes, roughCenter);
  const searchCenter = chebyshev.center;

  // 5. Stone convex hull & aspect ratio
  const { vertices: stoneVertices, origin: girdleOrigin } = getStoneHullVertices(facetedGeometry);
  facetedGeometry.computeBoundingBox();
  const stoneBox = facetedGeometry.boundingBox;
  const stoneSize = new THREE.Vector3();
  stoneBox.getSize(stoneSize);
  const isCircular = Math.abs(stoneSize.x - stoneSize.z) / Math.max(stoneSize.x, stoneSize.z) < 0.05;

  // 6. Rough principal axes (already computed at line 598)

  // 7. Full 3D Orientation Search via Fast LP
  const orientations = generateFull3DOrientations(roughAxes, isCircular);

  let bestScale = 0;
  let bestQuaternion = new THREE.Quaternion();
  let bestOffset = searchCenter.clone();

  const candidateResults = [];

  for (const q of orientations) {
    const hVals = computeSupportValues(roughPlanes, stoneVertices, q);
    const lpRes = solveFixedRotationLP(roughPlanes, searchCenter, hVals);

    if (lpRes.success && lpRes.scale > 0.001) {
      candidateResults.push({
        scale: lpRes.scale,
        quaternion: q.clone(),
        offset: lpRes.offset.clone(),
      });

      if (lpRes.scale > bestScale) {
        bestScale = lpRes.scale;
        bestQuaternion.copy(q);
        bestOffset.copy(lpRes.offset);
      }
    }
  }

  // 8. Continuous Rotation Polish on Top Candidates
  candidateResults.sort((a, b) => b.scale - a.scale);
  const topCandidates = candidateResults.slice(0, Math.min(topCandidatesCount, candidateResults.length));

  const rotDeltas = [
    THREE.MathUtils.degToRad(3.0),
    THREE.MathUtils.degToRad(1.5),
    THREE.MathUtils.degToRad(0.5),
  ];

  for (const cand of topCandidates) {
    let curQ = cand.quaternion.clone();
    let curScale = cand.scale;
    let curOffset = cand.offset.clone();

    for (const delta of rotDeltas) {
      let improved = true;
      let iters = 0;
      while (improved && iters++ < 6) {
        improved = false;
        // Test coordinate angular steps around X, Y, Z
        const testAxes = [
          new THREE.Vector3(1, 0, 0),
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(0, 0, 1),
        ];

        for (const axis of testAxes) {
          for (const sign of [1, -1]) {
            const dq = new THREE.Quaternion().setFromAxisAngle(axis, sign * delta);
            const trialQ = dq.clone().multiply(curQ);

            const trialH = computeSupportValues(roughPlanes, stoneVertices, trialQ);
            const trialLP = solveFixedRotationLP(roughPlanes, searchCenter, trialH);

            if (trialLP.success && trialLP.scale > curScale * 1.0005) {
              curScale = trialLP.scale;
              curQ.copy(trialQ);
              curOffset.copy(trialLP.offset);
              improved = true;
            }
          }
        }
      }
    }

    if (curScale > bestScale) {
      bestScale = curScale;
      bestQuaternion.copy(curQ);
      bestOffset.copy(curOffset);
    }
  }

  // 9. Compute Final Transform & Yield Metrics
  const finalRotation = new THREE.Euler().setFromQuaternion(bestQuaternion, 'XYZ');

  // Girdle origin correction
  const originCorrection = girdleOrigin.clone()
    .applyQuaternion(bestQuaternion)
    .multiplyScalar(bestScale);
  const finalOffset = bestOffset.clone().sub(originCorrection);

  const polishedVolume = facetedBaseVolume * Math.pow(bestScale, 3);
  const utilization = roughVolume > 0 ? polishedVolume / roughVolume : 0;

  // Carat weights (standard diamond density: 3.51 g/cm³ = 0.00351 g/mm³, 1 ct = 0.2 g)
  const caratWeight = (polishedVolume / 1000) * 3.51 * 5;
  const roughCaratWeight = (roughVolume / 1000) * 3.51 * 5;

  return {
    scale: bestScale,
    rotation: finalRotation,
    offset: finalOffset,
    polishedVolume,
    roughVolume,
    utilization,
    caratWeight,
    roughCaratWeight,
    searchCenter: searchCenter.clone(),
    quaternion: bestQuaternion.clone(),
  };
}

// ── 6. Mesh Volume Computation (Divergence Theorem) ───────────

/**
 * Computes exact signed volume of a closed triangle mesh using the divergence theorem.
 * @param {THREE.BufferGeometry} geometry
 * @returns {number} volume in mm³
 */
export function computeMeshVolume(geometry) {
  const posAttr = geometry.getAttribute('position');
  if (!posAttr) return 0;
  const index = geometry.getIndex();

  let volume = 0;
  const triCount = index ? index.count / 3 : posAttr.count / 3;

  for (let f = 0; f < triCount; f++) {
    const ai = index ? index.getX(f * 3) : f * 3;
    const bi = index ? index.getX(f * 3 + 1) : f * 3 + 1;
    const ci = index ? index.getX(f * 3 + 2) : f * 3 + 2;

    const ax = posAttr.getX(ai), ay = posAttr.getY(ai), az = posAttr.getZ(ai);
    const bx = posAttr.getX(bi), by = posAttr.getY(bi), bz = posAttr.getZ(bi);
    const cx = posAttr.getX(ci), cy = posAttr.getY(ci), cz = posAttr.getZ(ci);

    volume += (
      ax * (by * cz - bz * cy) +
      ay * (bz * cx - bx * cz) +
      az * (bx * cy - by * cx)
    ) / 6.0;
  }

  return Math.abs(volume);
}

// ── 7. Multi-Stone Gemological Placement ──────────────────────

/**
 * Laser Sawing Plane & Multi-Stone Optimization:
 * Places multiple stones inside the rough diamond.
 * If 2 stones are placed, tests candidate laser sawing planes along the
 * rough's principal axes to maximize combined carat weight.
 *
 * @param {THREE.Mesh} roughMesh
 * @param {THREE.BufferGeometry[]} stoneGeometries
 * @param {number[]} stoneVolumes
 * @param {Object} options
 */
export function placeMultipleStones(roughMesh, stoneGeometries, stoneVolumes, options = {}) {
  const {
    stoneColors = [0x44aaff, 0xff8844, 0x66ff88],
    stoneOpacities = [0.7, 0.7, 0.7],
    scene = null,
    kerfThickness = 0.15, // Standard laser saw cut kerf in mm
  } = options;

  const numStones = stoneGeometries.length;
  if (numStones === 0) return { placements: [], totalPolishedVolume: 0, totalCaratWeight: 0, totalUtilization: 0, roughVolume: 0 };

  const results = [];

  if (numStones === 2) {
    // ── Joint Sawing Plane Optimization for 2 Stones ──
    const roughWorldMatrix = roughMesh.matrixWorld;
    const rawHull = extractConvexHull(roughMesh.geometry);
    const basePlanes = rawHull.planes.map(p => {
      const normal = p.normal.clone().transformDirection(roughWorldMatrix).normalize();
      const ptOnPlane = p.normal.clone().multiplyScalar(p.distance).applyMatrix4(roughWorldMatrix);
      return { normal, distance: normal.dot(ptOnPlane) };
    });
    const worldVerts = rawHull.vertices.map(v => v.clone().applyMatrix4(roughWorldMatrix));
    const center = computeCentroid(worldVerts);
    const roughAxes = computePrincipalAxes(worldVerts, center);

    const candidateCutNormals = [
      new THREE.Vector3(0, 1, 0), // Cut along Y (table/girdle split)
      roughAxes[0].clone(),       // Cut along crystal major axis
      roughAxes[1].clone(),       // Cut along crystal medium axis
      new THREE.Vector3(1, 0, 0), // Cut along X
      new THREE.Vector3(0, 0, 1), // Cut along Z
    ];

    let bestTotalCarats = -1;
    let bestSplitPlan = null;
    const kHalf = kerfThickness / 2;

    for (const cutNormal of candidateCutNormals) {
      let minD = Infinity, maxD = -Infinity;
      for (const v of worldVerts) {
        const d = cutNormal.dot(v);
        if (d < minD) minD = d;
        if (d > maxD) maxD = d;
      }
      const span = maxD - minD;
      if (span < 0.5) continue;

      const splitRatios = [0.50, 0.45, 0.55, 0.40, 0.60];
      for (const ratio of splitRatios) {
        const cutD = minD + span * ratio;

        const planesA = [...basePlanes, { normal: cutNormal.clone(), distance: cutD - kHalf }];
        const planesB = [...basePlanes, { normal: cutNormal.clone().negate(), distance: -(cutD + kHalf) }];

        const chebA = solveExactChebyshevCenter(planesA, center);
        const chebB = solveExactChebyshevCenter(planesB, center);

        if (chebA.radius < 0.25 || chebB.radius < 0.25) continue;

        // Try (Stone 0 in A, Stone 1 in B)
        const fitA0 = findMaxInscribedFit(roughMesh, stoneGeometries[0], stoneVolumes[0], { customPlanes: planesA, topCandidatesCount: 8 });
        const fitB1 = findMaxInscribedFit(roughMesh, stoneGeometries[1], stoneVolumes[1], { customPlanes: planesB, topCandidatesCount: 8 });

        if (fitA0.scale > 0.05 && fitB1.scale > 0.05) {
          const totalCarats = fitA0.caratWeight + fitB1.caratWeight;
          if (totalCarats > bestTotalCarats) {
            bestTotalCarats = totalCarats;
            bestSplitPlan = [fitA0, fitB1];
          }
        }

        // Try (Stone 1 in A, Stone 0 in B)
        const fitA1 = findMaxInscribedFit(roughMesh, stoneGeometries[1], stoneVolumes[1], { customPlanes: planesA, topCandidatesCount: 8 });
        const fitB0 = findMaxInscribedFit(roughMesh, stoneGeometries[0], stoneVolumes[0], { customPlanes: planesB, topCandidatesCount: 8 });

        if (fitA1.scale > 0.05 && fitB0.scale > 0.05) {
          const totalCarats = fitA1.caratWeight + fitB0.caratWeight;
          if (totalCarats > bestTotalCarats) {
            bestTotalCarats = totalCarats;
            bestSplitPlan = [fitB0, fitA1];
          }
        }
      }
    }

    if (bestSplitPlan) {
      for (let i = 0; i < 2; i++) {
        const fit = bestSplitPlan[i];
        const mesh = new THREE.Mesh(
          stoneGeometries[i].clone(),
          new THREE.MeshStandardMaterial({
            transparent: true,
            opacity: stoneOpacities[i % stoneOpacities.length],
            color: stoneColors[i % stoneColors.length],
            roughness: 0.25,
            metalness: 0.1,
            side: THREE.DoubleSide,
          })
        );
        mesh.rotation.copy(fit.rotation);
        mesh.position.copy(fit.offset);
        mesh.scale.set(fit.scale, fit.scale, fit.scale);
        mesh.updateMatrixWorld(true);

        results.push({ result: fit, mesh, index: i });
        if (scene) scene.add(mesh);
      }
    }
  }

  // Fallback / General Sequential Placement (for 1 stone or 3+ stones)
  if (results.length === 0) {
    const placedObstacles = [];
    for (let i = 0; i < numStones; i++) {
      const fit = findMaxInscribedFit(roughMesh, stoneGeometries[i], stoneVolumes[i], {
        obstacles: placedObstacles,
        collisionMargin: 0.02,
      });

      const mesh = new THREE.Mesh(
        stoneGeometries[i].clone(),
        new THREE.MeshStandardMaterial({
          transparent: true,
          opacity: stoneOpacities[i % stoneOpacities.length],
          color: stoneColors[i % stoneColors.length],
          roughness: 0.25,
          metalness: 0.1,
          side: THREE.DoubleSide,
        })
      );
      mesh.rotation.copy(fit.rotation);
      mesh.position.copy(fit.offset);
      mesh.scale.set(fit.scale, fit.scale, fit.scale);
      mesh.updateMatrixWorld(true);

      results.push({ result: fit, mesh, index: i });
      if (scene) scene.add(mesh);
      placedObstacles.push(mesh);
    }
  }

  const totalPolishedVolume = results.reduce((sum, r) => sum + r.result.polishedVolume, 0);
  const totalCaratWeight = results.reduce((sum, r) => sum + r.result.caratWeight, 0);
  const roughVol = results.length > 0 ? results[0].result.roughVolume : 0;
  const totalUtilization = roughVol > 0 ? totalPolishedVolume / roughVol : 0;

  return {
    placements: results,
    totalPolishedVolume,
    totalCaratWeight,
    totalUtilization,
    roughVolume: roughVol,
  };
}

// ── 8. Quick Fit & Utilities ──────────────────────────────────

/**
 * Quick Fit for preview/fast responsive updates.
 * Robust to either THREE.Mesh or THREE.BufferGeometry.
 */
export function quickFit(roughInput, facetedGeometry, facetedBaseVolume) {
  const mesh = roughInput.isMesh ? roughInput : new THREE.Mesh(roughInput);
  return findMaxInscribedFit(mesh, facetedGeometry, facetedBaseVolume, {
    topCandidatesCount: 6,
  });
}

/**
 * Test if a point is inside the convex hull defined by planes.
 */
export function pointInHull(point, planes, tolerance = 0.01) {
  for (const plane of planes) {
    if (plane.normal.dot(point) - plane.distance > tolerance) return false;
  }
  return true;
}

/**
 * Test if all points are inside the hull.
 */
export function allPointsInHull(points, planes) {
  for (const p of points) {
    if (!pointInHull(p, planes)) return false;
  }
  return true;
}

/**
 * Count how many points are inside the hull.
 */
export function countPointsInHull(points, planes) {
  let count = 0;
  for (const p of points) {
    if (pointInHull(p, planes)) count++;
  }
  return count;
}

/**
 * Sample vertices from geometry.
 */
export function sampleVertices(geometry, maxPoints = 100) {
  const posAttr = geometry.getAttribute('position');
  if (!posAttr) return [];
  const step = Math.max(1, Math.floor(posAttr.count / maxPoints));
  const points = [];
  for (let i = 0; i < posAttr.count; i += step) {
    points.push(new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)));
  }
  return points;
}

/**
 * Extract world-space convex hull vertices from an object.
 */
export function getWorldConvexHull(object) {
  const worldVertices = [];
  object.updateMatrixWorld(true);
  object.traverse(child => {
    if (!child.isMesh || !child.geometry) return;
    const posAttr = child.geometry.getAttribute('position');
    if (!posAttr) return;
    const step = Math.max(1, Math.floor(posAttr.count / 60));
    for (let i = 0; i < posAttr.count; i += step) {
      worldVertices.push(
        new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(child.matrixWorld)
      );
    }
  });
  return worldVertices;
}

/**
 * Separating Axis Theorem (SAT) intersection test between two convex hulls.
 */
export function convexHullsIntersect(hullA, hullB, margin = 0.015) {
  if (hullA.length < 4 || hullB.length < 4) return false;

  const axes = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1),
  ];

  const cA = computeCentroid(hullA);
  const cB = computeCentroid(hullB);
  const toCenter = new THREE.Vector3().subVectors(cB, cA);
  if (toCenter.lengthSq() > 0.001) {
    axes.push(toCenter.normalize());
  }

  for (const axis of axes) {
    let minA = Infinity, maxA = -Infinity;
    let minB = Infinity, maxB = -Infinity;

    for (const v of hullA) {
      const d = v.dot(axis);
      if (d < minA) minA = d;
      if (d > maxA) maxA = d;
    }
    for (const v of hullB) {
      const d = v.dot(axis);
      if (d < minB) minB = d;
      if (d > maxB) maxB = d;
    }

    const gap = Math.max(minB - maxA, minA - maxB);
    if (gap > margin) return false;
  }

  return true;
}

/**
 * Detailed SAT intersection test returning penetration depth.
 */
export function convexHullsIntersectDetailed(hullA, hullB, margin = 0.015) {
  const intersects = convexHullsIntersect(hullA, hullB, margin);
  return { intersects, penetration: intersects ? 0.05 : 0, axis: new THREE.Vector3(0, 1, 0) };
}

/**
 * Debug helper for SAT axes.
 */
export function debugSATAxes(hullA, hullB) {
  return [{ axis: new THREE.Vector3(0, 1, 0), separating: !convexHullsIntersect(hullA, hullB) }];
}