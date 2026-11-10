/* ============================================================
   main.js — Application Entry Point & Controller
   Wires together scene, UI panels, rough editor, and all
   subsystems. Manages global application state.
   ============================================================ */

import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { Evaluator, Brush, INTERSECTION } from 'three-bvh-csg';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const csgEvaluator = new Evaluator();

import { GEMLoader } from './gem-loader.js';
import { ensureOutwardNormals } from './faceted-generators.js';
import { initScene, setRoughMesh, setFacetedMesh, toggleAxes, toggleGrid, resetCamera, getRenderer, getScene, getCamera, getControls } from './scene.js';
import { generateOctahedron, generateDodecahedron, generateMacle, generateMakeable } from './rough-generators.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { createRoughEditor } from './rough-editor.js';
import { initUIPanels, updateUIForShape } from './ui-panels.js';
import { 
  initManualFitter,
  attachTransformControls,
  detachTransformControls,
  setRoughMeshForClipping,
  updateClippingVisualization,
  setFitterMode
} from './manual-fitter.js';
import { 
  calculateGeometryProportions, 
  updateMeasurementUI 
} from './measurements.js';
import { 
  findMaxInscribedFit, 
  computeMeshVolume,
  placeMultipleStones,
  getWorldConvexHull,
  convexHullsIntersect
} from './volume-fitter.js';

// ── Application State ──────────────────────────────────────

const state = {
  // Current rough shape
  roughType: 'octahedron',       // 'octahedron' | 'dodecahedron' | 'macle' | 'makeable'
  roughParams: {
    height: 6.0,
    width: 5.0,
    length: 5.0,
    aspectRatio: 1.2,
    girdleThickness: 0.30,
    twistAngle: 0,               // macle only (degrees)
  },
  lockAspect: true,

  // Polished shapes
  polishedShapes: [],            // Array of { id, name, mesh, geometry, baseVolume, edges }
  selectedPolishedShape: null,   // Reference to an object in polishedShapes

  // Fitting mode
  fitMode: 'none',               // 'none' | 'manual'
  avoidOverlap: true,

  // View options
  roughWireframe: false,
  polishedEdges: false,
  showAxes: false,
  showGrid: true,
  transparency: false,

  // Measurements
  roughVolume: 0,
  roughCarats: 0,
  facetedVolume: 0,
  facetedCarats: 0,
  utilization: 0,
};

// ── Rough Material ─────────────────────────────────────────

const roughMaterial = new THREE.MeshPhysicalMaterial({
  color: 0xd4c8b0,
  metalness: 0.05,
  roughness: 0.3,
  clearcoat: 0.1,
  clearcoatRoughness: 0.2,
  reflectivity: 0.7,
  transparent: true,
  opacity: 0.6, // slightly more transparent to see fit better
  side: THREE.DoubleSide,
  envMapIntensity: 0.4,
});

const roughWireframeMaterial = new THREE.MeshBasicMaterial({
  color: 0xe94560,
  wireframe: true,
  transparent: true,
  opacity: 0.6,
});

const polishedEdgesMaterial = new THREE.LineBasicMaterial({
  color: 0xefefef,
  linewidth: 1,
  transparent: true,
  opacity: 0.7
});

// ── Initialization ─────────────────────────────────────────

