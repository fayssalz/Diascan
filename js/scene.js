/* ============================================================
   scene.js — Three.js 3D Rendering Core
   Sets up renderer, camera, lights, orbit controls, grid,
   and manages scene object groups.
   ============================================================ */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ── Private State ──────────────────────────────────────────

let renderer, scene, camera, controls;
let roughGroup, facetedGroup, helperGroup;
let gridHelper, axisHelper;
let animationId;

// ── Initialization ─────────────────────────────────────────

export function initScene(viewportElement) {
  // Renderer
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: true, // needed for screenshot export
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(viewportElement.clientWidth, viewportElement.clientHeight);
  renderer.setClearColor(0x0d0d1a);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  viewportElement.appendChild(renderer.domElement);

  // Scene
  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0d0d1a, 15, 40);

  // Camera
  camera = new THREE.PerspectiveCamera(
    45,
    viewportElement.clientWidth / viewportElement.clientHeight,
    0.1,
    100
  );
  camera.position.set(6, 4, 8);
  camera.lookAt(0, 0, 0);

  // Orbit Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);
  controls.minDistance = 2;
  controls.maxDistance = 20;
  controls.maxPolarAngle = Math.PI * 0.8;
  controls.update();

  // Lighting
  setupLights();

  // Grid & Helpers
  setupHelpers();

  // Object Groups
  roughGroup = new THREE.Group();
  roughGroup.name = 'roughGroup';
  scene.add(roughGroup);

  facetedGroup = new THREE.Group();
  facetedGroup.name = 'facetedGroup';
  scene.add(facetedGroup);

  helperGroup = new THREE.Group();
  helperGroup.name = 'helperGroup';
  scene.add(helperGroup);

  // Animation Loop
  function animate() {
    animationId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  // Resize Handler
  window.addEventListener('resize', () => onResize(viewportElement));

  // ResizeObserver for element container size changes (drawer toggle, orientation)
  if (window.ResizeObserver) {
    const resizeObserver = new ResizeObserver(() => onResize(viewportElement));
    resizeObserver.observe(viewportElement);
  }

  return { scene, camera, renderer, controls };
}

// ── Lighting Setup ─────────────────────────────────────────

function setupLights() {
  // Ambient — soft fill
  const ambient = new THREE.AmbientLight(0x404060, 1.5);
  scene.add(ambient);

  // Hemisphere — sky/ground gradient
  const hemi = new THREE.HemisphereLight(0xddeeff, 0x0d0d1a, 0.8);
  scene.add(hemi);

  // Key Light — main directional with shadows
  const keyLight = new THREE.DirectionalLight(0xffffff, 4);
  keyLight.position.set(8, 12, 6);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.width = 2048;
  keyLight.shadow.mapSize.height = 2048;
  keyLight.shadow.camera.near = 0.5;
  keyLight.shadow.camera.far = 50;
  keyLight.shadow.camera.left = -10;
  keyLight.shadow.camera.right = 10;
  keyLight.shadow.camera.top = 10;
  keyLight.shadow.camera.bottom = -10;
  keyLight.shadow.bias = -0.0001;
  keyLight.shadow.normalBias = 0.02;
  scene.add(keyLight);

  // Fill Light — softer, opposite side
  const fillLight = new THREE.DirectionalLight(0x8899cc, 2);
  fillLight.position.set(-4, 2, -4);
  scene.add(fillLight);

  // Rim Light — back highlight for depth
  const rimLight = new THREE.DirectionalLight(0xffffff, 1.5);
  rimLight.position.set(0, 1, -6);
  scene.add(rimLight);
}

// ── Helpers ────────────────────────────────────────────────

function setupHelpers() {
  // Ground Grid
  gridHelper = new THREE.GridHelper(12, 20, 0x2a2a4a, 0x1a1a30);
  gridHelper.position.y = -3;
  scene.add(gridHelper);

  // Subtle second grid ring
  const grid2 = new THREE.PolarGridHelper(5, 32, 20, 64, 0x2a2a4a, 0x1a1a30);
  grid2.position.y = -3;
  scene.add(grid2);

  // Axis helper (hidden by default, toggleable)
  axisHelper = new THREE.AxesHelper(5);
  axisHelper.visible = false;
  scene.add(axisHelper);
}

// ── Resize Handler ─────────────────────────────────────────

function onResize(viewportElement) {
  const w = viewportElement.clientWidth;
  const h = viewportElement.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

// ── Public API ─────────────────────────────────────────────

/** Replace the contents of the rough group with a new mesh */
export function setRoughMesh(mesh) {
  clearGroup(roughGroup);
  if (mesh) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    roughGroup.add(mesh);
  }
}

/** Replace the contents of the faceted group with a new mesh */
export function setFacetedMesh(mesh) {
  clearGroup(facetedGroup);
  if (mesh) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    facetedGroup.add(mesh);
  }
}

/** Add a helper object (dimension lines, markers, etc.) */
export function addHelper(obj) {
  helperGroup.add(obj);
}

/** Clear all helper objects */
export function clearHelpers() {
  clearGroup(helperGroup);
}

/** Toggle axis helper visibility */
export function toggleAxes(visible) {
  axisHelper.visible = visible;
}

/** Toggle grid visibility */
export function toggleGrid(visible) {
  gridHelper.visible = visible;
}

/** Get the current renderer for screenshot export */
export function getRenderer() {
  return renderer;
}

/** Get the scene */
export function getScene() {
  return scene;
}

/** Get the camera */
export function getCamera() {
  return camera;
}

/** Get orbit controls */
export function getControls() {
  return controls;
}

/** Reset camera to default position */
export function resetCamera() {
  camera.position.set(6, 4, 8);
  controls.target.set(0, 0, 0);
  controls.update();
}

/** Dispose and clean up */
export function dispose() {
  if (animationId) cancelAnimationFrame(animationId);
  renderer.dispose();
  clearGroup(scene);
}

// ── Internal Helpers ───────────────────────────────────────

function clearGroup(group) {
  while (group.children.length > 0) {
    const child = group.children[0];
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (Array.isArray(child.material)) {
        child.material.forEach(m => m.dispose());
      } else {
        child.material.dispose();
      }
    }
    group.remove(child);
  }
}