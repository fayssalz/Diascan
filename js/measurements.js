/* ============================================================
   measurements.js — Proportion & Weight Calculations
   Calculates volume, weight in carats, and dimensions.
   ============================================================ */

import * as THREE from 'three';
import { computeMeshVolume } from './volume-fitter.js';

// Diamond density: 3.515 g/cm³
export const DIAMOND_DENSITY = 3.515;

/**
 * Calculates proportions and carat weight for a given geometry.
 *
 * @param {THREE.BufferGeometry} geometry
 * @returns {Object} { volume, carat, dimensions: { x, y, z } }
 */
export function calculateGeometryProportions(geometry) {
  if (!geometry) {
    return { volume: 0, carat: 0, dimensions: { x: 0, y: 0, z: 0 } };
  }

  // Calculate volume in mm³
  const volume = computeMeshVolume(geometry);

  // Convert volume from mm³ to cm³ (divide by 1000)
  // Mass in grams = volume in cm³ * density
  // 1 Carat = 0.2 grams, so Carats = Mass / 0.2 = Mass * 5
  const carat = (volume / 1000.0) * DIAMOND_DENSITY * 5.0;

  // Calculate bounding box dimensions
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const dimensions = new THREE.Vector3();
  box.getSize(dimensions);

  return {
    volume,
    carat,
    dimensions: {
      x: dimensions.x,
      y: dimensions.y,
      z: dimensions.z
    }
  };
}

/**
 * Updates UI measurement cards.
 *
 * @param {number} roughCarat
 * @param {number} facetedCarat
 * @param {number} utilization (0.0 to 1.0)
 */
export function updateMeasurementUI(roughCarat, facetedCarat, utilization) {
  const roughVolEl = document.getElementById('meas-rough-vol');
  const facetedVolEl = document.getElementById('meas-faceted-vol');
  const utilizationEl = document.getElementById('meas-utilization');
  const yieldEl = document.getElementById('meas-yield');
  const utilFill = document.querySelector('.util-fill');

  // Format values
  const roughCaratStr = roughCarat.toFixed(3);
  const facetedCaratStr = facetedCarat.toFixed(3);
  const utilPercentStr = (utilization * 100).toFixed(1) + '%';
  const yieldCaratStr = facetedCarat.toFixed(3);

  // Update text contents
  if (roughVolEl) roughVolEl.textContent = roughCaratStr;
  if (facetedVolEl) facetedVolEl.textContent = facetedCaratStr;
  if (utilizationEl) utilizationEl.textContent = utilPercentStr;
  if (yieldEl) yieldEl.textContent = yieldCaratStr;

  // Update utilization bar visual representation
  if (utilFill) {
    const pct = Math.min(100, utilization * 100);
    utilFill.style.width = pct + '%';
    
    // Set color category
    utilFill.className = 'util-fill'; // reset
    if (pct >= 55) {
      utilFill.classList.add('high');
    } else if (pct >= 35) {
      utilFill.classList.add('medium');
    } else {
      utilFill.classList.add('low');
    }
  }
}
