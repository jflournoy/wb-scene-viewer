import * as THREE from 'three';

export function createBrainMesh(
  vertices: Float32Array,
  faces: Uint32Array,
  colors: Float32Array
): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geo.setIndex(new THREE.BufferAttribute(faces, 1));

  const colorAttr = new THREE.BufferAttribute(colors, 3);
  colorAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('color', colorAttr);

  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const mat = new THREE.MeshPhongMaterial({
    vertexColors: true,
    shininess: 30,
    specular: new THREE.Color(0x222222),
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geo, mat);
}

export function updateVertexColors(mesh: THREE.Mesh, newColors: Float32Array): void {
  const attr = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
  (attr.array as Float32Array).set(newColors);
  attr.needsUpdate = true;
}
