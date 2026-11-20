import {
  AdditiveBlending, Box3, BufferAttribute, BufferGeometry, CanvasTexture, DynamicDrawUsage, Group, Mesh, MeshBasicMaterial,
  Sprite, SpriteMaterial, Vector3,
} from 'three';

export const CAST_GLOW_SECONDS = 2.4;

/** One smooth charge/release, never a rapid full-screen flash. */
export function castGlowEnvelope(age: number): number {
  if (age < 0 || age >= CAST_GLOW_SECONDS) return 0;
  const smooth = (x: number) => x * x * (3 - 2 * x);
  return age < 0.3 ? smooth(age / 0.3) : 1 - smooth((age - 0.3) / 2.1);
}

const ARC_SEGMENTS = 20;
const ARC_SIDES = 5;
const VERTS_PER_ARC = (ARC_SEGMENTS + 1) * ARC_SIDES;

type ArcSpec = { offset: Vector3; staff: boolean; index: number };

/** Batch all core and halo energy arcs across both emitters into 2 draw calls
 * (down from 22) using vertex colors for per-filament brightness & visibility. */
function createBatchedEnergyArcs(model: Group, specs: readonly ArcSpec[]) {
  const totalVerts = specs.length * VERTS_PER_ARC;
  const corePositions = new Float32Array(totalVerts * 3);
  const haloPositions = new Float32Array(totalVerts * 3);
  const coreColors = new Float32Array(totalVerts * 3);
  const haloColors = new Float32Array(totalVerts * 3);
  const indices: number[] = [];

  for (let arcIdx = 0; arcIdx < specs.length; arcIdx++) {
    const baseVertex = arcIdx * VERTS_PER_ARC;
    for (let j = 0; j < ARC_SEGMENTS; j++) {
      for (let k = 0; k < ARC_SIDES; k++) {
        const a = baseVertex + j * ARC_SIDES + k;
        const b = baseVertex + j * ARC_SIDES + (k + 1) % ARC_SIDES;
        indices.push(a, b, a + ARC_SIDES, b, b + ARC_SIDES, a + ARC_SIDES);
      }
    }
  }

  const corePosAttr = new BufferAttribute(corePositions, 3).setUsage(DynamicDrawUsage);
  const haloPosAttr = new BufferAttribute(haloPositions, 3).setUsage(DynamicDrawUsage);
  const coreColAttr = new BufferAttribute(coreColors, 3).setUsage(DynamicDrawUsage);
  const haloColAttr = new BufferAttribute(haloColors, 3).setUsage(DynamicDrawUsage);

  const coreGeometry = new BufferGeometry();
  coreGeometry.setAttribute('position', corePosAttr);
  coreGeometry.setAttribute('color', coreColAttr);
  coreGeometry.setIndex(indices);

  const haloGeometry = new BufferGeometry();
  haloGeometry.setAttribute('position', haloPosAttr);
  haloGeometry.setAttribute('color', haloColAttr);
  haloGeometry.setIndex(indices);

  const coreMaterial = new MeshBasicMaterial({
    color: '#fff0f7', vertexColors: true, transparent: true,
    blending: AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const haloMaterial = new MeshBasicMaterial({
    color: '#ff164c', vertexColors: true, transparent: true,
    blending: AdditiveBlending, depthWrite: false, toneMapped: false,
  });

  const coreMesh = new Mesh(coreGeometry, coreMaterial);
  const haloMesh = new Mesh(haloGeometry, haloMaterial);
  coreMesh.name = 'vanec-lightning-core-batch';
  haloMesh.name = 'vanec-lightning-halo-batch';
  coreMesh.frustumCulled = haloMesh.frustumCulled = false;
  coreMesh.userData.dynamicFx = haloMesh.userData.dynamicFx = true;
  if (specs.length > 0) model.add(haloMesh, coreMesh);

  const points = Array.from({ length: ARC_SEGMENTS + 1 }, () => new Vector3());
  const tangent = new Vector3(), normal = new Vector3(), binormal = new Vector3();
  const up = new Vector3(0, 1, 0), right = new Vector3(1, 0, 0);
  const lastSeeds = new Float64Array(specs.length).fill(-1);
  const lastCoreAlpha = new Float32Array(specs.length).fill(-1);
  const lastHaloAlpha = new Float32Array(specs.length).fill(-1);
  const random = (seed: number) => { const n = Math.sin(seed * 127.1 + 311.7) * 43758.5453; return n - Math.floor(n); };

  const writeTubeSlice = (arr: Float32Array, arcIdx: number, offset: Vector3, radius: number) => {
    const vertexStart = arcIdx * VERTS_PER_ARC;
    for (let j = 0; j <= ARC_SEGMENTS; j++) {
      tangent.subVectors(points[Math.min(ARC_SEGMENTS, j + 1)], points[Math.max(0, j - 1)]).normalize();
      normal.crossVectors(tangent, Math.abs(tangent.y) > 0.9 ? right : up).normalize();
      binormal.crossVectors(tangent, normal);
      const width = radius * (0.15 + Math.sin(j / ARC_SEGMENTS * Math.PI) * 0.85);
      for (let k = 0; k < ARC_SIDES; k++) {
        const a = k / ARC_SIDES * Math.PI * 2, c = Math.cos(a) * width, s = Math.sin(a) * width;
        const pIdx = (vertexStart + j * ARC_SIDES + k) * 3;
        arr[pIdx] = offset.x + points[j].x + normal.x * c + binormal.x * s;
        arr[pIdx + 1] = offset.y + points[j].y + normal.y * c + binormal.y * s;
        arr[pIdx + 2] = offset.z + points[j].z + normal.z * c + binormal.z * s;
      }
    }
  };

  const writeColorSlice = (arr: Float32Array, arcIdx: number, value: number) => {
    const start = arcIdx * VERTS_PER_ARC * 3;
    const end = start + VERTS_PER_ARC * 3;
    for (let i = start; i < end; i++) arr[i] = value;
  };

  return {
    update(seconds: number, burst: number, reduced: boolean, hidden: boolean) {
      let posDirty = false, coreColDirty = false, haloColDirty = false;
      for (let arcIdx = 0; arcIdx < specs.length; arcIdx++) {
        const { offset, staff, index } = specs[arcIdx];
        const time = reduced ? 0.35 : seconds * (staff ? 6.3 : 7.7) + index * 0.713;
        const tick = Math.floor(time), seed = tick * 31 + index * 137 + (staff ? 900 : 0);
        if (seed !== lastSeeds[arcIdx]) {
          lastSeeds[arcIdx] = seed;
          const angle = random(seed + 1) * Math.PI * 2;
          const reach = 0.17 + random(seed + 2) * 0.15;
          for (let j = 0; j <= ARC_SEGMENTS; j++) {
            const t = j / ARC_SEGMENTS, taper = Math.sin(t * Math.PI);
            const noise = (n: number) => (random(seed + j * 7 + n) - 0.5) * 0.048 * taper;
            if (staff) {
              // Discharges crawl around the ruby in three dimensions, never a fixed branch silhouette.
              const theta = angle + t * (1.3 + random(seed + 3) * 2.4);
              points[j].set(Math.cos(theta) * 0.105 + noise(1), Math.sin(theta) * 0.14 + noise(2),
                Math.sin(theta * 2 + index) * 0.055 + noise(3));
            } else {
              // Each short-lived filament rises from the palm and curls back toward the energy center.
              const theta = angle + t * (2.2 + random(seed + 4) * 2);
              const radius = Math.sin(t * Math.PI) * (0.07 + random(seed + 5) * 0.055);
              points[j].set(Math.cos(theta) * radius + noise(1), t * reach + noise(2),
                Math.sin(theta) * radius + noise(3));
            }
          }
          writeTubeSlice(corePositions, arcIdx, offset, 0.0018);
          writeTubeSlice(haloPositions, arcIdx, offset, 0.007);
          posDirty = true;
        }
        const visible = index < (staff ? 3 : 4) || burst > 0.2;
        const discharge = reduced ? 0.45 : Math.pow(Math.sin((time - tick) * Math.PI), 0.6);
        const strength = visible ? discharge * (0.55 + random(seed + 20) * 0.45) * (hidden ? 0.45 : 1) : 0;
        const cAlpha = Math.fround(strength * (0.7 + burst * 0.3));
        const hAlpha = Math.fround(strength * (0.28 + burst * 0.42));
        if (lastCoreAlpha[arcIdx] !== cAlpha) {
          lastCoreAlpha[arcIdx] = cAlpha;
          writeColorSlice(coreColors, arcIdx, cAlpha);
          coreColDirty = true;
        }
        if (lastHaloAlpha[arcIdx] !== hAlpha) {
          lastHaloAlpha[arcIdx] = hAlpha;
          writeColorSlice(haloColors, arcIdx, hAlpha);
          haloColDirty = true;
        }
      }
      if (posDirty) { corePosAttr.needsUpdate = true; haloPosAttr.needsUpdate = true; }
      if (coreColDirty) coreColAttr.needsUpdate = true;
      if (haloColDirty) haloColAttr.needsUpdate = true;
    },
    dispose() {
      coreGeometry.dispose();
      haloGeometry.dispose();
      coreMaterial.dispose();
      haloMaterial.dispose();
      coreMesh.removeFromParent();
      haloMesh.removeFromParent();
    },
  };
}

/** Replace only the baked effect meshes; approved staff, hand and ruby geometry stay intact. */
export function createVanecLightning(model: Group) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(255,245,238,1)');
  gradient.addColorStop(0.12, 'rgba(255,145,160,.85)');
  gradient.addColorStop(0.35, 'rgba(245,20,65,.3)');
  gradient.addColorStop(1, 'rgba(190,0,25,0)');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 128, 128);
  const texture = new CanvasTexture(canvas);
  const glows: Array<{ sprite: Sprite; size: number; phase: number; source: boolean }> = [];
  const arcSpecs: ArcSpec[] = [];
  const emitters: Group[] = [];
  const addGlow = (parent: Group | Mesh, position: Vector3, size: number, source: boolean) => {
    const sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true,
      blending: AdditiveBlending, depthWrite: false, depthTest: true, toneMapped: false }));
    sprite.position.copy(position); sprite.scale.setScalar(size); parent.add(sprite);
    glows.push({ sprite, size, phase: glows.length * 1.7, source });
  };
  // Collect first: adding sprite children during traversal must not affect discovery.
  const meshes: Mesh[] = [];
  model.traverse(node => { if (node instanceof Mesh) meshes.push(node); });
  for (const mesh of meshes) {
    if (/^(Palm_Lightning_|Staff_Lightning_)/.test(mesh.name)) mesh.visible = false;
  }
  const addEmitter = (position: Vector3, staff: boolean) => {
    const emitter = new Group();
    emitter.userData.dynamicFx = true;
    emitter.position.copy(position);
    model.add(emitter);
    emitters.push(emitter);
    const count = staff ? 5 : 6;
    for (let i = 0; i < count; i++) arcSpecs.push({ offset: position.clone(), staff, index: i });
    addGlow(emitter, new Vector3(0, staff ? 0 : 0.1, 0), staff ? 0.29 : 0.24, true);
  };
  const palm = model.getObjectByName('Palm_Lightning_Main_Core');
  if (palm) addEmitter(palm.position.clone().add(new Vector3(0, 0.018, 0)), false);
  const ruby = model.getObjectByName('Staff_Ruby_Glow_Face_1');
  if (ruby) {
    model.updateMatrixWorld(true);
    const center = new Box3().setFromObject(ruby).getCenter(new Vector3());
    addEmitter(model.worldToLocal(center), true);
  }
  const batchedArcs = createBatchedEnergyArcs(model, arcSpecs);
  let castAt = -Infinity;
  return {
    cast(now: number) { castAt = now; },
    active(now: number) { return now - castAt < CAST_GLOW_SECONDS; },
    update(seconds: number, now: number, reduced: boolean, hidden: boolean) {
      const burst = castGlowEnvelope(now - castAt);
      batchedArcs.update(seconds, reduced ? burst * 0.3 : burst, reduced, hidden);
      for (const { sprite, size, phase, source } of glows) {
        const shimmer = reduced ? 1 : 0.9 + 0.1 * Math.sin(seconds * 4 + phase);
        // Reduced motion keeps a restrained, steady cast highlight; no expansion.
        sprite.scale.setScalar(size * (reduced ? 1 : shimmer + burst * (source ? 1.5 : 0.7)));
        sprite.material.opacity = (source ? 0.46 : 0.23) * shimmer * (1 + burst * (reduced ? 0.6 : 1.8)) * (hidden ? 0.45 : 1);
      }
    },
    dispose() {
      glows.forEach(({ sprite }) => { sprite.removeFromParent(); sprite.material.dispose(); });
      batchedArcs.dispose();
      emitters.forEach(emitter => emitter.removeFromParent());
      texture.dispose();
    },
  };
}
