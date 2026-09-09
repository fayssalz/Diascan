import { loadFacetedModel } from './main.js';

/* ============================================================
   ui-panels.js — UI Panel Management
   Sets up and manages all UI elements: shape selector, sliders,
   buttons, and event binding.
   ============================================================ */

/**
 * Initialize all UI panels and bind event listeners
 * @param {Object} state - Application state
 * @param {Object} callbacks - Callback functions
 */
export function initUIPanels(state, callbacks) {
  // Bind shape selector buttons
  document.querySelectorAll('.shape-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const shapeType = btn.dataset.shape;
      if (callbacks.onShapeSelect) {
        callbacks.onShapeSelect(shapeType);
      }
    });
  });

  // Bind parameter sliders and inputs
  bindParameterControls('height', state.roughParams.height, callbacks.onParamChange);
  bindParameterControls('width', state.roughParams.width, callbacks.onParamChange);
  bindParameterControls('length', state.roughParams.length, callbacks.onParamChange);
  bindParameterControls('aspectRatio', state.roughParams.aspectRatio, callbacks.onParamChange);
  bindParameterControls('girdleThickness', state.roughParams.girdleThickness, callbacks.onParamChange);
  bindParameterControls('twistAngle', state.roughParams.twistAngle, callbacks.onParamChange);

  // --- Inject Rough Dimensions Display ---
  const roughParamsSection = document.getElementById('rough-params-section');
  if (roughParamsSection) {
    const panelContent = roughParamsSection.querySelector('.panel-content');
    if (panelContent) {
        const dimensionsSection = document.createElement('div');
        dimensionsSection.id = 'rough-dimensions-section';
        dimensionsSection.className = 'panel-subsection';
        dimensionsSection.style.cssText = 'margin-top: 15px; padding-top: 15px; border-top: 1px solid #333;';
        dimensionsSection.innerHTML = `
            <div class="subsection-header" style="margin-bottom: 10px; font-weight: bold; color: #ccc;">Rough Dimensions</div>
            <div id="rough-dimensions-grid" class="measurement-grid">
                <!-- Populated by JS -->
            </div>
        `;
        panelContent.appendChild(dimensionsSection);
    }
  }

  // Bind aspect ratio lock
  const lockToggle = document.getElementById('lock-aspect');
  if (lockToggle) {
    lockToggle.checked = state.lockAspect;
    lockToggle.addEventListener('change', (e) => {
      if (callbacks.onLockAspect) {
        callbacks.onLockAspect(e.target.checked);
      }
    });
  }

  // Bind view toggles
  bindToggle('rough-wireframe-toggle', state.roughWireframe, callbacks.onRoughWireframeToggle);
  bindToggle('polished-edges-toggle', state.polishedEdges, callbacks.onPolishedEdgesToggle);
  bindToggle('axes-toggle', state.showAxes, callbacks.onAxesToggle);
  bindToggle('grid-toggle', state.showGrid, callbacks.onGridToggle);

  // Bind action buttons
  bindButton('reset-camera', callbacks.onResetCamera);
  bindButton('auto-fit-all', callbacks.onAutoFit);
  bindButton('manual-mode', callbacks.onManualMode);
  bindButton('export-screenshot', callbacks.onExportScreenshot);
  bindButton('export-report', callbacks.onExportReport);
  bindButton('btn-scan-rough', callbacks.onScanRoughClick);

  // Bind polished shape parameter controls
  bindParameterControls('polished-scale', 1.0, callbacks.onPolishedTransformChange);
  bindParameterControls('polished-posX', 0.0, callbacks.onPolishedTransformChange);
  bindParameterControls('polished-posY', 0.0, callbacks.onPolishedTransformChange);
  bindParameterControls('polished-posZ', 0.0, callbacks.onPolishedTransformChange);
  bindParameterControls('polished-rotX', 0.0, callbacks.onPolishedTransformChange);
  bindParameterControls('polished-rotY', 0.0, callbacks.onPolishedTransformChange);
  bindParameterControls('polished-rotZ', 0.0, callbacks.onPolishedTransformChange);

  // --- Inject and bind Flip button ---
  const polishedParamsSection = document.getElementById('polished-params-section');
  if (polishedParamsSection && callbacks.onFlipPolished) {
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'panel-actions';
    // Basic styling to separate it from sliders
    actionsDiv.style.cssText = 'padding: 10px 15px; text-align: center; border-top: 1px solid #333; margin-top: 10px;';

    const flipBtn = document.createElement('button');
    flipBtn.id = 'flip-polished-btn';
    flipBtn.className = 'btn';
    flipBtn.textContent = 'Flip 180° (Z-axis)';
    flipBtn.title = 'Rotate the selected shape 180 degrees around its Z-axis.';
    
    flipBtn.addEventListener('click', callbacks.onFlipPolished);
    
    actionsDiv.appendChild(flipBtn);
    polishedParamsSection.appendChild(actionsDiv);
  }

  bindToggle('avoid-overlap-toggle', state.avoidOverlap, callbacks.onAvoidOverlapToggle);

  // Bind faceted model library buttons
  document.querySelectorAll('.model-btn').forEach(btn => {
    btn.addEventListener('click', () => loadFacetedModel(btn.dataset.file, 'gltf'));
  });

  populateGemLibrary();

  initFileHandling(document.getElementById('faceted-drop-zone'));
  
  // Initial UI update
  const listEl = document.getElementById('placed-shapes-list');
  listEl.innerHTML = '<div class="faceted-item-placeholder">No polished shapes placed.</div>';
  updateUIForShape(state.roughType);

  // Bind Mobile Drawer & Navigation Controls
  initMobileNavigation();
}

