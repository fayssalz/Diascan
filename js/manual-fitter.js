/* ============================================================
   manual-fitter.js — Interactive Manual Positioning
   Allows user to drag/rotate/scale a faceted shape within
   the rough using TransformControls. Visualizes out-of-bounds
   clipping points in RED.
   ============================================================ */

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { extractConvexHull, pointInHull } from './volume-fitter.js';

let transformControls;
let currentObject = null;
let roughMesh = null;
let clippingPointsHelper = null;
let changeCallback = null;

// Red material for out-of-bounds points
const clippingMaterial = new THREE.PointsMaterial({
  color: 0xff3333,
  size: 0.15,
  transparent: true,
  opacity: 0.9,
  depthTest: false // render on top
});

/**
 * Initialize the TransformControls gizmo.
 * @param {THREE.Camera} camera - The main camera.
 * @param {HTMLElement} domElement - The renderer's DOM element.
 * @param {THREE.Scene} scene - The main scene.
 * @param {OrbitControls} orbitControls - Camera orbit controls.
 */
export function initManualFitter(camera, domElement, scene, orbitControls) {
  transformControls = new TransformControls(camera, domElement);
  scene.add(transformControls);

  // Create clipping points helper
  clippingPointsHelper = new THREE.Points(new THREE.BufferGeometry(), clippingMaterial);
  clippingPointsHelper.renderOrder = 999; // render on top
  scene.add(clippingPointsHelper);

  // Disable OrbitControls when dragging to prevent conflict
  transformControls.addEventListener('dragging-changed', (event) => {
    orbitControls.enabled = !event.value;
  });

  // Listen for changes (drag, rotate, scale)
  transformControls.addEventListener('change', () => {
    if (currentObject) {
      updateClippingVisualization();
      if (changeCallback) {
        changeCallback();
      }
    }
  });

  // Hide initially
  transformControls.visible = false;

  // Key shortcuts
  window.addEventListener('keydown', (event) => {
    if (!currentObject || !transformControls.visible) return;
    
    // Ignore if typing in an input
    if (event.target.tagName === 'INPUT') return;

    // --- Rotation with Ctrl/Cmd + Arrow Keys ---
    // This block handles rotation and will override the translation logic below if an arrow key is pressed with Ctrl/Cmd.
    if (event.ctrlKey || event.metaKey) {
      const rotStep = THREE.MathUtils.degToRad(1.0); // 1 degree step
      let rotChanged = false;

      switch (event.key.toLowerCase()) {
        case 'arrowup':
          currentObject.rotation.x += rotStep; // Pitch up
          rotChanged = true;
          break;
        case 'arrowdown':
          currentObject.rotation.x -= rotStep; // Pitch down
          rotChanged = true;
          break;
        case 'arrowleft':
          currentObject.rotation.z += rotStep; // Roll left
          rotChanged = true;
          break;
        case 'arrowright':
          currentObject.rotation.z -= rotStep; // Roll right
          rotChanged = true;
          break;
      }

      if (rotChanged) {
        event.preventDefault();
        updateClippingVisualization();
        if (changeCallback) changeCallback();
        return; // Do not proceed to translation logic
      }
    }

    const stepBase = 0.1;
    let multiplier = 1.0;
    if (event.shiftKey) multiplier = 10.0;
    const step = stepBase * multiplier;

    let changed = false;

    switch (event.key.toLowerCase()) {
      case 't': // Translate
        setFitterMode('translate');
        break;
      case 'r': // Rotate
        setFitterMode('rotate');
        break;
      case 's': // Scale
        setFitterMode('scale');
        break;
      case 'arrowup':
        currentObject.position.z -= step;
        changed = true;
        break;
      case 'arrowdown':
        currentObject.position.z += step;
        changed = true;
        break;
      case 'arrowleft':
        currentObject.position.x -= step;
        changed = true;
        break;
      case 'arrowright':
        currentObject.position.x += step;
        changed = true;
        break;
    }

    if (changed) {
      event.preventDefault();
      updateClippingVisualization();
      if (changeCallback) changeCallback();
    }
  });

  // Mouse wheel shortcuts
  domElement.addEventListener('wheel', (event) => {
    if (!currentObject || !transformControls.visible) return;

    // Alt + Wheel = Scale
    if (event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      const scaleStep = 0.05 * (event.deltaY > 0 ? -1 : 1);
      const newScale = Math.max(0.01, currentObject.scale.x + scaleStep);
      currentObject.scale.set(newScale, newScale, newScale);
      updateClippingVisualization();
      if (changeCallback) changeCallback();
    } 
    // Shift + Wheel = Translate Y (Elevation)
    else if (event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      const posStep = 0.1 * (event.deltaY > 0 ? -1 : 1);
      currentObject.position.y += posStep;
      updateClippingVisualization();
      if (changeCallback) changeCallback();
    }
  }, { passive: false });
}