function init() {
  // --- Mobile Viewport Height Fix ---
  // This addresses the issue on mobile browsers (like Samsung Browser) where
  // '100vh' can include the space for the browser's dynamic UI, causing
  // content at the bottom of the screen to be obscured. We calculate the
  // real visible height (`window.innerHeight`) and expose it as a CSS variable.
  const handleViewportHeight = () => {
    document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
  };

  window.addEventListener('resize', handleViewportHeight);
  handleViewportHeight(); // Initial call

  // Inject style rules to create a flexible column layout on mobile.
  // This makes the bottom panel flow naturally after the viewport, eliminating gaps.
  const style = document.createElement('style');
  style.textContent = `
    @media (max-width: 768px) and (orientation: portrait) {
      /* 1. Force a top-to-bottom layout for the entire app body */
      body {
        display: flex;
        flex-direction: column;
        height: calc(var(--vh, 1vh) * 100); /* Full real viewport height */
        overflow: hidden; /* Prevent the body itself from scrolling */
      }

      /* 2. The viewport should grow to fill available space not taken by panels. */
      #viewport {
        flex-grow: 1;
        min-height: 250px; /* Prevent it from becoming unusable if panels are large */
      }

      /* 3. The panel container now takes its natural content height. It is capped
         and scrollable, allowing the viewport above to fill the remaining space. */
      .right-panel, .properties-panel, .panel-container {
        position: static !important; /* Override any fixed/absolute positioning */
        flex-shrink: 0; /* Don't allow the panel to be squished */
        overflow-y: auto; /* Make the panel's content scrollable */
        max-height: 45vh; /* Cap the panel's height to prevent it from dominating the screen */
      }
    }
  `;
  document.head.appendChild(style);

  const viewportEl = document.getElementById('viewport');
  if (!viewportEl) {
    console.error('Viewport element not found');
    return;
  }

  // Init 3D scene
  const sceneAPI = initScene(viewportEl);

  // Init manual fitter (TransformControls)
  initManualFitter(getCamera(), getRenderer().domElement, getScene(), getControls());

  // Init rough editor (parameter management)
  const roughEditor = createRoughEditor(state, onRoughParamsChanged);

  // Init UI panels
  initUIPanels(state, {
    onShapeSelect: (type) => onShapeSelect(type),
    onParamChange: (key, value) => roughEditor.setParam(key, value),
    onLockAspect: (locked) => roughEditor.setLockAspect(locked),
    onRoughWireframeToggle: (on) => toggleRoughWireframe(on),
    onPolishedEdgesToggle: (on) => togglePolishedEdges(on),
    onAvoidOverlapToggle: (on) => { state.avoidOverlap = on; },
    onPolishedTransformChange: onPolishedTransformChange,
    onAxesToggle: (on) => toggleAxes(on),
    onGridToggle: (on) => toggleGrid(on),
    onResetCamera: () => resetCamera(),
    onAutoFit: () => onAutoFitAll(), // Corresponds to "Auto-Fit All" button
    onManualMode: () => onManualMode(),
    onFlipPolished: () => onFlipPolished(),
    onExportScreenshot: () => exportScreenshot(),
    onExportReport: () => exportReport(),
    onScanRoughClick: () => openScanner(),
  });

  // Bind scanner close events
  const closeScannerBtn = document.getElementById('close-scanner-btn');
  if (closeScannerBtn) {
    closeScannerBtn.addEventListener('click', closeScanner);
  }
  const scannerModal = document.getElementById('scanner-modal');
  if (scannerModal) {
    scannerModal.addEventListener('click', (e) => {
      if (e.target === scannerModal) {
        closeScanner();
      }
    });
  }

  // Handle messages from scanner iframe
  window.addEventListener('message', (event) => {
    const { type, geometry: serializedGeometry } = (event.data || {});

    if (type === 'SCANNED_MODEL' && serializedGeometry) {
      console.log('Received scanned model from 3-axis scanner.');
      state.scannedGeometry = deserializeGeometry(serializedGeometry);
      if (event.data.roughParams) {
        state.roughParams.height = event.data.roughParams.height || state.roughParams.height;
        state.roughParams.width = event.data.roughParams.width || state.roughParams.width;
        state.roughParams.length = event.data.roughParams.length || state.roughParams.length;
      }
      // Switch to Makeable and regenerate with the new geometry
      onShapeSelect('makeable');
    }

    if (type === 'SCAN_DONE') {
      setTimeout(closeScanner, 600);
    }
  });

  // Restore previously scanned geometry from localStorage
  try {
    const cached = localStorage.getItem('scanned_rough_geometry');
    if (cached) {
      const data = JSON.parse(cached);
      if (data && data.positions) {
        state.scannedGeometry = deserializeGeometry(data);
        console.log("Restored scanned geometry from localStorage.");
      }
    }
  } catch (e) {
    console.error("Failed to restore scanned geometry from localStorage:", e);
  }

  // Generate initial rough shape
  regenerateRough();

  // Bind Transform Mode UI Toolbar buttons
  const modeTranslateBtn = document.getElementById('btn-mode-translate');
  const modeRotateBtn = document.getElementById('btn-mode-rotate');
  const modeScaleBtn = document.getElementById('btn-mode-scale');
  
  if (modeTranslateBtn) {
    modeTranslateBtn.addEventListener('click', () => {
      setFitterMode('translate');
      modeTranslateBtn.classList.add('btn-primary');
      modeRotateBtn.classList.remove('btn-primary');
      modeScaleBtn.classList.remove('btn-primary');
    });
  }
  if (modeRotateBtn) {
    modeRotateBtn.addEventListener('click', () => {
      setFitterMode('rotate');
      modeTranslateBtn.classList.remove('btn-primary');
      modeRotateBtn.classList.add('btn-primary');
      modeScaleBtn.classList.remove('btn-primary');
    });
  }
  if (modeScaleBtn) {
    modeScaleBtn.addEventListener('click', () => {
      setFitterMode('scale');
      modeTranslateBtn.classList.remove('btn-primary');
      modeRotateBtn.classList.remove('btn-primary');
      modeScaleBtn.classList.add('btn-primary');
    });
  }

  // Update button states if keyboard shortcuts are used
  window.addEventListener('keydown', (event) => {
    if (event.target.tagName === 'INPUT') return;
    if (!state.selectedPolishedShape || state.fitMode !== 'manual') return;
    
    switch (event.key.toLowerCase()) {
      case 't':
        if(modeTranslateBtn) modeTranslateBtn.click();
        break;
      case 'r':
        if(modeRotateBtn) modeRotateBtn.click();
        break;
      case 's':
        if(modeScaleBtn) modeScaleBtn.click();
        break;
    }
  });

  // Prevent camera zoom with mouse wheel when modifier keys are pressed.
  // This allows the wheel to be used for other custom interactions like scaling/rotating objects.
  getRenderer().domElement.addEventListener('wheel', (event) => {
    if (event.shiftKey || event.altKey || event.ctrlKey) {
      // Stop the event from propagating to OrbitControls' listener.
      event.stopPropagation();

      // --- Custom Interaction: Scale with Shift + Mouse Wheel ---
      if (event.shiftKey && state.selectedPolishedShape) {
        const shape = state.selectedPolishedShape;
        const mesh = shape.mesh;
        
        const scaleStep = 0.01;
        const currentScale = mesh.scale.x;
        
        // event.deltaY is negative for wheel up (scale up), positive for wheel down (scale down)
        const delta = -Math.sign(event.deltaY) * scaleStep;
        let newScale = currentScale + delta;

        // Clamp the scale to the slider's range for consistency
        const scaleSlider = document.getElementById('param-polished-scale-slider');
        const minScale = parseFloat(scaleSlider.min);
        const maxScale = parseFloat(scaleSlider.max);
        newScale = THREE.MathUtils.clamp(newScale, minScale, maxScale);

        mesh.scale.set(newScale, newScale, newScale);

        updatePolishedTransformUI(mesh); // Sync UI sliders
        updateMeasurements();            // Update carat/yield
        updateClippingVisualization();   // Update red clipping dots
        highlightOverlaps();             // Update red overlap meshes
      }
      // --- Custom Interaction: Move along Y-axis with Alt + Mouse Wheel ---
      else if (event.altKey && state.selectedPolishedShape) {
        const shape = state.selectedPolishedShape;
        const mesh = shape.mesh;
        
        const moveStep = 0.01; // A reasonable step for position
        const currentY = mesh.position.y;
        
        // event.deltaY is negative for wheel up (move up), positive for wheel down (move down)
        const delta = -Math.sign(event.deltaY) * moveStep;
        let newY = currentY + delta;

        // Clamp the position to the slider's range for consistency
        const posYSlider = document.getElementById('param-polished-posY-slider');
        const minY = parseFloat(posYSlider.min);
        const maxY = parseFloat(posYSlider.max);
        newY = THREE.MathUtils.clamp(newY, minY, maxY);

        mesh.position.y = newY;

        updatePolishedTransformUI(mesh); // Sync UI sliders
        updateMeasurements();            // Update carat/yield
        updateClippingVisualization();   // Update red clipping dots
        highlightOverlaps();             // Update red overlap meshes
      }
      // --- Custom Interaction: Rotate around Y-axis with Ctrl + Mouse Wheel ---
      else if ((event.ctrlKey || event.metaKey) && state.selectedPolishedShape) {
        const shape = state.selectedPolishedShape;
        const mesh = shape.mesh;
        
        const rotStep = THREE.MathUtils.degToRad(1.0); // 1 degree step
        
        // event.deltaY is negative for wheel up, positive for wheel down
        const delta = -Math.sign(event.deltaY) * rotStep;
        
        // Apply rotation around the Y axis
        mesh.rotation.y += delta;

        updatePolishedTransformUI(mesh); // Sync UI sliders
        updateMeasurements();            // Update carat/yield
        updateClippingVisualization();   // Update red clipping dots
        highlightOverlaps();             // Update red overlap meshes
      }
    }
  }, { capture: true }); // Use capture phase to intercept the event early.

  // --- Touch Controls for Pinch-to-Scale in Manual Mode ---
  const rendererEl = getRenderer().domElement;
  let initialPinchDistance = 0;

  rendererEl.addEventListener('touchstart', (event) => {
    // Check for a two-finger touch gesture in manual mode
    if (state.fitMode !== 'manual' || !state.selectedPolishedShape || event.touches.length !== 2) {
      return;
    }
    
    // Prevent default browser zoom and disable camera controls for the gesture
    event.preventDefault();
    getControls().enabled = false;
    
    const t1 = event.touches[0];
    const t2 = event.touches[1];
    initialPinchDistance = Math.hypot(t1.pageX - t2.pageX, t1.pageY - t2.pageY);

  }, { passive: false });

  rendererEl.addEventListener('touchmove', (event) => {
    // Check if a two-finger pinch is in progress
    if (state.fitMode !== 'manual' || !state.selectedPolishedShape || event.touches.length !== 2 || initialPinchDistance <= 0) {
      return;
    }

    event.preventDefault();

    const t1 = event.touches[0];
    const t2 = event.touches[1];
    const currentPinchDistance = Math.hypot(t1.pageX - t2.pageX, t1.pageY - t2.pageY);

    const scaleFactor = currentPinchDistance / initialPinchDistance;
    
    const shape = state.selectedPolishedShape;
    const mesh = shape.mesh;
    
    let newScale = mesh.scale.x * scaleFactor;

    // Clamp the scale to the slider's range for consistency
    const scaleSlider = document.getElementById('param-polished-scale-slider');
    const minScale = parseFloat(scaleSlider.min);
    const maxScale = parseFloat(scaleSlider.max);
    newScale = THREE.MathUtils.clamp(newScale, minScale, maxScale);

    mesh.scale.set(newScale, newScale, newScale);

    updatePolishedTransformUI(mesh); // Sync UI sliders
    updateMeasurements();            // Update carat/yield
    updateClippingVisualization();   // Update red clipping dots
    highlightOverlaps();             // Update red overlap meshes

    // Update initial distance for the next move event, making scaling continuous
    initialPinchDistance = currentPinchDistance;
  }, { passive: false });

  rendererEl.addEventListener('touchend', (event) => {
    // The pinch gesture ends when fewer than 2 fingers are on the screen.
    // If a pinch was in progress, reset its state and re-enable camera controls.
    if (initialPinchDistance > 0 && event.touches.length < 2) {
      initialPinchDistance = 0;
      getControls().enabled = true;
    }
  });

  console.log('Diamond CAD initialized — rough type:', state.roughType);
}

