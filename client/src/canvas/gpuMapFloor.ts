import { acquireAnimatedMap } from './animatedMapMedia';
import { acquireMapTileTexture } from './mapTileTextures';
import {
  Color,
  Group,
  Mesh,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
  VideoTexture,
  WebGLRenderTarget,
  type Camera,
  type Texture,
  type WebGLRenderer,
} from 'three';

export type GpuMapFloorTile = {
  url: string;
  videoPath?: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type GpuMapFloorConfig = {
  tiles: readonly GpuMapFloorTile[];
  bounds: { x: number; y: number; w: number; h: number };
  grid?: { size: number; x: number; y: number; hot?: boolean };
  canvasBg: string;
  exploredBrightness: number;
};

type FloorEntry = {
  mesh: Mesh<PlaneGeometry, ShaderMaterial>;
  memory: Mesh<PlaneGeometry, ShaderMaterial>;
  material: ShaderMaterial;
  memoryMaterial: ShaderMaterial;
  ready: () => boolean;
  releaseTile: () => void;
  releaseVideo: () => void;
  videoTexture?: VideoTexture;
};

function cssColorToSrgbVec3(color: string): Vector3 {
  const c = new Color(color);
  const out = { r: 0, g: 0, b: 0 };
  c.getRGB(out, SRGBColorSpace);
  return new Vector3(out.r, out.g, out.b);
}

const VERTEX_SHADER = `varying vec2 artUv; varying vec3 world;
void main() {
  artUv = uv;
  world = (modelMatrix * vec4(position, 1.)).xyz;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.);
}`;

const FRAGMENT_SHADER = `uniform sampler2D art;
uniform float hasArt, gridSize, gridAlpha, gridMinStep, gridMaxStep, memoryPass, keepRevealed, memoryBrightness;
uniform vec2 gridOffset;
uniform vec3 fillColor, canvasBg;
varying vec2 artUv;
varying vec3 world;
void main() {
  vec4 source = hasArt > .5 ? texture2D(art, artUv) : vec4(fillColor, 1.);
  float grid = 0.;
  if (gridSize > 0.) {
    vec2 cell = (world.xz - gridOffset) / gridSize;
    vec2 d = abs(fract(cell - .5) - .5) / max(fwidth(cell), vec2(.0001));
    grid = 1. - smoothstep(gridMinStep, gridMaxStep, min(d.x, d.y));
  }
  if (memoryPass > .5) {
    vec3 remembered = mix(source.rgb, vec3(1.), grid * (80. / 255.));
    if (keepRevealed < .5) {
      remembered = vec3(dot(remembered, vec3(.2126, .7152, .0722)) * memoryBrightness);
    }
    gl_FragColor = vec4(remembered, source.a);
    return;
  }
  vec3 base = hasArt > .5 ? mix(canvasBg, source.rgb, source.a) : source.rgb;
  vec3 rgb = mix(base, vec3(1.), grid * gridAlpha);
  gl_FragColor = vec4(rgb, 1.);
}`;

/** Render the static/animated 2D battlemap tiles and grid inside the WebGL scene
 * so 3D camera gestures skip Konva 6152x4358 redraws and DOM SVG masks. */
export function createGpuMapFloor(scene: Scene, renderer: WebGLRenderer, invalidate: () => void) {
  const root = new Group();
  root.name = 'gpu-map-floor';
  root.visible = false;
  scene.add(root);

  const memoryScene = new Scene();
  const savedClearColor = new Color();
  const entries: FloorEntry[] = [];
  let memoryTarget: WebGLRenderTarget | undefined;
  let lastStructuralKey = '';
  let lastConfig: GpuMapFloorConfig | undefined;
  let generation = 0;
  let memoryKey = '';
  let maxTexDim = 8192;

  const clear = () => {
    generation++;
    memoryKey = '';
    for (const entry of entries) {
      root.remove(entry.mesh);
      memoryScene.remove(entry.memory);
      entry.mesh.geometry.dispose();
      entry.material.dispose();
      entry.memoryMaterial.dispose();
      entry.videoTexture?.dispose();
      entry.releaseVideo();
      entry.releaseTile();
    }
    entries.length = 0;
  };

  const makeMaterial = (params: {
    hasArt: number;
    art: Texture | null;
    fillColor: Vector3;
    canvasBg: Vector3;
    gridSize: number;
    gridOffset: Vector2;
    gridHot: boolean;
  }) =>
    new ShaderMaterial({
      transparent: false,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      uniforms: {
        hasArt: { value: params.hasArt },
        art: { value: params.art },
        fillColor: { value: params.fillColor },
        canvasBg: { value: params.canvasBg },
        gridSize: { value: params.gridSize },
        gridOffset: { value: params.gridOffset },
        gridAlpha: { value: (params.gridHot ? 0xcc : 0x5c) / 255 },
        gridMinStep: { value: params.gridHot ? 0.6 : 0.35 },
        gridMaxStep: { value: params.gridHot ? 1.55 : 1.15 },
        memoryPass: { value: 0 },
        keepRevealed: { value: 1 },
        memoryBrightness: { value: 0.48 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
    });

  return {
    get ready(): boolean {
      return !!lastConfig && entries.length > 0 && entries.every((entry) => entry.ready());
    },

    update(config: GpuMapFloorConfig | undefined, requestedMaxTexDim = 8192) {
      lastConfig = config;
      const clampedLimit = Math.max(256, Math.min(renderer.capabilities?.maxTextureSize || 4096, Math.floor(requestedMaxTexDim || 8192)));
      maxTexDim = clampedLimit;
      if (!config) {
        if (lastStructuralKey !== '') {
          lastStructuralKey = '';
          clear();
        }
        return;
      }
      const gridSize = config.grid?.size ?? 0;
      const gridX = config.grid?.x ?? 0;
      const gridY = config.grid?.y ?? 0;
      const gridHot = !!config.grid?.hot;
      const bgVec = cssColorToSrgbVec3(config.canvasBg);
      const structuralKey = JSON.stringify([maxTexDim, config.canvasBg, config.bounds, config.tiles]);

      if (structuralKey === lastStructuralKey && entries.length > 0) {
        for (const entry of entries) {
          for (const mat of [entry.material, entry.memoryMaterial]) {
            mat.uniforms.gridSize.value = gridSize;
            (mat.uniforms.gridOffset.value as Vector2).set(gridX, gridY);
            mat.uniforms.gridAlpha.value = (gridHot ? 0xcc : 0x5c) / 255;
            mat.uniforms.gridMinStep.value = gridHot ? 0.6 : 0.35;
            mat.uniforms.gridMaxStep.value = gridHot ? 1.55 : 1.15;
          }
        }
        return;
      }

      lastStructuralKey = structuralKey;
      clear();
      const version = generation;
      const hasTiles = config.tiles.length > 0;
      const backdropColor = hasTiles ? bgVec : cssColorToSrgbVec3('#2a2f3a');
      const backdropMat = makeMaterial({
        hasArt: 0,
        art: null,
        fillColor: backdropColor,
        canvasBg: bgVec,
        gridSize,
        gridOffset: new Vector2(gridX, gridY),
        gridHot,
      });
      const backdropGeom = new PlaneGeometry(Math.max(1, config.bounds.w), Math.max(1, config.bounds.h));
      const backdropMesh = new Mesh(backdropGeom, backdropMat);
      backdropMesh.rotation.x = -Math.PI / 2;
      backdropMesh.position.set(config.bounds.x + config.bounds.w / 2, -0.056, config.bounds.y + config.bounds.h / 2);
      backdropMesh.renderOrder = -11;
      backdropMesh.frustumCulled = false;
      root.add(backdropMesh);

      const backdropMemMat = backdropMat.clone();
      backdropMemMat.uniforms = { ...backdropMat.uniforms, memoryPass: { value: 1 } };
      backdropMemMat.transparent = true;
      const backdropMem = new Mesh(backdropGeom, backdropMemMat);
      backdropMem.copy(backdropMesh, false);
      backdropMem.material = backdropMemMat;
      backdropMem.visible = !hasTiles;
      memoryScene.add(backdropMem);

      entries.push({
        mesh: backdropMesh,
        memory: backdropMem,
        material: backdropMat,
        memoryMaterial: backdropMemMat,
        ready: () => true,
        releaseTile: () => {},
        releaseVideo: () => {},
      });

      for (const [index, tile] of config.tiles.entries()) {
        const material = makeMaterial({
          hasArt: 1,
          art: null,
          fillColor: bgVec,
          canvasBg: bgVec,
          gridSize,
          gridOffset: new Vector2(gridX, gridY),
          gridHot,
        });
        const geom = new PlaneGeometry(Math.max(1, tile.w), Math.max(1, tile.h));
        const mesh = new Mesh(geom, material);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(tile.x + tile.w / 2, -0.055 + index * 0.0001, tile.y + tile.h / 2);
        mesh.renderOrder = -10 + index * 0.001;
        mesh.frustumCulled = false;
        mesh.visible = false;
        root.add(mesh);

        const memoryMaterial = material.clone();
        memoryMaterial.uniforms = { ...material.uniforms, memoryPass: { value: 1 } };
        memoryMaterial.transparent = true;
        const memory = new Mesh(geom, memoryMaterial);
        memory.copy(mesh, false);
        memory.material = memoryMaterial;
        memory.visible = false;
        memoryScene.add(memory);

        let ready = false;
        const acquired = acquireMapTileTexture(renderer, tile.url, maxTexDim, () => {
          if (version !== generation) return;
          ready = true;
          mesh.visible = memory.visible = true;
          memoryKey = '';
          invalidate();
        });
        const posterTexture = acquired.texture;
        material.uniforms.art.value = posterTexture;
        memoryMaterial.uniforms.art = { value: posterTexture };

        let videoTexture: VideoTexture | undefined;
        let releaseVideo = () => {};
        if (tile.videoPath) {
          const handle = acquireAnimatedMap(tile.videoPath);
          const mediaEntry = handle.entry;
          videoTexture = new VideoTexture(mediaEntry.video);
          videoTexture.generateMipmaps = false;
          const refresh = () => {
            if (version !== generation) return;
            material.uniforms.art.value = mediaEntry.ready && !mediaEntry.failed ? videoTexture! : posterTexture;
            invalidate();
          };
          const paint = () => {
            if (version === generation && mediaEntry.ready && !mediaEntry.failed) invalidate();
          };
          mediaEntry.listeners.add(refresh);
          mediaEntry.frameListeners.add(paint);
          refresh();
          releaseVideo = () => {
            mediaEntry.listeners.delete(refresh);
            mediaEntry.frameListeners.delete(paint);
            handle.release();
          };
        }

        if (ready) mesh.visible = memory.visible = true;
        entries.push({
          mesh,
          memory,
          material,
          memoryMaterial,
          ready: () => ready,
          releaseTile: acquired.release,
          releaseVideo,
          videoTexture,
        });
      }
    },

    setVisible(visible: boolean) {
      root.visible = visible;
    },

    renderMemory(renderer: WebGLRenderer, camera: Camera, keepRevealed: boolean, brightness: number) {
      if (!lastConfig || !entries.length || entries.some((e) => !e.ready())) return;
      const w = renderer.domElement.width, h = renderer.domElement.height;
      const next = JSON.stringify([
        lastStructuralKey,
        lastConfig.grid,
        w,
        h,
        keepRevealed,
        brightness,
        camera.projectionMatrix.elements,
        camera.matrixWorld.elements,
      ]);
      if (next === memoryKey) return;
      memoryKey = next;
      for (const entry of entries) {
        entry.memoryMaterial.uniforms.keepRevealed.value = keepRevealed ? 1 : 0;
        entry.memoryMaterial.uniforms.memoryBrightness.value = brightness;
      }
      if (!memoryTarget || memoryTarget.width !== w || memoryTarget.height !== h) {
        memoryTarget?.dispose();
        memoryTarget = new WebGLRenderTarget(w, h, { depthBuffer: false, stencilBuffer: false });
      }
      const prevTarget = renderer.getRenderTarget();
      const prevAutoClear = renderer.autoClear;
      const prevAlpha = renderer.getClearAlpha();
      const prevShadow = renderer.shadowMap.needsUpdate;
      renderer.getClearColor(savedClearColor);
      try {
        renderer.shadowMap.needsUpdate = false;
        renderer.setRenderTarget(memoryTarget);
        renderer.setClearColor(0x000000, 0);
        renderer.autoClear = true;
        renderer.clear(true, false, false);
        renderer.render(memoryScene, camera);
      } finally {
        renderer.setRenderTarget(prevTarget);
        renderer.setClearColor(savedClearColor, prevAlpha);
        renderer.autoClear = prevAutoClear;
        renderer.shadowMap.needsUpdate = prevShadow;
      }
    },

    get memoryTexture(): Texture | null {
      return memoryTarget?.texture ?? null;
    },

    dispose() {
      clear();
      scene.remove(root);
      memoryTarget?.dispose();
      memoryTarget = undefined;
    },
  };
}
