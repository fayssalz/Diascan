import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { 
  pointInHull, 
  allPointsInHull, 
  convexHullsIntersect, 
  computeCentroid 
} from '../js/volume-fitter.js';

test('Hyperplane separation theorem ensures two polyhedra partitioned by a plane are disjoint', () => {
  const cutNormal = new THREE.Vector3(0, 1, 0);
  const cutD = 0.0;
  const kerf = 0.15;
  const kHalf = kerf / 2;

  // Polyhedron A strictly below (cutD - kHalf): y <= -0.075
  const pointsA = [
    new THREE.Vector3(-1, -1.0, -1),
    new THREE.Vector3(1, -1.0, -1),
    new THREE.Vector3(1, -0.1, 1),
    new THREE.Vector3(-1, -0.1, 1),
    new THREE.Vector3(0, -0.08, 0) // highest point: y = -0.08 < -0.075
  ];

  // Polyhedron B strictly above (cutD + kHalf): y >= +0.075
  const pointsB = [
    new THREE.Vector3(-1, 0.08, -1), // lowest point: y = +0.08 > +0.075
    new THREE.Vector3(1, 0.08, -1),
    new THREE.Vector3(1, 1.2, 1),
    new THREE.Vector3(-1, 1.2, 1),
    new THREE.Vector3(0, 1.5, 0)
  ];

  // Plane A: normal (0, 1, 0), distance = -0.075 (y <= -0.075)
  const planeA = [{ normal: cutNormal.clone(), distance: cutD - kHalf }];
  // Plane B: normal (0, -1, 0), distance = -0.075 (-y <= -0.075 <=> y >= +0.075)
  const planeB = [{ normal: cutNormal.clone().negate(), distance: -(cutD + kHalf) }];

  // Verify all points of A satisfy Plane A
  assert.equal(allPointsInHull(pointsA, planeA), true, 'All points of A must lie on side A of cut');
  // Verify all points of B satisfy Plane B
  assert.equal(allPointsInHull(pointsB, planeB), true, 'All points of B must lie on side B of cut');

  // Verify none of points B satisfy Plane A
  for (const pb of pointsB) {
    assert.equal(pointInHull(pb, planeA), false, 'Points of B cannot lie inside halfspace A');
  }

  // Verify SAT reports no intersection between A and B
  const intersects = convexHullsIntersect(pointsA, pointsB, 0.01);
  assert.equal(intersects, false, 'Stones partitioned by separating plane cannot intersect');
});

test('Separating plane along arbitrary oblique crystal axis guarantees non-overlapping hulls', () => {
  // Diagonal axis (1, 1, 1) normalized
  const cutNormal = new THREE.Vector3(1, 1, 1).normalize();
  const cutD = 1.0;
  const kerf = 0.20;
  const kHalf = kerf / 2;

  // Box A offset in negative normal direction
  const centerA = cutNormal.clone().multiplyScalar(cutD - kHalf - 0.5);
  // Box B offset in positive normal direction
  const centerB = cutNormal.clone().multiplyScalar(cutD + kHalf + 0.5);

  const hullA = [
    centerA.clone().add(new THREE.Vector3(0.1, 0.1, 0.1)),
    centerA.clone().add(new THREE.Vector3(-0.1, -0.1, -0.1)),
    centerA.clone().add(new THREE.Vector3(0.1, -0.1, 0.1)),
    centerA.clone().add(new THREE.Vector3(-0.1, 0.1, -0.1))
  ];

  const hullB = [
    centerB.clone().add(new THREE.Vector3(0.1, 0.1, 0.1)),
    centerB.clone().add(new THREE.Vector3(-0.1, -0.1, -0.1)),
    centerB.clone().add(new THREE.Vector3(0.1, -0.1, 0.1)),
    centerB.clone().add(new THREE.Vector3(-0.1, 0.1, -0.1))
  ];

  const intersects = convexHullsIntersect(hullA, hullB, 0.01);
  assert.equal(intersects, false, 'Hulls separated along crystal diagonal axis do not intersect');
});

test('Recursive laser sawing into 3 chambers guarantees pairwise disjoint polyhedra (0 overlap)', () => {
  // Cut 1: divides rough along Y at y = 0 with kerf 0.15
  // Chamber A: y <= -0.075
  // Cut 2: divides positive half along X at x = 0 with kerf 0.15
  // Chamber B1: y >= 0.075 and x <= -0.075
  // Chamber B2: y >= 0.075 and x >= 0.075

  const pointsA = [
    new THREE.Vector3(-0.5, -0.1, -0.5),
    new THREE.Vector3(0.5, -0.1, -0.5),
    new THREE.Vector3(0.5, -1.0, 0.5),
    new THREE.Vector3(-0.5, -1.0, 0.5),
  ];

  const pointsB1 = [
    new THREE.Vector3(-0.1, 0.1, -0.5),
    new THREE.Vector3(-0.8, 0.1, -0.5),
    new THREE.Vector3(-0.8, 0.9, 0.5),
    new THREE.Vector3(-0.1, 0.9, 0.5),
  ];

  const pointsB2 = [
    new THREE.Vector3(0.1, 0.1, -0.5),
    new THREE.Vector3(0.8, 0.1, -0.5),
    new THREE.Vector3(0.8, 0.9, 0.5),
    new THREE.Vector3(0.1, 0.9, 0.5),
  ];

  // Pairwise SAT tests
  assert.equal(convexHullsIntersect(pointsA, pointsB1, 0.01), false, 'A and B1 must not intersect');
  assert.equal(convexHullsIntersect(pointsA, pointsB2, 0.01), false, 'A and B2 must not intersect');
  assert.equal(convexHullsIntersect(pointsB1, pointsB2, 0.01), false, 'B1 and B2 must not intersect');
});

test('Multi-obstacle separating planes isolate a 3rd stone between two obstacles with 0 overlap', () => {
  // Obstacle 1 at top (+Y, y in [1.0, 2.5])
  const obs1 = [
    new THREE.Vector3(-1, 1.0, -1),
    new THREE.Vector3(1, 1.0, -1),
    new THREE.Vector3(1, 2.5, 1),
    new THREE.Vector3(-1, 2.5, 1),
  ];

  // Obstacle 2 at bottom (-Y, y in [-2.5, -1.0])
  const obs2 = [
    new THREE.Vector3(-1, -2.5, -1),
    new THREE.Vector3(1, -2.5, -1),
    new THREE.Vector3(1, -1.0, 1),
    new THREE.Vector3(-1, -1.0, 1),
  ];

  // Pocket for Stone 3 in the middle: y in [-0.8, 0.8]
  // Separating plane 1: normal (0, 1, 0), distance = 1.0 - 0.1 = 0.9 (y <= 0.9)
  // Separating plane 2: normal (0, -1, 0), distance = -(-1.0 + 0.1) = 0.9 (-y <= 0.9 <=> y >= -0.9)
  const stone3 = [
    new THREE.Vector3(-0.5, -0.7, -0.5),
    new THREE.Vector3(0.5, -0.7, -0.5),
    new THREE.Vector3(0.5, 0.7, 0.5),
    new THREE.Vector3(-0.5, 0.7, 0.5),
  ];

  assert.equal(convexHullsIntersect(stone3, obs1, 0.01), false, 'Stone 3 must not intersect Obstacle 1');
  assert.equal(convexHullsIntersect(stone3, obs2, 0.01), false, 'Stone 3 must not intersect Obstacle 2');
  assert.equal(convexHullsIntersect(obs1, obs2, 0.01), false, 'Obstacle 1 and Obstacle 2 must not intersect');
});