// ── Shape Selection ────────────────────────────────────────

function onShapeSelect(type) {
  state.roughType = type;

  // Reset to sensible defaults per shape
  const defaults = {
    octahedron:  { height: 6.0, width: 5.0, length: 5.0, aspectRatio: 1.2, girdleThickness: 0.30, twistAngle: 0 },
    dodecahedron:{ height: 6.0, width: 5.0, length: 5.0, aspectRatio: 1.2, girdleThickness: 0.0, twistAngle: 0 },
    macle:       { height: 2.0, width: 5.0, length: 5.0, aspectRatio: 1.2, girdleThickness: 0.0, twistAngle: 15 },
    makeable:    { height: 6.0, width: 5.0, length: 5.0, aspectRatio: 1.2, girdleThickness: 0.0, twistAngle: 0 },
  };

  if (type === 'makeable' && state.scannedGeometry) {
    state.scannedGeometry.computeBoundingBox();
    const sz = new THREE.Vector3();
    state.scannedGeometry.boundingBox.getSize(sz);
    if (sz.x > 0.1 && sz.y > 0.1 && sz.z > 0.1) {
      defaults.makeable.width = parseFloat(sz.x.toFixed(2));
      defaults.makeable.height = parseFloat(sz.y.toFixed(2));
      defaults.makeable.length = parseFloat(sz.z.toFixed(2));
      defaults.makeable.aspectRatio = parseFloat((sz.x / sz.z).toFixed(2));
    }
  }

  state.roughParams = { ...defaults[type] };
  state.lockAspect = true;

  regenerateRough();
  
  // Update HTML elements (badges, labels)
  const overlayRoughType = document.getElementById('overlay-rough-type');
  if (overlayRoughType) overlayRoughType.textContent = type.charAt(0).toUpperCase() + type.slice(1);

  // Reset sliders in UI
  const heightSlider = document.getElementById('param-height-slider');
  const heightInput = document.getElementById('param-height-input');
  if (heightSlider && heightInput) {
    heightSlider.value = state.roughParams.height;
    heightInput.value = state.roughParams.height.toFixed(2);
  }
  const widthSlider = document.getElementById('param-width-slider');
  const widthInput = document.getElementById('param-width-input');
  if (widthSlider && widthInput) {
    widthSlider.value = state.roughParams.width;
    widthInput.value = state.roughParams.width.toFixed(2);
  }
  const lengthSlider = document.getElementById('param-length-slider');
  const lengthInput = document.getElementById('param-length-input');
  if (lengthSlider && lengthInput) {
    lengthSlider.value = state.roughParams.length;
    lengthInput.value = state.roughParams.length.toFixed(2);
  }

  // Show/hide the correct parameter sliders for the selected shape.
  updateUIForShape(type);
}

