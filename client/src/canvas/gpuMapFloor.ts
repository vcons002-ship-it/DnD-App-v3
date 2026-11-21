import { acquireAnimatedMap } from './animatedMapMedia';
import { acquireMapTileTexture } from './mapTileTextures';
import type { GpuGroundTokenSprite } from './gpuGroundTokens';
import {
  CanvasTexture,
  Color,
  DataTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
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

export type GpuManualFogConfig = {
  grid: number;
  colMin: number;
  colMax: number;
  rowMin: number;
  rowMax: number;
  mapFog?: { revealed: readonly string[]; color: string; opacity: number };
  tokenFog?: { revealed: readonly string[]; color: string; opacity: number };
};

export type GpuMapFloorConfig = {
  tiles: readonly GpuMapFloorTile[];
  bounds: { x: number; y: number; w: number; h: number };
  grid?: { size: number; x: number; y: number; hot?: boolean };
  canvasBg: string;
  exploredBrightness: number;
  manualFog?: GpuManualFogConfig;
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

type SpriteEntry = {
  mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  texture: CanvasTexture;
  version: string;
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

const FRAGMENT_SHADER = `uniform sampler2D art, manualFogTex;
uniform float hasArt, gridSize, gridAlpha, gridWidth, memoryPass, keepRevealed, memoryBrightness;
uniform float manualFogAlpha, tokenFogAlpha;
uniform vec2 gridOffset, manualFogEnabled;
uniform vec3 fillColor, canvasBg, manualFogColor, tokenFogColor;
uniform vec4 manualFogBounds;
varying vec2 artUv;
varying vec3 world;
void main() {
  vec4 source = hasArt > .5 ? texture2D(art, artUv) : vec4(fillColor, 1.);
  vec2 fogUv = (world.xz - manualFogBounds.xy) / max(manualFogBounds.zw, vec2(.001));
  bool inFog = all(greaterThanEqual(fogUv, vec2(0.))) && all(lessThan(fogUv, vec2(1.)));
  vec2 mf = inFog ? texture2D(manualFogTex, fogUv).rg : vec2(1.);
  float grid = 0.;
  if (gridSize > 0.) {
    vec2 cell = (world.xz - gridOffset) / gridSize;
    vec2 grad = vec2(
      length(vec2(dFdx(cell.x), dFdy(cell.x))),
      length(vec2(dFdx(cell.y), dFdy(cell.y)))
    );
    vec2 safeGrad = max(grad, vec2(1e-5));
    vec2 distPx = abs(fract(cell - .5) - .5) / safeGrad;
    vec2 wPx = gridWidth / max(safeGrad * gridSize, vec2(1e-5));
    vec2 cov = clamp(.5 + wPx * .5 - distPx, vec2(0.), min(wPx, vec2(1.)));
    grid = max(cov.x, cov.y);
  }
  if (memoryPass > .5) {
    if (manualFogEnabled.x > .5 && manualFogAlpha > .99 && inFog && mf.r < .5) {
      gl_FragColor = vec4(0.);
      return;
    }
    vec3 remembered = mix(source.rgb, vec3(1.), grid * (80. / 255.));
    if (keepRevealed < .5) {
      remembered = vec3(dot(remembered, vec3(.2126, .7152, .0722)) * memoryBrightness);
    }
    gl_FragColor = vec4(remembered, source.a);
    return;
  }
  vec3 base = hasArt > .5 ? mix(canvasBg, source.rgb, source.a) : source.rgb;
  vec3 rgb = mix(base, vec3(1.), grid * gridAlpha);
  if (manualFogEnabled.x > .5 && inFog) {
    rgb = mix(rgb, manualFogColor, (1. - step(.5, mf.r)) * manualFogAlpha);
  }
  if (manualFogEnabled.y > .5 && inFog) {
    rgb = mix(rgb, tokenFogColor, (1. - step(.5, mf.g)) * tokenFogAlpha);
  }
  gl_FragColor = vec4(rgb, 1.);
}`;

/** Render the static/animated 2D battlemap tiles, grid, manual fog, and 2D
 * ground tokens inside WebGL so 3D camera gestures skip Konva & SVG redraws. */
export function createGpuMapFloor(scene: Scene, renderer: WebGLRenderer, invalidate: () => void) {
  const root = new Group();
  root.name = 'gpu-map-floor';
  root.visible = false;
  scene.add(root);

  const spritesRoot = new Group();
  spritesRoot.name = 'gpu-ground-sprites';
  root.add(spritesRoot);

  const memoryScene = new Scene();
  const savedClearColor = new Color();
  const entries: FloorEntry[] = [];
  const spriteEntries = new Map<string, SpriteEntry>();
  const spriteGeom = new PlaneGeometry(1, 1);

  const manualFogTex = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat, UnsignedByteType);
  manualFogTex.minFilter = manualFogTex.magFilter = NearestFilter;
  manualFogTex.generateMipmaps = false;
  manualFogTex.needsUpdate = true;

  const manualFogUniforms = {
    manualFogTex: { value: manualFogTex },
    manualFogBounds: { value: new Vector4(0, 0, 1, 1) },
    manualFogEnabled: { value: new Vector2(0, 0) },
    manualFogColor: { value: new Vector3() },
    tokenFogColor: { value: new Vector3() },
    manualFogAlpha: { value: 1 },
    tokenFogAlpha: { value: 0.35 },
  };

  let memoryTarget: WebGLRenderTarget | undefined;
  let lastStructuralKey = '';
  let lastConfig: GpuMapFloorConfig | undefined;
  let dragHot = false;
  const effectiveHot = () => !!lastConfig?.grid?.hot || dragHot;
  let generation = 0;
  let memoryKey = '';
  let maxTexDim = 8192;
  let manualFogSupported = true;
  let manualFogRevision = 0;
  let lastFogScalarKey = '';
  let lastMapRevealedRef: readonly string[] | undefined;
  let lastTokenRevealedRef: readonly string[] | undefined;

  const updateManualFog = (fog: GpuManualFogConfig | undefined) => {
    const mapFog = fog?.mapFog;
    const tokenFog = fog?.tokenFog;
    const scalarKey = fog
      ? `${maxTexDim}:${fog.grid}:${fog.colMin}:${fog.colMax}:${fog.rowMin}:${fog.rowMax}:${mapFog?.color ?? ''}:${mapFog?.opacity ?? ''}:${tokenFog?.color ?? ''}:${tokenFog?.opacity ?? ''}`
      : 'none';
    if (
      scalarKey === lastFogScalarKey &&
      mapFog?.revealed === lastMapRevealedRef &&
      tokenFog?.revealed === lastTokenRevealedRef
    ) {
      return;
    }
    lastFogScalarKey = scalarKey;
    lastMapRevealedRef = mapFog?.revealed;
    lastTokenRevealedRef = tokenFog?.revealed;
    manualFogRevision++;
    memoryKey = '';

    if (!fog || (!mapFog && !tokenFog)) {
      manualFogSupported = true;
      manualFogUniforms.manualFogEnabled.value.set(0, 0);
      manualFogUniforms.manualFogBounds.value.set(0, 0, 1, 1);
      return;
    }

    const cols = Math.max(1, fog.colMax - fog.colMin);
    const rows = Math.max(1, fog.rowMax - fog.rowMin);
    if (cols > maxTexDim || rows > maxTexDim) {
      manualFogSupported = false;
      manualFogUniforms.manualFogEnabled.value.set(0, 0);
      return;
    }

    manualFogSupported = true;
    const data = new Uint8Array(cols * rows * 4);
    if (mapFog) {
      for (const cell of mapFog.revealed) {
        const comma = cell.indexOf(',');
        const cx = Number(cell.slice(0, comma)) - fog.colMin;
        const cy = Number(cell.slice(comma + 1)) - fog.rowMin;
        if (Number.isInteger(cx) && Number.isInteger(cy) && cx >= 0 && cx < cols && cy >= 0 && cy < rows) {
          data[(cy * cols + cx) * 4] = 255;
        }
      }
      manualFogUniforms.manualFogColor.value.copy(cssColorToSrgbVec3(mapFog.color));
      manualFogUniforms.manualFogAlpha.value = mapFog.opacity;
    }
    if (tokenFog) {
      for (const cell of tokenFog.revealed) {
        const comma = cell.indexOf(',');
        const cx = Number(cell.slice(0, comma)) - fog.colMin;
        const cy = Number(cell.slice(comma + 1)) - fog.rowMin;
        if (Number.isInteger(cx) && Number.isInteger(cy) && cx >= 0 && cx < cols && cy >= 0 && cy < rows) {
          data[(cy * cols + cx) * 4 + 1] = 255;
        }
      }
      manualFogUniforms.tokenFogColor.value.copy(cssColorToSrgbVec3(tokenFog.color));
      manualFogUniforms.tokenFogAlpha.value = tokenFog.opacity;
    }

    manualFogTex.dispose();
    manualFogTex.image = { data, width: cols, height: rows };
    manualFogTex.needsUpdate = true;
    manualFogUniforms.manualFogEnabled.value.set(mapFog ? 1 : 0, tokenFog ? 1 : 0);
    manualFogUniforms.manualFogBounds.value.set(fog.colMin * fog.grid, fog.rowMin * fog.grid, cols * fog.grid, rows * fog.grid);
  };

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

  const clearSprites = () => {
    for (const entry of spriteEntries.values()) {
      spritesRoot.remove(entry.mesh);
      entry.mesh.material.dispose();
      entry.texture.dispose();
    }
    spriteEntries.clear();
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
        ...manualFogUniforms,
        hasArt: { value: params.hasArt },
        art: { value: params.art },
        fillColor: { value: params.fillColor },
        canvasBg: { value: params.canvasBg },
        gridSize: { value: params.gridSize },
        gridOffset: { value: params.gridOffset },
        gridAlpha: { value: (params.gridHot ? 0xcc : 0x5c) / 255 },
        gridWidth: { value: params.gridHot ? 1.5 : 1 },
        memoryPass: { value: 0 },
        keepRevealed: { value: 1 },
        memoryBrightness: { value: 0.48 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
    });

  return {
    get ready(): boolean {
      return !!lastConfig && manualFogSupported && entries.length > 0 && entries.every((entry) => entry.ready());
    },

    update(config: GpuMapFloorConfig | undefined, requestedMaxTexDim = 8192) {
      lastConfig = config;
      const clampedLimit = Math.max(256, Math.min(renderer.capabilities?.maxTextureSize || 4096, Math.floor(requestedMaxTexDim || 8192)));
      maxTexDim = clampedLimit;
      if (!config) {
        updateManualFog(undefined);
        clearSprites();
        if (lastStructuralKey !== '') {
          lastStructuralKey = '';
          clear();
        }
        return;
      }
      updateManualFog(config.manualFog);
      const gridSize = config.grid?.size ?? 0;
      const gridX = config.grid?.x ?? 0;
      const gridY = config.grid?.y ?? 0;
      const gridHot = effectiveHot();
      const bgVec = cssColorToSrgbVec3(config.canvasBg);
      const structuralKey = JSON.stringify([maxTexDim, config.canvasBg, config.bounds, config.tiles]);

      if (structuralKey === lastStructuralKey && entries.length > 0) {
        for (const entry of entries) {
          entry.material.uniforms.gridSize.value = gridSize;
          (entry.material.uniforms.gridOffset.value as Vector2).set(gridX, gridY);
          entry.material.uniforms.gridAlpha.value = (gridHot ? 0xcc : 0x5c) / 255;
          entry.material.uniforms.gridWidth.value = gridHot ? 1.5 : 1;
          entry.memoryMaterial.uniforms.gridSize.value = gridSize;
          (entry.memoryMaterial.uniforms.gridOffset.value as Vector2).set(gridX, gridY);
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
      backdropMemMat.uniforms = {
        ...backdropMat.uniforms,
        ...manualFogUniforms,
        gridAlpha: { value: 0x5c / 255 },
        gridWidth: { value: 1 },
        memoryPass: { value: 1 },
      };
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
        memoryMaterial.uniforms = {
          ...material.uniforms,
          ...manualFogUniforms,
          gridAlpha: { value: 0x5c / 255 },
          gridWidth: { value: 1 },
          memoryPass: { value: 1 },
        };
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

    syncGroundSprites(sprites: readonly GpuGroundTokenSprite[]) {
      const live = new Set<string>();
      for (const sprite of sprites) {
        live.add(sprite.id);
        let entry = spriteEntries.get(sprite.id);
        if (!entry) {
          const texture = new CanvasTexture(sprite.canvas);
          texture.colorSpace = SRGBColorSpace;
          const material = new MeshBasicMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
            depthWrite: false,
            toneMapped: false,
          });
          const mesh = new Mesh(spriteGeom, material);
          mesh.rotation.x = -Math.PI / 2;
          mesh.renderOrder = -9;
          mesh.frustumCulled = false;
          spritesRoot.add(mesh);
          entry = { mesh, texture, version: sprite.version };
          spriteEntries.set(sprite.id, entry);
        } else if (entry.version !== sprite.version) {
          entry.texture.image = sprite.canvas;
          entry.texture.needsUpdate = true;
          entry.version = sprite.version;
        }
        entry.mesh.position.set(sprite.x + sprite.bx + sprite.w / 2, -0.052, sprite.y + sprite.by + sprite.h / 2);
        entry.mesh.scale.set(sprite.w, sprite.h, 1);
        entry.mesh.material.opacity = sprite.opacity;
      }
      for (const [id, entry] of spriteEntries) {
        if (live.has(id)) continue;
        spritesRoot.remove(entry.mesh);
        entry.mesh.material.dispose();
        entry.texture.dispose();
        spriteEntries.delete(id);
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
        manualFogRevision,
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

    setGridHot(hot: boolean) {
      if (dragHot === hot) return;
      dragHot = hot;
      const nextHot = effectiveHot();
      for (const entry of entries) {
        entry.material.uniforms.gridAlpha.value = (nextHot ? 0xcc : 0x5c) / 255;
        entry.material.uniforms.gridWidth.value = nextHot ? 1.5 : 1;
      }
      invalidate();
    },

    get memoryTexture(): Texture | null {
      return memoryTarget?.texture ?? null;
    },

    dispose() {
      dragHot = false;
      clear();
      clearSprites();
      spriteGeom.dispose();
      manualFogTex.dispose();
      scene.remove(root);
      memoryTarget?.dispose();
      memoryTarget = undefined;
    },
  };
}
