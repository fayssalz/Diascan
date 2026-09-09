/* ============================================================
   gem-loader.js — Custom .gem File Loader for Three.js
   Parses GemCAD-style ASCII .gem files OR falls back to
   procedurally generated models for binary Helium/Sarine .gem files.
   ============================================================ */

import * as THREE from 'three';
import { generateFacetedShape, ensureOutwardNormals } from './faceted-generators.js';

export class GEMLoader extends THREE.Loader {
  load(url, onLoad, onProgress, onError) {
    const scope = this;
    const loader = new THREE.FileLoader(this.manager);
    loader.setPath(this.path);
    loader.setRequestHeader(this.requestHeader);
    loader.setWithCredentials(this.withCredentials);

    loader.load(url, (text) => {
      try {
        onLoad(scope.parse(text, url));
      } catch (e) {
        if (onError) {
          onError(e);
        } else {
          console.error(e);
        }
        scope.manager.itemError(url);
      }
    }, onProgress, onError);
  }

  parse(text, url) {
    // Check if it is a binary Helium/Sarine MME format (.gem starting with TITLE 02)
    if (text && text.startsWith('TITLE 02')) {
      console.log('Detected binary Helium/Sarine .gem file:', url);
      
      // Extract shape type from filename
      const filename = url ? url.split('/').pop().toLowerCase() : '';
      let shapeKey = 'round';
      
      if (filename.includes('princess')) {
        shapeKey = 'princess';
      } else if (filename.includes('emerald')) {
        shapeKey = 'emerald';
      } else if (filename.includes('cushion')) {
        shapeKey = 'cushion';
      } else if (filename.includes('oval')) {
        shapeKey = 'oval';
      } else if (filename.includes('pear')) {
        shapeKey = 'pear';
      } else if (filename.includes('marquise')) {
        shapeKey = 'oval'; 
      } else if (filename.includes('stepcut')) {
        shapeKey = 'emerald';
      } else if (filename.includes('brilliant') || filename.includes('round')) {
        shapeKey = 'round';
      }
      
      console.log(`Mapping binary model to procedural shape: ${shapeKey}`);
      const { geometry, volume } = generateFacetedShape(shapeKey);
      ensureOutwardNormals(geometry);
      
      const mesh = new THREE.Mesh(geometry);
      const group = new THREE.Group();
      group.add(mesh);
      group.userData.volume = volume;
      group.userData.shapeKey = shapeKey;
      
      return group;
    }

    // Otherwise, parse as GemCAD ASCII
    const vertices = [];
    const indices = [];
    const lines = text.split('\n');

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const type = parts[0];

      if (type === 'v') {
        // Vertex line: v x y z
        const x = parseFloat(parts[1]);
        const y = parseFloat(parts[2]);
        const z = parseFloat(parts[3]);
        vertices.push(x, y, z);
      } else if (type === 'f') {
        // Facet line: f v1 v2 v3 ...
        // .gem files are 1-indexed, so we subtract 1
        const v1 = parseInt(parts[1], 10) - 1;

        // Create a triangle fan for polygons with 3 or more vertices
        for (let i = 2; i < parts.length - 1; i++) {
            const v_i = parseInt(parts[i], 10) - 1;
            const v_j = parseInt(parts[i + 1], 10) - 1;
            indices.push(v1, v_i, v_j);
        }
      }
    }

    if (vertices.length === 0) {
        throw new Error('GEMLoader: No vertices found in file.');
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    
    if (indices.length > 0) {
        geometry.setIndex(indices);
    }

    ensureOutwardNormals(geometry);
    geometry.computeBoundingSphere();

    // Approximate volume of the mesh using bounding box for GemCAD ASCII
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    const size = new THREE.Vector3();
    box.getSize(size);
    const volume = size.x * size.y * size.z * 0.5; // generic diamond bounding fill factor

    const mesh = new THREE.Mesh(geometry);
    const group = new THREE.Group();
    group.add(mesh);
    group.userData.volume = volume;
    group.userData.shapeKey = 'custom';

    return group;
  }
}