// ── Rough Regeneration ─────────────────────────────────────

function onRoughParamsChanged(params) {
  state.roughParams = { ...params };
  regenerateRough();
}

async function regenerateRough() {
  let geometry;

  switch (state.roughType) {
    case 'octahedron':
      geometry = generateOctahedron(state.roughParams);
      break;
    case 'dodecahedron':
      geometry = await generateDodecahedron(state.roughParams);
      break;
    case 'macle':
      // Pass all rough parameters to the generator.
      geometry = await generateMacle(state.roughParams);
      break;
    case 'makeable':
      if (state.scannedGeometry) {
        geometry = state.scannedGeometry.clone();
        geometry.center();
        geometry.computeBoundingBox();
        const bbSize = new THREE.Vector3();
        geometry.boundingBox.getSize(bbSize);
        // Guard against degenerate bounding box
        const sx = bbSize.x > 0.001 ? state.roughParams.width  / bbSize.x : 1;
        const sy = bbSize.y > 0.001 ? state.roughParams.height / bbSize.y : 1;
        const sz = bbSize.z > 0.001 ? state.roughParams.length / bbSize.z : 1;
        geometry.scale(sx, sy, sz);
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
      } else {
        geometry = await generateMakeable(state.roughParams);
      }
      break;
    default:
      geometry = generateOctahedron(state.roughParams);
  }

  const material = state.roughWireframe ? roughWireframeMaterial : roughMaterial;
  const mesh = new THREE.Mesh(geometry, material);
  setRoughMesh(mesh);
  setRoughMeshForClipping(mesh);

  // Compute rough volume
  const props = calculateGeometryProportions(geometry);
  state.roughVolume = props.volume;
  state.roughCarats = props.carat;

  // Re-calculate utilization if a faceted model is loaded
  updateMeasurements();
  updateStatusBar();
  updateRoughDimensionsUI();
}

// ── View Toggles ───────────────────────────────────────────

function toggleRoughWireframe(on) {
  state.roughWireframe = on;
  regenerateRough();
}

function togglePolishedEdges(on) {
  state.polishedEdges = on;
  state.polishedShapes.forEach(shape => {
    if (shape.edges) {
      shape.edges.visible = on;
    }
  });
}

export function loadFacetedModel(fileOrPath, type) {
  let loader;
  if (type === 'gltf') {
    loader = new GLTFLoader();
  } else if (type === 'gem') {
    loader = new GEMLoader();
  } else { // 'obj'
    loader = new OBJLoader();
  }

  const isFile = fileOrPath instanceof File;
  const url = isFile ? URL.createObjectURL(fileOrPath) : fileOrPath;

  loader.load(
    url,
    (loadedObject) => {
      const object = type === 'gltf' ? loadedObject.scene : loadedObject;
      const rawName = isFile ? fileOrPath.name : url.split('/').pop().replace('sample_helium_', '').replace(/\.(gem|obj|gltf|glb)$/i, '');
      const displayName = rawName.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      
      // Extract geometry from the loaded object
      let geometry = null;
      object.traverse((child) => {
        if (child.isMesh) {
          ensureOutwardNormals(child.geometry);
          // Semi-transparent nice blue diamond-like material
          child.material = new THREE.MeshPhysicalMaterial({
            color: 0x64b5f6,
            metalness: 0.1,
            roughness: 0.1,
            transmission: 0.6,
            ior: 2.4, // diamond refractive index
            thickness: 2.0,
            transparent: true,
            opacity: 0.8,
            side: THREE.DoubleSide
          });
          geometry = child.geometry;
          if (!geometry.attributes.normal) {
            geometry.computeVertexNormals();
          }
          geometry.computeBoundingBox(); // Ensure box is computed for centering
          geometry.computeBoundsTree();  // Required for three-bvh-csg
        }
      });

      if (!geometry) {
        console.error("Could not find a mesh with geometry in the loaded model.");
        if (isFile) URL.revokeObjectURL(url);
        return;
      }

      // Center the geometry
      // This is critical for the auto-fit collision detection to work correctly.
      // It ensures the geometry's bounding box is centered at the object's local origin.
      geometry.center();

      // Extract or compute base volume
      const baseVolume = (object.userData && object.userData.volume) ? object.userData.volume : computeMeshVolume(geometry);

      // Create edge lines for the polished shape
      const edgesGeom = new THREE.EdgesGeometry(geometry);
      const edges = new THREE.LineSegments(edgesGeom, polishedEdgesMaterial);
      edges.visible = state.polishedEdges;
      object.add(edges); // Attach edges to the object to move/scale with it

      // Create the new polished shape object
      const newShape = {
        id: THREE.MathUtils.generateUUID(),
        name: displayName,
        mesh: object,
        geometry: geometry,
        baseVolume: baseVolume,
        edges: edges,
      };

      state.polishedShapes.push(newShape);
      getScene().getObjectByName('facetedGroup').add(object);

      console.log(`Polished shape "${displayName}" added to scene.`);

      updatePolishedShapesUI();
      selectPolishedShape(newShape.id);

      updateMeasurements();
      updateStatusBar();

      if (isFile) URL.revokeObjectURL(url); // Clean up memory
    },
    undefined,
    (error) => console.error('An error happened while loading the model:', error)
  );
}

