/* ============================================================
   volume-fitter.js — Automatic Inscribed Shape Fitting
   Finds the largest scaled version of a faceted shape, at its
   best rotation and position, that fits entirely inside the
   rough diamond volume. Shape-agnostic: makes no assumption
   about the rough's symmetry (works for octahedra, macles,
   boart, or irregular boules alike).

   Algorithm: Convex hull extraction → point-in-hull test →
   binary search on scale, wrapped in a coarse-to-fine 6D
   (3 rotation + 3 position) search:
     1. Chebyshev-center approximation for a generic, shape-
        agnostic starting position (deepest interior point).
     2. Coarse orientation ranking (full Y sweep × X/Z flips ×
        tilt jitter) at low precision.
     3. 3D position grid search for the surviving orientations.
     4. Local coordinate pattern search (Hooke–Jeeves style) to
        jointly polish rotation + position at full precision.

   Collision: SAT (Separating Axis Theorem) on convex hulls
   for accurate overlap prevention between placed shapes.

   Multi-stone: Anti-centroid positioning ensures subsequent
   stones search in the remaining free space. Flip orientations
   (180° on X/Z) allow stones to nest in opposite halves.
   ============================================================ */

import * as THREE from 'three';

// ── Convex Hull Representation ─────────────────────────────

/**
 * Extract face planes from a convex BufferGeometry.
 * Each plane is defined by a normal and distance from origin.
 * A point is "inside" if dot(normal, point) <= distance for ALL planes.
 *
 * IMPORTANT: After extraction, all normals are re-oriented to point
 * OUTWARD from the hull centroid. This ensures correctness regardless
 * of face winding order in the source geometry.
 *
 * @param {THREE.BufferGeometry} geometry - Must be convex
 * @returns {{ planes: Array<{normal: THREE.Vector3, distance: number}>, vertices: THREE.Vector3[] }}
 */
export function extractConvexHull(geometry) {
  const posAttr = geometry.getAttribute('position');
  const index = geometry.getIndex();

  // Collect unique vertices
  const vertices = [];
  for (let i = 0; i < posAttr.count; i++) {
    vertices.push(new THREE.Vector3(
      posAttr.getX(i),
      posAttr.getY(i),
      posAttr.getZ(i)
    ));
  }

  // Compute centroid for normal orientation check
  const centroid = computeCentroid(vertices);

  // Extract face normals and distances
  const planes = [];
  const seenNormals = new Set();

  const triCount = index ? index.count / 3 : posAttr.count / 3;

  for (let f = 0; f < triCount; f++) {
    let a, b, c;
    if (index) {
      a = index.getX(f * 3);
      b = index.getX(f * 3 + 1);
      c = index.getX(f * 3 + 2);
    } else {
      a = f * 3;
      b = f * 3 + 1;
      c = f * 3 + 2;
    }

    const va = vertices[a];
    const vb = vertices[b];
    const vc = vertices[c];

    const edge1 = new THREE.Vector3().subVectors(vb, va);
    const edge2 = new THREE.Vector3().subVectors(vc, va);
    const normal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();

    if (normal.length() < 0.001) continue; // Degenerate triangle

    // Quantize normal to avoid duplicate planes
    const key = `${normal.x.toFixed(4)},${normal.y.toFixed(4)},${normal.z.toFixed(4)}`;
    if (seenNormals.has(key)) continue;
    seenNormals.add(key);

    let distance = normal.dot(va);

    // ── FIX: Ensure normal points OUTWARD from centroid ──
    // The centroid must be on the "inside" of each plane.
    // If dot(normal, centroid) > distance, the normal points inward → flip it.
    const centroidDot = normal.dot(centroid);
    if (centroidDot > distance) {
      normal.negate();
      distance = -distance;
    }

    planes.push({ normal: normal.clone(), distance });
  }

  return { planes, vertices };
}

/**
 * Compute the center of mass of a set of vertices.
 */
function computeCentroid(vertices) {
  const center = new THREE.Vector3();
  for (const v of vertices) center.add(v);
  center.divideScalar(vertices.length);
  return center;
}

// ── Point-in-Hull Test ─────────────────────────────────────

/**
 * Test if a single point is inside a convex hull defined by planes.
 * @param {THREE.Vector3} point
 * @param {Array<{normal: THREE.Vector3, distance: number}>} planes
 * @param {number} [tolerance=0.01] - Small tolerance for edge cases
 * @returns {boolean}
 */
