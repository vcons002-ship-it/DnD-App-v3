import { useMemo } from 'react';
import { Circle, Group, Line, Path, Rect, Text } from 'react-konva';
import { doorInteractionArea } from '../../../shared/doorInteraction';
import { DEFAULT_MAP_ENVIRONMENT, mapLightColorHex, type MapEnvironmentLight } from '../../../shared/mapEnvironment';
import { doorSegmentApproachPoints, type MapWall } from '../../../shared/mapWalls';
import { fogVisionContains, usesTokenVision } from '../../../shared/playerVision';
import type { StateSnapshot, Token } from '../../../shared/types';
import { translateWall, wallBoundarySegments, wallCenter, wallEndpointHandles, wallSvgPath, wallVertices } from '../../../shared/wallGeometry';
import { BulkLightFields, type CopiedLightStyle } from '../components/MapLightControls';
import { NumberInput } from '../components/NumberInput';
import { ObjectControls } from '../components/ObjectControls';
import type { WallTool } from '../components/WallMenu';
import { useStore } from '../state/socket';

type Pt = { x: number; y: number };

export function WallAndDoorKonvaGroup({
  wallActive,
  placingLight = false,
  wallTool,
  map,
  wallPreview,
  featureDragDelta,
  featureDuplicatePreview = false,
  featureSelection,
  viewScale,
  wallAnchor,
  wallPointer,
  strokeWall,
  selectedWall,
  rotationHandle,
  doors,
  doorVisible,
  actualDm,
  sourceSnapshot,
  snapshot,
  doorDragPreview,
  nearbyDoors,
  pxPerFoot,
  renderPlayerVision,
  openDoorControls,
  notify,
}: {
  wallActive: boolean;
  placingLight?: boolean;
  wallTool: WallTool;
  map: StateSnapshot['map'];
  wallPreview: MapWall | null;
  featureDragDelta?: Pt | null;
  featureDuplicatePreview?: boolean;
  featureSelection: string[];
  viewScale: number;
  wallAnchor: Pt | null;
  wallPointer: Pt | null;
  strokeWall: (a: Pt, b: Pt) => MapWall;
  selectedWall: MapWall | undefined;
  rotationHandle: (w: MapWall) => Pt;
  doors: MapWall[];
  doorVisible: (door: MapWall) => boolean;
  actualDm: boolean;
  sourceSnapshot: StateSnapshot;
  snapshot: StateSnapshot;
  doorDragPreview: { tokenId: string; ids: string[] } | null;
  nearbyDoors: MapWall[];
  pxPerFoot: number;
  renderPlayerVision: boolean;
  openDoorControls: (id: string) => void;
  notify: (msg: string) => void;
}) {
  const editorVisible = wallActive || placingLight;
  const endpointHandles = useMemo(
    () => (wallActive && wallTool === 'edit' && selectedWall && !featureDragDelta ? wallEndpointHandles(selectedWall) : []),
    [wallActive, wallTool, selectedWall, featureDragDelta],
  );
  return (
    <>
      {editorVisible && (
        <Group name="wall-edit-outlines" listening={false}>
          {(map?.walls ?? []).map((original) => {
            const selected = featureSelection.includes(`wall:${original.id}`);
            const w =
              wallPreview?.id === original.id
                ? wallPreview
                : selected && featureDragDelta && !featureDuplicatePreview
                  ? translateWall(original, featureDragDelta.x, featureDragDelta.y)
                  : original;
            return (
              <Path
                key={w.id}
                name="wall-edit-piece"
                wallId={w.id}
                featureSelected={selected}
                data={wallSvgPath(w)}
                fillRule="evenodd"
                stroke={selected ? '#6ee7ff' : w.arch ? '#f64fe0' : w.window ? '#398cff' : '#ffc76e'}
                fill={
                  selected
                    ? '#6ee7ff35'
                    : w.arch
                      ? '#f64fe040'
                      : w.window
                        ? '#398cff55'
                        : w.kind || w.thickness
                          ? '#ffc76e25'
                          : undefined
                }
                strokeWidth={(selected ? 3 : 2) / viewScale}
              />
            );
          })}
          {featureDuplicatePreview &&
            featureDragDelta &&
            (map?.walls ?? [])
              .filter((w) => !w.door && featureSelection.includes(`wall:${w.id}`))
              .map((w) => (
                <Path
                  key={`dup-${w.id}`}
                  data={wallSvgPath(translateWall(w, featureDragDelta.x, featureDragDelta.y))}
                  fillRule="evenodd"
                  stroke="#90f2ff"
                  fill="#90f2ff30"
                  strokeWidth={2.5 / viewScale}
                  dash={[7 / viewScale, 4 / viewScale]}
                />
              ))}
          {(map?.environment?.lights ?? []).map((light, i) => {
            const selected = featureSelection.includes(`light:${light.id}`);
            const dx = selected && featureDragDelta && !featureDuplicatePreview ? featureDragDelta.x : 0;
            const dy = selected && featureDragDelta && !featureDuplicatePreview ? featureDragDelta.y : 0;
            const lx = light.x + dx;
            const ly = light.y + dy;
            const isOn = light.enabled !== false;
            const hex = mapLightColorHex(light.color);
            return (
              <Group
                key={light.id}
                name="light-edit-marker"
                lightId={light.id}
                featureSelected={selected}
                x={lx}
                y={ly}
              >
                {selected && (
                  <Circle
                    radius={light.radiusFt * pxPerFoot}
                    stroke={isOn ? hex : '#7a8596'}
                    fill={isOn ? `${hex}18` : undefined}
                    strokeWidth={1.5 / viewScale}
                    dash={[6 / viewScale, 5 / viewScale]}
                  />
                )}
                <Circle
                  radius={11 / viewScale}
                  fill={selected ? '#6ee7ff' : isOn ? hex : '#4d5563'}
                  opacity={isOn ? 1 : 0.72}
                  stroke={selected ? '#0b1824' : isOn ? '#152230' : '#aeb7c4'}
                  strokeWidth={2 / viewScale}
                  dash={isOn ? undefined : [3 / viewScale, 2 / viewScale]}
                />
                <Text
                  text={isOn ? String(i + 1) : `${i + 1}×`}
                  x={-12 / viewScale}
                  y={-6 / viewScale}
                  width={24 / viewScale}
                  align="center"
                  fontStyle="bold"
                  fontSize={(isOn ? 12 : 10) / viewScale}
                  fill={selected || isOn ? '#142331' : '#e6ecf5'}
                />
              </Group>
            );
          })}
          {featureDuplicatePreview &&
            featureDragDelta &&
            (map?.environment?.lights ?? [])
              .filter((l) => featureSelection.includes(`light:${l.id}`))
              .map((light) => (
                <Circle
                  key={`dup-light-${light.id}`}
                  x={light.x + featureDragDelta.x}
                  y={light.y + featureDragDelta.y}
                  radius={11 / viewScale}
                  fill="#90f2ff88"
                  stroke="#0b1824"
                  strokeWidth={2 / viewScale}
                  dash={[4 / viewScale, 3 / viewScale]}
                />
              ))}
          {wallActive &&
            wallAnchor &&
            wallPointer &&
            (wallTool === 'erase-area' ? (
              <Rect
                name="wall-erase-preview"
                x={Math.min(wallAnchor.x, wallPointer.x)}
                y={Math.min(wallAnchor.y, wallPointer.y)}
                width={Math.abs(wallPointer.x - wallAnchor.x)}
                height={Math.abs(wallPointer.y - wallAnchor.y)}
                fill="#ff667733"
                stroke="#ff6677"
                strokeWidth={2 / viewScale}
                dash={[8 / viewScale, 5 / viewScale]}
              />
            ) : wallTool === 'door' ? (
              <Group>
                <Line
                  points={[wallAnchor.x, wallAnchor.y, wallPointer.x, wallPointer.y]}
                  stroke="#78e6ff"
                  strokeWidth={6 / viewScale}
                  opacity={0.35}
                  lineCap="round"
                />
                <Line
                  points={[wallAnchor.x, wallAnchor.y, wallPointer.x, wallPointer.y]}
                  stroke="#fff1c2"
                  strokeWidth={3 / viewScale}
                  dash={[8 / viewScale, 5 / viewScale]}
                />
                {Math.hypot(wallPointer.x - wallAnchor.x, wallPointer.y - wallAnchor.y) >= 2 && (
                  <Text
                    text={`${(Math.hypot(wallPointer.x - wallAnchor.x, wallPointer.y - wallAnchor.y) / Math.max(0.01, pxPerFoot)).toFixed(1)} ft door`}
                    x={(wallAnchor.x + wallPointer.x) / 2 - 42 / viewScale}
                    y={(wallAnchor.y + wallPointer.y) / 2 - 22 / viewScale}
                    width={84 / viewScale}
                    align="center"
                    fontSize={12 / viewScale}
                    fontStyle="bold"
                    fill="#fff4cf"
                    stroke="#0d131a"
                    strokeWidth={3 / viewScale}
                    fillAfterStrokeEnabled
                  />
                )}
              </Group>
            ) : (
              <Path
                data={wallSvgPath(strokeWall(wallAnchor, wallPointer))}
                fillRule="evenodd"
                stroke="#fff1c2"
                fill="#ffe5b333"
                strokeWidth={2 / viewScale}
                dash={[8 / viewScale, 5 / viewScale]}
              />
            ))}
          {wallActive && wallTool === 'edit' && selectedWall && !featureDragDelta && (
            <Group name="wall-rotation-control">
              <Line
                points={[
                  wallCenter(selectedWall).x,
                  wallCenter(selectedWall).y,
                  rotationHandle(selectedWall).x,
                  rotationHandle(selectedWall).y,
                ]}
                stroke="#6ee7ff"
                strokeWidth={1 / viewScale}
                dash={[5 / viewScale, 4 / viewScale]}
              />
              <Circle
                name="wall-rotation-handle"
                x={rotationHandle(selectedWall).x}
                y={rotationHandle(selectedWall).y}
                radius={8 / viewScale}
                fill="#142833"
                stroke="#6ee7ff"
                strokeWidth={2 / viewScale}
              />
              {endpointHandles.map((pt, idx) => (
                <Rect
                  key={idx}
                  name="wall-vertex-handle"
                  vertexIndex={idx}
                  x={pt.x}
                  y={pt.y}
                  width={10 / viewScale}
                  height={10 / viewScale}
                  offsetX={5 / viewScale}
                  offsetY={5 / viewScale}
                  fill="#fff4cf"
                  stroke="#0d1b26"
                  strokeWidth={2 / viewScale}
                />
              ))}
            </Group>
          )}
          {wallActive && wallPointer && wallTool !== 'edit' && (
            <Circle
              x={wallPointer.x}
              y={wallPointer.y}
              radius={4 / viewScale}
              fill={wallTool === 'erase' || wallTool === 'erase-area' ? '#ff6677' : '#fff1c2'}
            />
          )}
        </Group>
      )}
      {useMemo(() => {
        const wallVis = usesTokenVision(map);
        return doors.filter(doorVisible).map((d) => {
          let visibleFaces: Set<number> | null = null;
          if (renderPlayerVision && !editorVisible && !d.open) {
            let baseFaces: number[][];
            if (d.kind === 'rectangle' && !d.rotation) {
              const x0 = Math.min(d.ax, d.bx), x1 = Math.max(d.ax, d.bx), y0 = Math.min(d.ay, d.by), y1 = Math.max(d.ay, d.by);
              baseFaces = x1 - x0 >= y1 - y0 ? [[x0, y0 - 2, x1, y0 - 2], [x0, y1 + 2, x1, y1 + 2]] : [[x0 - 2, y0, x0 - 2, y1], [x1 + 2, y0, x1 + 2, y1]];
            } else {
              baseFaces = wallBoundarySegments(d).map(({ a, b }) => [a.x, a.y, b.x, b.y]);
            }
            visibleFaces = new Set<number>();
            baseFaces.forEach((points, i) => {
              if (doorSegmentApproachPoints({ x: points[0], y: points[1] }, { x: points[2], y: points[3] }, d).some((p) => fogVisionContains(snapshot.playerVision, p.x, p.y, wallVis))) {
                visibleFaces!.add(i);
              }
            });
          }
          return { d, visibleFaces };
        });
      }, [doors, doorVisible, renderPlayerVision, editorVisible, snapshot.playerVision, map]).map(({ d, visibleFaces }) => {
        const doorFaceVisible = (_door: MapWall, faceIndex: number) => !visibleFaces || visibleFaces.has(faceIndex);
        const doorSnapshot = actualDm ? sourceSnapshot : snapshot;
        const token = doorSnapshot.tokens.find((t) => t.id === d.tokenId);
        const object = doorSnapshot.monsters.find((m) => m.id === token?.refId);
        const locked = !!object?.conditions.some((c) => c.label.toLowerCase() === 'locked');
        const hidden = !!token?.isHidden;
        const previewed = !!doorDragPreview?.ids.includes(d.id);
        const approached = nearbyDoors.some((door) => door.id === d.id);
        const color = previewed
          ? '#78e6ff'
          : hidden
            ? '#a2a8b1'
            : locked
              ? '#efb05f'
              : d.open
                ? '#94d6b0'
                : '#f1d49c';
        const label = hidden ? 'Hidden' : locked ? 'Locked' : d.open ? 'Open' : 'Door';
        const pad = 2 / viewScale;
        let faces: number[][];
        if (d.kind === 'rectangle' && !d.rotation) {
          const x0 = Math.min(d.ax, d.bx);
          const x1 = Math.max(d.ax, d.bx);
          const y0 = Math.min(d.ay, d.by);
          const y1 = Math.max(d.ay, d.by);
          faces =
            x1 - x0 >= y1 - y0
              ? [
                  [x0, y0 - pad, x1, y0 - pad],
                  [x0, y1 + pad, x1, y1 + pad],
                ]
              : [
                  [x0 - pad, y0, x0 - pad, y1],
                  [x1 + pad, y0, x1 + pad, y1],
                ];
        } else {
          faces = wallBoundarySegments(d).map(({ a, b }) => [a.x, a.y, b.x, b.y]);
        }
        const activate = () => {
          if (actualDm || nearbyDoors.some((door) => door.id === d.id)) openDoorControls(d.id);
          else
            notify(
              'Move your character’s footprint within 5 ft of this door’s approach area to open it or pick its lock.',
            );
        };
        return (
          <Group
            key={d.id}
            name="wall-door-marker"
            doorId={d.id}
            doorState={label}
            doorPreview={previewed}
            doorVisualVersion={`${label}|${previewed ? 1 : 0}|${approached ? 1 : 0}|${hidden ? 1 : 0}|${viewScale}|${pxPerFoot}|${faces.length}|${d.open ? 1 : 0}|${d.ax},${d.ay},${d.bx},${d.by},${d.rotation ?? 0}|${visibleFaces ? [...visibleFaces].join(',') : 'all'}`}
            opacity={hidden ? 0.45 : 1}
            listening={!editorVisible}
            onMouseDown={(e) => {
              e.cancelBubble = true;
            }}
            onTouchStart={(e) => {
              e.cancelBubble = true;
            }}
            onClick={(e) => {
              e.cancelBubble = true;
              activate();
            }}
            onTap={(e) => {
              e.cancelBubble = true;
              activate();
            }}
          >
            <Line
              name="door-approach-area"
              points={wallVertices(doorInteractionArea(d, pxPerFoot)).flatMap((p) => [p.x, p.y])}
              closed
              listening={false}
              stroke={color}
              strokeWidth={(previewed ? 2 : 1) / viewScale}
              dash={[5 / viewScale, 4 / viewScale]}
              opacity={previewed ? 0.85 : approached ? 0.6 : 0.25}
              fill={previewed ? '#78e6ff20' : approached ? '#f1d49c15' : undefined}
            />
            {faces
              .filter(
                (_points, faceIndex) =>
                  !renderPlayerVision ||
                  editorVisible ||
                  d.open ||
                  doorFaceVisible(d, faceIndex),
              )
              .map((points, i) => (
                <Line
                  key={i}
                  name="wall-door-face"
                  points={points}
                  stroke={color}
                  strokeWidth={(previewed ? 6 : 4) / viewScale}
                  shadowColor={previewed ? '#78e6ff' : undefined}
                  shadowBlur={previewed ? 8 / viewScale : 0}
                  hitStrokeWidth={16 / viewScale}
                  lineCap="butt"
                  dash={d.open || hidden ? [7 / viewScale, 5 / viewScale] : undefined}
                />
              ))}
          </Group>
        );
      })}
    </>
  );
}