// ── Polished Shape Management ──────────────────────────────

function updatePolishedShapesUI() {
  const listEl = document.getElementById('placed-shapes-list');
  listEl.innerHTML = '';

  if (state.polishedShapes.length === 0) {
    listEl.innerHTML = '<div class="faceted-item-placeholder">No polished shapes placed.</div>';
    document.getElementById('overlay-faceted-type').textContent = 'None';
  } else {
    document.getElementById('overlay-faceted-type').textContent = `${state.polishedShapes.length} Stone(s)`;
  }

  state.polishedShapes.forEach(shape => {
    const itemEl = document.createElement('div');
    itemEl.className = 'faceted-item';
    itemEl.dataset.id = shape.id;
    if (state.selectedPolishedShape && state.selectedPolishedShape.id === shape.id) {
      itemEl.classList.add('active');
    }

    itemEl.innerHTML = `
      <span class="faceted-icon">✨</span>
      <span class="faceted-name">${shape.name} <span id="ct-weight-${shape.id}" style="opacity: 0.7; font-size: 0.85em; margin-left: 5px;">(0.00 ct)</span></span>
      <button class="remove-btn">&times;</button>
    `;

    itemEl.addEventListener('click', (e) => {
      if (e.target.classList.contains('remove-btn')) {
        removePolishedShape(shape.id);
      } else {
        selectPolishedShape(shape.id);
      }
    });

    listEl.appendChild(itemEl);
  });
}

function selectPolishedShape(id) {
  const shape = state.polishedShapes.find(s => s.id === id);
  if (!shape) return;

  state.selectedPolishedShape = shape;
  console.log(`Selected polished shape: ${shape.name}`);

  // Update UI
  updatePolishedShapesUI();
  const paramsSection = document.getElementById('polished-params-section');
  paramsSection.style.display = '';
  document.getElementById('selected-polished-name').textContent = shape.name;

  // Sync all transform controls (scale, position, rotation)
  updatePolishedTransformUI(shape.mesh);

  // Update transform controls if in manual mode
  if (state.fitMode === 'manual') {
    attachTransformControls(shape.mesh, onManualFitUpdate);
  }
}

function removePolishedShape(id) {
  const index = state.polishedShapes.findIndex(s => s.id === id);
  if (index === -1) return;

  const shape = state.polishedShapes[index];
  console.log(`Removing polished shape: ${shape.name}`);

  // Remove from scene
  getScene().getObjectByName('facetedGroup').remove(shape.mesh);
  if (shape.geometry) shape.geometry.dispose();
  if (shape.edges.geometry) shape.edges.geometry.dispose();

  // Remove from state
  state.polishedShapes.splice(index, 1);

  // If it was selected, deselect it
  if (state.selectedPolishedShape && state.selectedPolishedShape.id === id) {
    state.selectedPolishedShape = null;
    document.getElementById('polished-params-section').style.display = 'none';
    document.getElementById('polished-dimensions-section').style.display = 'none';
    if (state.fitMode === 'manual') {
      state.fitMode = 'none';
      const btn = document.getElementById('manual-mode');
      if (btn) {
        btn.textContent = 'Manual Mode';
        btn.classList.remove('btn-primary');
      }
      const toolbar = document.getElementById('transform-mode-toolbar');
      if (toolbar) toolbar.style.display = 'none';
      detachTransformControls();
    }
  }

  updatePolishedShapesUI();
  updateMeasurements();
  updateStatusBar();
}

function onPolishedTransformChange(key, value) {
  if (!state.selectedPolishedShape) return;
  const mesh = state.selectedPolishedShape.mesh;
  
  // Key is in the format "polished-scale", "polished-posX", "polished-rotY", etc.
  const name = key.substring('polished-'.length); // "scale", "posX", "rotY"
  
  if (name === 'scale') {
    mesh.scale.set(value, value, value);
  } else if (name.startsWith('pos')) {
    const axis = name.substring(3).toLowerCase(); // "posX" -> "x"
    if (axis) {
      mesh.position[axis] = value;
    }
  } else if (name.startsWith('rot')) {
    const axis = name.substring(3).toLowerCase(); // "rotX" -> "x"
    if (axis) {
      // To ensure robust updates, especially when TransformControls is active,
      // we construct a new Euler angle from the current rotation and the new value,
      // then apply it. This avoids potential sync issues between Euler and Quaternion.
      const euler = new THREE.Euler().copy(mesh.rotation);
      euler[axis] = THREE.MathUtils.degToRad(value);
      mesh.setRotationFromEuler(euler);
    }
  }

  updateMeasurements();
  updateClippingVisualization();
  highlightOverlaps();
}

/** Flips the selected polished shape 180 degrees on its Z-axis */
function onFlipPolished() {
  if (!state.selectedPolishedShape) return;

  const mesh = state.selectedPolishedShape.mesh;
  
  // Flip 180 degrees around the Z axis (roll)
  mesh.rotation.z += Math.PI;

  // Update everything
  updatePolishedTransformUI(mesh);
  updateMeasurements();
  updateClippingVisualization();
  highlightOverlaps();
}

