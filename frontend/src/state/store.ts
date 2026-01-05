import { create } from 'zustand';
import type { Scene, SceneNode, StableId, Vec2 } from '../shared/types';
import { generateStableId } from '../shared/types';
import { segmentManager } from '../geometry/segmentManager';
import { buildFunctionRegistry, computeAdaptiveResolution, marchingSquaresSegmentsWithRegistry, sampleExplicitWithRegistry, computeExtrema, computeInflectionPoints, projectPointsToAxes, isExplicitLinear, evaluateWithRegistry, findExplicitVerticalBreaks } from '../geometry/mathEval';
import { connectSegmentsToPolylines } from '../geometry/mathEval';
import { saveGraph, loadGraph } from './graphStorage';
import { sceneToSVG } from '../export/svg';

// History snapshot type and utilities
type SceneSnapshot = {
  scene: Scene;
  selectedIds: StableId[];
  nextSymbolIndex: number;
};

function deepCloneSnapshot(s: SceneSnapshot): SceneSnapshot {
  try {
    const sc = (globalThis as any).structuredClone;
    return (sc ? sc(s) : JSON.parse(JSON.stringify(s))) as SceneSnapshot;
  } catch {
    return JSON.parse(JSON.stringify(s)) as SceneSnapshot;
  }
}

type Tool = 'select' | 'line' | 'bezier' | 'arrow' | 'pan' | 'two-point-line' | 'two-point-segment' | 'two-point-dashed' | 'two-point-ray' | 'two-point-angle' | 'curve-tangent' | 'curve-point' | 'paint' | 'length-dashed' | 'circle-3pt' | 'circle-center' | 'circle-radius' | 'magnifier';

export type SceneState = {
  scene: Scene;
  currentTool: Tool;
  selectedIds: StableId[];
  hoveredId: StableId | null;
  hoveredIntersection: Vec2 | null; // for intersection hover
  hoveredBezierAnchorId: StableId | null; // for bezier anchor/handle hover
  hoveredAxisAnchorId: StableId | null; // for axis anchor hover
  currentMousePos: Vec2 | null; // current mouse position in world coords
  dpr: number;
  isInteracting: boolean;
  isDraggingAxisAnchor: boolean; // true when dragging a custom axis anchor
  draggingNodeType: 'anchor' | 'segment' | 'math-text' | 'bezier-curve' | null; // type of node currently being dragged
  nextSymbolIndex: number; // for f,g,h,... assignment
  twoPointFirstClick: Vec2 | null; // for two-point tools
  twoPointAngleFirstSegment: StableId | null; // for two-point-angle tool
  twoPointAngleFirstClickPos: Vec2 | null; // where first segment was clicked
  lengthDashedFirstClick: Vec2 | null; // for length-dashed tool
  arrowFirstClick: Vec2 | null; // for arrow tool
  // Circle tools
  circleFirstClick: Vec2 | null; // for circle tools (center or first point)
  circleSecondClick: Vec2 | null; // for 3-point circle second point
  circleRadius: number | null; // for circle-radius tool
  intersections: Vec2[]; // computed intersection points
  functionIntersections: Vec2[]; // stable intersections derived from functions/segment conversion (no feedback loop)
  mathLabelClipRegions: Array<{ screenX: number; screenY: number; width: number; height: number }>; // regions to clip for math labels with displayAboveCurves
  savedViewBeforeMagnifier: Scene['view'] | null; // saved view state when entering magnifier mode
  // Agent drawing state
  agentDrawingPending: boolean; // true when AI agent is executing tool calls (show skeleton)
  // History state
  undoStack: SceneSnapshot[];
  redoStack: SceneSnapshot[];
  suppressHistory: boolean;
  pendingInteractionSnapshot: SceneSnapshot | null;
  hasPendingInteractionChange: boolean;
  setTool: (tool: Tool) => void;
  setDpr: (dpr: number) => void;
  setInteracting: (active: boolean) => void;
  setDraggingNodeType: (type: 'anchor' | 'segment' | 'math-text' | 'bezier-curve' | null) => void;
  upsertNode: (node: SceneNode) => void;
  removeNode: (id: StableId) => void;
  setZIndex: (id: StableId, z: number) => void;
  setView: (view: Scene['view']) => void;
  setSelected: (ids: StableId[]) => void;
  setHovered: (id: StableId | null) => void;
  setHoveredIntersection: (pos: Vec2 | null) => void;
  setHoveredBezierAnchor: (id: StableId | null) => void;
  setHoveredAxisAnchor: (id: StableId | null) => void;
  createAnchor: (position: Vec2) => StableId;
  addPoint: (position: Vec2, diameterMm?: number, color?: string) => StableId;
  setTwoPointFirstClick: (pos: Vec2 | null) => void;
  setTwoPointAngleFirstSegment: (segmentId: StableId | null, clickPos?: Vec2 | null) => void;
  setLengthDashedFirstClick: (pos: Vec2 | null) => void;
  setArrowFirstClick: (pos: Vec2 | null) => void;
  setCircleFirstClick: (pos: Vec2 | null) => void;
  setCircleSecondClick: (pos: Vec2 | null) => void;
  setCircleRadius: (radius: number | null) => void;
  convertFunctionsToSegments: () => void;
  updateIntersectionsWithPoints: () => void;
  allocateFunctionSymbol: (preferImplicit?: boolean) => string;
  undo: () => void;
  redo: () => void;
  resetScene: () => void;
  saveCurrentGraph: (name: string, thumbnail?: string) => Promise<string>; // returns graph ID
  loadGraphById: (id: string) => Promise<boolean>; // returns success status
  setAgentDrawingPending: (pending: boolean) => void;
};

// Create default axes with labels
const createDefaultAxes = () => {
  const xStartId = generateStableId('anchor-x-start');
  const xEndId = generateStableId('anchor-x-end');
  const yStartId = generateStableId('anchor-y-start');
  const yEndId = generateStableId('anchor-y-end');

  const xAxisId = generateStableId('axis-x');
  const yAxisId = generateStableId('axis-y');

  // 라벨 노드 추가: rmO (원점), x (x축 끝), y (y축 끝)
  const originLabelId = generateStableId('label-origin');
  const xLabelId = generateStableId('label-x');
  const yLabelId = generateStableId('label-y');

  return {
    [xStartId]: { id: xStartId, kind: 'anchor' as const, position: { x: -8, y: 0 } },
    [xEndId]: { id: xEndId, kind: 'anchor' as const, position: { x: 8, y: 0 } },
    [yStartId]: { id: yStartId, kind: 'anchor' as const, position: { x: 0, y: -8 } },
    [yEndId]: { id: yEndId, kind: 'anchor' as const, position: { x: 0, y: 8 } },
    [xAxisId]: {
      id: xAxisId,
      kind: 'axis' as const,
      originId: xStartId,
      endpointId: xEndId,
      style: { color: '#000', width: 2 },
      showArrow: true,
      visible: true,
      name: 'X',
      labelId: xLabelId  // x축 라벨 연결
    },
    [yAxisId]: {
      id: yAxisId,
      kind: 'axis' as const,
      originId: yStartId,
      endpointId: yEndId,
      style: { color: '#000', width: 2 },
      showArrow: true,
      visible: true,
      name: 'Y',
      labelId: yLabelId  // y축 라벨 연결
    },
    // 원점 라벨 (rmO) - 원점(0,0)에서 픽셀 오프셋으로 고정
    [originLabelId]: {
      id: originLabelId,
      kind: 'math-text' as const,
      position: { x: 0, y: 0 },  // 원점
      latex: 'rmO',
      fontSize: 11,
      offsetPx: { x: -20, y: 20 }  // 원점 좌측 하단에 고정 (픽셀 단위)
    },
    // x축 라벨 - 축에 연결됨 (axisId로 추적)
    [xLabelId]: {
      id: xLabelId,
      kind: 'math-text' as const,
      position: { x: 0, y: 0 },  // 초기 위치 (offsetPx로 계산됨)
      latex: 'x',
      fontSize: 11,
      axisId: xAxisId,  // 축과 연결
      offsetPx: { x: 7, y: 16 }  // 축 끝점으로부터 픽셀 오프셋 (우측 하단)
    },
    // y축 라벨 - 축에 연결됨 (axisId로 추적)
    [yLabelId]: {
      id: yLabelId,
      kind: 'math-text' as const,
      position: { x: 0, y: 0 },  // 초기 위치 (offsetPx로 계산됨)
      latex: 'y',
      fontSize: 11,
      axisId: yAxisId,  // 축과 연결
      offsetPx: { x: -15, y: -6 }  // 축 끝점으로부터 픽셀 오프셋 (좌측 상단)
    }
  };
};

const initialScene: Scene = {
  id: generateStableId('scene'),
  nodes: createDefaultAxes(),
  zIndex: {},
  view: { scale: 1, rotation: 0, translate: { x: 0, y: 0 }, yScale: 1, magnification: 1 },
};

// ========= 로컬 자동 저장/복원 (마지막 접속 상태 유지) =========
const LAST_SCENE_STORAGE_KEY = 'alphacanvas_last_scene_v1';
const LEGACY_SCENE_STORAGE_KEYS = [
  // 이전 프로젝트/배포에서 쓰던 키들 (마이그레이션)
  'alphastudio_last_scene_v1',
  'alphastudio_last_scene',
  'alphacanvas_last_scene', // 혹시 v1 이전을 썼던 경우
];

function safeLoadLastScene(): Scene | null {
  try {
    // 1) 현재 키 우선
    let raw = localStorage.getItem(LAST_SCENE_STORAGE_KEY);
    let fromKey: string | null = raw ? LAST_SCENE_STORAGE_KEY : null;

    // 2) 없으면 레거시 키에서 탐색
    if (!raw) {
      for (const k of LEGACY_SCENE_STORAGE_KEYS) {
        const v = localStorage.getItem(k);
        if (v) {
          raw = v;
          fromKey = k;
          break;
        }
      }
    }

    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.nodes || !parsed.view) return null;

    // 레거시 키에서 읽었다면 최신 키로 승격(복사)해서 다음부터는 안정적으로 로드
    if (fromKey && fromKey !== LAST_SCENE_STORAGE_KEY) {
      try {
        localStorage.setItem(LAST_SCENE_STORAGE_KEY, raw);
      } catch { }
    }

    // 최소한의 형태만 확인 (상세 스키마 검증은 생략)
    return parsed as Scene;
  } catch {
    return null;
  }
}

const bootScene: Scene = (() => {
  try {
    const saved = safeLoadLastScene();
    return saved || initialScene;
  } catch {
    return initialScene;
  }
})();

