/* ============================================================
   rough-editor.js — Rough Shape Parameter Management
   Handles parameter state, locking, and debounced regeneration
   ============================================================ */

import * as THREE from 'three';

/**
 * Create a rough editor instance that manages shape parameters
 * and notifies listeners when parameters change.
 * 
 * @param {Object} initialState - Initial state object
 * @param {Function} onChange - Callback when parameters change
 * @returns {Object} Editor API
 */
export function createRoughEditor(initialState, onChange) {
  let state = { ...initialState.roughParams };
  let lockAspect = initialState.lockAspect;
  let changeCallback = onChange;
  let debounceTimer = null;

  // ── Public API ───────────────────────────────────────────

  return {
    /**
     * Get current parameters
     * @returns {Object} Current parameters
     */
    getParams() {
      return { ...state };
    },

    /**
     * Set a parameter value
     * @param {string} key - Parameter name
     * @param {number} value - New value
     */
    setParam(key, value) {
      // Update the parameter
      state[key] = value;

      // If aspect ratio is locked, update width when height changes
      if (lockAspect && key === 'height') {
        const aspect = state.aspectRatio || 1.2;
        state.width = value / aspect;
      }

      // If aspect ratio is locked, update height when width changes
      if (lockAspect && key === 'width') {
        const aspect = state.aspectRatio || 1.2;
        state.height = value * aspect;
      }

      // Debounced change notification
      this.notifyChange();
    },

    /**
     * Set aspect ratio lock state
     * @param {boolean} locked - Lock state
     */
    setLockAspect(locked) {
      lockAspect = locked;
    },

    /**
     * Notify listeners of parameter changes (debounced)
     */
    notifyChange() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        if (changeCallback) {
          changeCallback({ ...state });
        }
        debounceTimer = null;
      }, 50); // 50ms debounce
    },

    /**
     * Reset to default parameters for a shape type
     * @param {string} shapeType - Shape type
     */
    resetToDefaults(shapeType) {
      const defaults = {
        octahedron:  { height: 6.0, width: 5.0, aspectRatio: 1.2, twistAngle: 0 },
        dodecahedron:{ height: 6.0, width: 5.0, aspectRatio: 1.2, twistAngle: 0 },
        macle:       { height: 6.0, width: 5.0, aspectRatio: 1.2, twistAngle: 15 },
        makeable:    { height: 6.0, width: 5.0, aspectRatio: 1.2, twistAngle: 0 },
      };
      state = { ...defaults[shapeType] };
      this.notifyChange();
    }
  };
}