/** Helper to sync all polished parameter sliders with a mesh's state */
function updatePolishedTransformUI(mesh) {
  const { position, rotation, scale } = mesh;

  // Update scale
  document.getElementById('param-polished-scale-slider').value = scale.x;
  document.getElementById('param-polished-scale-input').value = scale.x.toFixed(2);
  document.getElementById('polished-scale-value').textContent = scale.x.toFixed(2);

  // Update position
  const pos = { x: position.x, y: position.y, z: position.z };
  for (const axis of ['X', 'Y', 'Z']) {
    const key = `polished-pos${axis}`;
    const val = pos[axis.toLowerCase()];
    document.getElementById(`param-${key}-slider`).value = val;
    document.getElementById(`param-${key}-input`).value = val.toFixed(2);
    document.getElementById(`${key}-value`).textContent = val.toFixed(2);
  }

  // Update rotation (convert radians to degrees for UI)
  const rot = { x: rotation.x, y: rotation.y, z: rotation.z };
  for (const axis of ['X', 'Y', 'Z']) {
    const key = `polished-rot${axis}`;
    const val = THREE.MathUtils.radToDeg(rot[axis.toLowerCase()]);
    document.getElementById(`param-${key}-slider`).value = val;
    document.getElementById(`param-${key}-input`).value = val.toFixed(2);
    document.getElementById(`${key}-value`).textContent = val.toFixed(2);
  }

  updatePolishedDimensionsUI();
}

function updatePolishedDimensionsUI() {
  const container = document.getElementById('polished-dimensions-grid');
  const section = document.getElementById('polished-dimensions-section');
  if (!container || !section) return;

  if (!state.selectedPolishedShape) {
    section.style.display = 'none';
    return;
  }

  const shape = state.selectedPolishedShape;
  const mesh = shape.mesh;
  const geom = shape.geometry;
  
  if (!geom.boundingBox) geom.computeBoundingBox();
  const box = geom.boundingBox;
  const size = new THREE.Vector3();
  box.getSize(size);
  
  // Apply scale
  size.multiply(mesh.scale);

  const name = shape.name.toLowerCase();
  let html = '';

  if (name.includes('round')) {
    // Round shape: Diameter and Height
    const diameter = Math.max(size.x, size.z);
    html = `
      <div class="measurement-card">
        <div class="meas-value">${diameter.toFixed(2)}</div>
        <div class="meas-label">Diameter (mm)</div>
      </div>
      <div class="measurement-card">
        <div class="meas-value">${size.y.toFixed(2)}</div>
        <div class="meas-label">Height (mm)</div>
      </div>
    `;
  } else {
    // Other shape: Length, Width, Height.
    // By convention, Length is the largest horizontal dimension.
    const length = Math.max(size.x, size.z);
    const width = Math.min(size.x, size.z);
    html = `
      <div class="measurement-card">
        <div class="meas-value">${length.toFixed(2)}</div>
        <div class="meas-label">Length (mm)</div>
      </div>
      <div class="measurement-card">
        <div class="meas-value">${width.toFixed(2)}</div>
        <div class="meas-label">Width (mm)</div>
      </div>
      <div class="measurement-card">
        <div class="meas-value">${size.y.toFixed(2)}</div>
        <div class="meas-label">Height (mm)</div>
      </div>
    `;
  }
  container.innerHTML = html;
  section.style.display = 'block';
}

/** Updates the UI with the rough stone's bounding box dimensions. */
function updateRoughDimensionsUI() {
  const container = document.getElementById('rough-dimensions-grid');
  const section = document.getElementById('rough-dimensions-section');
  if (!container || !section) return;

  const roughMesh = getScene().getObjectByName('roughGroup')?.children[0];
  if (!roughMesh) {
    section.style.display = 'none';
    return;
  }

  const geom = roughMesh.geometry;
  if (!geom.boundingBox) geom.computeBoundingBox();
  const box = geom.boundingBox;
  const size = new THREE.Vector3();
  box.getSize(size);

  const html = `
    <div class="measurement-card">
      <div class="meas-value">${size.z.toFixed(2)}</div>
      <div class="meas-label">Length (mm)</div>
    </div>
    <div class="measurement-card">
      <div class="meas-value">${size.x.toFixed(2)}</div>
      <div class="meas-label">Width (mm)</div>
    </div>
    <div class="measurement-card">
      <div class="meas-value">${size.y.toFixed(2)}</div>
      <div class="meas-label">Height (mm)</div>
    </div>
  `;
  container.innerHTML = html;
  section.style.display = 'block';
}

// ── Fitting Logic ──────────────────────────────────────────

