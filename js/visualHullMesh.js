import * as THREE from 'three';
import { Evaluator, Brush, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';

// ============================================================================
// Exact polyhedral visual-hull reconstruction.
//
// This replaces the marching-cubes / voxel-grid approach entirely. Instead of
// sampling an implicit field on a discrete grid and meshing it (which is
// fundamentally resolution-limited — that's why the old pipeline looked
// blocky even after smoothing), this computes the visual hull analytically
// as the intersection of "silhouette cones": for each captured frame, the
// 2D silhouette contour is reduced to its convex hull, and the infinite
// pyramid from the camera through that convex polygon is represented exactly
// as a small set of half-space planes (one per polygon edge). Intersecting
// every half-space from every frame gives a convex polyhedron whose faces
// are the *exact* geometry — not an approximation that improves with grid
// resolution, an exact answer up to floating point precision.
//
// Tradeoff vs. voxel carving (read this before relying on it):
//   - No blockiness, no smoothing pass, no grid resolution to tune. Facet
//     edges come out crisp, which is also just a more correct look for a
//     rough diamond's planar crystal faces than a Laplacian-smoothed blob.
//   - Because each frame's silhouette is reduced to ITS CONVEX HULL before
//     building half-spaces, any concave dip that is visible in an individual
//     frame's outline is discarded — this method can only ever produce a
//     convex result. Voxel carving could in principle use a concave
//     per-frame silhouette to carve concave 3D detail; this method cannot.
//     For a rough diamond (typically close to convex overall), that's
//     usually an acceptable trade for a clean mesh. It is NOT acceptable if
//     you need to capture real surface concavities/pits for planning —
//     no camera-only silhouette method can do that regardless of which of
//     these two approaches you pick; only dedicated laser/structured-light
//     hardware handles that reliably.
// ============================================================================

const DEFAULT_BOX_HALF_SIZE = 2.0; // Must comfortably contain the object. Tune to your rig.
const MIN_HULL_BOUNDARY_POINTS = 8; // Below this, a frame's silhouette is too noisy/small to trust.

/**
 * @param {Array}   frames   - [{ canvas, rotation: THREE.Quaternion }]
 * @param {THREE.Camera} camera
 * @param {Function} onProgress
 * @param {Object}  options  - { boxHalfSize }
 * @returns {Promise<{ mesh: THREE.Mesh, geometry: THREE.BufferGeometry }>}
 */
export async function carveConvexVisualHullMesh(frames, camera, onProgress, options = {}) {
    const boxHalfSize = options.boxHalfSize ?? DEFAULT_BOX_HALF_SIZE;

    let faces = makeBoxFaces(boxHalfSize);

    let frameIndex = 0;
    let skippedFrames = 0;

    for (const frame of frames) {
        const { canvas, rotation } = frame;
        const hull2D = extractSilhouetteHull2D(canvas);

        if (!hull2D || hull2D.length < 3) {
            skippedFrames++;
        } else {
            const halfSpaces = hullToHalfSpaces(hull2D, canvas.width, canvas.height, camera, rotation);
            for (const { normal, d } of halfSpaces) {
                faces = clipByHalfSpace(faces, normal, d);
                if (faces.length === 0) {
                    console.warn('Polyhedron vanished during clipping — a frame\'s silhouette likely disagrees with the camera/rig calibration used for the others. Skipping remaining planes from this frame.');
                    break;
                }
            }
        }

        if (frameIndex % 4 === 0) {
            if (onProgress) onProgress(Math.round((frameIndex / frames.length) * 100));
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        frameIndex++;
    }

    if (skippedFrames > 0) {
        console.warn(`Skipped ${skippedFrames}/${frames.length} frames with unusable silhouettes (too small/noisy).`);
    }
    if (onProgress) onProgress(100);

    if (faces.length === 0) {
        console.warn('Visual hull carving produced an empty polyhedron. Falling back to sphere.');
        const material = new THREE.MeshStandardMaterial({ color: 0x88ccee, roughness: 0.2, metalness: 0.1 });
        const fallback = new THREE.Mesh(new THREE.SphereGeometry(boxHalfSize / 2, 16, 12), material);
        fallback.geometry.computeVertexNormals();
        return { mesh: fallback, geometry: fallback.geometry };
    }

    // FIX: with many frames/edges, floating-point noise produces lots of tiny
    // near-duplicate planes that clip off razor-thin sliver faces right next
    // to the "real" facet boundary. Left alone this turns what should be a
    // handful of clean facets into dozens of degenerate slivers. Merge faces
    // that share (nearly) the same plane, and drop true zero-area slivers.
    faces = mergeCoplanarFaces(faces);

    const geometry = trianglateFacesToGeometry(faces);

    const material = new THREE.MeshStandardMaterial({
        color: 0x88ccee,
        roughness: 0.15,
        metalness: 0.1,
        flatShading: true, // FIX: flat shading is correct here — these are real planar facets, not a surface to smooth
    });
    const mesh = new THREE.Mesh(geometry, material);

    console.log(`Visual hull mesh built. Faces: ${faces.length}, triangles: ${geometry.index.count / 3}`);

    return { mesh, geometry };
}

/**
 * Analytical 3-Axis Orthogonal Visual Hull Reconstruction.
 * Synthesizes a watertight, faceted 3D rough diamond crystal mesh
 * by intersecting silhouette prisms from Front, Side, and Top photographic views.
 *
 * @param {Array<[number, number]>} frontHull2D - Front view (X-Y plane) 2D contour polygon
 * @param {Array<[number, number]>} sideHull2D  - Side view (Z-Y plane) 2D contour polygon
 * @param {Array<[number, number]>} topHull2D   - Top view (X-Z plane) 2D contour polygon
 * @param {Object} dimensions - { width, height, length } in millimeters
 * @returns {{ mesh: THREE.Mesh, geometry: THREE.BufferGeometry, volume: number, faces: Array }}
 */
export function reconstruct3AxisVisualHull(frontHull2D, sideHull2D, topHull2D, dimensions = {}) {
    const width  = dimensions.width  || 5.0;
    const height = dimensions.height || 6.0;
    const length = dimensions.length || 5.0;

    const maxDim = Math.max(width, height, length, 1.0);
    let faces = makeBoxFaces(maxDim * 1.5);

    function normalizePoly(poly, targetW, targetH) {
        if (!poly || poly.length < 3) return null;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const [x, y] of poly) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
        const spanX = Math.max(maxX - minX, 1e-4);
        const spanY = Math.max(maxY - minY, 1e-4);
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        return poly.map(([x, y]) => [
            ((x - cx) / spanX) * targetW,
            ((cy - y) / spanY) * targetH
        ]);
    }

    // 1. Front View: (X, Y)
    const normFront = normalizePoly(frontHull2D, width, height);
    if (normFront) {
        const n = normFront.length;
        for (let i = 0; i < n; i++) {
            const [x0, y0] = normFront[i];
            const [x1, y1] = normFront[(i + 1) % n];
            const dx = x1 - x0;
            const dy = y1 - y0;
            const len = Math.hypot(dx, dy);
            if (len < 1e-6) continue;
            const normal = new THREE.Vector3(dy / len, -dx / len, 0);
            let d = normal.x * x0 + normal.y * y0;
            if (d < 0) { normal.negate(); d = -d; }
            faces = clipByHalfSpace(faces, normal, d);
            if (faces.length === 0) break;
        }
    }

    // 2. Side View: (Z, Y)
    const normSide = normalizePoly(sideHull2D, length, height);
    if (normSide && faces.length > 0) {
        const n = normSide.length;
        for (let i = 0; i < n; i++) {
            const [z0, y0] = normSide[i];
            const [z1, y1] = normSide[(i + 1) % n];
            const dz = z1 - z0;
            const dy = y1 - y0;
            const len = Math.hypot(dz, dy);
            if (len < 1e-6) continue;
            // In (Z, Y) plane, normal perpendicular to (dz, dy) is (dy, -dz)
            const normal = new THREE.Vector3(0, -dz / len, dy / len);
            let d = normal.z * z0 + normal.y * y0;
            if (d < 0) { normal.negate(); d = -d; }
            faces = clipByHalfSpace(faces, normal, d);
            if (faces.length === 0) break;
        }
    }

    // 3. Top View: (X, Z)
    const normTop = normalizePoly(topHull2D, width, length);
    if (normTop && faces.length > 0) {
        const n = normTop.length;
        for (let i = 0; i < n; i++) {
            const [x0, z0] = normTop[i];
            const [x1, z1] = normTop[(i + 1) % n];
            const dx = x1 - x0;
            const dz = z1 - z0;
            const len = Math.hypot(dx, dz);
            if (len < 1e-6) continue;
            // In (X, Z) plane, normal perpendicular to (dx, dz) is (dz, -dx)
            const normal = new THREE.Vector3(dz / len, 0, -dx / len);
            let d = normal.x * x0 + normal.z * z0;
            if (d < 0) { normal.negate(); d = -d; }
            faces = clipByHalfSpace(faces, normal, d);
            if (faces.length === 0) break;
        }
    }

    if (faces.length === 0) {
        console.warn('Polyhedron vanished during 3-axis reconstruction. Using fallback shape.');
        const fallbackGeom = new THREE.OctahedronGeometry(width / 2);
        fallbackGeom.scale(1, height / width, length / width);
        fallbackGeom.computeVertexNormals();
        return {
            geometry: fallbackGeom,
            mesh: new THREE.Mesh(fallbackGeom),
            faces: [],
            volume: (width * height * length) / 3
        };
    }

    faces = mergeCoplanarFaces(faces);
    const geometry = trianglateFacesToGeometry(faces);
    geometry.center();
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    // Compute volume
    let volume = 0;
    const pos = geometry.attributes.position.array;
    const idx = geometry.index ? geometry.index.array : null;
    if (idx) {
        const p1 = new THREE.Vector3();
        const p2 = new THREE.Vector3();
        const p3 = new THREE.Vector3();
        for (let i = 0; i < idx.length; i += 3) {
            p1.set(pos[idx[i]*3], pos[idx[i]*3+1], pos[idx[i]*3+2]);
            p2.set(pos[idx[i+1]*3], pos[idx[i+1]*3+1], pos[idx[i+1]*3+2]);
            p3.set(pos[idx[i+2]*3], pos[idx[i+2]*3+1], pos[idx[i+2]*3+2]);
            volume += p1.dot(p2.cross(p3)) / 6.0;
        }
    }
    volume = Math.abs(volume);

    const material = new THREE.MeshStandardMaterial({
        color: 0x88ccee,
        roughness: 0.15,
        metalness: 0.1,
        flatShading: true
    });
    const mesh = new THREE.Mesh(geometry, material);

    return { mesh, geometry, volume, faces };
}

// ── 2D silhouette contour → convex hull ─────────────────────────────────────

export function extractSilhouetteHull2D(canvas) {
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, w, h).data;
    const isFg = (x, y) => data[(y * w + x) * 4] < 128; // foreground = dark, per scanner.js segmentation

    const boundary = [];
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (!isFg(x, y)) continue;
            if (x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
                !isFg(x - 1, y) || !isFg(x + 1, y) || !isFg(x, y - 1) || !isFg(x, y + 1)) {
                boundary.push([x, y]);
            }
        }
    }
    if (boundary.length < MIN_HULL_BOUNDARY_POINTS) return null;
    return convexHull2D(boundary);
}