/**
 * Initialize Mobile Drawer & Navigation Bar Event Handlers
 */
function initMobileNavigation() {
  const sidebarLeft = document.getElementById('sidebar-left');
  const sidebarRight = document.getElementById('sidebar-right');
  const backdrop = document.getElementById('drawer-backdrop');

  const btnMobileLeft = document.getElementById('mobile-toggle-left');
  const btnMobileRight = document.getElementById('mobile-toggle-right');

  const closeLeft = document.getElementById('close-left-drawer');
  const closeRight = document.getElementById('close-right-drawer');

  const navLibrary = document.getElementById('nav-btn-library');
  const navParams = document.getElementById('nav-btn-params');
  const navCanvas = document.getElementById('nav-btn-canvas');

  function openLeftDrawer() {
    sidebarRight?.classList.remove('open');
    sidebarLeft?.classList.add('open');
    backdrop?.classList.add('active');
    updateNavState('library');
    triggerResize();
  }

  function openRightDrawer() {
    sidebarLeft?.classList.remove('open');
    sidebarRight?.classList.add('open');
    backdrop?.classList.add('active');
    updateNavState('params');
    triggerResize();
  }

  function closeAllDrawers() {
    sidebarLeft?.classList.remove('open');
    sidebarRight?.classList.remove('open');
    backdrop?.classList.remove('active');
    updateNavState('canvas');
    triggerResize();
  }

  function updateNavState(activeKey) {
    navLibrary?.classList.toggle('active', activeKey === 'library');
    navParams?.classList.toggle('active', activeKey === 'params');
    navCanvas?.classList.toggle('active', activeKey === 'canvas');
  }

  function triggerResize() {
    window.dispatchEvent(new Event('resize'));
  }

  btnMobileLeft?.addEventListener('click', openLeftDrawer);
  btnMobileRight?.addEventListener('click', openRightDrawer);

  closeLeft?.addEventListener('click', closeAllDrawers);
  closeRight?.addEventListener('click', closeAllDrawers);

  backdrop?.addEventListener('click', closeAllDrawers);

  navLibrary?.addEventListener('click', () => {
    if (sidebarLeft?.classList.contains('open')) closeAllDrawers();
    else openLeftDrawer();
  });

  navParams?.addEventListener('click', () => {
    if (sidebarRight?.classList.contains('open')) closeAllDrawers();
    else openRightDrawer();
  });

  navCanvas?.addEventListener('click', closeAllDrawers);
}

/**
 * Dynamically creates and adds buttons for pre-loaded .gem files.
 */
async function populateGemLibrary() {
  const libraryContainer = document.getElementById('faceted-library-list');
  if (!libraryContainer) {
    console.warn('Faceted library container not found. Cannot add .gem files.');
    return;
  }

  try {
    const response = await fetch('cuts/manifest.json');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const gemFiles = await response.json();

    gemFiles.forEach(gem => {
      const path = `cuts/${gem.file}`;
      const fileType = gem.type || (gem.file.endsWith('.gem') ? 'gem' : 'obj');
      const badgeText = fileType.toUpperCase();
      const btn = document.createElement('button');
      btn.className = 'faceted-item model-btn';
      btn.innerHTML = `
        <span class="faceted-icon">${gem.icon}</span>
        <span class="faceted-name">${gem.name}</span>
        <span class="faceted-badge">${badgeText}</span>
      `;
      btn.addEventListener('click', () => loadFacetedModel(path, fileType));
      libraryContainer.appendChild(btn);
    });
  } catch (error) {
    console.error("Could not load faceted model manifest 'cuts/manifest.json':", error);
  }
}