async function onAutoFitAll() {
  const roughMesh = getScene().getObjectByName('roughGroup')?.children[0];
  if (!roughMesh) {
    console.warn('No rough mesh found for auto-fitting.');
    return;
  }
  if (state.polishedShapes.length === 0) {
    console.warn('Auto-fit requested, but no polished shapes are in the scene.');
    return;
  }

  // Turn status bar to "Computing"
  const statusLabel = document.querySelector('#statusbar .status-item span');
  if (statusLabel) statusLabel.textContent = 'Computing fit...';

  const placedObstacles = [];
  // Sort by base volume, largest first, for a better greedy placement
  const shapesToFit = [...state.polishedShapes].sort((a, b) => b.baseVolume - a.baseVolume);

  // When fitting exactly 2 stones with avoidOverlap enabled, execute Joint Laser Sawing Plane Optimization
  if (state.avoidOverlap && shapesToFit.length === 2) {
    await new Promise(resolve => {
      setTimeout(() => {
        try {
          const multiResult = placeMultipleStones(
            roughMesh,
            shapesToFit.map(s => s.geometry),
            shapesToFit.map(s => s.baseVolume),
            { kerfThickness: 0.15 }
          );

          if (multiResult && multiResult.placements && multiResult.placements.length === 2) {
            for (let i = 0; i < 2; i++) {
              const placement = multiResult.placements[i];
              const shape = shapesToFit[i];
              shape.mesh.position.copy(placement.result.offset);
              shape.mesh.rotation.copy(placement.result.rotation);
              shape.mesh.scale.set(placement.result.scale, placement.result.scale, placement.result.scale);
              shape.mesh.updateMatrixWorld(true);

              if (state.selectedPolishedShape && state.selectedPolishedShape.id === shape.id) {
                updatePolishedTransformUI(shape.mesh);
              }
            }
          }
        } catch (err) {
          console.error('Error during joint 2-stone placement:', err);
        }
        resolve();
      }, 20);
    });

    updateMeasurements();
    highlightOverlaps();
    if (statusLabel) statusLabel.textContent = 'Ready';
    updateStatusBar();
    return;
  }

  for (const shape of shapesToFit) {
    // Use a promise to ensure sequential execution with a small delay.
    // This prevents the UI from freezing during a long computation, allowing the status bar to update and the app to remain responsive.
    await new Promise(resolve => {
      setTimeout(() => {
        console.log(`Fitting ${shape.name}, with ${placedObstacles.length} obstacles.`);
        const fitOptions = {};
        if (state.avoidOverlap) {
          fitOptions.obstacles = placedObstacles;
        }
        fitOptions.roughType = state.roughType;

        const result = findMaxInscribedFit(
          roughMesh,
          shape.geometry,
          shape.baseVolume,
          fitOptions // Pass options
        );

        // --- Visualize search center for multi-stone fitting ---
        if (result.searchCenter) {
          const scene = getScene();
          // Remove previous helper if it exists
          const oldHelper = scene.getObjectByName('searchCenterHelper');
          if (oldHelper) {
            scene.remove(oldHelper);
            if (oldHelper.geometry) oldHelper.geometry.dispose();
            if (oldHelper.material) oldHelper.material.dispose();
          }

          const helperGeom = new THREE.SphereGeometry(0.1, 16, 8);
          const helperMat = new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true, depthTest: false });
          const searchCenterMarker = new THREE.Mesh(helperGeom, helperMat);
          searchCenterMarker.name = 'searchCenterHelper';
          searchCenterMarker.position.copy(result.searchCenter);
          searchCenterMarker.renderOrder = 999; // Render on top
          scene.add(searchCenterMarker);

          // Automatically remove the marker after a few seconds
          setTimeout(() => {
            if (searchCenterMarker.parent) {
              scene.remove(searchCenterMarker);
              searchCenterMarker.geometry.dispose();
              searchCenterMarker.material.dispose();
            }
          }, 5000);
        }

        console.log(`Fit for ${shape.name}:`, result);

        shape.mesh.position.copy(result.offset);
        shape.mesh.rotation.copy(result.rotation);
        shape.mesh.scale.set(result.scale, result.scale, result.scale);
        shape.mesh.updateMatrixWorld(true);
        
        placedObstacles.push(shape.mesh);

        // If this is the currently selected shape, update its parameter UI
        if (state.selectedPolishedShape && state.selectedPolishedShape.id === shape.id) {
          updatePolishedTransformUI(shape.mesh);
        }
        
        updateClippingVisualization(); // Update for manual fitter if active
        resolve();
      }, 20); // Small delay
    });
  }

  updateMeasurements();
  highlightOverlaps();
  if (statusLabel) statusLabel.textContent = 'Ready';
  updateStatusBar();
}

function onManualMode() {
  const btn = document.getElementById('manual-mode');
  const toolbar = document.getElementById('transform-mode-toolbar');
  if (!btn) return;

  if (state.fitMode === 'manual') {
    // End manual mode
    state.fitMode = 'none';
    btn.textContent = 'Manual Mode';
    btn.classList.remove('btn-primary');
    if (toolbar) toolbar.style.display = 'none';
    detachTransformControls();
  } else {
    if (!state.selectedPolishedShape) {
      console.warn('Select a polished shape before entering Manual Mode.');
      // Maybe flash a warning on the UI
      return;
    }
    // Start manual mode
    state.fitMode = 'manual';
    btn.textContent = 'End Manual';
    btn.classList.add('btn-primary');
    if (toolbar) toolbar.style.display = 'flex';
    attachTransformControls(state.selectedPolishedShape.mesh, onManualFitUpdate);
  }
}

function onManualFitUpdate() {
  if (!state.selectedPolishedShape) return;

  // Sync all parameter sliders with the transform control's changes
  updatePolishedTransformUI(state.selectedPolishedShape.mesh);

  updateMeasurements();
  highlightOverlaps();
}

// ── Overlap Highlighting ───────────────────────────────────