/**
 * Sets the reference rough mesh for clipping detection.
 */
export function setRoughMeshForClipping(mesh) {
  roughMesh = mesh;
  updateClippingVisualization();
}

/**
 * Attach controls to a faceted shape object.
 */
export function attachTransformControls(object, onUpdate) {
  currentObject = object;
  changeCallback = onUpdate;
  transformControls.attach(object);
  transformControls.visible = true;
  updateClippingVisualization();
}

/**
 * Detach controls.
 */
export function detachTransformControls() {
  currentObject = null;
  changeCallback = null;
  transformControls.detach();
  transformControls.visible = false;
  
  // Clear clipping points
  if (clippingPointsHelper) {
    clippingPointsHelper.geometry.dispose();
    clippingPointsHelper.geometry = new THREE.BufferGeometry();
  }
}

/**
 * Get current transform mode ('translate', 'rotate', 'scale').
 */
export function setFitterMode(mode) {
  if (transformControls) {
    transformControls.setMode(mode);
  }
}

/**
 * Scan all vertices of the faceted shape, transform to world coordinates,
 * check if they lie inside the rough's convex hull, and visualize out-of-bounds vertices.
 */
export function updateClippingVisualization() {
  if (!currentObject || !roughMesh || !clippingPointsHelper) return;

  // 1. Extract rough hull planes
  let hull;
  try {
    hull = extractConvexHull(roughMesh.geometry);
  } catch (e) {
    console.error('Error extracting rough hull:', e);
    return;
  }
  const planes = hull.planes;

  // We need to account for rough mesh transform
  roughMesh.updateMatrixWorld();
  const roughWorldMatrix = roughMesh.matrixWorld;
  
  // Transform planes to world coordinates
  const worldPlanes = planes.map(plane => {
    const normal = plane.normal.clone().transformDirection(roughWorldMatrix).normalize();
    // A point on the plane in local space: plane.normal * plane.distance
    const ptOnPlane = plane.normal.clone().multiplyScalar(plane.distance).applyMatrix4(roughWorldMatrix);
    const distance = normal.dot(ptOnPlane);
    return { normal, distance };
  });

  // 2. Get faceted mesh vertices
  let facetedMesh = null;
  currentObject.traverse(child => {
    if (child.isMesh && !facetedMesh) {
      facetedMesh = child;
    }
  });

  if (!facetedMesh) return;

  facetedMesh.updateMatrixWorld();
  const facetedWorldMatrix = facetedMesh.matrixWorld;

  const posAttr = facetedMesh.geometry.getAttribute('position');
  const count = posAttr.count;

  // We sample vertices to keep performance high during dragging
  const step = Math.max(1, Math.floor(count / 150)); 
  const outOfBoundsPoints = [];

  const tempV = new THREE.Vector3();

  for (let i = 0; i < count; i += step) {
    tempV.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
    // Transform to world coordinates
    tempV.applyMatrix4(facetedWorldMatrix);

    // Test containment
    if (!pointInHull(tempV, worldPlanes, 0.02)) {
      outOfBoundsPoints.push(tempV.x, tempV.y, tempV.z);
    }
  }

  // Update geometry of clipping points helper
  clippingPointsHelper.geometry.dispose();
  const geometry = new THREE.BufferGeometry();
  
  if (outOfBoundsPoints.length > 0) {
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(outOfBoundsPoints, 3));
  }
  
  clippingPointsHelper.geometry = geometry;
}
