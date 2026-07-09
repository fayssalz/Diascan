/* ============================================================
   rough-generators.js — Procedural Rough Diamond Geometry
   Generators for octahedron, dodecahedron, macle, and makeable
   ============================================================ */

import * as THREE from 'three';

// ── Octahedron Generator ───────────────────────────────────

/**
 * Generate a rough octahedron (double pyramid) with girdle
 * thickness and optional table/culet flats.
 * 
 * @param {Object} params - Shape parameters
 * @param {number} params.height - Total height of the octahedron
 * @param {number} params.width - Girdle diameter
 * @param {number} params.length - Girdle diameter along Z-axis
 * @param {number} params.girdleThickness - Thickness of the girdle band
 * @returns {THREE.BufferGeometry}
 */
export function generateOctahedron(params) {
  const { height = 6.0, width = 5.0, length = 5.0, girdleThickness = 0.3 } = params;
  const gH = Math.min(height * 0.4, girdleThickness); // clamp to max 40% of height
  const hPyr = (height - gH) / 2;
  const rX = width / 2;
  const rZ = length / 2;

  // Vertices
  // 0: Top apex
  // 1: Bottom apex
  // 2-5: Top girdle corners (Rhombus shape: +X, +Z, -X, -Z)
  // 6-9: Bottom girdle corners (Rhombus shape: +X, +Z, -X, -Z)
  const vertices = [
    // Top apex (0)
    0, gH / 2 + hPyr, 0,
    // Bottom apex (1)
    0, -(gH / 2 + hPyr), 0,

    // Top girdle corners
    rX,  gH / 2,  rZ,  // 2
   -rX,  gH / 2,  rZ,  // 3
   -rX,  gH / 2, -rZ,  // 4
    rX,  gH / 2, -rZ,  // 5

    // Bottom girdle corners
    rX, -gH / 2,  rZ,  // 6
   -rX, -gH / 2,  rZ,  // 7
   -rX, -gH / 2, -rZ,  // 8
    rX, -gH / 2, -rZ,  // 9
  ];

  const indices = [
    // Top pyramid faces (CCW from outside)
    0, 3, 2,
    0, 4, 3,
    0, 5, 4,
    0, 2, 5,

    // Bottom pyramid faces (CCW from outside)
    1, 6, 7,
    1, 7, 8,
    1, 8, 9,
    1, 9, 6,

    // Girdle side faces (Quads split into triangles)
    3, 7, 6,  3, 6, 2, // +Z face
    4, 8, 7,  4, 7, 3, // -X face
    5, 9, 8,  5, 8, 4, // -Z face
    2, 6, 9,  2, 9, 5  // +X face
  ];

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  return geometry;
}

// ── Dodecahedron Generator ─────────────────────────────────

/**
 * Generate a rhombic dodecahedron (diamond-specific polyhedron)
 * with adjustable height/width/aspect ratio.
 * 
 * @param {Object} params - Shape parameters
 * @param {number} params.height - Total height
 * @param {number} params.width - Width
 * @param {number} params.aspectRatio - Height to width ratio
 * @returns {THREE.BufferGeometry}
 */
export async function generateDodecahedron(params) {
  const { height = 6.0, width = 5.0, length = 5.0 } = params;
  
  // Rhombic dodecahedron vertices can be formed by the union of:
  // - A cube: (+-a, +-a, +-a)
  // - An octahedron: (+-2a, 0, 0), (0, +-2a, 0), (0, 0, +-2a)
  // We scale this to fit our exact height and width.
  const h = height / 2;
  const w = width / 2;
  const l = length / 2;

  // Let's create the 14 vertices
  // Scale factor for cube vs octahedron vertices is typically 0.5
  const cx = w * 0.5;
  const cy = h * 0.5;
  const cz = l * 0.5;

  const vertices = [
    // 8 Cube vertices
     cx,  cy,  cz,
     cx,  cy, -cz,
     cx, -cy,  cz,
     cx, -cy, -cz,
    -cx,  cy,  cz,
    -cx,  cy, -cz,
    -cx, -cy,  cz,
    -cx, -cy, -cz,

    // 6 Octahedron vertices (extremes)
     w,  0,  0,
    -w,  0,  0,
     0,  h,  0,
     0, -h,  0,
     0,  0,  l,
     0,  0, -l,
  ];

  const points = [];
  for (let i = 0; i < vertices.length; i += 3) {
    points.push(new THREE.Vector3(vertices[i], vertices[i + 1], vertices[i + 2]));
  }

  const { ConvexGeometry } = await import('three/addons/geometries/ConvexGeometry.js');
  const geometry = new ConvexGeometry(points);

  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  return geometry;
}