export function pointInHull(point, planes, tolerance = 0.01) {
  for (const plane of planes) {
    const d = plane.normal.dot(point) - plane.distance;
    if (d > tolerance) return false;
  }
  return true;
}

/**
 * Test if ALL points are inside the hull.
 * @param {THREE.Vector3[]} points
 * @param {Array<{normal: THREE.Vector3, distance: number}>} planes
 * @returns {boolean}
 */
export function allPointsInHull(points, planes) {
  for (const point of points) {
    if (!pointInHull(point, planes)) return false;
  }
  return true;
}

/**
 * Count how many points are inside the hull.
 * Useful for partial-fit metrics.
 */
export function countPointsInHull(points, planes) {
  let count = 0;
  for (const point of points) {
    if (pointInHull(point, planes)) count++;
  }
  return count;
}

// ── Vertex Sampling ────────────────────────────────────────

/**
 * Sample vertices from a geometry for containment testing.
 * Uses every Nth vertex for even coverage across the mesh.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {number} [maxPoints=100]
 * @returns {THREE.Vector3[]}
 */
export function sampleVertices(geometry, maxPoints = 100) {
  const posAttr = geometry.getAttribute('position');
  const totalVerts = posAttr.count;
  const step = Math.max(1, Math.floor(totalVerts / maxPoints));

  const points = [];
  for (let i = 0; i < totalVerts; i += step) {
    points.push(new THREE.Vector3(
      posAttr.getX(i),
      posAttr.getY(i),
      posAttr.getZ(i)
    ));
  }

  return points;
}

// ── SAT Collision Detection ────────────────────────────────

/**
 * Extract convex hull vertices from a mesh and transform to world space.
 * Returns an array of THREE.Vector3 in world coordinates.
 *
 * @param {THREE.Object3D} object - The mesh or group to extract from
 * @returns {THREE.Vector3[]}
 */
export function getWorldConvexHull(object) {
  const worldVertices = [];

  object.updateMatrixWorld(true);

  object.traverse(child => {
    if (!child.isMesh) return;

    const geo = child.geometry;
    const posAttr = geo.getAttribute('position');
    if (!posAttr) return;

    const worldMatrix = child.matrixWorld;
    const count = posAttr.count;
    const step = Math.max(1, Math.floor(count / 60));

    for (let i = 0; i < count; i += step) {
      const v = new THREE.Vector3(
        posAttr.getX(i),
        posAttr.getY(i),
        posAttr.getZ(i)
      ).applyMatrix4(worldMatrix);
      worldVertices.push(v);
    }
  });

  return worldVertices;
}

/**
 * Project an array of vertices onto a given axis and return the [min, max] interval.
 *
 * @param {THREE.Vector3[]} vertices
 * @param {THREE.Vector3} axis - Must be normalized
 * @returns {{min: number, max: number}}
 */
function projectOntoAxis(vertices, axis) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of vertices) {
    const d = v.dot(axis);
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return { min, max };
}

/**
 * Test if two convex hulls (given as arrays of world-space vertices) intersect,
 * using the Separating Axis Theorem (SAT).
 *
 * ── FIXED: Corrected the inverted interval logic boundary checking.
 *
 * @param {THREE.Vector3[]} hullA - World-space vertices of hull A
 * @param {THREE.Vector3[]} hullB - World-space vertices of hull B
 * @param {number} [margin=0.015] - Separation margin (small gap to prevent touching)
 * @returns {boolean} true if the hulls intersect (overlap)
 */
export function convexHullsIntersect(hullA, hullB, margin = 0.015) {
  if (hullA.length < 4 || hullB.length < 4) return false;

  const axes = [];
  const normalsA = getHullFaceNormals(hullA);
  const normalsB = getHullFaceNormals(hullB);
  axes.push(...normalsA, ...normalsB);

  const edgesA = getHullEdges(hullA, 12);
  const edgesB = getHullEdges(hullB, 12);

  for (const eA of edgesA) {
    for (const eB of edgesB) {
      const cross = new THREE.Vector3().crossVectors(eA, eB);
      if (cross.lengthSq() > 1e-8) {
        axes.push(cross.normalize());
      }
    }
  }

  // SAT: if ANY axis separates the two hulls, they don't intersect
  for (const axis of axes) {
    if (axis.lengthSq() < 1e-10) continue; 
    
    const projA = projectOntoAxis(hullA, axis);
    const projB = projectOntoAxis(hullB, axis);

    // Calculate actual separation intervals along the axis
    const gapA = projB.min - projA.max;
    const gapB = projA.min - projB.max;
    const actualGap = Math.max(gapA, gapB);
    
    // Found a valid separating axis where the gap is larger than the margin boundary
    if (actualGap > margin) {
      return false; 
    }
  }

  return true; // No separating axis found → hulls intersect
}