const QUICK_WALL_TOOLS: { id: WallTool; label: string; title: string }[] = [
  { id: 'edit', label: '✥ Select', title: 'Select, move, rotate, or drag wall endpoints (V)' },
  { id: 'draw', label: '╱ Line', title: 'Draw or click-chain straight wall segments · Hold Shift for 0°/45°/90° (L)' },
  { id: 'rectangle', label: '▭ Rect', title: 'Drag across wall length and thickness · Hold Shift for square (R)' },
  { id: 'circle', label: '◯ Circle', title: 'Drag from center to circular wall radius (C)' },
  { id: 'freehand', label: '✎ Free', title: 'Freehand trace curved walls (F)' },
  { id: 'door', label: '🚪 Door', title: 'Drag along wall(s) to cut a door opening · Hold Shift for 0°/45°/90° (D)' },
  { id: 'erase-area', label: '✂ Erase box', title: 'Drag a box to erase a wall section (E)' },
  { id: 'erase', label: '🗑 Erase piece', title: 'Click a wall piece to delete it (Shift+E)' },
];

export function WallAndDoorHud({
  wallActive,
  placingLight = false,
  onStartPlaceLight,
  onStopPlaceLight,
  wallSnap,
  setWallSnap,
  wallChain,
  setWallChain,
  wallTool,
  setWallTool,
  setWallAnchor,
  wallThickness,
  setWallThickness,
  selectedWall,
  featureSelection,
  onSelectAllLights,
  onSelectAllDoors,
  onDuplicateFeatures,
  lightEditorOpen = false,
  lightEditorPos,
  onOpenLightEditor,
  onCloseLightEditor,
  doorEditorOpen = false,
  doorEditorPos,
  onOpenDoorEditor,
  onCloseDoorEditor,
  deleteFeatures,
  map,
  doorDragPreview,
  doors,
  activeDoorControls,
  dismissDoorControls,
  actualDm,
  sourceSnapshot,
  snapshot,
  onSelectToken,
  operateDoor,
}: {
  wallActive: boolean;
  placingLight?: boolean;
  onStartPlaceLight?: () => void;
  onStopPlaceLight?: () => void;
  wallSnap?: boolean;
  setWallSnap?: (snap: boolean) => void;
  wallChain?: boolean;
  setWallChain?: (chain: boolean) => void;
  wallTool: WallTool;
  setWallTool: (t: WallTool) => void;
  setWallAnchor: (p: Pt | null) => void;
  wallThickness: number;
  setWallThickness: (n: number) => void;
  selectedWall: MapWall | undefined;
  featureSelection: string[];
  onSelectAllLights?: () => void;
  onSelectAllDoors?: () => void;
  onDuplicateFeatures?: () => void;
  lightEditorOpen?: boolean;
  lightEditorPos?: { x: number; y: number } | null;
  onOpenLightEditor?: () => void;
  onCloseLightEditor?: () => void;
  doorEditorOpen?: boolean;
  doorEditorPos?: { x: number; y: number } | null;
  onOpenDoorEditor?: () => void;
  onCloseDoorEditor?: () => void;
  deleteFeatures: () => void;
  map: StateSnapshot['map'];
  doorDragPreview: { tokenId: string; ids: string[] } | null;
  doors: MapWall[];
  activeDoorControls: MapWall[];
  dismissDoorControls: () => void;
  actualDm: boolean;
  sourceSnapshot: StateSnapshot;
  snapshot: StateSnapshot;
  onSelectToken: (token: Token | null, additive?: boolean) => void;
  operateDoor: (id: string, open: boolean) => void;
}) {
  const editorOpen = wallActive || placingLight;
  const allLights: MapEnvironmentLight[] = map?.environment?.lights ?? [];
  const allWalls: MapWall[] = map?.walls ?? [];
  const selectedLightIds = useMemo(
    () => new Set(featureSelection.filter((id) => id.startsWith('light:')).map((id) => id.slice(6))),
    [featureSelection],
  );
  const selectedWallIds = useMemo(
    () => new Set(featureSelection.filter((id) => id.startsWith('wall:')).map((id) => id.slice(5))),
    [featureSelection],
  );
  const selectedLights = useMemo(
    () => allLights.filter((l) => selectedLightIds.has(l.id)),
    [allLights, selectedLightIds],
  );
  const selectedWalls = useMemo(
    () => allWalls.filter((w) => selectedWallIds.has(w.id)),
    [allWalls, selectedWallIds],
  );
  const selectedNonDoorWalls = useMemo(
    () => selectedWalls.filter((w) => !w.door),
    [selectedWalls],
  );
  const selectedDoors = useMemo(
    () => selectedWalls.filter((w) => !!w.door),
    [selectedWalls],
  );
  const duplicableCount = selectedNonDoorWalls.length + selectedLights.length;

  const anyLightOn = allLights.some((l) => l.enabled !== false);
  const toggleAllLights = () => {
    if (!map || !allLights.length) return;
    useStore.getState().setMapEnvironment(map.id, {
      lights: allLights.map((l) => ({ ...l, enabled: !anyLightOn })),
    });
  };
  const updateLights = (lights: MapEnvironmentLight[], newLightColor?: MapEnvironmentLight['color']) => {
    if (!map) return;
    const env = map.environment ?? DEFAULT_MAP_ENVIRONMENT;
    useStore.getState().setMapEnvironment(map.id, {
      lights,
      ...(newLightColor ? { newLightColor } : {}),
      ...(!env.enabled ? { enabled: true } : {}),
    });
  };
  const applyStyleAsDefault = (style: CopiedLightStyle) => {
    if (!map) return;
    useStore.getState().setMapEnvironment(map.id, {
      newLightColor: style.color,
      newLightDefaults: {
        radiusFt: style.radiusFt,
        heightFt: style.heightFt,
        intensity: style.intensity,
        flicker: style.flicker,
        fixture: style.fixture ?? 'torch',
        visibleTorch: !!style.visibleTorch,
      },
    });
    useStore.getState().notify('Saved light settings as default for new lights.');
  };

  const setBarrierType = (kind: 'wall' | 'window' | 'arch') => {
    if (!map || !selectedNonDoorWalls.length) return;
    useStore.getState().editMapWalls(map.id, {
      barrierType: { wallIds: selectedNonDoorWalls.map((w) => w.id), kind },
    });
  };
  const allSelectedAreSolidWalls = selectedNonDoorWalls.length > 0 && selectedNonDoorWalls.every((w) => !w.window && !w.arch);
  const allSelectedAreWindows = selectedNonDoorWalls.length > 0 && selectedNonDoorWalls.every((w) => !!w.window);
  const allSelectedAreArches = selectedNonDoorWalls.length > 0 && selectedNonDoorWalls.every((w) => !!w.arch);

  const doorSnapshot = actualDm ? sourceSnapshot : snapshot;
  const doorMeta = useMemo(() => {
    return selectedDoors.map((d) => {
      const tok = doorSnapshot.tokens.find((t) => t.id === d.tokenId);
      const obj = doorSnapshot.monsters.find((m) => m.id === tok?.refId);
      const locked = !!obj?.conditions.some((c) => c.label.toLowerCase() === 'locked');
      const hidden = !!tok?.isHidden;
      const dc = (obj && 'objectDc' in obj ? obj.objectDc : undefined) ?? 12;
      return { door: d, tok, obj, open: !!d.open, locked, hidden, dc };
    });
  }, [selectedDoors, doorSnapshot]);

  const updateSelectedDoors = (patch: { open?: boolean; locked?: boolean; hidden?: boolean; objectDc?: number }) => {
    if (!map || !selectedDoors.length) return;
    useStore.getState().editMapWalls(map.id, {
      doorState: { doorIds: selectedDoors.map((d) => d.id), ...patch },
    });
  };

  return (
    <>
      {!editorOpen && doorDragPreview && doorDragPreview.ids.length > 0 && (
        <div
          data-testid="door-preview-hint"
          role="status"
          style={{
            position: 'absolute',
            bottom: 92,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 5,
            padding: '9px 14px',
            background: '#102633ee',
            border: '1px solid #78e6ff',
            borderRadius: 6,
            color: '#c7f5ff',
            pointerEvents: 'none',
          }}
        >
          Release to interact · {doorDragPreview.ids.map((id) => `Door ${doors.findIndex((d) => d.id === id) + 1}`).join(', ')}
        </div>
      )}
      {!editorOpen && activeDoorControls.length > 0 && !doorDragPreview && (
        <section data-testid="door-controls" className="nearby-door-controls" role="region" aria-label="Door controls">
          <header>
            <strong>Door controls</strong>
            <button
              className="btn tiny"
              aria-label="Close door controls"
              title="Close — click a nearby door or leave and return to reopen"
              onClick={dismissDoorControls}
            >
              ×
            </button>
          </header>
          <div className="nearby-door-list">
            {activeDoorControls.map((d) => {
              const token = doorSnapshot.tokens.find((t) => t.id === d.tokenId);
              return (
                <div className="nearby-door" key={d.id}>
                  <strong>Door {doors.indexOf(d) + 1}</strong>
                  {token ? (
                    <>
                      <ObjectControls snapshot={doorSnapshot} token={token} editable={actualDm} compact />
                      {actualDm && (
                        <button className="btn tiny" onClick={() => onSelectToken(token)}>
                          Door details
                        </button>
                      )}
                    </>
                  ) : (
                    <button className="btn" onClick={() => operateDoor(d.id, !d.open)}>
                      {d.open ? 'Close' : 'Open'} door
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
      {editorOpen && lightEditorOpen && selectedLights.length > 0 && map && (
        <section
          data-testid="map-light-inspector"
          role="dialog"
          aria-label="Light options"
          onPointerDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            left: lightEditorPos ? Math.max(76, Math.min(lightEditorPos.x + 14, window.innerWidth - 310)) : undefined,
            top: lightEditorPos ? Math.max(14, Math.min(lightEditorPos.y - 40, window.innerHeight - 450)) : 70,
            right: lightEditorPos ? undefined : 16,
            width: 286,
            maxHeight: 'calc(100% - 170px)',
            overflowY: 'auto',
            zIndex: 35,
            background: '#141820f7',
            border: '1px solid #b89658',
            borderRadius: 6,
            padding: '10px 12px',
            boxShadow: '0 12px 32px #000b',
            color: '#f2e6cc',
            fontSize: 12,
            display: 'grid',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <strong>
              {selectedLights.length === 1
                ? `Light #${allLights.findIndex((l) => l.id === selectedLights[0].id) + 1}`
                : `${selectedLights.length} lights selected`}
            </strong>
            <button type="button" className="btn tiny" aria-label="Close light options" onClick={onCloseLightEditor}>
              ×
            </button>
          </div>
          <BulkLightFields
            lights={selectedLights}
            allLights={allLights}
            onUpdateLights={updateLights}
            onApplyAsDefault={applyStyleAsDefault}
          />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', paddingTop: 4, borderTop: '1px solid #594b3466' }}>
            {onDuplicateFeatures && (
              <button type="button" className="btn tiny" title="Duplicate selected light(s) (Ctrl+D)" onClick={onDuplicateFeatures}>
                ⧉ Duplicate
              </button>
            )}
            {allLights.length > 1 && selectedLights.length < allLights.length && onSelectAllLights && (
              <button type="button" className="btn tiny" onClick={onSelectAllLights}>
                Select all ({allLights.length})
              </button>
            )}
            <button
              type="button"
              className="btn tiny danger"
              onClick={() => {
                deleteFeatures();
                onCloseLightEditor?.();
              }}
            >
              Delete {selectedLights.length === 1 ? 'light' : `${selectedLights.length} lights`}
            </button>
          </div>
        </section>
      )}
      {editorOpen && doorEditorOpen && doorMeta.length > 0 && map && (
        <section
          data-testid="map-door-inspector"
          role="dialog"
          aria-label="Door options"
          onPointerDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            left: doorEditorPos ? Math.max(76, Math.min(doorEditorPos.x + 14, window.innerWidth - 310)) : undefined,
            top: doorEditorPos ? Math.max(14, Math.min(doorEditorPos.y - 40, window.innerHeight - 360)) : 70,
            right: doorEditorPos ? undefined : 16,
            width: 280,
            zIndex: 35,
            background: '#141820f7',
            border: '1px solid #b89658',
            borderRadius: 6,
            padding: '10px 12px',
            boxShadow: '0 12px 32px #000b',
            color: '#f2e6cc',
            fontSize: 12,
            display: 'grid',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <strong>
              {doorMeta.length === 1
                ? `Door #${doors.findIndex((d) => d.id === doorMeta[0].door.id) + 1}`
                : `${doorMeta.length} doors selected`}
            </strong>
            <button type="button" className="btn tiny" aria-label="Close door options" onClick={onCloseDoorEditor}>
              ×
            </button>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className={`btn tiny ${doorMeta.every((m) => !m.open) ? 'on' : ''}`}
              onClick={() => updateSelectedDoors({ open: false })}
            >
              🚪 Closed
            </button>
            <button
              type="button"
              className={`btn tiny ${doorMeta.every((m) => m.open) ? 'on' : ''}`}
              onClick={() => updateSelectedDoors({ open: true })}
            >
              🔓 Open
            </button>
          </div>
          <label className="environment-toggle">
            <input
              type="checkbox"
              checked={doorMeta.every((m) => m.locked)}
              onChange={(e) => updateSelectedDoors({ locked: e.target.checked })}
            />
            🔒 Locked (players must unlock first)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span>Lock / Force DC</span>
            <NumberInput
              aria-label="Door lock DC"
              min={1}
              max={40}
              step={1}
              value={doorMeta[0].dc}
              emptyFallback={12}
              onValueChange={(dc) => {
                if (dc !== undefined && Number.isFinite(dc)) updateSelectedDoors({ objectDc: dc });
              }}
              style={{ width: 64 }}
            />
          </label>
          <label className="environment-toggle">
            <input
              type="checkbox"
              checked={doorMeta.every((m) => m.hidden)}
              onChange={(e) => updateSelectedDoors({ hidden: e.target.checked })}
            />
            🕵️ Secret door (hidden from players)
          </label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', paddingTop: 4, borderTop: '1px solid #594b3466' }}>
            {doors.length > 1 && selectedDoors.length < doors.length && onSelectAllDoors && (
              <button type="button" className="btn tiny" onClick={onSelectAllDoors}>
                Select all doors ({doors.length})
              </button>
            )}
            {doorMeta.length === 1 && doorMeta[0].tok && (
              <button
                type="button"
                className="btn tiny"
                onClick={() => {
                  onCloseDoorEditor?.();
                  setWallTool('off');
                  onSelectToken(doorMeta[0].tok!);
                }}
              >
                Inspect object
              </button>
            )}
            <button
              type="button"
              className="btn tiny danger"
              onClick={() => {
                deleteFeatures();
                onCloseDoorEditor?.();
              }}
            >
              Delete {doorMeta.length === 1 ? 'door' : `${doorMeta.length} doors`}
            </button>
          </div>
        </section>
      )}
      {editorOpen && (
        <div
          data-testid="wall-drawing-hint"
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            bottom: 88,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 28,
            background: '#161b23f2',
            color: '#ffe5b3',
            padding: '8px 12px',
            border: '1px solid #aa8550',
            borderRadius: 6,
            boxShadow: '0 8px 26px #000a',
            fontSize: 12,
            display: 'grid',
            gap: 6,
            maxWidth: 'calc(100% - 150px)',
          }}
        >
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
            {QUICK_WALL_TOOLS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`btn tiny ${!placingLight && wallTool === item.id ? 'on' : ''}`}
                title={item.title}
                onClick={() => {
                  onStopPlaceLight?.();
                  setWallAnchor(null);
                  setWallTool(item.id);
                }}
              >
                {item.label}
              </button>
            ))}
            {onStartPlaceLight && (
              <button
                type="button"
                className={`btn tiny ${placingLight ? 'on' : ''}`}
                title="Click map repeatedly to place lights · Right/double-click any light to edit (G)"
                onClick={() => {
                  setWallAnchor(null);
                  if (placingLight) {
                    onStopPlaceLight?.();
                    setWallTool('edit');
                  } else {
                    setWallTool('off');
                    onStartPlaceLight();
                  }
                }}
              >
                🕯️ Light
              </button>
            )}
            {setWallSnap && (
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0 4px', cursor: 'pointer' }} title="Snap endpoints to grid corners and existing wall vertices">
                <input type="checkbox" checked={!!wallSnap} onChange={(e) => setWallSnap(e.target.checked)} />
                Snap
              </label>
            )}
            {wallTool === 'draw' && !placingLight && setWallChain && (
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0 4px', cursor: 'pointer' }} title="Continue each drawn wall segment from the previous endpoint (Esc or Enter to end chain)">
                <input type="checkbox" checked={!!wallChain} onChange={(e) => setWallChain(e.target.checked)} />
                ⛓ Chain
              </label>
            )}
            <button
              type="button"
              className="btn tiny"
              title="Undo last map or session action (Ctrl+Z)"
              onClick={() => useStore.getState().undo()}
            >
              ↩ Undo
            </button>
            <button
              type="button"
              className="btn tiny"
              onClick={() => {
                onStopPlaceLight?.();
                setWallTool('off');
                setWallAnchor(null);
              }}
            >
              Done
            </button>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ color: '#d8c59e' }}>
              {placingLight
                ? 'Click map to place lights · Right/double-click light to edit · V/L/R/C/F/D/E/G hotkeys'
                : wallTool === 'erase-area'
                  ? 'Drag a box to erase that wall section (doors kept)'
                  : wallTool === 'rectangle'
                    ? 'Drag wall rectangle (Shift = square) · Right-click wall to delete'
                    : wallTool === 'door'
                      ? 'Drag along wall(s) or junctions to cut a door (Shift = 45°) · Right/double-click door for options'
                      : wallTool === 'draw'
                        ? 'Drag or click-chain wall lines (Shift = 0°/45°/90°, Esc/Enter ends chain) · Right-click wall to delete'
                        : wallTool === 'circle'
                          ? 'Drag from center to wall radius · Right-click wall to delete'
                          : wallTool === 'freehand'
                            ? 'Hold and trace wall · Right-click wall to delete'
                            : wallTool === 'edit'
                              ? 'Drag walls/lights or square handles · Alt+Drag or Ctrl+D duplicates · Right/double-click light or door for options'
                              : 'Click any wall piece to delete it'}
            </span>

            {['draw', 'circle', 'freehand'].includes(wallTool) && !placingLight && (
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                Thickness{' '}
                <NumberInput
                  aria-label="Wall thickness in feet"
                  min={0.1}
                  max={20}
                  step={0.25}
                  allowDecimal
                  value={wallThickness}
                  emptyFallback={0.5}
                  onValueChange={(n) => {
                    if (n !== undefined) setWallThickness(Math.max(0.1, Math.min(20, n)));
                  }}
                  style={{ width: 60 }}
                />{' '}
                ft
              </label>
            )}

            {wallTool === 'edit' && selectedWall && (
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                Rotation{' '}
                <NumberInput
                  aria-label="Wall rotation in degrees"
                  min={-360}
                  max={360}
                  step={1}
                  value={Math.round(selectedWall.rotation ?? 0)}
                  emptyFallback={0}
                  onValueChange={(rotation) => {
                    if (rotation !== undefined && Number.isFinite(rotation) && map)
                      useStore
                        .getState()
                        .editMapWalls(map.id, { update: { ...selectedWall, rotation: Math.max(-360, Math.min(360, rotation)) } });
                  }}
                  style={{ width: 62 }}
                />
                °
              </label>
            )}

            {selectedNonDoorWalls.length > 0 && (
              <div style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }} role="group" aria-label="Barrier type">
                <span style={{ color: '#c4b18c' }}>Barrier:</span>
                <button
                  type="button"
                  data-testid="barrier-type-wall"
                  className={`btn tiny ${allSelectedAreSolidWalls ? 'on' : ''}`}
                  title="Convert selected piece(s) to solid wall (blocks movement and sight)"
                  onClick={() => setBarrierType('wall')}
                >
                  🧱 Wall
                </button>
                <button
                  type="button"
                  data-testid="barrier-type-window"
                  className={`btn tiny ${allSelectedAreWindows ? 'on' : ''}`}
                  title="Convert selected piece(s) to window (blocks movement, allows sight & light)"
                  onClick={() => setBarrierType('window')}
                >
                  🪟 Window
                </button>
                <button
                  type="button"
                  data-testid="barrier-type-arch"
                  className={`btn tiny ${allSelectedAreArches ? 'on' : ''}`}
                  title="Convert selected piece(s) to arch / overpass (allows movement and sight)"
                  onClick={() => setBarrierType('arch')}
                >
                  ⛩ Arch
                </button>
              </div>
            )}

            {allLights.length > 0 && (
              <>
                {onSelectAllLights && (
                  <button
                    type="button"
                    className="btn tiny"
                    title="Select every placed light on this map and open bulk light options"
                    onClick={onSelectAllLights}
                  >
                    Select all lights ({allLights.length})
                  </button>
                )}
                <button
                  type="button"
                  className={`btn tiny ${anyLightOn ? 'on' : ''}`}
                  title="Toggle every placed light on this map on or off at once"
                  onClick={toggleAllLights}
                >
                  {anyLightOn ? 'All lights off' : 'All lights on'}
                </button>
              </>
            )}

            {selectedLights.length > 0 && onOpenLightEditor && (
              <button type="button" className="btn tiny" onClick={onOpenLightEditor}>
                Edit {selectedLights.length === 1 ? 'light' : `${selectedLights.length} lights`}
              </button>
            )}

            {selectedDoors.length > 0 && onOpenDoorEditor && (
              <button type="button" className="btn tiny" onClick={onOpenDoorEditor}>
                Edit {selectedDoors.length === 1 ? 'door' : `${selectedDoors.length} doors`}
              </button>
            )}

            {duplicableCount > 0 && onDuplicateFeatures && (
              <button
                type="button"
                data-testid="duplicate-map-features"
                className="btn tiny"
                title="Duplicate selected walls and lights (Ctrl+D or Alt+Drag)"
                onClick={onDuplicateFeatures}
              >
                ⧉ Duplicate
              </button>
            )}

            {featureSelection.length > 0 && (
              <button data-testid="delete-map-features" className="btn tiny danger" onClick={deleteFeatures}>
                Delete {featureSelection.length} selected
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