// ── Macle Generator ────────────────────────────────────────

/**
 * Generate a macle (twinned crystal) with a physically-based model.
 * This models a spinel-twinned crystal, flattened along the twin plane,
 * with re-entrant corners filled in to form a convex, triangular plate shape,
 * characteristic of a Group III-IV macle.
 * 
 * This implementation is based on the user-provided geometry class, but is made
 * robust by using ConvexGeometry and a precise scaling transform.
 * 
 * @param {Object} params - Shape parameters
 * @param {number} params.width - The side-to-side width of the final triangular plate.
 * @param {number} params.height - The thickness of the final triangular plate.
 * @returns {Promise<THREE.BufferGeometry>}
 */
export async function generateMacle(params) {
  const { width = 5.0, height = 1.0, length = 5.0 } = params;

  // Hardcoded vertices from the user-provided OBJ file, with Y and Z axes swapped.
  const vertices = [
    -0.001967, 0.029675, 1.000000,
    -0.000000, 0.019495, 1.000000,
    0.001967, 0.029675, 1.000000,
    0.000000, 0.039856, 1.000000,
    -0.000000, -0.299047, 0.893389,
    -0.773697, -0.299047, -0.446694,
    0.773697, -0.299047, -0.446694,
    -0.868976, 0.029675, -0.501704,
    0.868976, 0.029675, -0.501704,
    -0.790900, 0.299047, -0.456626,
    0.000000, 0.299047, 0.913252,
    0.790900, 0.299047, -0.456626
  ];

  // OBJ indices are 1-based, so subtract 1 for 0-based BufferGeometry indices.
  const indices = [
    0, 1, 2,    0, 2, 3,    4, 5, 6,    7, 8, 6,
    7, 6, 5,    7, 5, 4,    7, 4, 1,    7, 1, 0,
    8, 2, 1,    8, 1, 4,    8, 4, 6,    9, 10, 11,
    7, 9, 11,   7, 11, 8,   3, 2, 8,    3, 8, 11,
    3, 11, 10,  0, 3, 10,   0, 10, 9,   0, 9, 7
  ];

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);

  // Center the geometry so scaling is uniform from the origin.
  geometry.center();

  // Compute bounding box of the centered, unscaled geometry to find its dimensions.
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const unscaledSize = new THREE.Vector3();
  box.getSize(unscaledSize);

  // Calculate scale factors to match the target width, length, and height (thickness).
  // After swapping Y and Z from the original OBJ, the plate lies on the XZ plane,
  // so width corresponds to X, length to Z, and height to Y (thickness).
  const scaleX = (unscaledSize.x > 0.001) ? width / unscaledSize.x : 1;
  const scaleY = (unscaledSize.y > 0.001) ? height / unscaledSize.y : 1;
  const scaleZ = (unscaledSize.z > 0.001) ? length / unscaledSize.z : 1;

  // Apply scales
  geometry.scale(scaleX, scaleY, scaleZ);

  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  return geometry;
}

// ── Makeable Generator ─────────────────────────────────────

/**
 * Generate a makeable shape from a 2D profile revolved around an axis.
 * 
 * @param {Object} params - Shape parameters
 * @param {Array} params.profilePoints - Array of [x, y] points defining profile
 * @param {number} params.height - Total height
 * @param {number} params.width - Max width
 * @returns {THREE.BufferGeometry}
 */
export async function generateMakeable(params) {
  const { height = 6.0, width = 5.0, length = 5.0, profilePoints } = params;
  
  let points2D = [];
  if (profilePoints && profilePoints.length >= 3) {
    points2D = profilePoints.map(p => new THREE.Vector2(p[0], p[1]));
  } else {
    // Generate a default irregular profile if none is provided:
    // It goes from axis bottom (0, -h) to outer corners and back to axis top (0, h)
    const h = height / 2;
    const r = width / 2;
    points2D = [
      new THREE.Vector2(0.01, -h),      // bottom center
      new THREE.Vector2(r * 0.8, -h * 0.6),
      new THREE.Vector2(r, 0),         // girdle
      new THREE.Vector2(r * 0.7, h * 0.5),
      new THREE.Vector2(0.01, h),       // top center
    ];
  }

  // Create lathe geometry
  const geometry = new THREE.LatheGeometry(points2D, 24);

  // Scale non-uniformly on the Z-axis to account for length, creating an elliptical profile.
  if (width > 0.001) {
    const zScale = length / width;
    geometry.scale(1, 1, zScale);
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  return geometry;
}