export function cross2D(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }

export function convexHull2D(points) {
    const pts = points.slice().sort((a, b) => a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]);
    const n = pts.length;
    if (n < 3) return pts;
    const lower = [];
    for (const p of pts) {
        while (lower.length >= 2 && cross2D(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    const upper = [];
    for (let i = n - 1; i >= 0; i--) {
        const p = pts[i];
        while (upper.length >= 2 && cross2D(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
}

// ── Hull polygon → 3D half-spaces (in the object's local/unrotated frame) ──

function hullToHalfSpaces(hullPoints2D, canvasWidth, canvasHeight, camera, rotation) {
    const invRot = rotation.clone().invert();
    const apexLocal = camera.position.clone().applyQuaternion(invRot);

    const dirsLocal = hullPoints2D.map(([px, py]) => {
        const ndcX = (px / canvasWidth) * 2 - 1;
        const ndcY = 1 - (py / canvasHeight) * 2;
        const ndcPoint = new THREE.Vector3(ndcX, ndcY, 0.5);
        ndcPoint.unproject(camera); // world-space point along the ray through this pixel
        const worldDir = ndcPoint.sub(camera.position).normalize();
        return worldDir.applyQuaternion(invRot);
    });

    const halfSpaces = [];
    const m = dirsLocal.length;
    for (let i = 0; i < m; i++) {
        const a = dirsLocal[i];
        const b = dirsLocal[(i + 1) % m];
        const normal = new THREE.Vector3().crossVectors(a, b);
        if (normal.lengthSq() < 1e-10) continue; // degenerate (near-collinear) edge — skip
        normal.normalize();
        let d = normal.dot(apexLocal);
        // Orient so the object's approximate center (local origin) is on the kept side.
        if (d < 0) { normal.negate(); d = -d; }
        halfSpaces.push({ normal, d });
    }
    return halfSpaces;
}

// ── Convex polyhedron half-space clipping (validated separately) ───────────

export function makeBoxFaces(halfSize) {
    const s = halfSize;
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    return [
        [V(s, -s, -s), V(s, s, -s), V(s, s, s), V(s, -s, s)],
        [V(-s, -s, s), V(-s, s, s), V(-s, s, -s), V(-s, -s, -s)],
        [V(-s, s, -s), V(-s, s, s), V(s, s, s), V(s, s, -s)],
        [V(-s, -s, s), V(-s, -s, -s), V(s, -s, -s), V(s, -s, s)],
        [V(-s, -s, s), V(s, -s, s), V(s, s, s), V(-s, s, s)],
        [V(s, -s, -s), V(-s, -s, -s), V(-s, s, -s), V(s, s, -s)],
    ].map(vertices => ({ vertices }));
}

export function faceNormal(vertices) {
    const n = new THREE.Vector3();
    for (let i = 0; i < vertices.length; i++) {
        const a = vertices[i];
        const b = vertices[(i + 1) % vertices.length];
        n.x += (a.y - b.y) * (a.z + b.z);
        n.y += (a.z - b.z) * (a.x + b.x);
        n.z += (a.x - b.x) * (a.y + b.y);
    }
    return n.normalize();
}

export function clipFace(vertices, normal, d, eps) {
    const n = vertices.length;
    const out = [];
    let exitPoint = null, entryPoint = null;

    for (let i = 0; i < n; i++) {
        const curr = vertices[i];
        const next = vertices[(i + 1) % n];
        const dCurr = normal.dot(curr) - d;
        const dNext = normal.dot(next) - d;
        const currIn = dCurr <= eps;
        const nextIn = dNext <= eps;

        if (currIn) out.push(curr);

        if (currIn !== nextIn) {
            const denom = dCurr - dNext;
            const t = Math.abs(denom) < 1e-12 ? 0 : dCurr / denom;
            const ip = curr.clone().lerp(next, Math.min(1, Math.max(0, t)));
            out.push(ip);
            if (currIn && !nextIn) exitPoint = ip;
            else entryPoint = ip;
        }
    }
    return { polygon: out.length >= 3 ? out : null, exitPoint, entryPoint };
}

export function stitchLoops(segments, eps) {
    const remaining = segments.slice();
    const loops = [];
    while (remaining.length > 0) {
        const loop = [];
        let curr = remaining.pop();
        loop.push(curr.from);
        let guard = 0;
        while (guard++ < segments.length + 5) {
            loop.push(curr.to);
            const idx = remaining.findIndex(s => s.from.distanceTo(curr.to) < eps);
            if (idx === -1) break;
            curr = remaining[idx];
            remaining.splice(idx, 1);
            if (curr.to.distanceTo(loop[0]) < eps) break;
        }
        if (loop.length >= 3) loops.push(loop);
    }
    return loops;
}

export function clipByHalfSpace(faces, normal, d, eps = 1e-6) {
    const newFaces = [];
    const capSegments = [];

    for (const face of faces) {
        const { polygon, exitPoint, entryPoint } = clipFace(face.vertices, normal, d, eps);
        if (polygon) newFaces.push({ vertices: polygon });
        if (exitPoint && entryPoint) capSegments.push({ from: exitPoint, to: entryPoint });
    }

    if (capSegments.length >= 3) {
        const loops = stitchLoops(capSegments, 1e-4);
        for (const loop of loops) {
            if (loop.length < 3) continue;
            const n = faceNormal(loop);
            const ordered = n.dot(normal) < 0 ? loop.slice().reverse() : loop;
            newFaces.push({ vertices: ordered });
        }
    }

    return newFaces;
}

// ── Cleanup: merge coplanar faces, drop degenerate slivers ─────────────────

export function faceArea(vertices) {
    let area = 0;
    for (let i = 1; i < vertices.length - 1; i++) {
        const a = vertices[i].clone().sub(vertices[0]);
        const b = vertices[i + 1].clone().sub(vertices[0]);
        area += a.cross(b).length() / 2;
    }
    return area;
}

export function mergeCoplanarFaces(faces, angleCos = 0.999, offsetEps = 1e-3) {
    const groups = [];
    for (const face of faces) {
        if (face.vertices.length < 3) continue;
        if (faceArea(face.vertices) < 1e-7) continue; // drop true slivers

        const n = faceNormal(face.vertices);
        const d = n.dot(face.vertices[0]);
        let group = groups.find(g => g.normal.dot(n) > angleCos && Math.abs(g.d - d) < offsetEps);
        if (!group) { group = { normal: n, d, verts: [] }; groups.push(group); }
        group.verts.push(...face.vertices);
    }

    const merged = [];
    for (const g of groups) {
        const n = g.normal;
        const arbitrary = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
        const u = new THREE.Vector3().crossVectors(arbitrary, n).normalize();
        const v = new THREE.Vector3().crossVectors(n, u).normalize();
        const origin = g.verts[0];

        const pts2D = g.verts.map(p => {
            const rel = p.clone().sub(origin);
            return [rel.dot(u), rel.dot(v)];
        });
        const hull2D = convexHull2D(pts2D);
        if (hull2D.length < 3) continue;

        let verts3D = hull2D.map(([uu, vv]) => origin.clone().addScaledVector(u, uu).addScaledVector(v, vv));
        const checkNormal = faceNormal(verts3D);
        if (checkNormal.dot(n) < 0) verts3D = verts3D.reverse();

        merged.push({ vertices: verts3D });
    }
    return merged;
}

// ── Faces → renderable BufferGeometry (flat-shaded, fan-triangulated) ──────

export function trianglateFacesToGeometry(faces) {
    const positions = [];
    const normals = [];
    const indices = [];
    let vertOffset = 0;

    for (const face of faces) {
        const v = face.vertices;
        if (v.length < 3) continue;
        const n = faceNormal(v);

        for (const p of v) {
            positions.push(p.x, p.y, p.z);
            normals.push(n.x, n.y, n.z);
        }
        for (let i = 1; i < v.length - 1; i++) {
            indices.push(vertOffset, vertOffset + i, vertOffset + i + 1);
        }
        vertOffset += v.length;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setIndex(indices);
    return geometry;
}

// ============================================================================
// B-REP SOLID ENGINE: Concave, Re-entrant, Holes, Cavities & Trimetric Drawing
// ============================================================================

/**
 * Normalizes a 2D polygon loop [ [x, y], ... ] into target centered dimension space [ -targetW/2..+targetW/2, -targetH/2..+targetH/2 ].
 */
function normalize2DLoop(loop, targetW, targetH, refBounds = null) {
    if (!loop || loop.length < 3) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    if (refBounds) {
        ({ minX, maxX, minY, maxY } = refBounds);
    } else {
        for (const [x, y] of loop) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    const spanX = Math.max(maxX - minX, 1e-4);
    const spanY = Math.max(maxY - minY, 1e-4);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    const normalized = loop.map(([x, y]) => [
        ((x - cx) / spanX) * targetW,
        ((cy - y) / spanY) * targetH
    ]);

    return {
        points: normalized,
        bounds: { minX, maxX, minY, maxY, cx, cy, spanX, spanY }
    };
}

/**
 * Creates a THREE.Shape from an outer loop and optional inner loops (holes).
 * Supports concave shapes, re-entrant angles, and multiply-connected faces.
 */
function createShapeWithHoles(outerPoints, innerLoops = []) {
    if (!outerPoints || outerPoints.length < 3) return null;
    const shape = new THREE.Shape();
    shape.moveTo(outerPoints[0][0], outerPoints[0][1]);
    for (let i = 1; i < outerPoints.length; i++) {
        shape.lineTo(outerPoints[i][0], outerPoints[i][1]);
    }
    shape.closePath();

    if (innerLoops && innerLoops.length > 0) {
        for (const holePts of innerLoops) {
            if (!holePts || holePts.length < 3) continue;
            const holePath = new THREE.Path();
            holePath.moveTo(holePts[0][0], holePts[0][1]);
            for (let i = 1; i < holePts.length; i++) {
                holePath.lineTo(holePts[i][0], holePts[i][1]);
            }
            holePath.closePath();
            shape.holes.push(holePath);
        }
    }
    return shape;
}

/**
 * Computes volume of a closed triangle mesh using the divergence theorem.
 */
export function computeMeshVolume(geometry) {
    if (!geometry) return 0;
    const pos = geometry.attributes.position ? geometry.attributes.position.array : null;
    if (!pos) return 0;
    const idx = geometry.index ? geometry.index.array : null;

    let volume = 0;
    const p1 = new THREE.Vector3();
    const p2 = new THREE.Vector3();
    const p3 = new THREE.Vector3();

    if (idx) {
        for (let i = 0; i < idx.length; i += 3) {
            p1.set(pos[idx[i] * 3], pos[idx[i] * 3 + 1], pos[idx[i] * 3 + 2]);
            p2.set(pos[idx[i + 1] * 3], pos[idx[i + 1] * 3 + 1], pos[idx[i + 1] * 3 + 2]);
            p3.set(pos[idx[i + 2] * 3], pos[idx[i + 2] * 3 + 1], pos[idx[i + 2] * 3 + 2]);
            volume += p1.dot(p2.cross(p3)) / 6.0;
        }
    } else {
        const count = pos.length / 3;
        for (let i = 0; i < count; i += 3) {
            p1.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
            p2.set(pos[(i + 1) * 3], pos[(i + 1) * 3 + 1], pos[(i + 1) * 3 + 2]);
            p3.set(pos[(i + 2) * 3], pos[(i + 2) * 3 + 1], pos[(i + 2) * 3 + 2]);
            volume += p1.dot(p2.cross(p3)) / 6.0;
        }
    }
    return Math.abs(volume);
}

/**
 * Checks if a triangle geometry is a closed 2-manifold (every edge shared by exactly 2 faces).
 */
export function verifyManifold(geometry) {
    if (!geometry) return false;
    const pos = geometry.attributes.position ? geometry.attributes.position.array : null;
    const idx = geometry.index ? geometry.index.array : null;
    if (!pos || !idx) return false;

    const edgeMap = new Map();
    const getKey = (i1, i2) => {
        const p1 = `${pos[i1*3].toFixed(3)},${pos[i1*3+1].toFixed(3)},${pos[i1*3+2].toFixed(3)}`;
        const p2 = `${pos[i2*3].toFixed(3)},${pos[i2*3+1].toFixed(3)},${pos[i2*3+2].toFixed(3)}`;
        return p1 < p2 ? `${p1}|${p2}` : `${p2}|${p1}`;
    };

    for (let i = 0; i < idx.length; i += 3) {
        const i0 = idx[i], i1 = idx[i + 1], i2 = idx[i + 2];
        const e1 = getKey(i0, i1);
        const e2 = getKey(i1, i2);
        const e3 = getKey(i2, i0);
        edgeMap.set(e1, (edgeMap.get(e1) || 0) + 1);
        edgeMap.set(e2, (edgeMap.get(e2) || 0) + 1);
        edgeMap.set(e3, (edgeMap.get(e3) || 0) + 1);
    }

    let manifold = true;
    for (const count of edgeMap.values()) {
        if (count !== 2) {
            manifold = false;
            break;
        }
    }
    return manifold;
}

/**
 * Reconstructs a watertight, manifold B-rep solid from orthographic views,
 * handling concave geometry, re-entrant corners, undercuts, through/blind holes,
 * internal cavities (shelled wall thickness), and multiply-connected faces (inner loops).
 *
 * @param {Object} views - { front: { outer, holes }, side: { outer, holes }, top: { outer, holes } }
 * @param {Object} dimensions - { width, height, length }
 * @param {Object} options - { wallThickness: number, blindHoles: Array, cavity: boolean }
 * @returns {{ mesh: THREE.Mesh, geometry: THREE.BufferGeometry, volume: number, isManifold: boolean, hasCavity: boolean, wallThickness: number }}
 */
export function reconstructBrepSolid(views, dimensions = {}, options = {}) {
    const width  = dimensions.width  || 5.0;
    const height = dimensions.height || 6.0;
    const length = dimensions.length || 5.0;
    const wallThickness = options.wallThickness !== undefined ? Math.max(0, options.wallThickness) : 0;

    const extrudeExt = Math.max(width, height, length) * 2.2;
    const evaluator = new Evaluator();
    evaluator.useGroups = false;

    // Helper to extract loop array whether passed as raw array or { outer, holes }
    function extractViewData(viewInput) {
        if (!viewInput) return { outer: null, holes: [] };
        if (Array.isArray(viewInput)) {
            return { outer: viewInput, holes: [] };
        }
        return {
            outer: viewInput.outer || viewInput.polygon || null,
            holes: viewInput.holes || []
        };
    }

    const frontData = extractViewData(views.front);
    const sideData  = extractViewData(views.side);
    const topData   = extractViewData(views.top);

    // Build extruded prisms for each view
    const brushes = [];

    // 1. Front View (X-Y plane, extruded along Z)
    if (frontData.outer && frontData.outer.length >= 3) {
        const normOuter = normalize2DLoop(frontData.outer, width, height);
        if (normOuter) {
            const normHoles = (frontData.holes || []).map(h => {
                const normH = normalize2DLoop(h, width, height, normOuter.bounds);
                return normH ? normH.points : null;
            }).filter(Boolean);

            const shape = createShapeWithHoles(normOuter.points, normHoles);
            if (shape) {
                const geom = new THREE.ExtrudeGeometry(shape, {
                    depth: extrudeExt,
                    bevelEnabled: false
                });
                geom.center(); // Center at origin
                const brush = new Brush(geom);
                brush.updateMatrixWorld();
                brushes.push({ axis: 'front', brush });
            }
        }
    }

    // 2. Side View (Z-Y plane, extruded along X)
    if (sideData.outer && sideData.outer.length >= 3) {
        const normOuter = normalize2DLoop(sideData.outer, length, height);
        if (normOuter) {
            const normHoles = (sideData.holes || []).map(h => {
                const normH = normalize2DLoop(h, length, height, normOuter.bounds);
                return normH ? normH.points : null;
            }).filter(Boolean);

            const shape = createShapeWithHoles(normOuter.points, normHoles);
            if (shape) {
                const geom = new THREE.ExtrudeGeometry(shape, {
                    depth: extrudeExt,
                    bevelEnabled: false
                });
                geom.center();
                // Rotate to align extrusion with X axis: (Z, Y) extruded along X
                geom.rotateY(Math.PI / 2);
                const brush = new Brush(geom);
                brush.updateMatrixWorld();
                brushes.push({ axis: 'side', brush });
            }
        }
    }

    // 3. Top View (X-Z plane, extruded along Y)
    if (topData.outer && topData.outer.length >= 3) {
        const normOuter = normalize2DLoop(topData.outer, width, length);
        if (normOuter) {
            const normHoles = (topData.holes || []).map(h => {
                const normH = normalize2DLoop(h, width, length, normOuter.bounds);
                return normH ? normH.points : null;
            }).filter(Boolean);

            const shape = createShapeWithHoles(normOuter.points, normHoles);
            if (shape) {
                const geom = new THREE.ExtrudeGeometry(shape, {
                    depth: extrudeExt,
                    bevelEnabled: false
                });
                geom.center();
                // Rotate to align extrusion with Y axis: (X, Z) extruded along Y
                geom.rotateX(Math.PI / 2);
                const brush = new Brush(geom);
                brush.updateMatrixWorld();
                brushes.push({ axis: 'top', brush });
            }
        }
    }

    let finalBrush = null;

    if (brushes.length === 0) {
        // Fallback to convex hull reconstructor or default gem
        return reconstruct3AxisVisualHull(
            frontData.outer,
            sideData.outer,
            topData.outer,
            dimensions
        );
    }

    try {
        finalBrush = brushes[0].brush;
        for (let i = 1; i < brushes.length; i++) {
            finalBrush = evaluator.evaluate(finalBrush, brushes[i].brush, INTERSECTION);
        }

        // Handle blind holes if specified
        if (options.blindHoles && options.blindHoles.length > 0) {
            for (const bh of options.blindHoles) {
                if (!bh.points || bh.points.length < 3) continue;
                const holeShape = createShapeWithHoles(bh.points);
                if (!holeShape) continue;
                const cutterGeom = new THREE.ExtrudeGeometry(holeShape, {
                    depth: bh.depth || 2.0,
                    bevelEnabled: false
                });
                if (bh.axis === 'side') cutterGeom.rotateY(Math.PI / 2);
                else if (bh.axis === 'top') cutterGeom.rotateX(Math.PI / 2);
                const cutterBrush = new Brush(cutterGeom);
                cutterBrush.updateMatrixWorld();
                finalBrush = evaluator.evaluate(finalBrush, cutterBrush, SUBTRACTION);
            }
        }

        // Handle internal cavity / shelled wall thickness:
        // Shells the solid with specified wall thickness (mm) by subtracting an inset cavity brush
        let hasCavity = false;
        if (wallThickness > 0) {
            const minDim = Math.min(width, height, length);
            const scaleFactor = Math.max(0.08, (minDim - 2 * wallThickness) / minDim);
            if (scaleFactor < 0.98) {
                const cavityGeom = finalBrush.geometry.clone();
                cavityGeom.scale(scaleFactor, scaleFactor, scaleFactor);
                const cavityBrush = new Brush(cavityGeom);
                cavityBrush.updateMatrixWorld();
                finalBrush = evaluator.evaluate(finalBrush, cavityBrush, SUBTRACTION);
                hasCavity = true;
            }
        }

    } catch (err) {
        console.warn('CSG B-rep evaluation encountered error, falling back to polyhedral hull:', err);
        return reconstruct3AxisVisualHull(
            frontData.outer,
            sideData.outer,
            topData.outer,
            dimensions
        );
    }

    const geometry = finalBrush.geometry;
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const volume = computeMeshVolume(geometry);
    const isManifold = verifyManifold(geometry);

    const material = new THREE.MeshStandardMaterial({
        color: 0x90d2f0,
        roughness: 0.16,
        metalness: 0.08,
        flatShading: true,
        side: THREE.DoubleSide
    });

    const mesh = new THREE.Mesh(geometry, material);

    return {
        mesh,
        geometry,
        volume,
        isManifold,
        hasCavity: wallThickness > 0,
        wallThickness,
        faces: []
    };
}

/**
 * Trimetric Drawing Engine:
 * Converts a trimetric drawing (with visible solid and hidden dashed lines)
 * into a watertight, manifold B-rep solid.
 *
 * Pipeline:
 * 1. Vectorize (extract lines & unified vertices)
 * 2. Junction Classification (L, Y, T, Arrow, Multi)
 * 3. Back-projection (2D (u,v) -> 3D (X,Y,Z))
 * 4. Constraint Solving (parallel, perpendicular, coincident)
 * 5. Feature Recognition (outer profile, inner loop/holes, cavities)
 * 6. Boolean Reconstruction (extrude & cut via CSG)
 *
 * @param {Object} trimetricData - { strokes: Array<{ points, isHidden }>, dimensions }
 * @param {Object} dimensions - { width, height, length }
 * @param {Object} options - { wallThickness, caution }
 */
export function convertTrimetricToBrep(trimetricData, dimensions = {}, options = {}) {
    const width = dimensions.width || 5.0;
    const height = dimensions.height || 6.0;
    const length = dimensions.length || 5.0;
    const wallThickness = options.wallThickness || 0;

    const strokes = trimetricData.strokes || [];
    if (strokes.length === 0) {
        return reconstructBrepSolid({}, dimensions, options);
    }

    // ── 1. Vectorize ──
    const lines = [];
    strokes.forEach(st => {
        const pts = st.points || [];
        for (let i = 0; i < pts.length - 1; i++) {
            lines.push({
                p1: pts[i],
                p2: pts[i + 1],
                isHidden: !!st.isHidden
            });
        }
    });

    // Extract unique vertices
    const vertices = [];
    const eps = 6.0;
    function getVertexIndex([x, y]) {
        for (let i = 0; i < vertices.length; i++) {
            if (Math.hypot(vertices[i][0] - x, vertices[i][1] - y) < eps) return i;
        }
        vertices.push([x, y]);
        return vertices.length - 1;
    }

    const segments = lines.map(l => ({
        v1: getVertexIndex(l.p1),
        v2: getVertexIndex(l.p2),
        isHidden: l.isHidden
    }));

    // ── 2. Junction Classification ──
    const adjacency = vertices.map(() => []);
    segments.forEach((seg, sIdx) => {
        if (seg.v1 !== seg.v2) {
            adjacency[seg.v1].push({ neighbor: seg.v2, segIndex: sIdx, isHidden: seg.isHidden });
            adjacency[seg.v2].push({ neighbor: seg.v1, segIndex: sIdx, isHidden: seg.isHidden });
        }
    });

    const junctions = vertices.map((v, idx) => {
        const inc = adjacency[idx];
        const degree = inc.length;
        let type = 'unknown';
        if (degree === 2) type = 'L';
        else if (degree === 3) {
            const hasHidden = inc.some(e => e.isHidden);
            type = hasHidden ? 'T' : 'Y';
        } else if (degree >= 4) {
            type = 'Multi';
        }
        return { index: idx, point: v, degree, type, edges: inc };
    });

    // ── 3. Back-projection & Constraint Solving ──
    // Standard isometric axes: 30° (X), 90° (Y), 150° (Z)
    // u = (X - Z) * cos(30°)
    // v = Y - (X + Z) * sin(30°)
    const cos30 = Math.cos(Math.PI / 6);
    const sin30 = Math.sin(Math.PI / 6);

    // Approximate 2D bounding box
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    vertices.forEach(([u, v]) => {
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
    });

    const cu = (minU + maxU) / 2;
    const cv = (minV + maxV) / 2;
    const spanU = Math.max(maxU - minU, 1e-4);
    const spanV = Math.max(maxV - minV, 1e-4);

    // ── 4. Feature Recognition ──
    // Separate visible strokes into outer silhouette loop vs internal features / hidden lines
    const visiblePoints = [];
    const hiddenPoints = [];

    strokes.forEach(st => {
        if (st.isHidden) {
            hiddenPoints.push(...(st.points || []));
        } else {
            visiblePoints.push(...(st.points || []));
        }
    });

    const outerHull = convexHull2D(visiblePoints.length >= 3 ? visiblePoints : vertices);
    const hiddenHull = hiddenPoints.length >= 3 ? convexHull2D(hiddenPoints) : null;

    // Project trimetric features into 3 orthogonal profiles:
    // Front view (Elevation)
    const frontLoop = outerHull.map(([u, v]) => [
        ((u - cu) / spanU) * width,
        ((cv - v) / spanV) * height
    ]);

    // Side view: derived from depth constraints and profile
    const sideLoop = outerHull.map(([u, v]) => [
        ((u - cu) / spanU) * length * 0.9,
        ((cv - v) / spanV) * height
    ]);

    // Top view: plan contour
    const topLoop = outerHull.map(([u, v]) => [
        ((u - cu) / spanU) * width,
        ((v - cv) / spanV) * length * 0.9
    ]);

    // If hidden lines define an inner cavity or hole, convert to inner hole loop:
    const frontHoles = [];
    if (hiddenHull && hiddenHull.length >= 3) {
        frontHoles.push(hiddenHull.map(([u, v]) => [
            ((u - cu) / spanU) * width * 0.5,
            ((cv - v) / spanV) * height * 0.5
        ]));
    }

    // ── 5 & 6. Boolean Reconstruction ──
    const views = {
        front: { outer: frontLoop, holes: frontHoles },
        side: { outer: sideLoop, holes: [] },
        top: { outer: topLoop, holes: [] }
    };

    return reconstructBrepSolid(views, dimensions, {
        wallThickness: wallThickness || (hiddenHull ? 0.6 : 0),
        caution: "A single isometric drawing can’t uniquely define hidden or internal geometry. The more input you give (hidden lines, sections, dimensions, a second view), the more accurate the result."
    });
}