/**
 * Update UI elements based on selected shape
 * @param {string} shapeType - Selected shape type
 */
// ── Helper Functions ───────────────────────────────────────

function bindParameterControls(paramName, initialValue, onChange) {
  const slider = document.getElementById(`param-${paramName}-slider`);
  const input = document.getElementById(`param-${paramName}-input`);
  const labelVal = document.getElementById(`${paramName}-value`);

  if (slider && input) {
    // Set initial values
    slider.value = initialValue;
    input.value = initialValue.toFixed(2);
    if (labelVal) labelVal.textContent = initialValue.toFixed(2);

    // Bind slider change
    slider.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      input.value = value.toFixed(2);
      if (labelVal) labelVal.textContent = value.toFixed(2);
      if (onChange) onChange(paramName, value);
    });

    // Bind input change
    input.addEventListener('change', (e) => {
      let value = parseFloat(e.target.value);
      if (isNaN(value)) value = initialValue;
      slider.value = value;
      if (labelVal) labelVal.textContent = value.toFixed(2);
      if (onChange) onChange(paramName, value);
    });
  }
}

function bindToggle(elementId, initialValue, onChange) {
  const toggle = document.getElementById(elementId);
  if (toggle) {
    toggle.checked = initialValue;
    toggle.addEventListener('change', (e) => {
      if (onChange) onChange(e.target.checked);
    });
  }
}

function bindButton(elementId, onClick) {
  const button = document.getElementById(elementId);
  if (button && onClick) {
    button.addEventListener('click', onClick);
  }
}

// ── File Loading (Drag & Drop / Click-to-Open) ─────────────

function initFileHandling(element) {
  if (!element) return;

  // Create a hidden file input for the click-to-open dialog
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.obj,.glb,.gltf,.gem';
  fileInput.style.display = 'none';
  document.body.appendChild(fileInput);

  // --- Event Listeners ---

  element.addEventListener('dragover', (event) => {
    event.preventDefault();
    element.classList.add('dragover');
  });

  element.addEventListener('dragleave', () => {
    element.classList.remove('dragover');
  });

  element.addEventListener('drop', (event) => {
    event.preventDefault();
    element.classList.remove('dragover');
    const files = event.dataTransfer.files;
    if (files.length > 0) {
      handleFile(files[0]);
    }
  });

  element.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (event) => {
    const files = event.target.files;
    if (files.length > 0) {
      handleFile(files[0]);
    }
  });

  // Prevent browser from opening file when dropped outside the zone
  window.addEventListener('dragover', (event) => {
    event.preventDefault();
  });

  window.addEventListener('drop', (event) => {
    event.preventDefault();
    // Only handle the file if the drop is outside our designated zone
    // to avoid handling the same file drop twice.
    if (event.target !== element && !element.contains(event.target)) {
        handleFile(event.dataTransfer.files[0]);
    }
  });
}

function handleFile(file) {
  const fileName = file.name.toLowerCase();
  if (fileName.endsWith('.obj')) {
    loadFacetedModel(file, 'obj');
  } else if (fileName.endsWith('.glb') || fileName.endsWith('.gltf')) {
    loadFacetedModel(file, 'gltf');
  } else if (fileName.endsWith('.gem')) {
    loadFacetedModel(file, 'gem');
  } else {
    console.warn('Unsupported file type. Please drop an .obj, .glb, or .gltf file.');
  }
}
/**
 * Update UI elements based on selected shape
 * @param {string} shapeType - Selected shape type
 */
export function updateUIForShape(shapeType) {
  // Update shape selector active state
  document.querySelectorAll('.shape-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.shape === shapeType);
  });

  // Show/hide shape-specific parameter controls
  const twistGroup = document.getElementById('param-twist');
  const lengthGroup = document.getElementById('param-length');
  const girdleGroup = document.getElementById('param-girdle');
  
  // The twistAngle parameter is not used by current models.
  if (twistGroup) twistGroup.style.display = 'none';
  
  // The length slider is functional for all rough shapes.
  if (lengthGroup) lengthGroup.style.display = '';
  if (girdleGroup) girdleGroup.style.display = shapeType === 'octahedron' ? '' : 'none';

  // The scan button is only visible for makeable shape
  const scanRoughGroup = document.getElementById('param-scan-rough');
  if (scanRoughGroup) scanRoughGroup.style.display = shapeType === 'makeable' ? '' : 'none';
}