function highlightOverlaps() {
  const scene = getScene();
  
  // Remove existing overlap highlights
  const oldHighlights = scene.children.filter(c => c.name === 'overlapHighlight');
  oldHighlights.forEach(h => {
    scene.remove(h);
    if (h.geometry) h.geometry.dispose();
    if (h.material) h.material.dispose();
  });

  if (state.polishedShapes.length < 2) return;

  for (let i = 0; i < state.polishedShapes.length; i++) {
    for (let j = i + 1; j < state.polishedShapes.length; j++) {
      const shapeA = state.polishedShapes[i];
      const shapeB = state.polishedShapes[j];
      const geomA = shapeA.geometry;
      const geomB = shapeB.geometry;
      const meshA = shapeA.mesh;
      const meshB = shapeB.mesh;
      if (!geomA || !geomB || !meshA || !meshB) continue;

      // Fast check: if polyhedra are separated by SAT, they do not overlap
      const hullA = getWorldConvexHull(meshA);
      const hullB = getWorldConvexHull(meshB);
      if (!convexHullsIntersect(hullA, hullB, 0.005)) {
        continue;
      }

      if (!geomA.attributes.normal) geomA.computeVertexNormals();
      if (!geomB.attributes.normal) geomB.computeVertexNormals();

      const cleanGeomA = new THREE.BufferGeometry();
      cleanGeomA.setAttribute('position', geomA.attributes.position);
      cleanGeomA.setAttribute('normal', geomA.attributes.normal);
      if (geomA.index) cleanGeomA.setIndex(geomA.index);
      cleanGeomA.computeBoundsTree();

      const cleanGeomB = new THREE.BufferGeometry();
      cleanGeomB.setAttribute('position', geomB.attributes.position);
      cleanGeomB.setAttribute('normal', geomB.attributes.normal);
      if (geomB.index) cleanGeomB.setIndex(geomB.index);
      cleanGeomB.computeBoundsTree();

      const brushA = new Brush(cleanGeomA);
      brushA.position.copy(meshA.position);
      brushA.rotation.copy(meshA.rotation);
      brushA.scale.copy(meshA.scale);
      brushA.updateMatrixWorld(true);

      const brushB = new Brush(cleanGeomB);
      brushB.position.copy(meshB.position);
      brushB.rotation.copy(meshB.rotation);
      brushB.scale.copy(meshB.scale);
      brushB.updateMatrixWorld(true);

      let result = null;
      try {
        result = csgEvaluator.evaluate(brushA, brushB, INTERSECTION);
      } catch (err) {
        console.warn('CSG overlap evaluation skipped:', err);
      }
      
      // If there's an intersection, it will return a geometry with vertices
      if (result && result.geometry && result.geometry.attributes.position && result.geometry.attributes.position.count > 0) {
        result.name = 'overlapHighlight';
        result.material = new THREE.MeshBasicMaterial({ 
          color: 0xff0000, 
          depthTest: false, 
          transparent: true, 
          opacity: 0.9,
          wireframe: true
        });
        
        // Also add a solid red material to make it very obvious
        const solidMesh = new THREE.Mesh(
          result.geometry, 
          new THREE.MeshBasicMaterial({ color: 0xff0000, depthTest: false, transparent: true, opacity: 0.5 })
        );
        solidMesh.name = 'overlapHighlight';
        
        scene.add(result);
        scene.add(solidMesh);
      }
    }
  }
}

// ── Measurements Helper ────────────────────────────────────

function updateMeasurements() {
  let totalFacetedVolume = 0;

  state.polishedShapes.forEach(shape => {
    const scale = shape.mesh.scale.x;
    const currentVolume = shape.baseVolume * Math.pow(scale, 3);
    totalFacetedVolume += currentVolume;
    
    // Update individual carat weight in the list
    const ctWeight = (currentVolume / 1000.0) * 3.515 * 5.0;
    const ctSpan = document.getElementById(`ct-weight-${shape.id}`);
    if (ctSpan) {
      ctSpan.textContent = `(${ctWeight.toFixed(2)} ct)`;
    }
  });

  state.facetedVolume = totalFacetedVolume;
  state.facetedCarats = (state.facetedVolume / 1000.0) * 3.515 * 5.0;
  state.utilization = state.roughVolume > 0 ? state.facetedVolume / state.roughVolume : 0;

  updateMeasurementUI(state.roughCarats, state.facetedCarats, state.utilization);
}

// ── Export Functions ───────────────────────────────────────

function exportScreenshot() {
  const renderer = getRenderer();
  const dataURL = renderer.domElement.toDataURL('image/png');
  const link = document.createElement('a');
  link.download = `diamond-cad-${state.roughType}-${Date.now()}.png`;
  link.href = dataURL;
  link.click();
}

function exportReport() {
  const report = {
    timestamp: new Date().toISOString(),
    roughType: state.roughType,
    roughParams: state.roughParams,
    facetedModel: state.polishedShapes.map(s => s.name).join(', ') || 'None',
    measurements: {
      roughVolume_mm3: state.roughVolume.toFixed(2),
      roughCarat: state.roughCarats.toFixed(3),
      polishedVolume_mm3: state.facetedVolume.toFixed(2),
      polishedCarat: state.facetedCarats.toFixed(3),
      utilization: (state.utilization * 100).toFixed(1) + '%',
    },
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.download = `diamond-report-${Date.now()}.json`;
  link.href = URL.createObjectURL(blob);
  link.click();
  URL.revokeObjectURL(link.href);
}

// ── UI Helpers ─────────────────────────────────────────────

function updateStatusBar() {
  const typeEl = document.getElementById('status-shape');
  const scaleEl = document.getElementById('status-scale');
  const facetedEl = document.getElementById('status-faceted');

  if (typeEl) typeEl.textContent = state.roughType.charAt(0).toUpperCase() + state.roughType.slice(1);
  if (scaleEl) scaleEl.textContent = `${state.roughParams.height.toFixed(1)} × ${state.roughParams.width.toFixed(1)} × ${state.roughParams.length.toFixed(1)} mm`;
  if (facetedEl) {
    const count = state.polishedShapes.length;
    if (count === 0) facetedEl.textContent = '(none)';
    else if (count === 1) facetedEl.textContent = state.polishedShapes[0].name;
    else facetedEl.textContent = `${count} stones`;
  }
}

// ── Scanner UI Helpers ──────────────────────────────────────

function openScanner() {
  const modal = document.getElementById('scanner-modal');
  const iframe = document.getElementById('scanner-iframe');
  if (modal && iframe) {
    iframe.src = 'scan.html';
    modal.style.display = 'flex';
    modal.offsetHeight; // reflow
    modal.style.opacity = '1';
  }
}

function closeScanner() {
  const modal = document.getElementById('scanner-modal');
  const iframe = document.getElementById('scanner-iframe');
  if (modal && iframe) {
    modal.style.opacity = '0';
    setTimeout(() => {
      modal.style.display = 'none';
      iframe.src = 'about:blank'; // disable webcam feed
    }, 300);
  }
}

function deserializeGeometry(data) {
  if (!data?.positions?.length) {
    console.warn('deserializeGeometry: no position data, returning empty geometry.');
    return new THREE.BufferGeometry();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(data.positions), 3));
  if (data.indices?.length) {
    geometry.setIndex(data.indices);
  }
  ensureOutwardNormals(geometry);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

// ── Boot ───────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}