/**
 * Enhanced version of convexHullsIntersect that also returns the penetration depth
 */
export function convexHullsIntersectDetailed(hullA, hullB, margin = 0.015) {
  if (hullA.length < 4 || hullB.length < 4) {
    return { intersects: false, penetration: 0, axis: null };
  }

  const axes = [];
  const normalsA = getHullFaceNormals(hullA);
  const normalsB = getHullFaceNormals(hullB);
  axes.push(...normalsA, ...normalsB);

  const edgesA = getHullEdges(hullA, 12);
  const edgesB = getHullEdges(hullB, 12);

  for (const eA of edgesA) {
    for (const eB of edgesB) {
      const cross = new THREE.Vector3().crossVectors(eA, eB);
      if (cross.lengthSq() > 1e-8) {
        axes.push(cross.normalize());
      }
    }
  }

  let minPenetration = Infinity;
  let minAxis = null;

  for (const axis of axes) {
    if (axis.lengthSq() < 1e-10) continue;
    
    const projA = projectOntoAxis(hullA, axis);
    const projB = projectOntoAxis(hullB, axis);

    const gapA = projB.min - projA.max;
    const gapB = projA.min - projB.max;
    const actualGap = Math.max(gapA, gapB);
    
    if (actualGap > margin) {
      return { intersects: false, penetration: 0, axis: null };
    }
    
    // Penetration depth represents the overlap breach depth below the margin boundary
    const penetration = margin - actualGap;
    if (penetration < minPenetration) {
      minPenetration = penetration;
      minAxis = axis.clone();
    }
  }

  return { 
    intersects: true, 
    penetration: minPenetration === Infinity ? 0 : minPenetration,
    axis: minAxis 
  };
}

/**
 * Extract approximate face normals from a convex hull point cloud.
 */
function getHullFaceNormals(vertices) {
  const normals = [];
  const centroid = computeCentroid(vertices);
  const n = vertices.length;

  normals.push(new THREE.Vector3(1, 0, 0));
  normals.push(new THREE.Vector3(0, 1, 0));
  normals.push(new THREE.Vector3(0, 0, 1));

  const step = Math.max(1, Math.floor(n / 20));
  for (let i = 0; i < n; i += step) {
    for (let j = i + 1; j < n; j += step) {
      for (let k = j + 1; k < n; k += step) {
        const va = vertices[i];
        const vb = vertices[j];
        const vc = vertices[k];

        const edge1 = new THREE.Vector3().subVectors(vb, va);
        const edge2 = new THREE.Vector3().subVectors(vc, va);
        const normal = new THREE.Vector3().crossVectors(edge1, edge2);

        if (normal.lengthSq() > 1e-8) {
          normal.normalize();
          const toCenter = new THREE.Vector3().subVectors(centroid, va);
          if (normal.dot(toCenter) > 0) normal.negate();
          normals.push(normal);
        }

        if (normals.length > 40) break;
      }
      if (normals.length > 40) break;
    }
    if (normals.length > 40) break;
  }

  return normals;
}

/**
 * Extract edge direction vectors from a hull point cloud.
 */
function getHullEdges(vertices, maxEdges = 12) {
  const edges = [];
  const n = vertices.length;
  const step = Math.max(1, Math.floor(n / maxEdges));

  for (let i = 0; i < n && edges.length < maxEdges; i += step) {
    for (let j = i + 1; j < n && edges.length < maxEdges; j += step) {
      const edge = new THREE.Vector3().subVectors(vertices[j], vertices[i]);
      if (edge.lengthSq() > 1e-8) {
        edges.push(edge.normalize());
      }
    }
  }

  return edges;
}

// ── Binary Search for Maximum Scale ────────────────────────