export const useSceneStore = create<SceneState>((set, get) => ({
  scene: bootScene,
  currentTool: 'select',
  selectedIds: [],
  hoveredId: null,
  hoveredIntersection: null,
  hoveredBezierAnchorId: null,
  hoveredAxisAnchorId: null,
  currentMousePos: null,
  dpr: Math.max(1, window.devicePixelRatio || 1),
  isInteracting: false,
  isDraggingAxisAnchor: false,
  draggingNodeType: null,
  nextSymbolIndex: 0,
  twoPointFirstClick: null,
  twoPointAngleFirstSegment: null,
  twoPointAngleFirstClickPos: null,
  lengthDashedFirstClick: null,
  arrowFirstClick: null,
  circleFirstClick: null,
  circleSecondClick: null,
  circleRadius: null,
  intersections: [],
  functionIntersections: [],
  mathLabelClipRegions: [],
  savedViewBeforeMagnifier: null,
  // History init
  undoStack: [],
  redoStack: [],
  suppressHistory: false,
  pendingInteractionSnapshot: null,
  hasPendingInteractionChange: false,
  agentDrawingPending: false,
  setTool: (tool) => {
    set({ currentTool: tool, twoPointFirstClick: null, twoPointAngleFirstSegment: null, twoPointAngleFirstClickPos: null, lengthDashedFirstClick: null, arrowFirstClick: null, circleFirstClick: null, circleSecondClick: null, circleRadius: null }); // reset first click when changing tool
  },
  setDpr: (dpr) => set({ dpr }),
  setInteracting: (active) => {
    const s = get();
    if (active) {
      set({ isInteracting: true });
      return;
    }

    const wasAxisDrag = s.isDraggingAxisAnchor;

    // Interaction ended: if any pending, commit single snapshot
    if (s.hasPendingInteractionChange && s.pendingInteractionSnapshot) {
      set((curr) => ({
        isInteracting: false,
        isDraggingAxisAnchor: false,
        draggingNodeType: null,
        undoStack: [...curr.undoStack, deepCloneSnapshot(curr.pendingInteractionSnapshot as SceneSnapshot)],
        redoStack: [],
        pendingInteractionSnapshot: null,
        hasPendingInteractionChange: false,
      }));
    } else {
      set({ isInteracting: false, isDraggingAxisAnchor: false, draggingNodeType: null });
    }

    // Update special points after interaction ends (e.g., after dragging anchors)
    // This ensures endpoints and projections are recalculated once, not on every mouse move
    get().updateIntersectionsWithPoints();

    // Check if we need to reconvert functions after dragging
    const state = get();
    const wasBezierDrag = s.draggingNodeType === 'bezier-curve';

    // If we were dragging an axis anchor, we MUST resample function-derived segments.
    // Otherwise implicit/explicit function segments keep old sampling bounds and appear "not extended"
    // until some unrelated action triggers reconversion (e.g., adding another function).
    //
    // Important: convertFunctionsToSegments intentionally preserves user-created two-point segments
    // (no functionId), so this won't destroy user styling for manual segments.
    if (wasAxisDrag) {
      const hasClipToAxesFunctions = Object.values(state.scene.nodes).some((node: any) =>
        node && (node.kind === 'function-explicit' || node.kind === 'function-implicit') && node.clipToAxes
      );
      if (hasClipToAxesFunctions) {
        requestAnimationFrame(() => {
          setTimeout(() => {
            get().convertFunctionsToSegments();
          }, 50);
        });
      }
    }

    // If we were dragging a bezier anchor/handle, reconvert to update intersections
    if (wasBezierDrag) {
      const hasFunctions = Object.values(state.scene.nodes).some((node: any) =>
        node && (node.kind === 'function-explicit' || node.kind === 'function-implicit')
      );

      if (hasFunctions) {
        // Trigger reconversion after interaction ends
        requestAnimationFrame(() => {
          setTimeout(() => {
            get().convertFunctionsToSegments();
          }, 50);
        });
      }
    }
  },
  setTwoPointFirstClick: (pos) => set({ twoPointFirstClick: pos }),
  setTwoPointAngleFirstSegment: (segmentId, clickPos) => set({ twoPointAngleFirstSegment: segmentId, twoPointAngleFirstClickPos: clickPos ?? null }),
  setLengthDashedFirstClick: (pos) => set({ lengthDashedFirstClick: pos }),
  setArrowFirstClick: (pos) => set({ arrowFirstClick: pos }),
  // Circle helpers
  setCircleFirstClick: (pos: Vec2 | null) => set({ circleFirstClick: pos }),
  setCircleSecondClick: (pos: Vec2 | null) => set({ circleSecondClick: pos }),
  setCircleRadius: (radius: number | null) => set({ circleRadius: radius }),
  upsertNode: (node) => {
    set((s) => {
      // Record snapshot before change
      let undoStack = s.undoStack;
      let redoStack: SceneSnapshot[] = s.redoStack;
      let pendingInteractionSnapshot = s.pendingInteractionSnapshot;
      let hasPendingInteractionChange = s.hasPendingInteractionChange;
      if (!s.suppressHistory) {
        const before = deepCloneSnapshot({ scene: s.scene, selectedIds: s.selectedIds, nextSymbolIndex: s.nextSymbolIndex });
        if (s.isInteracting) {
          if (!pendingInteractionSnapshot) {
            pendingInteractionSnapshot = before;
            hasPendingInteractionChange = true;
          }
        } else {
          undoStack = [...undoStack, before];
          redoStack = [];
        }
      }

      return {
        scene: { ...s.scene, nodes: { ...s.scene.nodes, [node.id]: node } },
        undoStack,
        redoStack,
        pendingInteractionSnapshot,
        hasPendingInteractionChange,
      } as any;
    });
    // Auto-convert to segments when a function is added (but not for preview functions)
    const n = node as any;
    if ((n.kind === 'function-explicit' || n.kind === 'function-implicit') && !n.segmentsOnly && !n.isPreview) {
      // Use requestAnimationFrame to ensure state is updated
      requestAnimationFrame(() => {
        setTimeout(() => {
          get().convertFunctionsToSegments();
        }, 50);
      });
    }

    // Update special points when a segment is added/modified
    // Only update if not currently interacting (dragging), to avoid performance issues
    if (n.kind === 'segment' && !get().isInteracting) {
      const state = get();

      // Check if this is a two-point segment (no functionId) and there are functions present
      const isTwoPointSeg = !n.functionId;
      const isAutoSplitTpSeg = isTwoPointSeg && typeof (n as any).stableSegmentId === 'string' && (n as any).stableSegmentId.startsWith('tpseg_');
      const hasFunctions = Object.values(state.scene.nodes).some((node: any) =>
        node && (node.kind === 'function-explicit' || node.kind === 'function-implicit')
      );

      if (isTwoPointSeg && hasFunctions && !isAutoSplitTpSeg) {
        // Trigger reconversion to detect intersections with existing functions
        requestAnimationFrame(() => {
          setTimeout(() => {
            get().convertFunctionsToSegments();
          }, 50);
        });
      } else {
        get().updateIntersectionsWithPoints();
      }
    }

    // Update special points when a bezier is added/modified
    // Only update if not currently interacting (dragging), to avoid performance issues
    if (n.kind === 'bezier' && !get().isInteracting) {
      const state = get();
      const hasFunctions = Object.values(state.scene.nodes).some((node: any) =>
        node && (node.kind === 'function-explicit' || node.kind === 'function-implicit')
      );
      if (hasFunctions) {
        // Bezier added/modified with functions present - reconvert to update intersections
        requestAnimationFrame(() => {
          setTimeout(() => {
            get().convertFunctionsToSegments();
          }, 50);
        });
      } else {
        get().updateIntersectionsWithPoints();
      }
    }

    // Update special points when an anchor is moved (affects segment/bezier endpoints)
    // Only update if not currently interacting (dragging), to avoid performance issues
    if (n.kind === 'anchor' && !get().isInteracting) {
      const state = get();
      let hasBezierUsingAnchor = false;
      const hasSegmentOrBezierUsingAnchor = Object.values(state.scene.nodes).some((node: any) => {
        if (!node) return false;
        if (node.kind === 'segment' && (node.startAnchorId === n.id || node.endAnchorId === n.id)) return true;
        if (node.kind === 'bezier' && (node.a === n.id || node.b === n.id || node.c1 === n.id || node.c2 === n.id)) {
          hasBezierUsingAnchor = true;
          return true;
        }
        return false;
      });
      if (hasSegmentOrBezierUsingAnchor) {
        // If bezier anchor moved and there are functions, reconvert to update intersections
        const hasFunctions = Object.values(state.scene.nodes).some((node: any) =>
          node && (node.kind === 'function-explicit' || node.kind === 'function-implicit')
        );
        if (hasBezierUsingAnchor && hasFunctions) {
          // Trigger reconversion after interaction ends
          requestAnimationFrame(() => {
            setTimeout(() => {
              get().convertFunctionsToSegments();
            }, 50);
          });
        } else {
          get().updateIntersectionsWithPoints();
        }
      }
    }
  },
  removeNode: (id) => {
    const removedNode = get().scene.nodes[id] as any;
    const wasPoint = removedNode && removedNode.kind === 'point';
    const wasSegment = removedNode && removedNode.kind === 'segment';
    const wasBezier = removedNode && removedNode.kind === 'bezier';
    const wasFunction = removedNode && (removedNode.kind === 'function-explicit' || removedNode.kind === 'function-implicit');
    // If we auto-delete a function because its last segment was erased, treat it like a function removal
    // for reconversion purposes (to remove stale intersection splits).
    let autoRemovedFunctionId: string | null = null;

    set((s) => {
      // History before change
      let undoStack = s.undoStack;
      let redoStack: SceneSnapshot[] = s.redoStack;
      let pendingInteractionSnapshot = s.pendingInteractionSnapshot;
      let hasPendingInteractionChange = s.hasPendingInteractionChange;
      if (!s.suppressHistory) {
        const before = deepCloneSnapshot({ scene: s.scene, selectedIds: s.selectedIds, nextSymbolIndex: s.nextSymbolIndex });
        if (s.isInteracting) {
          if (!pendingInteractionSnapshot) {
            pendingInteractionSnapshot = before;
            hasPendingInteractionChange = true;
          }
        } else {
          undoStack = [...undoStack, before];
          redoStack = [];
        }
      }
      const next = { ...s.scene.nodes };
      const removed = next[id] as any;
      delete next[id];
      const z = { ...s.scene.zIndex };
      delete z[id];

      // Helper function to prune unreferenced anchors
      const pruneIfUnreferenced = (anchorId?: string) => {
        if (!anchorId) return;
        const stillUsed = Object.values(next).some((node: any) => {
          if (!node) return false;
          if (node.kind === 'segment' && (node.startAnchorId === anchorId || node.endAnchorId === anchorId)) return true;
          if (node.kind === 'line' && (node.a === anchorId || node.b === anchorId)) return true;
          if (node.kind === 'bezier' && (node.a === anchorId || node.b === anchorId || node.c1 === anchorId || node.c2 === anchorId)) return true;
          if (node.kind === 'axis' && (node.originId === anchorId || node.endpointId === anchorId)) return true;
          return false;
        });
        if (!stillUsed) {
          delete next[anchorId as string];
          delete z[anchorId as string];
        }
      };

      // If removing a segment, also consider pruning orphan anchors (optional, conservative)
      if (removed && removed.kind === 'segment') {
        const fnId = removed.functionId as string;
        const fnNode = next[fnId] as any;
        if (fnNode && (fnNode.kind === 'function-explicit' || fnNode.kind === 'function-implicit')) {
          // Count remaining segments for this function (after this removal)
          const hasRemaining = Object.values(next).some((node: any) => node && node.kind === 'segment' && node.functionId === fnId);

          if (fnNode.kind === 'function-implicit') {
            // 음함수: 삭제된 세그먼트를 억제 리스트에 추가
            const stableId = removed.stableSegmentId as string | undefined;
            let updated = { ...fnNode } as any;
            if (stableId) {
              const suppressed = new Set<string>(fnNode.suppressedSegmentIds || []);
              suppressed.add(stableId);
              updated.suppressedSegmentIds = Array.from(suppressed);
            }

            // 음함수는 축 이동 시 샘플링이 바뀌므로 중심점과 방향 벡터로도 저장
            const samples = removed.samples as Array<{ x: number; y: number }> | undefined;
            if (samples && samples.length >= 2) {
              const centers = updated.suppressedSegmentCenters || [];
              // 세그먼트의 중심점과 방향 벡터 계산
              const mid = Math.floor(samples.length / 2);
              const centerPt = samples[mid];
              // 방향 벡터 (시작 -> 끝의 정규화된 방향)
              const dx = samples[samples.length - 1].x - samples[0].x;
              const dy = samples[samples.length - 1].y - samples[0].y;
              const len = Math.sqrt(dx * dx + dy * dy);
              const dirX = len > 1e-9 ? dx / len : 0;
              const dirY = len > 1e-9 ? dy / len : 0;

              centers.push({ x: centerPt.x, y: centerPt.y, dx: dirX, dy: dirY });
              updated.suppressedSegmentCenters = centers;

              // Also store segment endpoints as persistent split points so that even if this
              // implicit curve is re-sampled/re-merged (e.g., after deleting another function),
              // we can force a split near the same deleted arc and keep it suppressed.
              const sp = updated.suppressedSplitPoints || [];
              const key = (p: { x: number; y: number }) => `${p.x.toFixed(6)}_${p.y.toFixed(6)}`;
              const seen = new Set<string>(sp.map((p: any) => key(p)));
              const a = samples[0];
              const b = samples[samples.length - 1];
              for (const p of [a, b]) {
                const k = key(p);
                if (!seen.has(k)) {
                  sp.push({ x: p.x, y: p.y });
                  seen.add(k);
                }
              }
              updated.suppressedSplitPoints = sp;
            }

            // 모든 세그먼트가 삭제되면 함수 자체를 제거 (위젯/화면 모두 제거)
            if (!hasRemaining) {
              delete next[fnId];
              delete z[fnId];
              autoRemovedFunctionId = fnId;
            } else {
              // 일부 세그먼트만 삭제된 경우 억제 리스트만 업데이트
              next[fnId] = updated as any;
            }
          } else {
            // 명시적 함수는 세그먼트 억제 리스트를 유지 + 양끝 세그먼트 억제 플래그 갱신
            const stableId = removed.stableSegmentId as string | undefined;
            let updated = { ...fnNode } as any;
            if (stableId) {
              const suppressed = new Set<string>(fnNode.suppressedSegmentIds || []);
              suppressed.add(stableId);
              updated.suppressedSegmentIds = Array.from(suppressed);
            }
            // 글로벌 좌/우 끝 세그먼트인지 판단하여 플래그 설정 (현재 상태의 모든 세그먼트 중 최소/최대 x 기준)
            try {
              const segmentsOfFn = Object.values(s.scene.nodes).filter((n: any) => n && n.kind === 'segment' && n.functionId === fnId) as any[];
              const withExtrema = segmentsOfFn.map((sg: any) => {
                const xs = (sg.samples || []) as Array<{ x: number; y: number }>;
                const minX = xs.length ? Math.min(...xs.map(p => p.x)) : Infinity;
                const maxX = xs.length ? Math.max(...xs.map(p => p.x)) : -Infinity;
                return { id: sg.id, minX, maxX };
              }).filter(v => Number.isFinite(v.minX) && Number.isFinite(v.maxX));
              if (withExtrema.length > 0) {
                withExtrema.sort((a, b) => a.minX - b.minX);
                const leftMostId = withExtrema[0]?.id;
                const rightMostId = withExtrema[withExtrema.length - 1]?.id;
                const prevEnds = (fnNode.suppressedEnds || {}) as { left?: boolean; right?: boolean };
                updated.suppressedEnds = {
                  left: prevEnds.left || (removed.id === leftMostId),
                  right: prevEnds.right || (removed.id === rightMostId)
                };
              }
            } catch { }
            // If no segments remain, the user has effectively erased the entire function.
            // Remove the function node too so the widget stays in sync.
            if (!hasRemaining) {
              delete next[fnId];
              delete z[fnId];
              autoRemovedFunctionId = fnId;
            } else {
              updated.segmentsOnly = true;
              next[fnId] = updated as any;
            }
          }
        }

        // Also prune this segment's anchors if they are no longer referenced elsewhere
        const startAnchorId = (removed as any).startAnchorId as string | undefined;
        const endAnchorId = (removed as any).endAnchorId as string | undefined;
        pruneIfUnreferenced(startAnchorId);
        pruneIfUnreferenced(endAnchorId);
      }

      // If removing a bezier curve, prune its anchors
      if (removed && removed.kind === 'bezier') {
        pruneIfUnreferenced(removed.a);
        pruneIfUnreferenced(removed.b);
        pruneIfUnreferenced(removed.c1);
        pruneIfUnreferenced(removed.c2);
      }

      // If removing a line, prune its anchors
      if (removed && removed.kind === 'line') {
        pruneIfUnreferenced(removed.a);
        pruneIfUnreferenced(removed.b);
      }
      // If a function is removed, remove all segments and their anchors that belong to it
      if (removed && (removed.kind === 'function-explicit' || removed.kind === 'function-implicit')) {
        const anchorIdsToRemove = new Set<string>();

        // First pass: collect segments and their anchor IDs
        for (const [nid, node] of Object.entries(next)) {
          const n = node as any;
          if (n && n.kind === 'segment' && n.functionId === id) {
            anchorIdsToRemove.add(n.startAnchorId);
            anchorIdsToRemove.add(n.endAnchorId);
            delete next[nid];
            delete z[nid];
          }
        }

        // Second pass: remove anchors that are only used by removed segments
        for (const anchorId of anchorIdsToRemove) {
          // Check if this anchor is still referenced by any remaining segment, line, bezier, or axis
          const stillUsed = Object.values(next).some((node: any) => {
            if (!node) return false;
            if (node.kind === 'segment' && (node.startAnchorId === anchorId || node.endAnchorId === anchorId)) return true;
            if (node.kind === 'line' && (node.a === anchorId || node.b === anchorId)) return true;
            if (node.kind === 'bezier' && (node.a === anchorId || node.b === anchorId || node.c1 === anchorId || node.c2 === anchorId)) return true;
            if (node.kind === 'axis' && (node.originId === anchorId || node.endpointId === anchorId)) return true;
            return false;
          });

          if (!stillUsed) {
            delete next[anchorId];
            delete z[anchorId];
          }
        }
      }
      // If no function nodes remain, reset symbol index to 0
      const hasFunction = Object.values(next).some((n: any) => n && (n.kind === 'function-explicit' || n.kind === 'function-implicit'));
      const updates: any = { scene: { ...s.scene, nodes: next, zIndex: z } };
      if (!hasFunction) {
        updates.nextSymbolIndex = 0;
      }
      return { ...updates, undoStack, redoStack, pendingInteractionSnapshot, hasPendingInteractionChange } as any;
    });

    // Update intersections if a point, segment, or bezier was removed
    if (wasPoint || wasSegment || wasBezier) {
      get().updateIntersectionsWithPoints();
    }

    // If a function was removed, remaining functions must be reconverted so their segments
    // are re-merged/re-split without intersections from the deleted function.
    // If no functions remain, fall back to point/curve intersections only.
    if (wasFunction || autoRemovedFunctionId) {
      const state = get();
      const hasFunctions = Object.values(state.scene.nodes).some((n: any) =>
        n && (n.kind === 'function-explicit' || n.kind === 'function-implicit')
      );
      if (hasFunctions) {
        requestAnimationFrame(() => {
          setTimeout(() => {
            get().convertFunctionsToSegments();
          }, 50);
        });
      } else {
        state.updateIntersectionsWithPoints();
      }
    }
  },
  setZIndex: (id, z) => set((s) => {
    let undoStack = s.undoStack;
    let redoStack: SceneSnapshot[] = s.redoStack;
    let pendingInteractionSnapshot = s.pendingInteractionSnapshot;
    let hasPendingInteractionChange = s.hasPendingInteractionChange;
    if (!s.suppressHistory) {
      const before = deepCloneSnapshot({ scene: s.scene, selectedIds: s.selectedIds, nextSymbolIndex: s.nextSymbolIndex });
      if (s.isInteracting) {
        if (!pendingInteractionSnapshot) {
          pendingInteractionSnapshot = before;
          hasPendingInteractionChange = true;
        }
      } else {
        undoStack = [...undoStack, before];
        redoStack = [];
      }
    }
    return { scene: { ...s.scene, zIndex: { ...s.scene.zIndex, [id]: z } }, undoStack, redoStack, pendingInteractionSnapshot, hasPendingInteractionChange } as any;
  }),
  setView: (view) => set((s) => {
    // View changes (zoom/pan) are not recorded in history
    return { scene: { ...s.scene, view } } as any;
  }),
  setSelected: (ids) => set({ selectedIds: ids }),
  setHovered: (id) => set({ hoveredId: id }),
  setHoveredIntersection: (pos) => set({ hoveredIntersection: pos }),
  setHoveredBezierAnchor: (id) => set({ hoveredBezierAnchorId: id }),
  setHoveredAxisAnchor: (id) => set({ hoveredAxisAnchorId: id }),
  setDraggingNodeType: (type) => set({ draggingNodeType: type }),
  // Helper to add a point node
  addPoint: (position: Vec2, diameterMm: number = 2.3, color: string = '#000000') => {
    const id = generateStableId('pt');
    const node: SceneNode = { id, kind: 'point' as any, position, diameterMm, color } as any;
    get().upsertNode(node);
    // Update intersections to include new point and its projections
    get().updateIntersectionsWithPoints();
    return id;
  },
  // Update intersections list to include all current points, segment endpoints, and their projections
  updateIntersectionsWithPoints: () => {
    const state = get();
    const nodes = state.scene.nodes;
    const view = state.scene.view;
    // 거리 기반 클러스터링: 화면 스케일에 따라 세계좌표 허용오차를 조정
    // IMPORTANT: 화면에서 "가까운" 점을 합쳐야 하므로 screen-space(px) 기준으로 클러스터링한다.
    // (yScale이 1이 아닐 때 world-space 거리로 합치면 교점 주변에 점이 과다하게 남을 수 있음)
    const clusterPoints = (pts: Vec2[], scale: number, yScale: number): Vec2[] => {
      const tolPx = 8.0; // 교점 주변 과밀 방지용(픽셀)
      const s = Math.max(1e-6, scale);
      const ys = Math.max(1e-6, yScale || 1);
      const clusters: Array<{ x: number; y: number; n: number }> = [];

      const distPx = (ax: number, ay: number, bx: number, by: number) =>
        Math.hypot((ax - bx) * s, (ay - by) * s * ys);

      for (const p of pts) {
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        let k = -1;
        for (let i = 0; i < clusters.length; i++) {
          const c = clusters[i];
          if (distPx(c.x, c.y, p.x, p.y) <= tolPx) { k = i; break; }
        }
        if (k >= 0) {
          const c = clusters[k];
          const n2 = c.n + 1;
          c.x = (c.x * c.n + p.x) / n2;
          c.y = (c.y * c.n + p.y) / n2;
          c.n = n2;
        } else {
          clusters.push({ x: p.x, y: p.y, n: 1 });
        }
      }
      // 최종 좌표는 1e-6 그리드에 스냅하여 안정화
      const out: Vec2[] = [];
      const seen = new Set<string>();
      for (const c of clusters) {
        const x = +c.x.toFixed(6);
        const y = +c.y.toFixed(6);
        const key = `${x.toFixed(6)},${y.toFixed(6)}`;
        if (!seen.has(key)) { seen.add(key); out.push({ x, y }); }
      }

      // 너무 많으면(교점 과밀) 화면 격자 기반으로 한 번 더 축약
      if (out.length > 600) {
        const gridPx = 10; // 한 셀에 하나만 남김
        const grid = new Map<string, Vec2>();
        for (const p of out) {
          const gx = Math.round((p.x * s) / gridPx);
          const gy = Math.round((p.y * s * ys) / gridPx);
          const key = `${gx},${gy}`;
          if (!grid.has(key)) grid.set(key, p);
        }
        return Array.from(grid.values());
      }
      return out;
    };

    // Check if there are any function nodes (explicit or implicit)
    const hasFunctions = Object.values(nodes).some((n: any) =>
      n && (n.kind === 'function-explicit' || n.kind === 'function-implicit')
    );

    // Build registry only when we need to validate intersections against function expressions.
    const registryForEval = hasFunctions ? buildFunctionRegistry(nodes as any) : null;

    // Start with function-related intersections only (if functions exist).
    // IMPORTANT: never use `state.intersections` here; that creates a feedback loop
    // (intersections become input to intersections) and can "explode" until refresh.
    const baseIntersections: Vec2[] = hasFunctions ? (state.functionIntersections || []) : [];

    // Collect all point nodes
    const pointNodes = Object.values(nodes).filter((n: any) => n && n.kind === 'point') as any[];
    const pointPositions: Vec2[] = pointNodes.map((pt: any) => pt.position).filter((p: any) => p);

    // Collect segment endpoints (ONLY user-drawn two-point segments/rays/lines).
    // Function-derived segments have many internal anchors and will "paint" points along the path
    // near intersections if we treat their endpoints as intersections.
    const segmentNodes = Object.values(nodes).filter((n: any) => n && n.kind === 'segment' && !n.functionId) as any[];
    const segmentEndpoints: Vec2[] = [];
    for (const seg of segmentNodes) {
      // If a two-point segment was auto-split at intersections, we generate many tiny segments with
      // `stableSegmentId: tpseg_...`. Their internal endpoints are implementation artifacts and
      // should NOT be shown as "intersection points" along the segment path.
      if (typeof seg.stableSegmentId === 'string' && seg.stableSegmentId.startsWith('tpseg_')) {
        continue;
      }
      // Add start point if not extended (segment or halfline start)
      if (!seg.extendStart && seg.startAnchorId) {
        const startAnchor = nodes[seg.startAnchorId] as any;
        if (startAnchor && startAnchor.position) {
          segmentEndpoints.push(startAnchor.position);
        }
      }
      // Add end point if not extended (segment or halfline end)
      if (!seg.extendEnd && seg.endAnchorId) {
        const endAnchor = nodes[seg.endAnchorId] as any;
        if (endAnchor && endAnchor.position) {
          segmentEndpoints.push(endAnchor.position);
        }
      }
    }

    // Collect bezier curve endpoints (both regular and dashed)
    const bezierNodes = Object.values(nodes).filter((n: any) => n && n.kind === 'bezier') as any[];
    const bezierEndpoints: Vec2[] = [];
    for (const bez of bezierNodes) {
      // Add start point (anchor a)
      if (bez.a) {
        const startAnchor = nodes[bez.a] as any;
        if (startAnchor && startAnchor.position) {
          bezierEndpoints.push(startAnchor.position);
        }
      }
      // Add end point (anchor b)
      if (bez.b) {
        const endAnchor = nodes[bez.b] as any;
        if (endAnchor && endAnchor.position) {
          bezierEndpoints.push(endAnchor.position);
        }
      }
    }

    // Compute intersections between linear elements (lines/segments/rays/axes) and with curve segments (if any)
    const linearIntersections: Vec2[] = [];
    try {
      // Helper: line-line intersection
      const lineLineIntersection = (
        x1: number, y1: number, x2: number, y2: number,
        x3: number, y3: number, x4: number, y4: number
      ): { x: number; y: number; t: number; u: number } | null => {
        const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
        if (Math.abs(denom) < 1e-10) return null;
        const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
        const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
        return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1), t, u };
      };

      // Collect linear elements (excluding axes - intercepts already calculated)
      const lineNodes = Object.values(nodes).filter((n: any) => n && n.kind === 'line') as any[];
      const twoPointSegNodes = Object.values(nodes).filter((n: any) => n && n.kind === 'segment' && !n.functionId) as any[];

      type LinearElem = { ax: number; ay: number; bx: number; by: number; isInfinite: boolean; isRayFromA: boolean; isRayFromB: boolean; isSegment: boolean };
      const linearElements: LinearElem[] = [];

      // lines
      for (const ln of lineNodes) {
        const a = nodes[ln.a] as any; const b = nodes[ln.b] as any; if (!a || !b) continue;
        linearElements.push({ ax: a.position.x, ay: a.position.y, bx: b.position.x, by: b.position.y, isInfinite: true, isRayFromA: false, isRayFromB: false, isSegment: false });
      }
      // two-point segments/rays/lines
      for (const sg of twoPointSegNodes) {
        const a = nodes[sg.startAnchorId] as any; const b = nodes[sg.endAnchorId] as any; if (!a || !b) continue;
        const extendStart = sg.extendStart || false; const extendEnd = sg.extendEnd || false;
        linearElements.push({
          ax: a.position.x, ay: a.position.y, bx: b.position.x, by: b.position.y,
          isInfinite: extendStart && extendEnd,
          isRayFromA: extendStart && !extendEnd,
          isRayFromB: !extendStart && extendEnd,
          isSegment: !extendStart && !extendEnd,
        });
      }
      // Note: axes excluded (intercepts already in baseIntersections from convertFunctionsToSegments)

      const addIfFinite = (pt: { x: number; y: number }) => {
        if (Number.isFinite(pt.x) && Number.isFinite(pt.y)) linearIntersections.push(pt);
      };

      // intersections with explicit function NODES (direct, no curve segment sampling)
      // This is the most stable path for straight lines/segments and avoids discretization floods.
      const explicitFnNodes = Object.values(nodes).filter((n: any) => n && n.kind === 'function-explicit' && !n.isPreview) as any[];
      if (explicitFnNodes.length > 0 && registryForEval) {
        const evalExplicit = (fn: any, x: number) => {
          try {
            return evaluateWithRegistry(fn.expr, { [fn.variable]: x }, registryForEval as any);
          } catch {
            return NaN;
          }
        };
        const dedupeAndPush = (pts: Vec2[], eps: number) => {
          for (const p of pts) {
            if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
            const isDupe = linearIntersections.some(q => Math.hypot(q.x - p.x, q.y - p.y) < eps);
            if (!isDupe) linearIntersections.push({ x: +p.x.toFixed(6), y: +p.y.toFixed(6) });
          }
        };

        for (const elem of linearElements) {
          const ax = elem.ax, ay = elem.ay, bx = elem.bx, by = elem.by;
          const dx = bx - ax;
          const dy = by - ay;
          const len2 = dx * dx + dy * dy;
          if (len2 < 1e-12) continue;

          // Param validity helper (same semantics as lineLineIntersection usage)
          const validT = (t: number) => (
            elem.isInfinite ||
            (elem.isRayFromA && t <= 1 + 1e-9) ||
            (elem.isRayFromB && t >= -1e-9) ||
            (elem.isSegment && t >= -1e-9 && t <= 1 + 1e-9)
          );

          for (const fn of explicitFnNodes) {
            const [xMin, xMax] = fn.domain || [-Infinity, Infinity];
            if (!(Number.isFinite(xMin) && Number.isFinite(xMax)) || xMin >= xMax) continue;

            // Determine t-range where x(t) is within function domain.
            let tLo = -Infinity;
            let tHi = Infinity;
            const epsDx = 1e-12;
            if (Math.abs(dx) > epsDx) {
              const t1 = (xMin - ax) / dx;
              const t2 = (xMax - ax) / dx;
              tLo = Math.min(t1, t2);
              tHi = Math.max(t1, t2);
            } else {
              // Vertical line in x: x(t) constant
              if (ax < xMin - 1e-12 || ax > xMax + 1e-12) continue;
              // We'll solve y(t) = f(ax) directly.
              const yFunc = evalExplicit(fn, ax);
              if (!Number.isFinite(yFunc)) continue;
              if (Math.abs(dy) < 1e-12) continue; // point/degenerate
              const t = (yFunc - ay) / dy;
              if (Number.isFinite(t) && validT(t)) {
                dedupeAndPush([{ x: ax, y: yFunc }], 1e-4);
              }
              continue;
            }

            // Apply elem bounds
            if (elem.isSegment) { tLo = Math.max(tLo, 0); tHi = Math.min(tHi, 1); }
            else if (elem.isRayFromB) { tLo = Math.max(tLo, 0); }
            else if (elem.isRayFromA) { tHi = Math.min(tHi, 1); }

            if (!(Number.isFinite(tLo) && Number.isFinite(tHi)) || tHi <= tLo) continue;

            // Scan diff(t) = y(t) - f(x(t)) for sign changes and refine with bisection.
            const steps = 128;
            const hits: Vec2[] = [];
            let prevT = tLo;
            let prevX = ax + dx * prevT;
            let prevY = ay + dy * prevT;
            let prevDiff = prevY - evalExplicit(fn, prevX);
            for (let i = 1; i <= steps; i++) {
              const t = tLo + (tHi - tLo) * (i / steps);
              const x = ax + dx * t;
              const y = ay + dy * t;
              const diff = y - evalExplicit(fn, x);
              if (!isFinite(prevDiff) || !isFinite(diff)) {
                prevT = t; prevDiff = diff;
                continue;
              }
              if (prevDiff === 0) {
                if (validT(prevT)) hits.push({ x: prevX, y: prevY });
              } else if (diff === 0) {
                if (validT(t)) hits.push({ x, y });
              } else if (prevDiff * diff < 0) {
                // bisection
                let a = prevT, b = t;
                let fa = prevDiff;
                for (let iter = 0; iter < 40 && (b - a) > 1e-10; iter++) {
                  const m = (a + b) / 2;
                  const mx = ax + dx * m;
                  const my = ay + dy * m;
                  const fm = my - evalExplicit(fn, mx);
                  if (!isFinite(fm)) break;
                  if (Math.abs(fm) < 1e-8) { a = b = m; break; }
                  if (fa * fm < 0) { b = m; } else { a = m; fa = fm; }
                }
                const tt = (a + b) / 2;
                if (validT(tt)) {
                  hits.push({ x: ax + dx * tt, y: ay + dy * tt });
                }
              }
              prevT = t; prevX = x; prevY = y; prevDiff = diff;
            }

            // Dedupe locally and cap: typical line vs explicit has <= 2, but allow a few for wavy functions.
            if (hits.length > 0) {
              const local: Vec2[] = [];
              for (const p of hits) {
                const dupe = local.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 1e-4);
                if (!dupe) local.push(p);
              }
              dedupeAndPush(local.slice(0, 6), 1e-4);
            }
          }
        }
      }

      // pairwise intersections among linear elements
      for (let i = 0; i < linearElements.length; i++) {
        for (let j = i + 1; j < linearElements.length; j++) {
          const a = linearElements[i]; const b = linearElements[j];
          const inter = lineLineIntersection(a.ax, a.ay, a.bx, a.by, b.ax, b.ay, b.bx, b.by);
          if (!inter) continue;
          const validA = a.isInfinite || (a.isRayFromA && inter.t <= 1 + 1e-9) || (a.isRayFromB && inter.t >= -1e-9) || (a.isSegment && inter.t >= -1e-9 && inter.t <= 1 + 1e-9);
          const validB = b.isInfinite || (b.isRayFromA && inter.u <= 1 + 1e-9) || (b.isRayFromB && inter.u >= -1e-9) || (b.isSegment && inter.u >= -1e-9 && inter.u <= 1 + 1e-9);
          if (validA && validB) addIfFinite({ x: inter.x, y: inter.y });
        }
      }

      // intersections with curve segments (from functions)
      const curveSegNodes = Object.values(nodes).filter((n: any) => n && n.kind === 'segment' && n.functionId) as any[];
      const overlapTolWorld = 2.5 / Math.max(1e-6, view.scale);
      const clusterTolPx = 8.0;
      const scaleForPx = Math.max(1e-6, view.scale);
      const yScaleForPx = Math.max(1e-6, view.yScale ?? 1);
      const distPointToLine = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy);
        if (!(len > 1e-12)) return Infinity;
        const cross = (px - ax) * dy - (py - ay) * dx;
        return Math.abs(cross) / len;
      };
      const clusterHits = (pts: Vec2[]): Vec2[] => {
        const clusters: Array<{ x: number; y: number; n: number }> = [];
        const distPx = (ax: number, ay: number, bx: number, by: number) =>
          Math.hypot((ax - bx) * scaleForPx, (ay - by) * scaleForPx * yScaleForPx);
        for (const p of pts) {
          if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
          let k = -1;
          for (let i = 0; i < clusters.length; i++) {
            const c = clusters[i];
            if (distPx(c.x, c.y, p.x, p.y) <= clusterTolPx) { k = i; break; }
          }
          if (k >= 0) {
            const c = clusters[k];
            const n2 = c.n + 1;
            c.x = (c.x * c.n + p.x) / n2;
            c.y = (c.y * c.n + p.y) / n2;
            c.n = n2;
          } else {
            clusters.push({ x: p.x, y: p.y, n: 1 });
          }
        }
        return clusters.map(c => ({ x: +c.x.toFixed(6), y: +c.y.toFixed(6) }));
      };
      for (const elem of linearElements) {
        // Aggregate intersections by functionId to avoid "exploding" duplicates
        // when a function curve is represented by many segment nodes.
        const hitsByFnId = new Map<string, Vec2[]>();

        for (const seg of curveSegNodes) {
          const fnId = (seg as any).functionId as string | undefined;
          if (!fnId) continue;
          if (!seg.samples || seg.samples.length < 2) continue;

          const hits: Vec2[] = [];
          for (let i = 0; i < seg.samples.length - 1; i++) {
            const p1 = seg.samples[i]; const p2 = seg.samples[i + 1];
            // If the curve segment lies almost exactly on the linear element, that's an overlap,
            // not a discrete intersection. Skip to avoid intersections "along the path".
            const d1 = distPointToLine(p1.x, p1.y, elem.ax, elem.ay, elem.bx, elem.by);
            const d2 = distPointToLine(p2.x, p2.y, elem.ax, elem.ay, elem.bx, elem.by);
            if (Math.max(d1, d2) <= overlapTolWorld) continue;
            const inter = lineLineIntersection(elem.ax, elem.ay, elem.bx, elem.by, p1.x, p1.y, p2.x, p2.y);
            if (!inter) continue;
            if (inter.u < -1e-9 || inter.u > 1 + 1e-9) continue;
            const validElem = elem.isInfinite || (elem.isRayFromA && inter.t <= 1 + 1e-9) || (elem.isRayFromB && inter.t >= -1e-9) || (elem.isSegment && inter.t >= -1e-9 && inter.t <= 1 + 1e-9);
            if (validElem && Number.isFinite(inter.x) && Number.isFinite(inter.y)) hits.push({ x: inter.x, y: inter.y });
          }

          if (hits.length > 0) {
            const prev = hitsByFnId.get(fnId) || [];
            prev.push(...hits);
            hitsByFnId.set(fnId, prev);
          }
        }

        // Validate + cluster/cap per (linear elem, functionId)
        for (const [fnId, pts] of hitsByFnId.entries()) {
          const clusteredHits = clusterHits(pts);

          // If we can, validate candidates against the function equation so we don't
          // paint "almost-intersections" along the entire segment.
          const fnNode: any = (nodes as any)[fnId];
          const scale = Math.max(1e-6, view.scale);
          const yScale = Math.max(1e-6, view.yScale ?? 1);
          const tolYWorld = 4.0 / (scale * yScale); // 4px in world-y
          const tolImplicit = 0.02;

          const scored: Array<{ p: Vec2; score: number }> = [];
          if (fnNode && registryForEval) {
            for (const p of clusteredHits) {
              if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
              if (fnNode.kind === 'function-explicit') {
                try {
                  const yFunc = evaluateWithRegistry(fnNode.expr, { [fnNode.variable]: p.x }, registryForEval as any);
                  if (!Number.isFinite(yFunc)) continue;
                  const err = Math.abs(p.y - yFunc);
                  if (err <= tolYWorld * 3) scored.push({ p, score: err });
                } catch { }
              } else if (fnNode.kind === 'function-implicit') {
                try {
                  const v = evaluateWithRegistry(fnNode.expr, { x: p.x, y: p.y }, registryForEval as any);
                  if (!Number.isFinite(v)) continue;
                  const err = Math.abs(v);
                  if (err <= tolImplicit * 5) scored.push({ p, score: err });
                } catch { }
              } else {
                // Unknown/legacy: accept
                scored.push({ p, score: 0 });
              }
            }
          }

          const finalPts = (scored.length > 0)
            ? scored.sort((a, b) => a.score - b.score).map(s => s.p)
            : clusteredHits;

          // Most common cases (line vs parabola etc.) have <= 2 intersections.
          for (const p of finalPts.slice(0, 2)) addIfFinite(p);
        }
      }
    } catch { }

    // Combine all special points (points, segment endpoints, bezier endpoints)
    // Always include origin point (0, 0)
    // Note: intercepts are already included in baseIntersections from convertFunctionsToSegments
    const allSpecialPoints = [{ x: 0, y: 0 }, ...pointPositions, ...segmentEndpoints, ...bezierEndpoints];

    // Project all special points onto axes
    const projections = projectPointsToAxes(allSpecialPoints);

    // Filter out points already on axes before projecting (to avoid duplicates)
    const axisThreshold = 1e-9;
    const notOnAxis = (pt: Vec2) => Math.abs(pt.x) > axisThreshold && Math.abs(pt.y) > axisThreshold;
    const intersectionsToProject = [
      ...baseIntersections.filter(notOnAxis),
      ...linearIntersections.filter(notOnAxis),
    ];
    // Project filtered intersections onto axes
    const intersectionProjections = projectPointsToAxes(intersectionsToProject);

    // Combine function intersections with new special points and projections
    // This ensures old anchor positions are not retained
    const allPoints = [
      ...baseIntersections,
      ...linearIntersections,
      ...allSpecialPoints,
      ...projections,
      ...intersectionProjections,
    ];
    const clustered = clusterPoints(allPoints, view.scale, view.yScale ?? 1);
    set({ intersections: clustered });
  },
  createAnchor: (position) => {
    const id = generateStableId('anchor');
    const node: SceneNode = { id, kind: 'anchor', position } as SceneNode;
    get().upsertNode(node);
    return id;
  },
  convertFunctionsToSegments: () => {
    const state = get();
    // Don't record history for automatic function-to-segments conversion
    // This is an internal implementation detail, not a user action
    const wasSuppressed = state.suppressHistory;
    set({ suppressHistory: true });
    const nodes = { ...state.scene.nodes } as any;

    // NOTE: Do not auto-delete `tpseg_...` pieces here.
    // Users can enable intersection-based splitting for two-point segments, which intentionally
    // creates `tpseg_...` pieces. Deleting them on every conversion would undo the feature.

    const registry = buildFunctionRegistry(nodes);
    const view = state.scene.view;
    // Filter out preview functions
    const explicitFns = Object.values(nodes).filter((n: any) => n.kind === 'function-explicit' && !n.isPreview) as any[];
    const implicitFns = Object.values(nodes).filter((n: any) => n.kind === 'function-implicit' && !n.isPreview) as any[];
    const bezierCurves = Object.values(nodes).filter((n: any) => n.kind === 'bezier') as any[];

    if (explicitFns.length === 0 && implicitFns.length === 0) {
      // Restore suppressHistory before returning
      if (!wasSuppressed) {
        set({ suppressHistory: false });
      }
      return;
    }

    type FnPolyline = { fn: any; polyline: { x: number; y: number }[] };
    const allPolylines: FnPolyline[] = [];

    // Helper: cubic bezier blend
    const cubicBlend = (p0: number, p1: number, p2: number, p3: number, t: number) => {
      const mt = 1 - t;
      return (
        mt * mt * mt * p0 +
        3 * mt * mt * t * p1 +
        3 * mt * t * t * p2 +
        t * t * t * p3
      );
    };

    // Helper: find intersections between two polylines
    const findPolylinePolylineIntersections = (polyA: Array<{ x: number; y: number }>, polyB: Array<{ x: number; y: number }>): Vec2[] => {
      const intersections: Vec2[] = [];
      // Use screen-space tolerance (in px) converted to world units so we don't
      // flood intersections along nearly-overlapping paths.
      const pxTol = 2.5;
      const scale = Math.max(1e-6, view.scale);
      const eps = pxTol / scale;
      const overlapTol = (pxTol * 1.5) / scale;
      const minOverlapLen = (pxTol * 2.0) / scale;

      const distPointToLine = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy);
        if (!(len > 1e-12)) return Infinity;
        const cross = (px - ax) * dy - (py - ay) * dx;
        return Math.abs(cross) / len;
      };

      // Line-line intersection helper
      const lineIntersection = (
        x1: number, y1: number, x2: number, y2: number,
        x3: number, y3: number, x4: number, y4: number
      ): Vec2 | null => {
        if (![x1, y1, x2, y2, x3, y3, x4, y4].every(Number.isFinite)) return null;
        const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
        // Keep a strict parallel check here; overlap cases are handled outside.
        if (Math.abs(denom) < 1e-12) return null; // parallel/collinear
        const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
        const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
        if (!Number.isFinite(t) || !Number.isFinite(u)) return null;
        if (t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) {
          const ix = x1 + t * (x2 - x1);
          const iy = y1 + t * (y2 - y1);
          if (!Number.isFinite(ix) || !Number.isFinite(iy)) return null;
          return { x: ix, y: iy };
        }
        return null;
      };

      // Check all segment pairs
      for (let i = 0; i < polyA.length - 1; i++) {
        for (let j = 0; j < polyB.length - 1; j++) {
          const a1 = polyA[i]; const a2 = polyA[i + 1];
          const b1 = polyB[j]; const b2 = polyB[j + 1];

          // If the two segments are nearly collinear and sit on top of each other,
          // there's no discrete intersection (it's an overlap) — return none to avoid
          // "intersections along the entire path".
          const adx = a2.x - a1.x; const ady = a2.y - a1.y;
          const blen = Math.hypot(b2.x - b1.x, b2.y - b1.y);
          const alen = Math.hypot(adx, ady);
          if (!(alen > 1e-12) || !(blen > 1e-12)) continue;

          const bdx = b2.x - b1.x; const bdy = b2.y - b1.y;
          const cross = adx * bdy - ady * bdx;
          const sinTheta = Math.abs(cross) / (alen * blen);

          if (sinTheta < 0.02) { // ~1.1 degrees
            const d1 = distPointToLine(b1.x, b1.y, a1.x, a1.y, a2.x, a2.y);
            const d2 = distPointToLine(b2.x, b2.y, a1.x, a1.y, a2.x, a2.y);
            if (Math.max(d1, d2) <= overlapTol) {
              // Check projection overlap along segment A
              const ux = adx / alen;
              const uy = ady / alen;
              const pB1 = (b1.x - a1.x) * ux + (b1.y - a1.y) * uy;
              const pB2 = (b2.x - a1.x) * ux + (b2.y - a1.y) * uy;
              const bMin = Math.min(pB1, pB2);
              const bMax = Math.max(pB1, pB2);
              const overlap = Math.min(alen, bMax) - Math.max(0, bMin);
              if (overlap >= minOverlapLen) {
                return [];
              }
            }
          }

          const pt = lineIntersection(
            a1.x, a1.y, a2.x, a2.y,
            b1.x, b1.y, b2.x, b2.y
          );
          if (pt) {
            // Deduplicate close points
            const isDuplicate = intersections.some(existing =>
              Math.hypot(existing.x - pt.x, existing.y - pt.y) < eps
            );
            if (!isDuplicate) {
              intersections.push(pt);
            }
          }

          // Safety cap: if this pair starts generating too many intersections,
          // treat it as a near-overlap/noise case and stop.
          if (intersections.length > 64) return intersections;
        }
      }

      return intersections;
    };

    // Sample explicit functions with asymptote detection
    const zeroExplicitFnIds = new Set<string>();

    // Pre-compute axis bounds for clipToAxes functions (일관된 도메인 처리)
    let axisXMin = -Infinity, axisXMax = Infinity, axisYMin = -Infinity, axisYMax = Infinity;
    const axes = Object.values(nodes).filter((n: any) => n.kind === 'axis') as any[];
    if (axes.length > 0) {
      for (const axis of axes) {
        const origin = nodes[axis.originId] as any;
        const endpoint = nodes[axis.endpointId] as any;
        if (!origin || !endpoint) continue;
        // Prefer axis.name ('X'/'Y') when available for stable classification.
        const axisName = (axis as any).name;
        if (axisName === 'X') {
          axisXMin = Math.max(axisXMin, Math.min(origin.position.x, endpoint.position.x));
          axisXMax = Math.min(axisXMax, Math.max(origin.position.x, endpoint.position.x));
        } else if (axisName === 'Y') {
          axisYMin = Math.max(axisYMin, Math.min(origin.position.y, endpoint.position.y));
          axisYMax = Math.min(axisYMax, Math.max(origin.position.y, endpoint.position.y));
        } else {
          const dx = endpoint.position.x - origin.position.x;
          const dy = endpoint.position.y - origin.position.y;
          if (Math.abs(dx) > Math.abs(dy)) {
            axisXMin = Math.max(axisXMin, Math.min(origin.position.x, endpoint.position.x));
            axisXMax = Math.min(axisXMax, Math.max(origin.position.x, endpoint.position.x));
          } else {
            axisYMin = Math.max(axisYMin, Math.min(origin.position.y, endpoint.position.y));
            axisYMax = Math.min(axisYMax, Math.max(origin.position.y, endpoint.position.y));
          }
        }
      }
    }
    const hasValidAxisBounds = isFinite(axisXMin) && isFinite(axisXMax) && axisXMin < axisXMax;

    for (const fn of explicitFns) {
      // clipToAxes가 true이고 축 범위가 있으면 축 범위 사용 (PixiStage와 동일한 로직)
      const effectiveXMin = fn.clipToAxes && hasValidAxisBounds ? axisXMin : fn.domain[0];
      const effectiveXMax = fn.clipToAxes && hasValidAxisBounds ? axisXMax : fn.domain[1];
      const xMin = effectiveXMin;
      const xMax = effectiveXMax;

      const visibleWidth = Math.max(1e-6, xMax - xMin);
      // 절댓값 함수 등의 꺾이는 지점을 정확히 포착하기 위해 domain 크기에 비례한 샘플링
      // domain 1단위당 최소 150개 샘플 (PixiStage의 drawExplicitFunction과 동일한 로직)
      const baseSamplesPerUnit = 150;
      const samples = Math.max(300, Math.min(8192, Math.round(visibleWidth * baseSamplesPerUnit)));

      // 점근선(수직 불연속점) 감지하여 도메인 분할 (1/x, tan(x) 등)
      // Get y range from axes for proper asymptote detection
      let yRange = 20; // default
      if (isFinite(axisYMin) && isFinite(axisYMax)) {
        yRange = Math.max(1, axisYMax - axisYMin);
      }

      const breaks = findExplicitVerticalBreaks(
        fn.expr,
        [xMin, xMax],
        registry as any,
        yRange,
        Math.min(128, Math.max(64, Math.round(samples / 6)))
      );

      // 점근선으로 도메인을 서브도메인으로 분할
      const subDomains: Array<[number, number]> = [];
      let last = xMin;
      for (const b of breaks) {
        if (b > last) subDomains.push([last, b]);
        last = b;
      }
      if (last < xMax) subDomains.push([last, xMax]);

      // 각 서브도메인을 별도의 polyline으로 샘플링 (점근선 양쪽이 연결되지 않도록)
      let allPolysAreZero = true; // y=0 상수함수 감지용
      for (const [a, b] of subDomains) {
        const w = b - a;
        const localSamples = Math.max(150, Math.min(4096, Math.round(w * baseSamplesPerUnit)));
        const rawPoly = sampleExplicitWithRegistry(fn.expr, fn.variable, [a, b], localSamples, registry as any);

        // 점근선 근처의 매우 큰 y값을 가진 점들을 제거 (수직선처럼 보이는 것을 방지)
        // yRange의 2배를 넘어가는 점들은 점근선 근처로 간주
        const maxY = yRange * 2;
        const filteredPoly = rawPoly.filter(p => Math.abs(p.y) <= maxY);

        // 필터링 후에도 연속적인 polyline인지 확인
        // 만약 중간에 큰 간격이 있다면 추가로 분할
        const finalPolys: Array<{ x: number; y: number }[]> = [];
        let currentPoly: Array<{ x: number; y: number }> = [];

        for (let i = 0; i < filteredPoly.length; i++) {
          if (currentPoly.length === 0) {
            currentPoly.push(filteredPoly[i]);
          } else {
            const prev = currentPoly[currentPoly.length - 1];
            const curr = filteredPoly[i];
            const xGap = curr.x - prev.x;
            const expectedGap = w / localSamples * 3; // 예상 간격의 3배 이상이면 끊김

            if (xGap > expectedGap) {
              // 간격이 크면 새로운 polyline 시작
              if (currentPoly.length >= 2) finalPolys.push(currentPoly);
              currentPoly = [curr];
            } else {
              currentPoly.push(curr);
            }
          }
        }
        if (currentPoly.length >= 2) finalPolys.push(currentPoly);

        // 각 분할된 polyline을 추가
        for (const poly of finalPolys) {
          if (poly.length >= 2) {
            // y=0 상수함수인지 확인 (전 구간 거의 0)
            let polyIsZero = true;
            for (let i = 0; i < poly.length; i += Math.max(1, Math.floor(poly.length / 16))) {
              if (Math.abs(poly[i].y) > 1e-9) { polyIsZero = false; break; }
            }
            if (!polyIsZero) allPolysAreZero = false;
            allPolylines.push({ fn, polyline: poly });
          }
        }
      }
      if (allPolysAreZero) zeroExplicitFnIds.add(fn.id);
    }

    // Calculate bounds for all implicit functions first
    let boundsUpdated = false;
    const implicitBoundsMap = new Map<string, any>();

    for (const fn of implicitFns) {
      let samplingBounds = fn.bounds;
      if (fn.clipToAxes) {
        const axes = Object.values(nodes).filter((n: any) => n.kind === 'axis') as any[];
        if (axes.length > 0) {
          let xMin = -Infinity, xMax = Infinity, yMin = -Infinity, yMax = Infinity;
          for (const axis of axes) {
            const origin = nodes[axis.originId] as any;
            const endpoint = nodes[axis.endpointId] as any;
            if (!origin || !endpoint) continue;
            // Prefer axis.name for stable classification during axis dragging (avoid dx/dy flip).
            const axisName = (axis as any).name;
            if (axisName === 'X') {
              xMin = Math.max(xMin, Math.min(origin.position.x, endpoint.position.x));
              xMax = Math.min(xMax, Math.max(origin.position.x, endpoint.position.x));
            } else if (axisName === 'Y') {
              yMin = Math.max(yMin, Math.min(origin.position.y, endpoint.position.y));
              yMax = Math.min(yMax, Math.max(origin.position.y, endpoint.position.y));
            } else {
              const dx = endpoint.position.x - origin.position.x;
              const dy = endpoint.position.y - origin.position.y;
              if (Math.abs(dx) > Math.abs(dy)) {
                xMin = Math.max(xMin, Math.min(origin.position.x, endpoint.position.x));
                xMax = Math.min(xMax, Math.max(origin.position.x, endpoint.position.x));
              } else {
                yMin = Math.max(yMin, Math.min(origin.position.y, endpoint.position.y));
                yMax = Math.min(yMax, Math.max(origin.position.y, endpoint.position.y));
              }
            }
          }
          if (isFinite(xMin) && isFinite(xMax) && isFinite(yMin) && isFinite(yMax)) {
            const padX = (xMax - xMin) * 0.05;
            const padY = (yMax - yMin) * 0.05;
            samplingBounds = {
              xMin: xMin - padX,
              xMax: xMax + padX,
              yMin: yMin - padY,
              yMax: yMax + padY
            };

            // Update bounds in nodes object
            if (nodes[fn.id]) {
              nodes[fn.id] = { ...nodes[fn.id], bounds: samplingBounds };
              boundsUpdated = true;
            }
          }
        }
      }
      implicitBoundsMap.set(fn.id, samplingBounds);
    }

    // Apply all bounds updates once
    if (boundsUpdated) {
      set((s) => ({
        scene: {
          ...s.scene,
          nodes: nodes
        }
      }));
    }

    // Sample bezier curves as polylines
    for (const bez of bezierCurves) {
      const a = nodes[bez.a] as any;
      const b = nodes[bez.b] as any;
      const c1 = nodes[bez.c1] as any;
      const c2 = nodes[bez.c2] as any;

      if (!a || !b || !c1 || !c2) continue;
      if (a.kind !== 'anchor' || b.kind !== 'anchor' || c1.kind !== 'anchor' || c2.kind !== 'anchor') continue;

      // Sample bezier curve with sufficient resolution
      const steps = 100; // Similar density to function sampling
      const points: { x: number; y: number }[] = [];

      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = cubicBlend(a.position.x, c1.position.x, c2.position.x, b.position.x, t);
        const y = cubicBlend(a.position.y, c1.position.y, c2.position.y, b.position.y, t);
        points.push({ x, y });
      }

      if (points.length >= 2) {
        allPolylines.push({ fn: bez, polyline: points });
      }
    }

    // Sample implicit functions as multiple polylines via marching squares
    for (const fn of implicitFns) {
      const samplingBounds = implicitBoundsMap.get(fn.id) || fn.bounds;
      // Use the updated function node from nodes (which has the new bounds)
      const updatedFn = nodes[fn.id] || fn;
      const res = computeAdaptiveResolution(samplingBounds, view.scale, { base: 64, min: 48, max: 1024, targetCellPx: 2.5, quality: 1.0 });
      const rawSegs = marchingSquaresSegmentsWithRegistry(updatedFn.expr, updatedFn.variables, samplingBounds, res, registry as any);
      const polys = connectSegmentsToPolylines(rawSegs as any);
      for (const p of polys) {
        if (p.length >= 2) allPolylines.push({ fn: updatedFn, polyline: p });
      }
    }

    // Add two-point segments (user-drawn segments without functionId) as polylines for intersection detection
    const twoPointSegments = Object.values(nodes).filter((n: any) =>
      n && n.kind === 'segment' && !n.functionId
    ) as any[];

    for (const seg of twoPointSegments) {
      const startAnchor = nodes[seg.startAnchorId] as any;
      const endAnchor = nodes[seg.endAnchorId] as any;
      if (!startAnchor || !endAnchor) continue;
      if (!startAnchor.position || !endAnchor.position) continue;

      // Create a simple polyline from start to end
      const polyline = [
        { x: startAnchor.position.x, y: startAnchor.position.y },
        { x: endAnchor.position.x, y: endAnchor.position.y }
      ];

      // Create a pseudo-function object for this segment to track intersections
      const pseudoFn = {
        id: seg.id,
        kind: 'two-point-segment' as const,
        startAnchorId: seg.startAnchorId,
        endAnchorId: seg.endAnchorId
      };

      allPolylines.push({ fn: pseudoFn as any, polyline });
    }

    // Compute intersections per function (including tangent points)
    const intersectionsByFn = new Map<string, { x: number; y: number }[]>();
    // Extra split points for FUNCTIONS caused by intersections with two-point segments.
    // We use these for splitting function segments, but do NOT persist them into `functionIntersections`
    // (otherwise segment-related points can linger like a snapshot and "feel exploded").
    const splitPointsForFunction = new Map<string, Vec2[]>();

    // ---- De-flood helpers (screen-space clustering) ----
    const _scaleForPx = Math.max(1e-6, view.scale);
    const _yScaleForPx = Math.max(1e-6, view.yScale ?? 1);
    const _distPx = (ax: number, ay: number, bx: number, by: number) =>
      Math.hypot((ax - bx) * _scaleForPx, (ay - by) * _scaleForPx * _yScaleForPx);
    const _clusterPtsPx = (pts: Vec2[], tolPx: number, maxOut: number): Vec2[] => {
      const clusters: Array<{ x: number; y: number; n: number }> = [];
      for (const p of pts) {
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        let k = -1;
        for (let i = 0; i < clusters.length; i++) {
          const c = clusters[i];
          if (_distPx(c.x, c.y, p.x, p.y) <= tolPx) { k = i; break; }
        }
        if (k >= 0) {
          const c = clusters[k];
          const n2 = c.n + 1;
          c.x = (c.x * c.n + p.x) / n2;
          c.y = (c.y * c.n + p.y) / n2;
          c.n = n2;
        } else {
          clusters.push({ x: p.x, y: p.y, n: 1 });
          if (clusters.length > maxOut * 4) break; // guard
        }
      }
      return clusters.slice(0, maxOut).map(c => ({ x: +c.x.toFixed(6), y: +c.y.toFixed(6) }));
    };
    for (let i = 0; i < allPolylines.length; i++) {
      for (let j = i + 1; j < allPolylines.length; j++) {
        const a = allPolylines[i];
        const b = allPolylines[j];
        // Skip intersection calculation for polylines from the same function
        // (same implicit function can be split into multiple polylines by marching squares)
        if (a.fn.id === b.fn.id) continue;

        let pts: Vec2[] = [];

        // Determine function types and use appropriate intersection method
        const aIsExplicit = a.fn.kind === 'function-explicit';
        const bIsExplicit = b.fn.kind === 'function-explicit';
        const aIsBezier = a.fn.kind === 'bezier';
        const bIsBezier = b.fn.kind === 'bezier';
        const aIsTwoPointSeg = a.fn.kind === 'two-point-segment';
        const bIsTwoPointSeg = b.fn.kind === 'two-point-segment';
        const aIsImplicit = a.fn.kind === 'function-implicit';
        const bIsImplicit = b.fn.kind === 'function-implicit';

        // Two-point segment vs Implicit: find intersections between the segment line and the implicit polyline
        if ((aIsTwoPointSeg && bIsImplicit) || (bIsTwoPointSeg && aIsImplicit)) {
          const [segEntry, implicitEntry] = aIsTwoPointSeg ? [a, b] : [b, a];
          const segPolyline = segEntry.polyline;
          const implicitPoly = implicitEntry.polyline;

          // Use polyline-polyline intersection for the segment vs implicit curve
          pts = findPolylinePolylineIntersections(segPolyline as any, implicitPoly as any);

          // Also check if segment endpoints are exactly on the implicit curve
          const fImplicit = (x: number, y: number) => {
            try {
              return (evaluateWithRegistry as any)(implicitEntry.fn.expr, { x, y }, registry);
            } catch {
              return NaN;
            }
          };

          for (const pt of segPolyline) {
            const val = fImplicit(pt.x, pt.y);
            if (Math.abs(val) < 0.01) {
              // Check if not already found
              const isDupe = pts.some(p => Math.hypot(p.x - pt.x, p.y - pt.y) < 1e-4);
              if (!isDupe) {
                pts.push({ x: pt.x, y: pt.y });
              }
            }
          }
        }
        // Two-point segment vs Explicit function: find where line segment intersects y = f(x)
        else if ((aIsTwoPointSeg && bIsExplicit) || (bIsTwoPointSeg && aIsExplicit)) {
          const [segEntry, explicitEntry] = aIsTwoPointSeg ? [a, b] : [b, a];
          const segPoly = segEntry.polyline;

          // Get segment endpoints
          const p1 = segPoly[0];
          const p2 = segPoly[segPoly.length - 1];

          // Define the explicit function
          const fExplicit = (x: number) => {
            try {
              return (evaluateWithRegistry as any)(explicitEntry.fn.expr, { [explicitEntry.fn.variable]: x }, registry);
            } catch {
              return NaN;
            }
          };

          // The segment is a line from p1 to p2: y = p1.y + t * (p2.y - p1.y), x = p1.x + t * (p2.x - p1.x)
          // We need to find t where: p1.y + t * (p2.y - p1.y) = f(p1.x + t * (p2.x - p1.x))
          // Use numerical search along the segment
          const segDx = p2.x - p1.x;
          const segDy = p2.y - p1.y;
          const segLen = Math.sqrt(segDx * segDx + segDy * segDy);

          if (segLen > 1e-9) {
            // Sample along the segment and find sign changes
            const steps = 100;
            let prevT = 0;
            let prevDiff = (p1.y + 0 * segDy) - fExplicit(p1.x + 0 * segDx);

            for (let i = 1; i <= steps; i++) {
              const t = i / steps;
              const x = p1.x + t * segDx;
              const y = p1.y + t * segDy;
              const diff = y - fExplicit(x);

              if (!isFinite(prevDiff) || !isFinite(diff)) {
                prevT = t;
                prevDiff = diff;
                continue;
              }

              // Sign change detected
              if (prevDiff * diff < 0) {
                // Bisection to find accurate intersection
                let a = prevT, b = t;
                let bisectPrevDiff = prevDiff; // Use separate variable for bisection
                for (let iter = 0; iter < 20 && (b - a) > 1e-8; iter++) {
                  const mid = (a + b) / 2;
                  const mx = p1.x + mid * segDx;
                  const my = p1.y + mid * segDy;
                  const mDiff = my - fExplicit(mx);

                  if (bisectPrevDiff * mDiff < 0) {
                    b = mid;
                  } else {
                    a = mid;
                    bisectPrevDiff = mDiff;
                  }
                }

                const finalT = (a + b) / 2;
                const ix = p1.x + finalT * segDx;
                const iy = p1.y + finalT * segDy;

                // Check not duplicate
                const isDupe = pts.some(p => Math.hypot(p.x - ix, p.y - iy) < 1e-4);
                if (!isDupe && isFinite(ix) && isFinite(iy)) {
                  pts.push({ x: ix, y: iy });
                }

                // Reset prevDiff for next segment
                prevDiff = diff;
              }

              prevT = t;
              prevDiff = diff;
            }
          }

          // Polyline intersection fallback ONLY when numerical search found nothing.
          // (This avoids flooding many near-intersections along the segment.)
          if (pts.length === 0) {
            const polyPts = findPolylinePolylineIntersections(a.polyline as any, b.polyline as any);
            for (const p of polyPts) {
              const isDupe = pts.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 1e-4);
              if (!isDupe) pts.push(p);
            }
          }

          // Final cap: explicit function vs line segment typically has <= 2 intersections.
          if (pts.length > 2) {
            // Keep the best 2 by evaluating |y - f(x)|
            try {
              const scored = pts
                .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
                .map(p => {
                  const fy = fExplicit(p.x);
                  return { p, err: Number.isFinite(fy) ? Math.abs(p.y - fy) : Infinity };
                })
                .filter(s => Number.isFinite(s.err))
                .sort((a, b) => a.err - b.err);
              pts = scored.slice(0, 2).map(s => s.p);
            } catch {
              pts = pts.slice(0, 2);
            }
          }
        }
        // Two-point segment vs anything else (bezier, another segment): use polyline intersection
        else if (aIsTwoPointSeg || bIsTwoPointSeg) {
          pts = findPolylinePolylineIntersections(a.polyline as any, b.polyline as any);
        }
        // Bezier-Bezier or Bezier-Function: use simple polyline intersection
        else if (aIsBezier || bIsBezier) {
          // Simple polyline-polyline intersection
          pts = findPolylinePolylineIntersections(a.polyline as any, b.polyline as any);
        } else if (aIsExplicit && bIsExplicit) {
          // Explicit-Explicit: Use enhanced numerical solver
          const fa = (x: number) => {
            try {
              return (evaluateWithRegistry as any)(a.fn.expr, { [a.fn.variable]: x }, registry);
            } catch {
              return NaN;
            }
          };
          const fb = (x: number) => {
            try {
              return (evaluateWithRegistry as any)(b.fn.expr, { [b.fn.variable]: x }, registry);
            } catch {
              return NaN;
            }
          };

          // Use overlapping domain
          const [aMin, aMax] = a.fn.domain;
          const [bMin, bMax] = b.fn.domain;
          const domainMin = Math.max(aMin, bMin);
          const domainMax = Math.min(aMax, bMax);

          if (domainMin < domainMax) {
            pts = segmentManager.findExplicitExplicitIntersections(fa, fb, [domainMin, domainMax]);
          }
        } else if (!aIsExplicit && !bIsExplicit && !aIsTwoPointSeg && !bIsTwoPointSeg) {
          // Implicit-Implicit: Use enhanced 2D Newton solver
          const fa = (x: number, y: number) => {
            try {
              return (evaluateWithRegistry as any)(a.fn.expr, { x, y }, registry);
            } catch {
              return NaN;
            }
          };
          const fb = (x: number, y: number) => {
            try {
              return (evaluateWithRegistry as any)(b.fn.expr, { x, y }, registry);
            } catch {
              return NaN;
            }
          };

          pts = segmentManager.findImplicitImplicitIntersections(
            a.polyline as any,
            b.polyline as any,
            fa,
            fb
          );
        } else {
          // Explicit-Implicit: Use hybrid solver
          const [explicitFn, implicitFn, , implicitPoly] = aIsExplicit
            ? [a.fn, b.fn, a.polyline, b.polyline]
            : [b.fn, a.fn, b.polyline, a.polyline];
          // Explicit vs Implicit
          const fExplicit = (x: number) => {
            try {
              return (evaluateWithRegistry as any)(explicitFn.expr, { [explicitFn.variable]: x }, registry);
            } catch {
              return NaN;
            }
          };

          const fImplicit = (x: number, y: number) => {
            try {
              return (evaluateWithRegistry as any)(implicitFn.expr, { x, y }, registry);
            } catch {
              return NaN;
            }
          };

          const [dMin, dMax] = explicitFn.domain;

          // Use polyline samples if available for checking near-points (endpoints)
          const explicitSamples = explicitFn.kind === 'segment' ? (explicitFn as any).samples : undefined;

          pts = segmentManager.findExplicitImplicitIntersections(
            fExplicit,
            fImplicit,
            implicitPoly as any,
            [dMin, dMax],
            { explicitSamples } as any
          );
        }

        if (pts.length > 0) {
          // Prevent "intersection carpets" along near-overlapping paths by clustering/capping per pair.
          pts = _clusterPtsPx(pts, 8, 16);

          const aIsFunction = a.fn.kind === 'function-explicit' || a.fn.kind === 'function-implicit';
          const bIsFunction = b.fn.kind === 'function-explicit' || b.fn.kind === 'function-implicit';
          const aIsTwoPointSegLocal = a.fn.kind === 'two-point-segment';
          const bIsTwoPointSegLocal = b.fn.kind === 'two-point-segment';
          const oneIsTwoPointSeg = (aIsTwoPointSegLocal && !bIsTwoPointSegLocal) || (!aIsTwoPointSegLocal && bIsTwoPointSegLocal);
          const bothTwoPointSeg = aIsTwoPointSegLocal && bIsTwoPointSegLocal;

          // Hard caps to prevent explosions:
          // - segment vs function: keep <= 2 (most common)
          // - segment vs segment: keep <= 1
          if (bothTwoPointSeg) {
            pts = pts.slice(0, 1);
          } else if (oneIsTwoPointSeg) {
            pts = pts.slice(0, 2);
          }

          // Storage rules:
          // - If BOTH are functions: store into both function ids (for function splitting + persistence).
          // - If ONE is a two-point segment and the other is a function:
          //   - store into the segment id (so the segment can be split)
          //   - store into splitPointsForFunction for the function id (so the function can be split),
          //     but do NOT persist those points into functionIntersections.
          const shouldStoreInA = aIsFunction && bIsFunction;
          const shouldStoreInB = aIsFunction && bIsFunction;

          if (shouldStoreInA) {
            const arrA = intersectionsByFn.get(a.fn.id) || [];
            arrA.push(...pts);
            intersectionsByFn.set(a.fn.id, arrA);
          } else if (aIsTwoPointSegLocal) {
            const arrS = intersectionsByFn.get(a.fn.id) || [];
            arrS.push(...pts);
            intersectionsByFn.set(a.fn.id, arrS);
          } else if (aIsFunction && bIsTwoPointSegLocal) {
            const arrF = splitPointsForFunction.get(a.fn.id) || [];
            arrF.push(...pts);
            splitPointsForFunction.set(a.fn.id, arrF);
          }

          if (shouldStoreInB) {
            const arrB = intersectionsByFn.get(b.fn.id) || [];
            arrB.push(...pts);
            intersectionsByFn.set(b.fn.id, arrB);
          } else if (bIsTwoPointSegLocal) {
            const arrS = intersectionsByFn.get(b.fn.id) || [];
            arrS.push(...pts);
            intersectionsByFn.set(b.fn.id, arrS);
          } else if (bIsFunction && aIsTwoPointSegLocal) {
            const arrF = splitPointsForFunction.get(b.fn.id) || [];
            arrF.push(...pts);
            splitPointsForFunction.set(b.fn.id, arrF);
          }
        }
      }
    }

    // Helper: insert an intersection point into a polyline at the correct edge
    const insertPointIntoPolyline = (poly: { x: number; y: number }[], p: { x: number; y: number }, eps = 1e-6) => {
      const quant = (v: number) => v.toFixed(6);
      const key = (pt: { x: number; y: number }) => `${quant(pt.x)}_${quant(pt.y)}`;
      const targetKey = key(p);
      // Skip if already present
      for (const q of poly) if (key(q) === targetKey) return poly;
      for (let i = 0; i < poly.length - 1; i++) {
        const a = poly[i];
        const b = poly[i + 1];
        const abx = b.x - a.x; const aby = b.y - a.y;
        const apx = p.x - a.x; const apy = p.y - a.y;
        const ab2 = abx * abx + aby * aby;
        const t = ab2 === 0 ? 0 : (apx * abx + apy * aby) / ab2;
        if (t >= -1e-6 && t <= 1 + 1e-6) {
          // Perpendicular distance
          const cx = a.x + abx * t; const cy = a.y + aby * t;
          const dist = Math.hypot(p.x - cx, p.y - cy);
          if (dist <= eps) {
            // Clamp t to [0,1]
            const tt = Math.max(0, Math.min(1, t));
            const ix = a.x + abx * tt; const iy = a.y + aby * tt;
            poly.splice(i + 1, 0, { x: ix, y: iy });
            return poly;
          }
        }
      }
      return poly;
    };

    // Group polylines by function ID to handle implicit functions with multiple branches
    const polylinesByFnId = new Map<string, FnPolyline[]>();
    for (const entry of allPolylines) {
      const list = polylinesByFnId.get(entry.fn.id) || [];
      list.push(entry);
      polylinesByFnId.set(entry.fn.id, list);
    }

    // Save existing segment properties for ALL functions before removal (by stableSegmentId)
    // This must be done globally to preserve styles when new functions are added
    const savedSegmentProps = new Map<string, any>();
    const savedFunctionStyles = new Map<string, any>(); // 함수별 대표 스타일 저장
    const savedSegmentGeomByFn = new Map<string, Array<{ x: number; y: number; dx: number; dy: number; style: any; xMin?: number; xMax?: number }>>();
    const currentState = get();
    for (const node of Object.values(currentState.scene.nodes)) {
      const n = node as any;
      if (n && n.kind === 'segment' && n.stableSegmentId) {
        savedSegmentProps.set(n.stableSegmentId, {
          style: n.style,
          extendStart: n.extendStart,
          extendEnd: n.extendEnd
        });
        // 함수별로 하나라도 스타일이 있으면 저장 (점선 등을 유지하기 위해)
        if (n.functionId && n.style && !savedFunctionStyles.has(n.functionId)) {
          savedFunctionStyles.set(n.functionId, n.style);
        }
        // 함수 세그먼트의 기하 서명(중심/방향) 저장하여 부분 스타일 복원 용도
        if (n.functionId && n.samples && Array.isArray(n.samples) && n.samples.length >= 2) {
          const samples = n.samples as Array<{ x: number; y: number }>;
          const mid = Math.floor(samples.length / 2);
          const centerPt = samples[mid];
          const dx = samples[samples.length - 1].x - samples[0].x;
          const dy = samples[samples.length - 1].y - samples[0].y;
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          let xMin: number | undefined;
          let xMax: number | undefined;
          try {
            const xs = samples.map(p => p.x);
            xMin = Math.min(...xs);
            xMax = Math.max(...xs);
          } catch { }
          const arr = savedSegmentGeomByFn.get(n.functionId) || [];
          arr.push({ x: centerPt.x, y: centerPt.y, dx: dx / len, dy: dy / len, style: n.style, xMin, xMax });
          savedSegmentGeomByFn.set(n.functionId, arr);
        }
      }
    }

    // Split and create segments per function
    for (const [_fnId, entries] of polylinesByFnId.entries()) {
      let fn = entries[0].fn;

      // Skip two-point segments - they are not function-derived and will be handled separately
      if (fn.kind === 'two-point-segment') continue;

      // IMPORTANT: Bezier curves (including "길이 점선") are drawn directly as beziers.
      // They are included in allPolylines only for intersection detection.
      // Converting them into segment nodes causes a solid overlay (SegmentManager previously dropped dash),
      // which can visually turn dashed beziers into solid lines when intersections appear.
      if (fn.kind === 'bezier') {
        // Clean up any legacy bezier-derived segments that may exist from previous conversions.
        set((s) => {
          const nextNodes = { ...s.scene.nodes } as any;
          const nextZ = { ...s.scene.zIndex } as any;
          for (const [nid, node] of Object.entries(nextNodes)) {
            const n = node as any;
            if (n && n.kind === 'segment' && n.functionId === fn.id) {
              delete nextNodes[nid];
              delete nextZ[nid];
            }
          }
          return { scene: { ...s.scene, nodes: nextNodes, zIndex: nextZ } } as any;
        });
        continue;
      }

      // 이 함수의 기존 세그먼트 스타일이 있으면 적용
      if (savedFunctionStyles.has(fn.id)) {
        fn = { ...fn, style: savedFunctionStyles.get(fn.id) };
      }

      // Remove existing segments for this function
      set((s) => {
        const nextNodes = { ...s.scene.nodes } as any;
        const nextZ = { ...s.scene.zIndex } as any;
        const anchorsToMaybeRemove = new Set<string>();
        for (const [nid, node] of Object.entries(nextNodes)) {
          const n = node as any;
          if (n && n.kind === 'segment' && n.functionId === fn.id) {
            if (n.startAnchorId) anchorsToMaybeRemove.add(n.startAnchorId);
            if (n.endAnchorId) anchorsToMaybeRemove.add(n.endAnchorId);
            delete nextNodes[nid];
            delete nextZ[nid];
          }
        }

        // Prune anchors that are no longer referenced after removing the old segments.
        // This prevents orphan anchors from accumulating across repeated reconversions.
        for (const anchorId of anchorsToMaybeRemove) {
          const stillUsed = Object.values(nextNodes).some((node: any) => {
            if (!node) return false;
            if (node.kind === 'segment' && (node.startAnchorId === anchorId || node.endAnchorId === anchorId)) return true;
            if (node.kind === 'line' && (node.a === anchorId || node.b === anchorId)) return true;
            if (node.kind === 'bezier' && (node.a === anchorId || node.b === anchorId || node.c1 === anchorId || node.c2 === anchorId)) return true;
            if (node.kind === 'axis' && (node.originId === anchorId || node.endpointId === anchorId)) return true;
            return false;
          });
          if (!stillUsed) {
            delete nextNodes[anchorId];
            delete nextZ[anchorId];
          }
        }
        return { scene: { ...s.scene, nodes: nextNodes, zIndex: nextZ } } as any;
      });

      // Use both function-function intersections and (non-persisted) segment->function split points.
      const intersections = (() => {
        const a = intersectionsByFn.get(fn.id) || [];
        const b = splitPointsForFunction.get(fn.id) || [];
        // Also include persistent split points from implicit suppression to prevent
        // deleted arcs from "reviving" when other functions are removed and the curve re-merges.
        const fnNodeForSuppression = (get().scene.nodes as any)[fn.id];
        const c = (fn.kind === 'function-implicit' && fnNodeForSuppression && fnNodeForSuppression.suppressedSplitPoints)
          ? (fnNodeForSuppression.suppressedSplitPoints as Vec2[])
          : [];
        if (b.length === 0 && c.length === 0) return a;
        // Cluster/cap to avoid pathological splitting.
        const merged = [...a, ...b, ...c];
        return _clusterPtsPx(merged as any, 8, 64);
      })();

      // 모든 polyline으로부터 임시로 세그먼트 생성(업서트 보류)
      const generatedSegments: any[] = [];

      // Process each polyline of this function
      for (const entry of entries) {
        let samples = entry.polyline as any[];
        // Ensure intersection coordinates are present in polyline for precise anchors
        for (const p of intersections) samples = insertPointIntoPolyline(samples, p);
        const segments = segmentManager.splitAtIntersections(
          { id: fn.id, style: fn.style, kind: fn.kind, clipToAxes: fn.clipToAxes } as any,
          samples,
          intersections,
          (pos) => state.createAnchor(pos)
        );

        // Heuristic: prevent extending at domain boundaries where function is undefined
        // Example: sqrt(x), log(x) near x=0 when domain is [-10,10]
        if (fn.kind === 'function-explicit' && samples && samples.length >= 2) {
          const firstX = samples[0].x;
          const lastX = samples[samples.length - 1].x;
          const domainMin = fn.domain[0];
          const domainMax = fn.domain[1];
          const eps = Math.max(1e-6, (domainMax - domainMin) / 1e6);
          const missingLeft = firstX - domainMin > eps;   // valid range starts after domain min
          const missingRight = domainMax - lastX > eps;   // valid range ends before domain max

          if (segments.length > 0) {
            // Left boundary: do not extend start if left side was invalid
            if (missingLeft) {
              segments[0].extendStart = false;
            }
            // Right boundary: do not extend end if right side was invalid
            if (missingRight) {
              segments[segments.length - 1].extendEnd = false;
            }
          }
        }

        // 일단 모아두기
        generatedSegments.push(...segments);
      }

      // 전역 억제 적용: stableSegmentIds + 함수 전체 좌/우 끝 억제
      // 최신 상태에서 함수 노드를 가져와야 suppressedSegmentIds가 반영됨
      const latestState = get();
      const fnNode = (latestState.scene.nodes as any)[fn.id];
      const suppressed = new Set<string>((fnNode && fnNode.suppressedSegmentIds) || []);
      const ends = (fnNode && fnNode.suppressedEnds) || {};

      // 좌/우 판정: 세그먼트 샘플 최소 x 기준 정렬
      const withMinX = generatedSegments.map((sg) => {
        const xs = (sg.samples || []) as Array<{ x: number; y: number }>;
        const minX = xs.length ? Math.min(...xs.map(p => p.x)) : Infinity;
        return { seg: sg, minX };
      }).filter(v => Number.isFinite(v.minX));
      withMinX.sort((a, b) => a.minX - b.minX);
      const leftSeg = withMinX[0]?.seg;
      const rightSeg = withMinX[withMinX.length - 1]?.seg;

      for (const seg of generatedSegments) {
        if (seg.stableSegmentId && suppressed.has(seg.stableSegmentId)) continue;
        if (fn.kind === 'function-explicit') {
          if (ends.left && leftSeg && seg === leftSeg) continue;
          if (ends.right && rightSeg && seg === rightSeg) continue;
        }

        // 음함수: 중심점 기반 억제 검사
        if (fn.kind === 'function-implicit' && fnNode && fnNode.suppressedSegmentCenters) {
          const samples = seg.samples as Array<{ x: number; y: number }>;
          if (samples && samples.length >= 2) {
            const mid = Math.floor(samples.length / 2);
            const centerPt = samples[mid];
            const dx = samples[samples.length - 1].x - samples[0].x;
            const dy = samples[samples.length - 1].y - samples[0].y;
            const len = Math.sqrt(dx * dx + dy * dy);
            const dirX = len > 1e-9 ? dx / len : 0;
            const dirY = len > 1e-9 ? dy / len : 0;

            // 억제된 세그먼트와 비교
            let isSuppressed = false;
            for (const suppCenter of fnNode.suppressedSegmentCenters) {
              // 중심점이 가까운지 확인 (허용 오차 0.5)
              const distSq = (centerPt.x - suppCenter.x) ** 2 + (centerPt.y - suppCenter.y) ** 2;
              if (distSq < 0.25) { // 0.5^2
                // 방향 벡터가 비슷한지 확인 (내적이 0.9 이상 = 약 25도 이내)
                const dot = dirX * suppCenter.dx + dirY * suppCenter.dy;
                if (Math.abs(dot) > 0.9) {
                  isSuppressed = true;
                  break;
                }
              }
            }
            if (isSuppressed) continue;
          }
        }

        // Restore saved properties if available
        if (seg.stableSegmentId && savedSegmentProps.has(seg.stableSegmentId)) {
          const saved = savedSegmentProps.get(seg.stableSegmentId);
          if (saved.style) seg.style = saved.style;
          if (saved.extendStart !== undefined) seg.extendStart = saved.extendStart;
          if (saved.extendEnd !== undefined) seg.extendEnd = saved.extendEnd;
        } else {
          // First try: explicit function range-overlap based restoration (preserve dashed extent across new intersections)
          if (fn.kind === 'function-explicit' && seg.samples && seg.samples.length >= 2) {
            try {
              const s = seg.samples as Array<{ x: number; y: number }>;
              const xs = s.map(p => p.x);
              const segMinX = Math.min(...xs);
              const segMaxX = Math.max(...xs);
              const segLenX = Math.max(1e-12, segMaxX - segMinX);
              const geomList = savedSegmentGeomByFn.get(fn.id) || [];
              let best = null as any;
              let bestOverlap = 0;
              for (const g of geomList) {
                if (g.xMin === undefined || g.xMax === undefined) continue;
                const overlap = Math.min(segMaxX, g.xMax) - Math.max(segMinX, g.xMin);
                if (overlap > bestOverlap) {
                  bestOverlap = overlap;
                  best = g;
                }
              }
              // If majority of this segment overlaps with a previously dashed segment, inherit its style
              if (best && best.style) {
                const dash = best.style?.stroke?.dash;
                const overlapRatio = bestOverlap / segLenX;
                if (dash && Array.isArray(dash) && dash.length > 0 && overlapRatio > 0.6) {
                  seg.style = best.style;
                }
              }
            } catch { }
          }

          // Fallback: geometry-based match (center+direction)
          try {
            const geomList = savedSegmentGeomByFn.get(fn.id) || [];
            if (geomList.length > 0 && seg.samples && seg.samples.length >= 2) {
              const s = seg.samples as Array<{ x: number; y: number }>;
              const mid = Math.floor(s.length / 2);
              const cx = s[mid].x;
              const cy = s[mid].y;
              const dx = s[s.length - 1].x - s[0].x;
              const dy = s[s.length - 1].y - s[0].y;
              const len = Math.sqrt(dx * dx + dy * dy) || 1;
              const dirX = dx / len;
              const dirY = dy / len;
              let bestIdx = -1;
              let bestScore = Infinity;
              for (let i = 0; i < geomList.length; i++) {
                const g = geomList[i];
                const dist2 = (cx - g.x) * (cx - g.x) + (cy - g.y) * (cy - g.y);
                const dirDot = Math.abs(dirX * g.dx + dirY * g.dy);
                // Score: favor close center and similar direction (lower is better)
                const score = dist2 + (1 - dirDot) * 0.5; // 0.5 weights direction mismatch
                if (score < bestScore) { bestScore = score; bestIdx = i; }
              }
              // Apply style if close enough
              if (bestIdx >= 0) {
                const g = geomList[bestIdx];
                // Thresholds: within ~0.6 units and direction within ~25° (dot>0.9)
                const distOk = ((cx - g.x) * (cx - g.x) + (cy - g.y) * (cy - g.y)) < 0.36;
                const dotOk = Math.abs(dirX * g.dx + dirY * g.dy) > 0.9;
                if (distOk && dotOk && g.style) {
                  seg.style = g.style;
                }
              }
            }
          } catch { }
        }
        state.upsertNode(seg as any);
      }

      // For explicit functions, suppress curve drawing when segments exist; implicit keeps curve visible
      const node = (latestState.scene.nodes as any)[fn.id];
      if (node && node.kind === 'function-explicit') {
        state.upsertNode({ ...node, segmentsOnly: true } as any);
      }
    }

    // Split two-point segments at their intersection points
    // Default behavior: ON (legacy). Opt-out by setting `autoSplitAtIntersections: false` on the segment.
    for (const seg of twoPointSegments) {
      if ((seg as any).autoSplitAtIntersections === false) continue;
      const rawIntersections = intersectionsByFn.get(seg.id) || [];
      // Prevent pathological "many split points": cluster and cap in screen-space.
      const intersections = _clusterPtsPx(rawIntersections as any, 8, 6);
      if (intersections.length === 0) continue; // No intersections, nothing to split

      const startAnchor = nodes[seg.startAnchorId] as any;
      const endAnchor = nodes[seg.endAnchorId] as any;
      if (!startAnchor || !endAnchor) continue;
      if (!startAnchor.position || !endAnchor.position) continue;

      const p1 = startAnchor.position;
      const p2 = endAnchor.position;

      // Calculate parameter t for each intersection on the line segment
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len2 = dx * dx + dy * dy;

      if (len2 < 1e-12) continue; // Degenerate segment

      // Project each intersection onto the segment and get parameter t
      const tValues: { t: number; pt: Vec2 }[] = [];
      for (const inter of intersections) {
        const t = ((inter.x - p1.x) * dx + (inter.y - p1.y) * dy) / len2;
        // Only consider intersections that are actually on the segment (not extended)
        if (t > 0.001 && t < 0.999) {
          tValues.push({ t, pt: inter });
        }
      }

      if (tValues.length === 0) continue; // No valid split points

      // Sort by parameter t
      tValues.sort((a, b) => a.t - b.t);

      // Remove the original segment
      set((s) => {
        const nextNodes = { ...s.scene.nodes } as any;
        const nextZ = { ...s.scene.zIndex } as any;
        delete nextNodes[seg.id];
        delete nextZ[seg.id];
        return { scene: { ...s.scene, nodes: nextNodes, zIndex: nextZ } } as any;
      });

      // Create new segments: start -> inter1 -> inter2 -> ... -> end
      const allPoints = [p1, ...tValues.map(tv => tv.pt), p2];

      for (let i = 0; i < allPoints.length - 1; i++) {
        const segStart = allPoints[i];
        const segEnd = allPoints[i + 1];

        // Create anchors for split points (first and last use existing anchors)
        let startId: StableId;
        let endId: StableId;

        if (i === 0) {
          startId = seg.startAnchorId;
        } else {
          startId = state.createAnchor(segStart);
        }

        if (i === allPoints.length - 2) {
          endId = seg.endAnchorId;
        } else {
          endId = state.createAnchor(segEnd);
        }

        // Create new segment
        const newSegId = generateStableId('seg');
        const newSeg: any = {
          id: newSegId,
          kind: 'segment',
          startAnchorId: startId,
          endAnchorId: endId,
          samples: [segStart, segEnd],
          style: seg.style || { stroke: { color: '#000000', width: 0.8 } },
          stableSegmentId: `tpseg_${segStart.x.toFixed(4)}_${segStart.y.toFixed(4)}_${segEnd.x.toFixed(4)}_${segEnd.y.toFixed(4)}`,
          extendStart: i === 0 ? (seg.extendStart || false) : false,
          extendEnd: i === allPoints.length - 2 ? (seg.extendEnd || false) : false
        };

        state.upsertNode(newSeg);
      }
    }

    // Collect all special points (intersections, extrema, inflection points, projections)
    const specialPoints: Vec2[] = [];

    // 0. Always add origin point (0, 0)
    specialPoints.push({ x: 0, y: 0 });

    // 1. Add intersection points
    // IMPORTANT:
    // `intersectionsByFn` also contains intersections for user-drawn two-point segments (keyed by segment.id).
    // Those should NOT be persisted into the "functionIntersections" snapshot, otherwise points will appear
    // along segment paths even after the user stops interacting (and may "explode" until refresh).
    const twoPointSegIdSet = new Set<string>((twoPointSegments || []).map((s: any) => s?.id).filter(Boolean));
    for (const [id, pts] of intersectionsByFn.entries()) {
      if (twoPointSegIdSet.has(id)) continue;
      specialPoints.push(...pts);
    }

    // 1.2. Add axis intercepts detected directly from sampled polylines (robust for implicit)
    // This complements the analytic/bisection approach and guarantees intercepts for sampled curves
    const interceptsFromPolylines: Vec2[] = [];
    for (const { fn, polyline } of allPolylines) {
      // y=0 상수함수에서 발생하는 무한 절편 방지: 해당 함수는 스킵
      if (fn && fn.kind === 'function-explicit' && zeroExplicitFnIds.has(fn.id)) continue;
      for (let i = 1; i < polyline.length; i++) {
        const p1 = polyline[i - 1];
        const p2 = polyline[i];
        // y = 0 crossing (x-intercept)
        if ((p1.y === 0 && p2.y === 0)) {
          // Entire segment lies on axis => infinite intercepts (overlap), not a discrete point set.
          // Skip to avoid "painting" many points along the axis.
        } else if ((p1.y <= 0 && p2.y >= 0) || (p1.y >= 0 && p2.y <= 0)) {
          const dy = p2.y - p1.y;
          if (Math.abs(dy) > 1e-12) {
            const t = (-p1.y) / dy;
            if (t >= 0 && t <= 1) {
              const x = p1.x + (p2.x - p1.x) * t;
              interceptsFromPolylines.push({ x, y: 0 });
            }
          }
        }
        // x = 0 crossing (y-intercept)
        if ((p1.x === 0 && p2.x === 0)) {
          // Entire segment lies on axis => infinite intercepts (overlap), not a discrete point set.
          // Skip to avoid "painting" many points along the axis.
        } else if ((p1.x <= 0 && p2.x >= 0) || (p1.x >= 0 && p2.x <= 0)) {
          const dx = p2.x - p1.x;
          if (Math.abs(dx) > 1e-12) {
            const t = (-p1.x) / dx;
            if (t >= 0 && t <= 1) {
              const y = p1.y + (p2.y - p1.y) * t;
              interceptsFromPolylines.push({ x: 0, y });
            }
          }
        }
      }
    }
    // Dedupe and add
    if (interceptsFromPolylines.length > 0) {
      const seenIntercepts = new Set<string>();
      for (const pt of interceptsFromPolylines) {
        const key = `${pt.x.toFixed(6)},${pt.y.toFixed(6)}`;
        if (!seenIntercepts.has(key)) {
          seenIntercepts.add(key);
          specialPoints.push(pt);
        }
      }
    }

    // 1.5. Add intercepts (x-intercepts and y-intercepts)
    for (const fn of explicitFns) {
      const [xMin, xMax] = fn.domain;
      // Y-intercept: f(0)
      if (xMin <= 0 && xMax >= 0) {
        try {
          const y = evaluateWithRegistry(fn.expr, { [fn.variable]: 0 }, registry);
          if (isFinite(y)) specialPoints.push({ x: 0, y });
        } catch { }
      }
      // X-intercepts: where f(x) = 0
      try {
        const samples = 200;
        const dx = (xMax - xMin) / samples;
        let prevY = evaluateWithRegistry(fn.expr, { [fn.variable]: xMin }, registry);
        for (let i = 1; i <= samples; i++) {
          const x = xMin + i * dx;
          const y = evaluateWithRegistry(fn.expr, { [fn.variable]: x }, registry);
          if (isFinite(prevY) && isFinite(y) && prevY * y < 0) {
            let a = xMin + (i - 1) * dx, b = x, fa = prevY;
            for (let iter = 0; iter < 20; iter++) {
              const mid = (a + b) / 2;
              const fmid = evaluateWithRegistry(fn.expr, { [fn.variable]: mid }, registry);
              if (Math.abs(fmid) < 1e-8 || (b - a) < 1e-8) {
                specialPoints.push({ x: mid, y: 0 });
                break;
              }
              if (fa * fmid < 0) b = mid; else { a = mid; fa = fmid; }
            }
          }
          prevY = y;
        }
      } catch { }
    }
    for (const fn of implicitFns) {
      try {
        const samplingBounds = implicitBoundsMap.get(fn.id) || fn.bounds;
        const { xMin, xMax, yMin, yMax } = samplingBounds || { xMin: -10, xMax: 10, yMin: -10, yMax: 10 };
        // X-intercepts: F(x, 0) = 0
        if (yMin <= 0 && yMax >= 0) {
          const samples = 200, dx = (xMax - xMin) / samples;
          let prevF = evaluateWithRegistry(fn.expr, { x: xMin, y: 0 }, registry);
          for (let i = 1; i <= samples; i++) {
            const x = xMin + i * dx;
            const f = evaluateWithRegistry(fn.expr, { x, y: 0 }, registry);
            if (isFinite(prevF) && isFinite(f) && prevF * f < 0) {
              let a = xMin + (i - 1) * dx, b = x, fa = prevF;
              for (let iter = 0; iter < 20; iter++) {
                const mid = (a + b) / 2;
                const fmid = evaluateWithRegistry(fn.expr, { x: mid, y: 0 }, registry);
                if (Math.abs(fmid) < 1e-8 || (b - a) < 1e-8) {
                  specialPoints.push({ x: mid, y: 0 });
                  break;
                }
                if (fa * fmid < 0) b = mid; else { a = mid; fa = fmid; }
              }
            }
            prevF = f;
          }
        }
        // Y-intercepts: F(0, y) = 0
        if (xMin <= 0 && xMax >= 0) {
          const samples = 200, dy = (yMax - yMin) / samples;
          let prevF = evaluateWithRegistry(fn.expr, { x: 0, y: yMin }, registry);
          for (let i = 1; i <= samples; i++) {
            const y = yMin + i * dy;
            const f = evaluateWithRegistry(fn.expr, { x: 0, y }, registry);
            if (isFinite(prevF) && isFinite(f) && prevF * f < 0) {
              let a = yMin + (i - 1) * dy, b = y, fa = prevF;
              for (let iter = 0; iter < 20; iter++) {
                const mid = (a + b) / 2;
                const fmid = evaluateWithRegistry(fn.expr, { x: 0, y: mid }, registry);
                if (Math.abs(fmid) < 1e-8 || (b - a) < 1e-8) {
                  specialPoints.push({ x: 0, y: mid });
                  break;
                }
                if (fa * fmid < 0) b = mid; else { a = mid; fa = fmid; }
              }
            }
            prevF = f;
          }
        }
      } catch { }
    }

    // 2. Compute extrema and inflection points for explicit functions (skip linear)
    for (const fn of explicitFns) {
      const [xMin, xMax] = fn.domain;
      const linear = isExplicitLinear(fn.expr, fn.variable, [xMin, xMax], registry as any);
      if (!linear) {
        const extrema = computeExtrema(fn.expr, fn.variable, [xMin, xMax], registry as any);
        specialPoints.push(...extrema);
        const inflections = computeInflectionPoints(fn.expr, fn.variable, [xMin, xMax], registry as any);
        specialPoints.push(...inflections);
      }

      // 3. Add domain endpoints (정의역 양 끝점)
      // clipToAxes가 false인 경우 (수동 정의역 설정)에만 추가
      if (fn.clipToAxes === false) {
        try {
          // Evaluate function at domain endpoints
          const fnRegistry = registry as any;
          const evalExpr = (x: number) => {
            const ctx = { x, ...fnRegistry };
            try {
              return Function(...Object.keys(ctx), `'use strict'; return (${fn.expr})`)(
                ...Object.values(ctx)
              );
            } catch {
              return NaN;
            }
          };

          const yMin = evalExpr(xMin);
          const yMax = evalExpr(xMax);

          if (Number.isFinite(yMin)) {
            specialPoints.push({ x: xMin, y: yMin });
          }
          if (Number.isFinite(yMax)) {
            specialPoints.push({ x: xMax, y: yMax });
          }
        } catch (e) {
          // Evaluation failed, skip endpoint
          console.warn('Failed to evaluate domain endpoints:', e);
        }
      }
    }

    // 3. Add all existing points (PointNode) to special points
    const pointNodes = Object.values(nodes).filter((n: any) => n && n.kind === 'point') as any[];
    for (const pt of pointNodes) {
      if (pt.position) {
        specialPoints.push(pt.position);
      }
    }

    // 4. Add endpoints of segments (ONLY user-drawn two-point segments/rays/lines).
    // Function-derived segments contain many internal anchors and should not become "special points".
    // Also exclude auto-split pieces (`tpseg_...`) to avoid painting points along the segment path.
    const segmentNodes = Object.values(nodes).filter((n: any) => {
      if (!n || n.kind !== 'segment') return false;
      if (n.functionId) return false;
      if (typeof (n as any).stableSegmentId === 'string' && (n as any).stableSegmentId.startsWith('tpseg_')) return false;
      return true;
    }) as any[];
    for (const seg of segmentNodes) {
      // Add start point if not extended (segment or halfline start)
      if (!seg.extendStart && seg.startAnchorId) {
        const startAnchor = nodes[seg.startAnchorId] as any;
        if (startAnchor && startAnchor.position) {
          specialPoints.push(startAnchor.position);
        }
      }
      // Add end point if not extended (segment or halfline end)
      if (!seg.extendEnd && seg.endAnchorId) {
        const endAnchor = nodes[seg.endAnchorId] as any;
        if (endAnchor && endAnchor.position) {
          specialPoints.push(endAnchor.position);
        }
      }
    }

    // 5. Add endpoints of bezier curves (both regular and dashed)
    const bezierNodes = Object.values(nodes).filter((n: any) => n && n.kind === 'bezier') as any[];
    for (const bez of bezierNodes) {
      // Add start point (anchor a)
      if (bez.a) {
        const startAnchor = nodes[bez.a] as any;
        if (startAnchor && startAnchor.position) {
          specialPoints.push(startAnchor.position);
        }
      }
      // Add end point (anchor b)
      if (bez.b) {
        const endAnchor = nodes[bez.b] as any;
        if (endAnchor && endAnchor.position) {
          specialPoints.push(endAnchor.position);
        }
      }
    }

    // 6. Calculate intercepts from functions (x-intercepts and y-intercepts)
    // Explicit functions: y = f(x)
    console.log('🔍 Calculating intercepts for', explicitFns.length, 'explicit functions');
    for (const fn of explicitFns) {
      try {
        // Y-intercept: evaluate at x=0
        const [xMin, xMax] = fn.domain;
        console.log(`  Function ${fn.symbol}: domain [${xMin}, ${xMax}], expr: ${fn.expr}`);
        if (xMin <= 0 && xMax >= 0) {
          const yAtZero = evaluateWithRegistry(fn.expr, { [fn.variable]: 0 }, registry);
          console.log(`    Y-intercept at x=0: y=${yAtZero}, isFinite=${isFinite(yAtZero)}`);
          if (isFinite(yAtZero)) {
            specialPoints.push({ x: 0, y: yAtZero });
            console.log(`    ✓ Added y-intercept: (0, ${yAtZero})`);
          }
        } else {
          console.log(`    ✗ x=0 not in domain [${xMin}, ${xMax}]`);
        }

        // X-intercepts: find where f(x) = 0
        const samples = 200;
        const dx = (xMax - xMin) / samples;
        let prevY = evaluateWithRegistry(fn.expr, { [fn.variable]: xMin }, registry);
        let xInterceptCount = 0;

        for (let i = 1; i <= samples; i++) {
          const x = xMin + i * dx;
          const y = evaluateWithRegistry(fn.expr, { [fn.variable]: x }, registry);

          if (isFinite(prevY) && isFinite(y) && prevY * y < 0) {
            // Sign change detected, use bisection to find root
            let a = xMin + (i - 1) * dx;
            let b = x;
            let fa = prevY;

            for (let iter = 0; iter < 20; iter++) {
              const mid = (a + b) / 2;
              const fmid = evaluateWithRegistry(fn.expr, { [fn.variable]: mid }, registry);

              if (Math.abs(fmid) < 1e-8 || (b - a) < 1e-8) {
                specialPoints.push({ x: mid, y: 0 });
                xInterceptCount++;
                console.log(`    ✓ Added x-intercept: (${mid}, 0)`);
                break;
              }

              if (fa * fmid < 0) {
                b = mid;
              } else {
                a = mid;
                fa = fmid;
              }
            }
          }

          prevY = y;
        }
        if (xInterceptCount > 0) {
          console.log(`    Total x-intercepts found: ${xInterceptCount}`);
        }
      } catch (e) {
        console.log(`    ✗ Error calculating intercepts:`, e);
      }
    }

    // Implicit functions: F(x,y) = 0
    console.log('🔍 Calculating intercepts for', implicitFns.length, 'implicit functions');
    for (const fn of implicitFns) {
      try {
        const samplingBounds = implicitBoundsMap.get(fn.id) || fn.bounds;
        const { xMin, xMax, yMin, yMax } = samplingBounds || { xMin: -10, xMax: 10, yMin: -10, yMax: 10 };
        console.log(`  Function ${fn.symbol}: bounds [${xMin}, ${xMax}] × [${yMin}, ${yMax}], expr: ${fn.expr}`);

        // X-intercepts: find where F(x, 0) = 0
        if (yMin <= 0 && yMax >= 0) {
          const samples = 200;
          const dx = (xMax - xMin) / samples;
          let prevF = evaluateWithRegistry(fn.expr, { x: xMin, y: 0 }, registry);
          let xInterceptCount = 0;

          for (let i = 1; i <= samples; i++) {
            const x = xMin + i * dx;
            const f = evaluateWithRegistry(fn.expr, { x, y: 0 }, registry);

            if (isFinite(prevF) && isFinite(f) && prevF * f < 0) {
              // Sign change detected
              let a = xMin + (i - 1) * dx;
              let b = x;
              let fa = prevF;

              for (let iter = 0; iter < 20; iter++) {
                const mid = (a + b) / 2;
                const fmid = evaluateWithRegistry(fn.expr, { x: mid, y: 0 }, registry);

                if (Math.abs(fmid) < 1e-8 || (b - a) < 1e-8) {
                  specialPoints.push({ x: mid, y: 0 });
                  xInterceptCount++;
                  console.log(`    ✓ Added x-intercept: (${mid}, 0)`);
                  break;
                }

                if (fa * fmid < 0) {
                  b = mid;
                } else {
                  a = mid;
                  fa = fmid;
                }
              }
            }

            prevF = f;
          }
          if (xInterceptCount > 0) {
            console.log(`    Total x-intercepts found: ${xInterceptCount}`);
          }
        } else {
          console.log(`    ✗ y=0 not in bounds [${yMin}, ${yMax}]`);
        }

        // Y-intercepts: find where F(0, y) = 0
        if (xMin <= 0 && xMax >= 0) {
          const samples = 200;
          const dy = (yMax - yMin) / samples;
          let prevF = evaluateWithRegistry(fn.expr, { x: 0, y: yMin }, registry);
          let yInterceptCount = 0;

          for (let i = 1; i <= samples; i++) {
            const y = yMin + i * dy;
            const f = evaluateWithRegistry(fn.expr, { x: 0, y }, registry);

            if (isFinite(prevF) && isFinite(f) && prevF * f < 0) {
              // Sign change detected
              let a = yMin + (i - 1) * dy;
              let b = y;
              let fa = prevF;

              for (let iter = 0; iter < 20; iter++) {
                const mid = (a + b) / 2;
                const fmid = evaluateWithRegistry(fn.expr, { x: 0, y: mid }, registry);

                if (Math.abs(fmid) < 1e-8 || (b - a) < 1e-8) {
                  specialPoints.push({ x: 0, y: mid });
                  yInterceptCount++;
                  console.log(`    ✓ Added y-intercept: (0, ${mid})`);
                  break;
                }

                if (fa * fmid < 0) {
                  b = mid;
                } else {
                  a = mid;
                  fa = fmid;
                }
              }
            }

            prevF = f;
          }
          if (yInterceptCount > 0) {
            console.log(`    Total y-intercepts found: ${yInterceptCount}`);
          }
        } else {
          console.log(`    ✗ x=0 not in bounds [${xMin}, ${xMax}]`);
        }
      } catch (e) {
        console.log(`    ✗ Error calculating intercepts:`, e);
      }
    }

    // 6.8. (Removed - axis projections handled in step 7 to avoid duplicates)

    // 6.9. Intersections of lines/segments/rays with other curves (excluding axes)
    // NOTE: this caused frequent "explosions" for straight lines/segments due to discretization.
    // Real-time line/segment intersections are computed in `updateIntersectionsWithPoints()`.
    // We intentionally skip persisting them here.
    /* try {
      // Helper: line-line intersection (returns point and parameter t for first line)
      const lineLineIntersection = (
        x1: number, y1: number, x2: number, y2: number,
        x3: number, y3: number, x4: number, y4: number
      ): { x: number; y: number; t: number; u: number } | null => {
        const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
        if (Math.abs(denom) < 1e-10) return null; // parallel
        const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
        const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
        return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1), t, u };
      };

      const addIfFinite = (pt: { x: number; y: number }) => {
        if (Number.isFinite(pt.x) && Number.isFinite(pt.y)) specialPoints.push(pt);
      };

      // Collect all linear geometries (lines, segments, rays - excluding axes)
      const lineNodes = Object.values(nodes).filter((n: any) => n && n.kind === 'line') as any[];
      // Two-point tool segments (functionId is empty or missing)
      const twoPointSegNodes = Object.values(nodes).filter((n: any) => n && n.kind === 'segment' && !n.functionId) as any[];
      // Function-based curve segments (for intersection with linear elements)
      const curveSegNodes = Object.values(nodes).filter((n: any) => n && n.kind === 'segment' && n.functionId) as any[];

      // Build list of all linear elements with their properties (axes excluded - intercepts already calculated)
      const linearElements: Array<{
        ax: number; ay: number; bx: number; by: number;
        isInfinite: boolean; isRayFromA: boolean; isRayFromB: boolean; isSegment: boolean;
      }> = [];

      // Add line nodes (infinite lines)
      for (const ln of lineNodes) {
        const a = nodes[ln.a] as any; const b = nodes[ln.b] as any;
        if (!a || !b) continue;
        linearElements.push({
          ax: a.position.x, ay: a.position.y,
          bx: b.position.x, by: b.position.y,
          isInfinite: true, isRayFromA: false, isRayFromB: false, isSegment: false
        });
      }

      // Add two-point tool segment nodes (segments, rays, or infinite lines based on extend flags)
      for (const sg of twoPointSegNodes) {
        const a = nodes[sg.startAnchorId] as any; const b = nodes[sg.endAnchorId] as any;
        if (!a || !b) continue;
        const extendStart = sg.extendStart || false;
        const extendEnd = sg.extendEnd || false;
        linearElements.push({
          ax: a.position.x, ay: a.position.y,
          bx: b.position.x, by: b.position.y,
          isInfinite: extendStart && extendEnd,
          isRayFromA: extendStart && !extendEnd,
          isRayFromB: !extendStart && extendEnd,
          isSegment: !extendStart && !extendEnd
        });
      }

      // Note: axes excluded from intersection calculation (intercepts already calculated in steps 1.2, 1.5, 6)

      // Intersect all pairs of linear elements
      for (let i = 0; i < linearElements.length; i++) {
        for (let j = i + 1; j < linearElements.length; j++) {
          const elem1 = linearElements[i];
          const elem2 = linearElements[j];

          const inter = lineLineIntersection(
            elem1.ax, elem1.ay, elem1.bx, elem1.by,
            elem2.ax, elem2.ay, elem2.bx, elem2.by
          );

          if (!inter) continue;

          // Check if intersection is within the bounds of both elements
          // t parameter: 0 = point A, 1 = point B, <0 = before A, >1 = after B
          // isRayFromA: extends before A (t <= 1)
          // isRayFromB: extends after B (t >= 0)
          const validForElem1 = elem1.isInfinite ||
            (elem1.isRayFromA && inter.t <= 1 + 1e-9) ||
            (elem1.isRayFromB && inter.t >= -1e-9) ||
            (elem1.isSegment && inter.t >= -1e-9 && inter.t <= 1 + 1e-9);

          const validForElem2 = elem2.isInfinite ||
            (elem2.isRayFromA && inter.u <= 1 + 1e-9) ||
            (elem2.isRayFromB && inter.u >= -1e-9) ||
            (elem2.isSegment && inter.u >= -1e-9 && inter.u <= 1 + 1e-9);

          if (validForElem1 && validForElem2) {
            addIfFinite({ x: inter.x, y: inter.y });
          }
        }
      }

      // Intersect linear elements with explicit functions
      for (const elem of linearElements) {
        const dx = elem.bx - elem.ax;
        const dy = elem.by - elem.ay;
        const len = Math.hypot(dx, dy);
        if (len < 1e-12) continue;

        for (const fn of explicitFns) {
          try {
            const [xMin, xMax] = fn.domain;
            // Sample the function and find intersections with the line
            const samples = 200;
            const step = (xMax - xMin) / samples;

            const hits: Vec2[] = [];
            for (let i = 0; i < samples; i++) {
              const x1 = xMin + i * step;
              const x2 = xMin + (i + 1) * step;
              const y1 = evaluateWithRegistry(fn.expr, { [fn.variable]: x1 }, registry);
              const y2 = evaluateWithRegistry(fn.expr, { [fn.variable]: x2 }, registry);

              if (!Number.isFinite(y1) || !Number.isFinite(y2)) continue;

              // Check intersection with this segment of the function
              const inter = lineLineIntersection(
                elem.ax, elem.ay, elem.bx, elem.by,
                x1, y1, x2, y2
              );

              if (!inter) continue;

              // Check if intersection is within function domain
              if (inter.x < xMin - 1e-9 || inter.x > xMax + 1e-9) continue;

              // Check if intersection is valid for the linear element
              const validForElem = elem.isInfinite ||
                (elem.isRayFromA && inter.t <= 1 + 1e-9) ||
                (elem.isRayFromB && inter.t >= -1e-9) ||
                (elem.isSegment && inter.t >= -1e-9 && inter.t <= 1 + 1e-9);

              if (validForElem) {
                if (Number.isFinite(inter.x) && Number.isFinite(inter.y)) hits.push({ x: inter.x, y: inter.y });
              }
            }
            // De-flood duplicates near endpoints: cluster per (elem, fn) before adding.
            for (const p of _clusterPtsPx(hits, 8, 8)) addIfFinite(p);
          } catch { }
        }
      }

      // Intersect linear elements with curve segment samples (from implicit functions, etc.)
      for (const elem of linearElements) {
        for (const seg of curveSegNodes) {
          if (!seg.samples || seg.samples.length < 2) continue;

          // Check intersection with each segment of the sampled curve
          const hits: Vec2[] = [];
          for (let i = 0; i < seg.samples.length - 1; i++) {
            const p1 = seg.samples[i];
            const p2 = seg.samples[i + 1];

            const inter = lineLineIntersection(
              elem.ax, elem.ay, elem.bx, elem.by,
              p1.x, p1.y, p2.x, p2.y
            );

            if (!inter) continue;

            // Check if intersection is within the sampled segment (u should be in [0,1])
            if (inter.u < -1e-9 || inter.u > 1 + 1e-9) continue;

            // Check if intersection is valid for the linear element
            const validForElem = elem.isInfinite ||
              (elem.isRayFromA && inter.t <= 1 + 1e-9) ||
              (elem.isRayFromB && inter.t >= -1e-9) ||
              (elem.isSegment && inter.t >= -1e-9 && inter.t <= 1 + 1e-9);

            if (validForElem) {
              if (Number.isFinite(inter.x) && Number.isFinite(inter.y)) hits.push({ x: inter.x, y: inter.y });
            }
          }
          // De-flood duplicates near endpoints: cluster per (elem, curveSeg) before adding.
          for (const p of _clusterPtsPx(hits, 8, 8)) addIfFinite(p);
        }
      }
    } catch { } */

    // 7. Project all special points onto X and Y axes (excluding points already on axes to avoid duplicates)
    const axisThreshold = 1e-9;
    const notOnAxisForProjection = (pt: Vec2) => Math.abs(pt.x) > axisThreshold && Math.abs(pt.y) > axisThreshold;
    const pointsToProject = specialPoints.filter(notOnAxisForProjection);
    const projections = projectPointsToAxes(pointsToProject);
    specialPoints.push(...projections);

    // Deduplicate + screen-space clustering (prevents "path carpets" around intersections)
    const clustered = (() => {
      const out = _clusterPtsPx(specialPoints, 10, 1200);
      if (out.length > 900) {
        // Coarse screen grid downsample (one per cell)
        const gridPx = 12;
        const grid = new Map<string, Vec2>();
        for (const p of out) {
          const gx = Math.round((p.x * _scaleForPx) / gridPx);
          const gy = Math.round((p.y * _scaleForPx * _yScaleForPx) / gridPx);
          const key = `${gx},${gy}`;
          if (!grid.has(key)) grid.set(key, p);
        }
        return Array.from(grid.values());
      }
      return out;
    })();
    // Keep a stable snapshot for later real-time intersection updates without feedback amplification.
    // Then recompute live intersections (lines/segments vs curves etc.) from the snapshot.
    set({ intersections: clustered, functionIntersections: clustered });
    // Ensure straight-line intersections are computed by the real-time path (avoids discretization floods here).
    try { get().updateIntersectionsWithPoints(); } catch { }

    console.log('Converted to segments:', {
      explicit: explicitFns.length,
      implicit: implicitFns.length,
      polylines: allPolylines.length,
      specialPoints: clustered.length
    });
    // Restore suppressHistory only if it wasn't suppressed before
    // This allows callers to batch function addition + segment conversion
    if (!wasSuppressed) {
      set({ suppressHistory: false });
    }
  },
  allocateFunctionSymbol: () => {
    const s = get();
    const symbols = 'fghijklmnopqrstuvwxyz'; // avoid a,b,c reserved for points later
    const used = new Set<string>();
    Object.values(s.scene.nodes).forEach((n: any) => {
      if ((n.kind === 'function-explicit' || n.kind === 'function-implicit') && n.symbol) {
        used.add(n.symbol);
      }
    });
    // Always pick the first unused from the start (f → g → h ...)
    for (let i = 0; i < symbols.length; i++) {
      const ch = symbols[i];
      if (!used.has(ch)) {
        // Keep nextSymbolIndex for potential future strategies
        set({ nextSymbolIndex: i + 1 });
        return ch;
      }
    }
    // fallback when all taken
    const fallback = `f${Math.floor(Math.random() * 1000)}`;
    return fallback;
  },
  undo: () => {
    const s = get();
    if (!s.undoStack.length) return;
    const prev = s.undoStack[s.undoStack.length - 1];
    const current = deepCloneSnapshot({ scene: s.scene, selectedIds: s.selectedIds, nextSymbolIndex: s.nextSymbolIndex });
    set({ suppressHistory: true });
    // Restore previous state but keep current view (zoom/pan)
    const currentView = s.scene.view;
    set({ scene: { ...prev.scene, view: currentView }, selectedIds: prev.selectedIds, nextSymbolIndex: prev.nextSymbolIndex });
    set((curr) => ({ suppressHistory: false, undoStack: curr.undoStack.slice(0, curr.undoStack.length - 1), redoStack: [...curr.redoStack, current] }));
  },
  redo: () => {
    const s = get();
    if (!s.redoStack.length) return;
    const next = s.redoStack[s.redoStack.length - 1];
    const current = deepCloneSnapshot({ scene: s.scene, selectedIds: s.selectedIds, nextSymbolIndex: s.nextSymbolIndex });
    set({ suppressHistory: true });
    // Restore next state but keep current view (zoom/pan)
    const currentView = s.scene.view;
    set({ scene: { ...next.scene, view: currentView }, selectedIds: next.selectedIds, nextSymbolIndex: next.nextSymbolIndex });
    set((curr) => ({ suppressHistory: false, redoStack: curr.redoStack.slice(0, curr.redoStack.length - 1), undoStack: [...curr.undoStack, current] }));
  }
  ,
  resetScene: () => {
    // Hard reset: restore initial axes, clear nodes/history/selection but keep DPR
    const freshScene: Scene = {
      id: generateStableId('scene'),
      nodes: createDefaultAxes(),
      zIndex: {},
      view: { scale: 1, rotation: 0, translate: { x: 0, y: 0 }, yScale: 1, magnification: 1 },
    } as any;
    set({
      scene: freshScene,
      currentTool: 'select',
      selectedIds: [],
      hoveredId: null,
      hoveredIntersection: null,
      currentMousePos: null,
      isInteracting: false,
      nextSymbolIndex: 0,
      twoPointFirstClick: null,
      twoPointAngleFirstSegment: null,
      twoPointAngleFirstClickPos: null,
      intersections: [],
      functionIntersections: [],
      undoStack: [],
      redoStack: [],
      suppressHistory: false,
      pendingInteractionSnapshot: null,
      hasPendingInteractionChange: false,
      agentDrawingPending: false,
    } as any);
  },
  saveCurrentGraph: async (name: string, thumbnail?: string) => {
    const state = get();
    const nickname = localStorage.getItem('alphacanvas_nickname') || undefined;

    // 썸네일이 제공되지 않으면 자동 생성
    let finalThumbnail = thumbnail;
    if (!finalThumbnail) {
      try {
        // 고해상도로 SVG 생성 (썸네일용 - SVG 내보내기와 동일한 설정)
        const svg = await sceneToSVG(state.scene, {
          viewportPx: { width: 1000, height: 1000 }, // 썸네일 크기
          clipToView: true,
          padding: 0,
          includeLabels: true,
          fitToContent: true,
          physicalCanvasMm: 100
        });

        // SVG를 base64로 인코딩
        finalThumbnail = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
      } catch (error) {
        console.warn('썸네일 생성 실패:', error);
        // 썸네일 생성 실패해도 저장은 진행
      }
    }

    const graphId = await saveGraph(name, state.scene, finalThumbnail, nickname);
    return graphId;
  },
  loadGraphById: async (id: string) => {
    const graph = await loadGraph(id);
    if (!graph) return false;

    const state = get();
    // 현재 view는 유지하고 나머지만 복원
    const currentView = state.scene.view;

    set({
      scene: { ...graph.scene, view: currentView },
      selectedIds: [],
      hoveredId: null,
      hoveredIntersection: null,
      currentMousePos: null,
      isInteracting: false,
      twoPointFirstClick: null,
      twoPointAngleFirstSegment: null,
      twoPointAngleFirstClickPos: null,
      functionIntersections: [],
      // 히스토리는 초기화
      undoStack: [],
      redoStack: [],
      suppressHistory: false,
      pendingInteractionSnapshot: null,
      hasPendingInteractionChange: false,
    });

    // intersections 업데이트
    get().updateIntersectionsWithPoints();

    return true;
  },
  setAgentDrawingPending: (pending) => set({ agentDrawingPending: pending })
}));

// store 생성 이후 자동 저장 설정 (throttle)
try {
  if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    let timer: any = null;
    useSceneStore.subscribe((state, prev) => {
      if (state.scene === prev.scene) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          localStorage.setItem(LAST_SCENE_STORAGE_KEY, JSON.stringify(state.scene));
        } catch { }
      }, 250);
    });
  }
} catch {
  // ignore
}


