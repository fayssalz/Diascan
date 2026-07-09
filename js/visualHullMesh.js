import * as THREE from 'three';

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

// ── 2D silhouette contour → convex hull ─────────────────────────────────────

function extractSilhouetteHull2D(canvas) {
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

function cross2D(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }

function convexHull2D(points) {
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

function makeBoxFaces(halfSize) {
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

function faceNormal(vertices) {
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

function clipFace(vertices, normal, d, eps) {
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

function stitchLoops(segments, eps) {
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

function clipByHalfSpace(faces, normal, d, eps = 1e-6) {
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

function faceArea(vertices) {
    let area = 0;
    for (let i = 1; i < vertices.length - 1; i++) {
        const a = vertices[i].clone().sub(vertices[0]);
        const b = vertices[i + 1].clone().sub(vertices[0]);
        area += a.cross(b).length() / 2;
    }
    return area;
}

function mergeCoplanarFaces(faces, angleCos = 0.999, offsetEps = 1e-3) {
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

function trianglateFacesToGeometry(faces) {
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