function binarySearchScale(facetedPoints, roughPlanes, rotation, offset, minScale = 0.01, maxScale = 3.0, steps = 24, obstacleHulls = [], collisionMargin = 0.015) {
  let lo = minScale;
  let hi = maxScale;
  
  const euler = new THREE.Euler(rotation.x, rotation.y, rotation.z, 'XYZ');
  const quaternion = new THREE.Quaternion().setFromEuler(euler);
  const matrix = new THREE.Matrix4();

  const transformedPoints = facetedPoints.map(p => p.clone());

  const transformPointsInPlace = (target, source, transformMatrix) => {
    for (let i = 0; i < source.length; i++) {
      target[i].copy(source[i]).applyMatrix4(transformMatrix);
    }
  };

  matrix.compose(
    offset,
    quaternion,
    new THREE.Vector3(minScale, minScale, minScale)
  );
  transformPointsInPlace(transformedPoints, facetedPoints, matrix);
  if (!allPointsInHull(transformedPoints, roughPlanes)) {
    return minScale;
  }

  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2;
    
    matrix.compose(
      offset,
      quaternion,
      new THREE.Vector3(mid, mid, mid)
    );

    transformPointsInPlace(transformedPoints, facetedPoints, matrix);

    if (!allPointsInHull(transformedPoints, roughPlanes)) {
      hi = mid; 
      continue;
    }

    let intersectsObstacle = false;
    if (obstacleHulls.length > 0) {
      for (const obsHull of obstacleHulls) {
        if (convexHullsIntersect(transformedPoints, obsHull, collisionMargin)) {
          intersectsObstacle = true;
          break;
        }
      }
    }

    if (intersectsObstacle) {
      hi = mid; 
    } else {
      lo = mid; 
    }
  }
  return lo;
}

// ── Generic Search-Center Estimation (Chebyshev Center) ────

function computeGirdleCenter(geometry, fallbackCenter) {
  const posAttr = geometry.getAttribute('position');
  let maxRadius = 0;
  for (let i = 0; i < posAttr.count; i++) {
    const r = Math.hypot(posAttr.getX(i), posAttr.getZ(i));
    if (r > maxRadius) maxRadius = r;
  }
  if (maxRadius <= 1e-6) return fallbackCenter.clone();

  const threshold = maxRadius * 0.92;
  let ySum = 0;
  let count = 0;
  for (let i = 0; i < posAttr.count; i++) {
    const r = Math.hypot(posAttr.getX(i), posAttr.getZ(i));
    if (r >= threshold) {
      ySum += posAttr.getY(i);
      count++;
    }
  }
  const girdleY = count > 0 ? ySum / count : fallbackCenter.y;
  return new THREE.Vector3(fallbackCenter.x, girdleY, fallbackCenter.z);
}

function approximateChebyshevCenter(planes, start, iterations = 150) {
  const center = start.clone();
  if (planes.length === 0) return center;

  let step = planes.reduce((acc, p) => Math.max(acc, Math.abs(p.distance)), 1) * 0.08;
  const minStep = step * 0.001;

  for (let i = 0; i < iterations && step > minStep; i++) {
    let minMargin = Infinity;
    let bindingPlane = null;
    for (const plane of planes) {
      const margin = plane.distance - plane.normal.dot(center);
      if (margin < minMargin) {
        minMargin = margin;
        bindingPlane = plane;
      }
    }
    if (!bindingPlane) break;
    center.addScaledVector(bindingPlane.normal, -step);
    step *= 0.97; 
  }

  return center;
}

// ── Candidate Generation for Global Search ─────────────────

function generateOrientationCandidates({ rotationStepsY = 16 } = {}) {
  const candidates = [];
  const flipStates = [0, Math.PI];
  const ySteps = Math.max(1, rotationStepsY);

  for (let yi = 0; yi < ySteps; yi++) {
    const rotY = (yi / ySteps) * Math.PI * 2;
    for (const flipX of flipStates) {
      for (const flipZ of flipStates) {
        candidates.push({ x: flipX, y: rotY, z: flipZ });
      }
    }
  }
  return candidates;
}

function generateProbeOffsets(center, rangeVec) {
  const probeScale = 0.6; 
  return [
    center.clone(),
    center.clone().add(new THREE.Vector3(rangeVec.x * probeScale, 0, 0)),
    center.clone().add(new THREE.Vector3(-rangeVec.x * probeScale, 0, 0)),
    center.clone().add(new THREE.Vector3(0, rangeVec.y * probeScale, 0)),
    center.clone().add(new THREE.Vector3(0, -rangeVec.y * probeScale, 0)),
    center.clone().add(new THREE.Vector3(0, 0, rangeVec.z * probeScale)),
    center.clone().add(new THREE.Vector3(0, 0, -rangeVec.z * probeScale)),
  ];
}

