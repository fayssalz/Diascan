import * as THREE from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// Configuration
const GRID_RES   = 64;  // FIX: was 40. Higher = smoother marching-cubes output, more expensive.
const WORLD_SIZE  = 3.0; // Size of the cubic scan volume in world units.
const SMOOTH_ITERATIONS = 6;  // FIX: new — Laplacian smoothing passes on final mesh.
const SMOOTH_LAMBDA     = 0.5; // FIX: new — smoothing strength per iteration (0-1).

/**
 * Core Voxel Carving Function.
 * Carves a solid voxel cube using silhouette images taken at different angles,
 * then meshes the result with Marching Cubes.
 *
 * @param {Array}          frames  - Array of { canvas, rotation } silhouette frames.
 *                                   `rotation` is a THREE.Quaternion describing the
 *                                   object's orientation at capture time (FIX: was a
 *                                   single scalar `angle` around Y only — that made it
 *                                   impossible to constrain the top/bottom of the stone
 *                                   with real data. Callers now supply a full
 *                                   orientation per frame so multi-axis capture works).
 * @param {THREE.Camera}   camera  - Camera whose projection was used during scanning.
 * @param {Function}       onProgress - Progress callback (0–100).
 * @param {Object}         options - { gridRes, worldSize, smoothIterations, smoothLambda }
 * @returns {Promise<{ mesh: THREE.Mesh, geometry: THREE.BufferGeometry }>}
 */