function generateOffsetCandidates(center, rangeVec, positionSteps) {
  const offsets = [];
  const half = Math.max(1, positionSteps);
  for (let xi = -half; xi <= half; xi++) {
    for (let yi = -half; yi <= half; yi++) {
      for (let zi = -half; zi <= half; zi++) {
        offsets.push(new THREE.Vector3(
          center.x + (xi / half) * rangeVec.x,
          center.y + (yi / half) * rangeVec.y,
          center.z + (zi / half) * rangeVec.z
        ));
      }
    }
  }
  return offsets;
}

// ── Local Pattern Search (Hooke–Jeeves style) ──────────────

function patternSearch(evalFn, initialParams, initialSteps, minSteps, maxIterations = 40) {
  let params = initialParams.slice();
  let steps = initialSteps.slice();
  let bestScore = evalFn(params);

  for (let iter = 0; iter < maxIterations; iter++) {
    let improved = false;
    for (let d = 0; d < params.length; d++) {
      for (const sign of [1, -1]) {
        const trial = params.slice();
        trial[d] += sign * steps[d];
        const score = evalFn(trial);
        if (score > bestScore * 1.0005) {
          bestScore = score;
          params = trial;
          improved = true;
        }
      }
    }
    if (!improved) {
      steps = steps.map(s => s * 0.5);
      if (steps.every((s, i) => s <= minSteps[i])) break;
    }
  }

  return { params, score: bestScore };
}

// ── Main Fitting Function ──────────────────────────────────