export async function carveRoughDiamond(frames, camera, onProgress, options = {}) {
    const gridRes           = options.gridRes ?? GRID_RES;
    const worldSize         = options.worldSize ?? WORLD_SIZE;
    const smoothIterations  = options.smoothIterations ?? SMOOTH_ITERATIONS;
    const smoothLambda      = options.smoothLambda ?? SMOOTH_LAMBDA;

    // 1. ── Initialise scalar field ─────────────────────────────────────────
    // 1 = solid, 0 = carved away.
    const totalPoints = gridRes * gridRes * gridRes;
    const scalarField = new Float32Array(totalPoints).fill(1);

    const halfSize     = worldSize / 2;
    const pointSpacing = worldSize / (gridRes - 1);

    // Reused temporaries to avoid GC pressure inside the hot loop.
    const tempPoint = new THREE.Vector3();
    const projected = new THREE.Vector3();

    // 2. ── Voxel carving ───────────────────────────────────────────────────
    let frameIndex = 0;
    for (const frame of frames) {
        const { canvas, rotation } = frame; // FIX: rotation is a THREE.Quaternion now
        const ctx    = canvas.getContext('2d');
        const width  = canvas.width;
        const height = canvas.height;
        const imgData = ctx.getImageData(0, 0, width, height).data;

        for (let i = 0; i < totalPoints; i++) {
            if (scalarField[i] === 0) continue; // Already carved

            const xi = i % gridRes;
            const yi = Math.floor(i / gridRes) % gridRes;
            const zi = Math.floor(i / (gridRes * gridRes));

            tempPoint.set(
                xi * pointSpacing - halfSize,
                yi * pointSpacing - halfSize,
                zi * pointSpacing - halfSize
            );

            // FIX: apply the frame's full orientation instead of a single Y-axis
            // angle, so tilted capture passes actually constrain top/bottom geometry.
            tempPoint.applyQuaternion(rotation);

            // Project to Normalised Device Coordinates (NDC: -1 … +1).
            projected.copy(tempPoint).project(camera);

            // Points outside the view frustum are not visible → carve.
            if (projected.x < -1 || projected.x > 1 ||
                projected.y < -1 || projected.y > 1) {
                scalarField[i] = 0;
                continue;
            }

            // NDC → pixel coordinates.
            const px = Math.floor(((projected.x + 1) * width)  / 2);
            const py = Math.floor(((-projected.y + 1) * height) / 2);

            // Clamp to valid pixel range.
            if (px < 0 || px >= width || py < 0 || py >= height) {
                scalarField[i] = 0;
                continue;
            }

            const r = imgData[(py * width + px) * 4];

            // White pixel = background → carve this voxel away.
            // NOTE: this assumes the incoming canvas is already a clean binary
            // silhouette (background flood-filled to white, foreground black —
            // see the border flood-fill segmentation in scanner.js). If you feed
            // this a raw brightness-thresholded frame, internal sparkle/glints
            // on a transparent stone will falsely read as "background" here.
            if (r > 200) scalarField[i] = 0;
        }

        // Yield every few frames to keep the UI responsive.
        if (frameIndex % 4 === 0) {
            if (onProgress) onProgress(Math.round((frameIndex / frames.length) * 90)); // leave headroom for smoothing step
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        frameIndex++;
    }
    if (onProgress) onProgress(90);

    // Count remaining solid voxels for diagnostic.
    let solidCount = 0;
    for (let i = 0; i < totalPoints; i++) if (scalarField[i] > 0) solidCount++;
    console.log(`Voxel carving done. Solid voxels remaining: ${solidCount} / ${totalPoints}`);

    // 3. ── Build Marching Cubes mesh ───────────────────────────────────────
    const material = new THREE.MeshStandardMaterial({
        color: 0x88ccee,
        roughness: 0.2,
        metalness: 0.1,
    });

    const mesh = new MarchingCubes(gridRes, material, false, false, totalPoints * 3);
    mesh.frustumCulled = false;

    // MarchingCubes.field has size (gridRes + 2)³ with 1-cell padding on every
    // face. Writing to flat indices [0 … gridRes³-1] maps to the wrong voxel
    // positions, so we use the padded coordinate formula:
    //   fieldIdx = (z+1)*(N2)² + (y+1)*(N2) + (x+1)   where N2 = gridRes+2
    const N2 = gridRes + 2;

    mesh.field.fill(0);

    for (let zi = 0; zi < gridRes; zi++) {
        for (let yi = 0; yi < gridRes; yi++) {
            for (let xi = 0; xi < gridRes; xi++) {
                const src = zi * gridRes * gridRes + yi * gridRes + xi;
                const dst = (zi + 1) * N2 * N2 + (yi + 1) * N2 + (xi + 1);
                mesh.field[dst] = scalarField[src];
            }
        }
    }

    mesh.isolation = 0.5;
    mesh.update();

    mesh.scale.setScalar(worldSize);

    let vertCount = mesh.geometry?.attributes?.position?.count ?? 0;
    console.log(`Marching Cubes mesh generated. Vertex count: ${vertCount}`);

    // 4. ── Fallback: if nothing was carved, create a rough-looking sphere ──
    if (vertCount === 0) {
        console.warn('Marching Cubes produced empty geometry. Using fallback sphere.');
        const fallback = new THREE.Mesh(
            new THREE.SphereGeometry(worldSize / 2, 16, 12),
            material.clone()
        );
        fallback.geometry.computeVertexNormals();
        if (onProgress) onProgress(100);
        return { mesh: fallback, geometry: fallback.geometry };
    }

    // 5. ── FIX: Laplacian smoothing pass ───────────────────────────────────
    // Marching cubes at any finite grid resolution produces a stair-stepped /
    // blocky surface. This is the main reason the previous output looked
    // "awful" regardless of carving accuracy — it's a meshing artifact, not
    // a data problem. A few iterations of vertex-averaging smoothing over the
    // welded mesh remove most of that blockiness cheaply.
    try {
        const smoothed = laplacianSmooth(mesh.geometry, smoothIterations, smoothLambda);
        mesh.geometry.dispose();
        mesh.geometry = smoothed;
        vertCount = smoothed.attributes.position.count;
        console.log(`Smoothing applied. Final vertex count: ${vertCount}`);
    } catch (err) {
        console.warn('Smoothing failed, using raw marching-cubes geometry:', err);
    }

    if (onProgress) onProgress(100);

    return { mesh, geometry: mesh.geometry };
}

/**
 * FIX: new helper — umbrella-operator Laplacian smoothing.
 * Marching Cubes emits unindexed geometry (every triangle has its own
 * duplicate vertices), so there is no shared topology to smooth over. This
 * first welds coincident vertices (mergeVertices), builds an adjacency list
 * from the resulting index buffer, then repeatedly moves each vertex toward
 * the average position of its neighbors.
 *
 * Note: plain Laplacian smoothing shrinks volume slightly as iterations
 * increase. Keep iterations modest (5-8) and lambda around 0.5 for a good
 * smoothness/volume-preservation tradeoff. If you need zero shrinkage, swap
 * this for Taubin (lambda/mu) smoothing instead.
 */
function laplacianSmooth(geometry, iterations = 6, lambda = 0.5) {
    const merged  = mergeVertices(geometry, 1e-4);
    const posAttr = merged.getAttribute('position');
    const index   = merged.getIndex();

    if (!index) {
        console.warn('laplacianSmooth: no index after merge, skipping smoothing.');
        merged.computeVertexNormals();
        return merged;
    }

    const vertexCount = posAttr.count;
    const neighbors = Array.from({ length: vertexCount }, () => new Set());

    for (let i = 0; i < index.count; i += 3) {
        const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
        neighbors[a].add(b); neighbors[a].add(c);
        neighbors[b].add(a); neighbors[b].add(c);
        neighbors[c].add(a); neighbors[c].add(b);
    }

    let positions = new Float32Array(posAttr.array);

    for (let iter = 0; iter < iterations; iter++) {
        const next = new Float32Array(positions.length);
        for (let v = 0; v < vertexCount; v++) {
            const nbrs = neighbors[v];
            const vx = positions[v * 3], vy = positions[v * 3 + 1], vz = positions[v * 3 + 2];
            if (nbrs.size === 0) {
                next[v * 3] = vx; next[v * 3 + 1] = vy; next[v * 3 + 2] = vz;
                continue;
            }
            let ax = 0, ay = 0, az = 0;
            for (const nb of nbrs) {
                ax += positions[nb * 3];
                ay += positions[nb * 3 + 1];
                az += positions[nb * 3 + 2];
            }
            ax /= nbrs.size; ay /= nbrs.size; az /= nbrs.size;

            next[v * 3]     = vx + lambda * (ax - vx);
            next[v * 3 + 1] = vy + lambda * (ay - vy);
            next[v * 3 + 2] = vz + lambda * (az - vz);
        }
        positions = next;
    }

    merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    merged.computeVertexNormals();
    return merged;
}