export function findMaxInscribedFit(roughMesh, facetedGeometry, facetedBaseVolume, options = {}) {
  const {
    rotationStepsY = 16,
    tiltRange = 15,
    positionSteps = 1,
    positionRange = 0.5,
    topOrientations = 8,
    refineCandidates = topOrientations,
    patternSearchIterations = 40,
    obstacles = [],
    collisionMargin = 0.015,
  } = options;

  // ────────────────────────────────────────────────────────
  // 1. Extract rough hull planes in world space
  // ────────────────────────────────────────────────────────
  const roughGeometry = roughMesh.geometry;
  const hull = extractConvexHull(roughGeometry);

  roughMesh.updateMatrixWorld();
  const roughWorldMatrix = roughMesh.matrixWorld;
  const roughPlanes = hull.planes.map(plane => {
    const normal = plane.normal.clone().transformDirection(roughWorldMatrix).normalize();
    const ptOnPlane = plane.normal.clone().multiplyScalar(plane.distance).applyMatrix4(roughWorldMatrix);
    const distance = normal.dot(ptOnPlane);
    return { normal, distance };
  });
  const worldVertices = hull.vertices.map(v => v.clone().applyMatrix4(roughWorldMatrix));
  const roughCenter = computeCentroid(worldVertices);

  const roughVolume = computeMeshVolume(roughGeometry);

  roughGeometry.computeBoundingBox();
  const roughBox = roughGeometry.boundingBox.clone().applyMatrix4(roughWorldMatrix);
  const roughSize = new THREE.Vector3();
  roughBox.getSize(roughSize);

  roughGeometry.computeBoundingSphere();
  const roughSphereRadius = roughGeometry.boundingSphere.radius;

  // ────────────────────────────────────────────────────────
  // 2. Sample faceted vertices and center them
  // ────────────────────────────────────────────────────────
  const facetedPoints = sampleVertices(facetedGeometry, 100);

  facetedGeometry.computeBoundingBox();
  const facetedBox = facetedGeometry.boundingBox;
  const facetedCenter = new THREE.Vector3();
  facetedBox.getCenter(facetedCenter);
  const girdleCenter = computeGirdleCenter(facetedGeometry, facetedCenter);
  const centeredPoints = facetedPoints.map(p => p.clone().sub(girdleCenter));

  facetedGeometry.computeBoundingSphere();
  const facetedSphereRadius = facetedGeometry.boundingSphere.radius;

  const estimatedMaxScale = facetedSphereRadius > 0.001
    ? (roughSphereRadius / facetedSphereRadius) * 1.5
    : 5.0;

  // ────────────────────────────────────────────────────────
  // 3. Pre-compute obstacle data
  // ────────────────────────────────────────────────────────
  const obstacleHulls = [];
  for (const obstacleMesh of obstacles) {
    const obsHull = getWorldConvexHull(obstacleMesh);
    if (obsHull.length >= 4) {
      obstacleHulls.push(obsHull);
    }
  }

  // ────────────────────────────────────────────────────────
  // 4. Compute search center (anti-centroid for multi-stone)
  // ────────────────────────────────────────────────────────
  let searchCenter;
  if (obstacles.length > 0) {
    const avgObstacle = new THREE.Vector3();
    for (const obs of obstacles) {
      obs.updateMatrixWorld();
      avgObstacle.add(new THREE.Vector3().setFromMatrixPosition(obs.matrixWorld));
    }
    avgObstacle.divideScalar(obstacles.length);
    
    const mirrored = roughCenter.clone().multiplyScalar(2).sub(avgObstacle);
    
    // ── FIXED: Explicitly lift the search center up into the crown for the second stone ──
    if (obstacles.length === 1) {
      mirrored.y += roughSize.y * 0.25; 
    }
    
    searchCenter = approximateChebyshevCenter(roughPlanes, mirrored);
  } else {
    searchCenter = approximateChebyshevCenter(roughPlanes, roughCenter);
  }

  // ────────────────────────────────────────────────────────
  // 5. Per-axis position offset ranges
  // ────────────────────────────────────────────────────────
  const offsetRange = new THREE.Vector3(
    roughSize.x * positionRange * 0.5,
    roughSize.y * positionRange * 0.5,
    roughSize.z * positionRange * 0.5
  );

  let bestScale = 0;
  let peakScale = 0; 
  let bestRotation = { x: 0, y: 0, z: 0 };
  let bestOffset = searchCenter.clone();

  const distToCenter = (p) => p.distanceTo(searchCenter);

  const orientationCandidates = generateOrientationCandidates({ rotationStepsY });
  const probeOffsets = generateProbeOffsets(searchCenter, offsetRange);

  const orientationScores = orientationCandidates.map(rotation => {
    let best = 0;
    for (const probeOffset of probeOffsets) {
      const scale = binarySearchScale(
        centeredPoints, roughPlanes, rotation, probeOffset,
        0.01, estimatedMaxScale, 10, 
        obstacleHulls,
        collisionMargin
      );
      if (scale > best) best = scale;
    }
    return { rotation, scale: best };
  });

  const byScore = orientationScores.slice().sort((a, b) => b.scale - a.scale);
  const wantTotal = Math.max(1, topOrientations);
  const wantByScore = Math.ceil(wantTotal / 2);

  const survivingOrientations = byScore.slice(0, wantByScore);
  const chosen = new Set(survivingOrientations.map(e => e.rotation));

  const remainingSlots = wantTotal - survivingOrientations.length;
  if (remainingSlots > 0) {
    const pool = orientationScores.filter(e => !chosen.has(e.rotation));
    const stride = Math.max(1, Math.floor(pool.length / remainingSlots));
    for (let i = 0; i < pool.length && survivingOrientations.length < wantTotal; i += stride) {
      survivingOrientations.push(pool[i]);
      chosen.add(pool[i].rotation);
    }
  }

  // ── Phase 2: Position grid search for each surviving orientation ──
  const positionCandidates = generateOffsetCandidates(searchCenter, offsetRange, positionSteps);
  const globalCandidates = [];

  for (const { rotation } of survivingOrientations) {
    for (const offset of positionCandidates) {
      const scale = binarySearchScale(
        centeredPoints, roughPlanes, rotation, offset,
        0.01, estimatedMaxScale, 18,
        obstacleHulls,
        collisionMargin
      );
      globalCandidates.push({ rotation, offset, scale });
      if (scale > peakScale) peakScale = scale;

      if (scale > bestScale * 1.005) {
        bestScale = scale;
        bestRotation = { ...rotation };
        bestOffset = offset.clone();
      } else if (scale > peakScale * 0.995 && distToCenter(offset) < distToCenter(bestOffset)) {
        bestScale = scale;
        bestRotation = { ...rotation };
        bestOffset = offset.clone();
      }
    }
  }

  // ── Phase 3: Local pattern-search polish (joint 6D: rotation + position) ──
  const bestPerOrientation = new Map();
  for (const cand of globalCandidates) {
    const existing = bestPerOrientation.get(cand.rotation);
    if (!existing || cand.scale > existing.scale) bestPerOrientation.set(cand.rotation, cand);
  }
  const perOrientationBest = Array.from(bestPerOrientation.values());
  perOrientationBest.sort((a, b) => b.scale - a.scale);
  const refineSeeds = perOrientationBest.slice(0, Math.max(1, refineCandidates));

  const rotStep = THREE.MathUtils.degToRad(Math.max(2, tiltRange / 4));
  const rotMinStep = THREE.MathUtils.degToRad(0.25);
  const posStep = new THREE.Vector3(offsetRange.x, offsetRange.y, offsetRange.z)
    .divideScalar(Math.max(1, positionSteps) * 2 || 1);
  const posMinStep = Math.max(posStep.x, posStep.y, posStep.z) * 0.01;

  for (const seed of refineSeeds) {
    const initialParams = [
      seed.rotation.x, seed.rotation.y, seed.rotation.z,
      seed.offset.x, seed.offset.y, seed.offset.z,
    ];
    const initialSteps = [rotStep, rotStep, rotStep, posStep.x || posStep.y || posStep.z, posStep.y || posStep.x, posStep.z || posStep.x];
    const minSteps = [rotMinStep, rotMinStep, rotMinStep, posMinStep, posMinStep, posMinStep];

    const evalFn = (params) => binarySearchScale(
      centeredPoints, roughPlanes,
      { x: params[0], y: params[1], z: params[2] },
      new THREE.Vector3(params[3], params[4], params[5]),
      0.01, estimatedMaxScale, 22,
      obstacleHulls,
      collisionMargin
    );

    const { params, score } = patternSearch(evalFn, initialParams, initialSteps, minSteps, patternSearchIterations);
    if (score > peakScale) peakScale = score;

    const refinedOffset = new THREE.Vector3(params[3], params[4], params[5]);
    const refinedRotation = { x: params[0], y: params[1], z: params[2] };
    if (score > bestScale * 1.005) {
      bestScale = score;
      bestRotation = refinedRotation;
      bestOffset = refinedOffset;
    } else if (score > peakScale * 0.995 && distToCenter(refinedOffset) < distToCenter(bestOffset)) {
      bestScale = score;
      bestRotation = refinedRotation;
      bestOffset = refinedOffset;
    }
  }

  // ────────────────────────────────────────────────────────
  // 6. Compute results
  // ────────────────────────────────────────────────────────
  const finalRotation = new THREE.Euler(bestRotation.x, bestRotation.y, bestRotation.z);
  const finalQuaternion = new THREE.Quaternion().setFromEuler(finalRotation);

  const centerCorrection = girdleCenter.clone()
    .applyQuaternion(finalQuaternion)
    .multiplyScalar(bestScale);
  
  const finalOffset = bestOffset.clone().sub(centerCorrection);

  const polishedVolume = facetedBaseVolume * Math.pow(bestScale, 3);
  const utilization = roughVolume > 0 ? polishedVolume / roughVolume : 0;

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
  };
}

// ── Mesh Volume Computation ────────────────────────────────

export function computeMeshVolume(geometry) {
  const posAttr = geometry.getAttribute('position');
  const index = geometry.getIndex();

  let volume = 0;
  const triCount = index ? index.count / 3 : posAttr.count / 3;

  for (let f = 0; f < triCount; f++) {
    let ai, bi, ci;
    if (index) {
      ai = index.getX(f * 3);
      bi = index.getX(f * 3 + 1);
      ci = index.getX(f * 3 + 2);
    } else {
      ai = f * 3;
      bi = f * 3 + 1;
      ci = f * 3 + 2;
    }

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

// ── Multi-Stone Placement Helper ──────────────────────────

/**
 * Place multiple stones sequentially, with each new stone avoiding previously placed ones.
 */
export function placeMultipleStones(roughMesh, stoneGeometries, stoneVolumes, options = {}) {
  const {
    stoneColors = [0x44aaff, 0xff8844, 0x66ff88],
    stoneOpacities = [0.6, 0.6, 0.6],
    scene = null,
    ...restOptions
  } = options;
  
  const results = [];
  const placedObstacles = [];
  let previousStone = null;
  
  for (let i = 0; i < stoneGeometries.length; i++) {
    const isFirstStone = i === 0;
    const isSecondStone = i === 1;
    
    const placementOptions = {
      ...restOptions,
      obstacles: placedObstacles,
      positionRange: isFirstStone ? 0.5 : 0.3,
      // ── FIXED: Enforce a wider clearance margin boundary to force the second stone smaller ──
      collisionMargin: isSecondStone ? 0.035 : 0.015,
    };
    
    const result = findMaxInscribedFit(
      roughMesh,
      stoneGeometries[i],
      stoneVolumes[i],
      placementOptions
    );
    
    const color = stoneColors[i % stoneColors.length];
    const opacity = stoneOpacities[i % stoneOpacities.length];
    
    const mesh = new THREE.Mesh(
      stoneGeometries[i].clone(),
      new THREE.MeshStandardMaterial({
        transparent: true,
        opacity: opacity,
        color: color,
        roughness: 0.3,
        metalness: 0.1,
        side: THREE.DoubleSide
      })
    );
    
    mesh.rotation.copy(result.rotation);
    mesh.position.copy(result.offset);
    mesh.scale.set(result.scale, result.scale, result.scale);
    mesh.updateMatrixWorld();
    
    results.push({
      result,
      mesh,
      index: i
    });
    
    if (scene) {
      scene.add(mesh);
    }
    
    if (result.scale > 0.01) {
      placedObstacles.push(mesh);
      previousStone = mesh;
    }
    
    console.log(`Stone ${i + 1}: scale=${result.scale.toFixed(3)}, volume=${result.polishedVolume.toFixed(2)}mm³, carat=${result.caratWeight.toFixed(2)}ct`);
  }
  
  const totalPolishedVolume = results.reduce((sum, r) => sum + r.result.polishedVolume, 0);
  const totalCaratWeight = results.reduce((sum, r) => sum + r.result.caratWeight, 0);
  const roughVolume = results.length > 0 ? results[0].result.roughVolume : 0;
  const totalUtilization = roughVolume > 0 ? totalPolishedVolume / roughVolume : 0;
  
  console.log(`\nTotal: ${totalPolishedVolume.toFixed(2)}mm³, ${totalCaratWeight.toFixed(2)}ct, utilization=${(totalUtilization * 100).toFixed(1)}%`);
  
  return {
    placements: results,
    totalPolishedVolume,
    totalCaratWeight,
    totalUtilization,
    roughVolume,
  };
}

// ── Quick Fit (faster, less accurate) ──────────────────────

export function quickFit(roughGeometry, facetedGeometry, facetedBaseVolume) {
  return findMaxInscribedFit(roughGeometry, facetedGeometry, facetedBaseVolume, {
    rotationStepsY: 8,
    positionSteps: 1,
    positionRange: 0.3,
    topOrientations: 4,
    refineCandidates: 4,
    patternSearchIterations: 20,
  });
}

// ── Debug Helper: Visualize SAT Axes ──────────────────────

export function debugSATAxes(hullA, hullB, sampleSize = 20) {
  const results = [];
  const axes = [];
  
  const normalsA = getHullFaceNormals(hullA);
  const normalsB = getHullFaceNormals(hullB);
  axes.push(...normalsA, ...normalsB);

  const edgesA = getHullEdges(hullA, 6);
  const edgesB = getHullEdges(hullB, 6);

  for (const eA of edgesA) {
    for (const eB of edgesB) {
      const cross = new THREE.Vector3().crossVectors(eA, eB);
      if (cross.lengthSq() > 1e-8) {
        axes.push(cross.normalize());
      }
    }
  }

  const step = Math.max(1, Math.floor(axes.length / sampleSize));
  for (let i = 0; i < axes.length && results.length < sampleSize; i += step) {
    const axis = axes[i];
    if (axis.lengthSq() < 1e-10) continue;
    
    const projA = projectOntoAxis(hullA, axis);
    const projB = projectOntoAxis(hullB, axis);
    
    // ── FIXED: Standardized correct gap tracking boundary checking here too ──
    const gapA = projB.min - projA.max;
    const gapB = projA.min - projB.max;
    const actualGap = Math.max(gapA, gapB);
    const separating = actualGap > 0.02;
    
    results.push({
      axis: axis.clone(),
      projection: {
        minA: projA.min,
        maxA: projA.max,
        minB: projB.min,
        maxB: projB.max,
        overlap: Math.max(0, Math.min(projA.max, projB.max) - Math.max(projA.min, projB.min)),
        gap: actualGap
      },
      separating: separating
    });
  }
  
  return results;
}

// ── Export Types ────────────────────────────────────────────

/**
 * @typedef {Object} FittingResult
 * @property {number} scale - Scale factor applied to the polished diamond
 * @property {THREE.Euler} rotation - Final rotation in Euler angles
 * @property {THREE.Vector3} offset - Final position offset
 * @property {number} polishedVolume - Volume of the polished diamond at final scale
 * @property {number} roughVolume - Volume of the rough diamond
 * @property {number} utilization - Ratio of polished volume to rough volume
 * @property {number} caratWeight - Carat weight of the polished diamond
 * @property {number} roughCaratWeight - Carat weight of the rough diamond
 * @property {THREE.Vector3} searchCenter - Search center used for placement
 */