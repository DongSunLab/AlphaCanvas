import { useEffect, useRef } from 'react';
import * as PIXI from 'pixi.js';
import { useSceneStore } from '../state/store';
import type { BezierSegmentNode, LineSegmentNode, SceneNode, AxisNode, ExplicitFunctionNode, ImplicitFunctionNode, SegmentNode, Vec2, PointNode, FilledRegionNode } from '../shared/types';
import { useD3Zoom } from '../interaction/useD3Zoom';
import { PointerOverlay } from './PointerOverlay';
import { MathLabels } from './MathLabels';
import { SegmentControls } from './SegmentControls';
import { BezierControls } from './BezierControls';
import { ArrowControls } from './ArrowControls';
import { MathTextOverlay } from './MathTextOverlay';
import { sampleExplicitWithRegistry, marchingSquaresSegmentsWithRegistry, computeAdaptiveResolution, buildFunctionRegistry, findExplicitVerticalBreaks, connectSegmentsToPolylines } from '../geometry/mathEval';
import { computeDashedPolyline } from '../geometry/dash';
import { clipPolylineToRect, extendPolylineToRect } from '../geometry/clip';

// Filled region polygon cache to avoid expensive recomputation on every view change
const filledRegionPolygonCache = new Map<string, Array<{ x: number; y: number }>>();
const filledRegionBoundariesCache = new Map<string, Array<{ start: Vec2; end: Vec2 }>>();
let lastInteractingForRegionCache = false;
let lastNodesRefForFilledRegion: Record<string, SceneNode> | null = null;

// Export cache for hit testing
export function getFilledRegionPolygon(regionId: string, yScale: number): Array<{ x: number; y: number }> | null {
  const cacheKey = `${regionId}|${yScale.toFixed(3)}`;
  return filledRegionPolygonCache.get(cacheKey) || null;
}

// Function registry and polyline caches to avoid resampling on every pan/zoom
let lastNodesRefForRegistry: Record<string, SceneNode> | null = null;
let cachedRegistry: any = null;
let lastNodesRefForPolylineCaches: Record<string, SceneNode> | null = null;
const explicitFunctionPolylineCache = new Map<string, Array<{ x: number; y: number }[]>>();
const implicitFunctionPolylineCache = new Map<string, Array<{ x: number; y: number }[]>>();
const makeClipKey = (b: { xMin: number; xMax: number; yMin: number; yMax: number } | null) => {
  if (!b) return 'none';
  // Use 0.5 unit buckets instead of 1.0 to make cache more responsive to axis dragging
  return `${(Math.round(b.xMin * 2) / 2).toFixed(1)}|${(Math.round(b.xMax * 2) / 2).toFixed(1)}|${(Math.round(b.yMin * 2) / 2).toFixed(1)}|${(Math.round(b.yMax * 2) / 2).toFixed(1)}`;
};
const scaleBucket = (s: number) => Math.max(0.001, Math.round(s * 10) / 10); // 0.1 단위 버킷팅

export function PixiStage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dpr = useSceneStore((s) => s.dpr);

  // D3 zoom on overlay (top layer) - pass ref object, not current
  useD3Zoom(overlayRef);

  // PIXI app lifecycle
  useEffect(() => {
    if (!containerRef.current) return;
    let app: PIXI.Application | null = null;
    let mounted = true;
    let unsubscribe: (() => void) | null = null;
    let onKeyHandler: ((e: KeyboardEvent) => void) | null = null;

    (async () => {
      try {
        const newApp = new PIXI.Application();

        // Get container dimensions (should be square)
        const container = containerRef.current;
        if (!container) return;

        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;
        const size = Math.min(containerWidth, containerHeight);

        await newApp.init({
          antialias: true,
          resolution: dpr,
          autoDensity: true,
          backgroundAlpha: 0,
          width: size,
          height: size,
          resizeTo: container
        });

        if (!mounted || !containerRef.current) {
          newApp.destroy(true);
          return;
        }

        app = newApp;
        containerRef.current.appendChild(app.canvas);
        (app.canvas as HTMLCanvasElement).style.pointerEvents = 'none';

        const graphics = new PIXI.Graphics();
        app.stage.addChild(graphics);

        // Render function
        const render = () => {
          if (!app || !mounted) return;
          const state = useSceneStore.getState();
          graphics.clear();
          const { scale, rotation, translate, yScale = 1, magnification = 1 } = state.scene.view;
          // Pixi v8: prefer explicit properties over setTransform
          // Flip y-axis for mathematical coordinate system (y increases upward)
          graphics.position.set(translate.x, translate.y);
          graphics.scale.set(scale, -scale);  // Don't apply yScale here
          graphics.rotation = rotation;

          // Pass current scale, yScale, and magnification to drawing functions
          // drawScale = scale / magnification: magnification > 1 makes lines thicker (real zoom effect)
          const drawScale = scale / magnification;
          const drawYScale = yScale;
          const hoveredBezierAnchorId = state.hoveredBezierAnchorId;
          const hoveredAxisAnchorId = state.hoveredAxisAnchorId;

          const ordered: SceneNode[] = Object.values(state.scene.nodes).sort((a, b) => {
            const za = state.scene.zIndex[a.id] ?? 0;
            const zb = state.scene.zIndex[b.id] ?? 0;
            return za - zb;
          });
          // Build set of explicit function IDs that already have segments; skip drawing those functions
          // (implicit functions always draw their curves directly, segments are for editing only)
          const functionIdsWithSegments = new Set<string>();
          for (const n of Object.values(state.scene.nodes) as any[]) {
            if (n && n.kind === 'segment' && n.functionId) {
              const fn = state.scene.nodes[n.functionId] as any;
              if (fn && fn.kind === 'function-explicit') {
                functionIdsWithSegments.add(n.functionId);
              }
            }
          }
          // Invalidate function caches when node graph changes (reference compare)
          if (lastNodesRefForPolylineCaches !== state.scene.nodes) {
            explicitFunctionPolylineCache.clear();
            implicitFunctionPolylineCache.clear();
            lastNodesRefForPolylineCaches = state.scene.nodes as any;
          }

          // Build function registry only when nodes change; exclude preview nodes
          let registry = cachedRegistry;
          if (lastNodesRefForRegistry !== state.scene.nodes) {
            const nonPreviewNodes: Record<string, SceneNode> = {};
            for (const [id, node] of Object.entries(state.scene.nodes)) {
              if (!(node as any).isPreview) nonPreviewNodes[id] = node;
            }
            registry = buildFunctionRegistry(nonPreviewNodes);
            cachedRegistry = registry;
            lastNodesRefForRegistry = state.scene.nodes as any;
          }
          const isInteracting = useSceneStore.getState().isInteracting;
          // Invalidate filled-region cache when nodes change (geometry changed)
          if (lastNodesRefForFilledRegion !== state.scene.nodes) {
            filledRegionPolygonCache.clear();
            filledRegionBoundariesCache.clear();
            lastNodesRefForFilledRegion = state.scene.nodes as any;
          }
          // Invalidate filled-region cache when interaction ends (geometry may have changed)
          if (lastInteractingForRegionCache && !isInteracting) {
            filledRegionPolygonCache.clear();
            filledRegionBoundariesCache.clear();
          }
          lastInteractingForRegionCache = isInteracting;
          // Compute current view bounds (world coords), then intersect with axis bounds
          const canvasEl = app.canvas as HTMLCanvasElement;
          const canvasWidth = canvasEl.width / dpr;
          const canvasHeight = canvasEl.height / dpr;
          const viewBounds = getViewWorldBounds(state.scene.view, canvasWidth, canvasHeight);
          const axesBounds = calculateClipBounds(state.scene.nodes);
          const clipBoundsRaw = axesBounds ? intersectBounds(viewBounds, axesBounds) : viewBounds;
          // NOTE:
          // - 축 클리핑 경계가 너무 타이트하면(0px) 스트로크/안티앨리어싱 때문에 살짝 잘려 보일 수 있음
          // - 반대로 패딩이 크면(기존 8px) 커스텀 축 끝을 넘어 곡선이 "튀어나와" 보임
          // - 아주 작은 화면 기준 패딩(0.5px)만 적용해서 축과 칼같이 끊기게 함
          const clipPadPx = 0.0;
          const padWorldX = clipPadPx / Math.max(1e-6, drawScale);
          const padWorldY = clipPadPx / Math.max(1e-6, drawScale * drawYScale);
          const clipBounds = (clipBoundsRaw ? {
            xMin: clipBoundsRaw.xMin - padWorldX,
            xMax: clipBoundsRaw.xMax + padWorldX,
            yMin: clipBoundsRaw.yMin - padWorldY,
            yMax: clipBoundsRaw.yMax + padWorldY,
          } : viewBounds);

          const selected = state.selectedIds;
          const hovered = state.hoveredId;
          const currentTool = state.currentTool;
          const twoPointAngleFirstSegment = state.twoPointAngleFirstSegment;

          // Collect all axis and segment anchor IDs to skip drawing them
          // Exception: show anchors for selected two-point segments (segments without functionId)
          const hiddenAnchorIds = new Set<string>();
          const selectedSegmentAnchorIds = new Set<string>();

          Object.values(state.scene.nodes).forEach((node: any) => {
            if (node.kind === 'axis') {
              hiddenAnchorIds.add(node.originId);
              hiddenAnchorIds.add(node.endpointId);
            } else if (node.kind === 'segment') {
              // Check if this is a selected two-point segment (no functionId)
              const isSelected = selected.includes(node.id);
              const isTwoPointSegment = !node.functionId;

              if (isSelected && isTwoPointSegment) {
                // Don't hide anchors for selected two-point segments
                selectedSegmentAnchorIds.add(node.startAnchorId);
                selectedSegmentAnchorIds.add(node.endAnchorId);
              } else {
                // Hide anchors for all other segments
                hiddenAnchorIds.add(node.startAnchorId);
                hiddenAnchorIds.add(node.endAnchorId);
              }
            }
          });

          for (const node of ordered) {
            const isSelected = selected.includes(node.id);
            // Highlight first segment in angle mode
            const isAngleFirstSegment = currentTool === 'two-point-angle' && node.id === twoPointAngleFirstSegment;
            const shouldHighlight = isSelected || node.id === hovered || isAngleFirstSegment;

            // Skip anchors and points - they will be drawn last to always be on top
            if (node.kind === 'anchor' || node.kind === 'point') continue;

            if (node.kind === 'filled-region') drawFilledRegion(graphics, node as FilledRegionNode, state.scene.nodes, clipBounds, drawScale, drawYScale);
            else if (node.kind === 'angle') drawAngle(graphics, node as any, state.scene.nodes, drawScale, drawYScale, shouldHighlight);
            else if (node.kind === 'line') drawLine(graphics, node as LineSegmentNode, state.scene.nodes, drawScale, drawYScale);
            else if (node.kind === 'bezier') drawBezier(graphics, node as BezierSegmentNode, state.scene.nodes, drawScale, drawYScale, shouldHighlight, hoveredBezierAnchorId);
            else if (node.kind === 'arrow') drawArrow(graphics, node as any, state.scene.nodes, drawScale, drawYScale, shouldHighlight, hoveredBezierAnchorId);
            else if (node.kind === 'axis') {
              const axis = node as AxisNode;
              // Always draw axis, but with different opacity
              const isVisible = (axis as any).visible !== false;
              drawAxis(graphics, axis, state.scene.nodes, drawScale, isVisible, drawYScale);
            }
            else if (node.kind === 'segment') drawSegment(graphics, node as any, state.scene.nodes, shouldHighlight, drawScale, drawYScale, clipBounds);
            else if (node.kind === 'function-explicit') {
              if (!(node as any).segmentsOnly && !functionIdsWithSegments.has(node.id)) {
                try {
                  // 노드에 포함된 functionRegistry를 우선 사용 (미리보기용)
                  const fnRegistry = (node as any).functionRegistry || registry;
                  drawExplicitFunction(graphics, node as ExplicitFunctionNode, drawScale, clipBounds, fnRegistry, isInteracting, drawYScale);
                } catch (err) {
                  // Silently skip invalid functions (wrong arity, undefined symbols, etc)
                  // This prevents infinite render loops from malformed expressions
                }
              }
            }
            else if (node.kind === 'function-implicit') {
              // implicit: 세그먼트가 있으면 세그먼트만 그리고, 없으면 원본 곡선 그리기
              const hasSegments = Object.values(state.scene.nodes).some((n: any) =>
                n && n.kind === 'segment' && n.functionId === node.id && !n.hidden
              );
              if (!hasSegments) {
                try {
                  // 세그먼트가 없으면 원본 곡선 그리기
                  // 노드에 포함된 functionRegistry를 우선 사용 (미리보기용)
                  const fnRegistry = (node as any).functionRegistry || registry;
                  drawImplicitFunction(graphics, node as ImplicitFunctionNode, drawScale, clipBounds, fnRegistry, isInteracting, drawYScale);
                } catch (err) {
                  // Silently skip invalid functions
                }
              }
              // 세그먼트가 있으면 drawSegment에서 그려짐
            }
          }

          // Draw all anchors and points last so they're always on top
          for (const node of ordered) {
            if (node.kind === 'anchor') {
              // Draw anchors for selected two-point segments (same style as intersection points)
              if (selectedSegmentAnchorIds.has(node.id)) {
                const anchorNode = node as any;
                const isHovered = node.id === hovered;

                // Same size as intersection points: 3.2mm diameter
                const sizeMm = 3.2;
                const radiusWorld = mmToWorld(sizeMm, drawScale) / 2;

                if (isHovered) {
                  // Cherry blossom color on hover (same as intersection points)
                  drawSmoothCircle(graphics, anchorNode.position.x, anchorNode.position.y * drawYScale, radiusWorld);
                  graphics.fill({ color: 0xdc143c, alpha: 0.7 });
                } else {
                  // Blue semi-transparent (same as intersection points)
                  drawSmoothCircle(graphics, anchorNode.position.x, anchorNode.position.y * drawYScale, radiusWorld);
                  graphics.fill({ color: 0x0064c8, alpha: 0.47 });
                }
              }

              // Draw hovered axis anchors in yellow
              if (hoveredAxisAnchorId && node.id === hoveredAxisAnchorId) {
                const anchorNode = node as any;

                // Slightly larger than intersection points for visibility
                const sizeMm = 3.5;
                const radiusWorld = mmToWorld(sizeMm, drawScale) / 2;

                // Yellow color for hover
                drawSmoothCircle(graphics, anchorNode.position.x, anchorNode.position.y * drawYScale, radiusWorld);
                graphics.fill({ color: 0xFFD700, alpha: 0.9 });
              }
            }
            else if (node.kind === 'point') {
              const isHovered = node.id === hovered;
              drawPoint(graphics, node as PointNode, drawScale, drawYScale, isHovered);
            }
          }

          // Draw preview angle arc in angle mode
          const twoPointAngleFirstClickPos = state.twoPointAngleFirstClickPos;
          const currentMousePos = state.currentMousePos;
          if (currentTool === 'two-point-angle' && twoPointAngleFirstSegment && hovered && hovered !== twoPointAngleFirstSegment) {
            const item1 = state.scene.nodes[twoPointAngleFirstSegment] as any;
            const item2 = state.scene.nodes[hovered] as any;
            if (item1 && item2 && (item1.kind === 'segment' || item1.kind === 'axis') && (item2.kind === 'segment' || item2.kind === 'axis')) {
              // Draw preview angle with semi-transparent style
              const previewAngle = {
                segment1Id: twoPointAngleFirstSegment,
                segment2Id: hovered,
                segment1ClickPos: twoPointAngleFirstClickPos,
                segment2ClickPos: currentMousePos, // Use current mouse position for preview
                isLargeAngle: false,
                isRightAngle: false,
                arcRadiusPt: 20,
                style: { stroke: { color: '#2196F3', width: 0.35 } }
              };
              drawAngle(graphics, previewAngle, state.scene.nodes, drawScale, drawYScale, false, 0.5);
            }
          }

          // Render intersection points (3.3.8 style) - only in drawing modes or when dragging non-axis anchors
          // Hide intersections when dragging math labels
          // Hide intersections in paint, magnifier, and angle modes
          const isInHiddenMode = currentTool === 'paint' || currentTool === 'magnifier' || currentTool === 'two-point-angle';
          const showIntersections = ((currentTool !== 'select' && currentTool !== 'pan') || isInteracting) && !state.isDraggingAxisAnchor && state.draggingNodeType !== 'math-text' && !isInHiddenMode;

          if (showIntersections) {
            const intersections = state.intersections || [];
            const hoveredIntersection = state.hoveredIntersection;
            for (const pt of intersections) {
              const isHovered = !!(hoveredIntersection &&
                Math.abs(hoveredIntersection.x - pt.x) < 1e-6 &&
                Math.abs(hoveredIntersection.y - pt.y) < 1e-6);
              drawIntersectionPoint(graphics, pt, drawScale, isHovered, drawYScale);
            }
          }

          // Ensure the stage is presented to the canvas immediately
          app.render();
        };

        // Subscribe to scene changes and trigger render
        // Throttle renders to animation frame and remove dev console spam
        let pending = false;
        const requestRender = () => {
          if (pending) return;
          pending = true;
          requestAnimationFrame(() => {
            pending = false;
            render();
          });
        };
        unsubscribe = useSceneStore.subscribe(() => {
          if (!app || !mounted) return;
          requestRender();
        });

        // Fit-to-content on 'f' key
        const onKey = (e: KeyboardEvent) => {
          if (!app || !mounted) return;
          // Do not intercept when typing in inputs or math editors
          const target = e.target as HTMLElement | null;
          const active = (document.activeElement as HTMLElement | null);
          const isEditable = (el: HTMLElement | null | undefined) => !!el && (
            el.tagName === 'INPUT' ||
            el.tagName === 'TEXTAREA' ||
            el.getAttribute('contenteditable') === 'true' ||
            !!el.closest?.('math-field') ||
            el.tagName === 'MATH-FIELD'
          );
          if (isEditable(target) || isEditable(active)) return;
          if (e.key.toLowerCase() !== 'f') return;
          const stateNow = useSceneStore.getState();
          const nodes = stateNow.scene.nodes as any;
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          const includePoint = (x: number, y: number) => {
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          };
          for (const n of Object.values(nodes) as any[]) {
            if (!n) continue;
            if (n.kind === 'anchor') includePoint(n.position.x, n.position.y);
            else if (n.kind === 'segment' && n.samples?.length) {
              for (const p of n.samples) includePoint(p.x, p.y);
            } else if (n.kind === 'line' || n.kind === 'bezier' || n.kind === 'arrow') {
              // anchors referenced by ids
              const ids = n.kind === 'line' ? [n.a, n.b] : [n.a, n.b, n.c1, n.c2];
              for (const id of ids) {
                const a = nodes[id];
                if (a && a.kind === 'anchor') includePoint(a.position.x, a.position.y);
              }
            }
          }
          if (!(isFinite(minX) && isFinite(minY) && isFinite(maxX) && isFinite(maxY))) {
            // fallback to default bounds
            minX = -8; maxX = 8; minY = -8; maxY = 8;
          }
          // Avoid zero-size
          if (maxX - minX < 1e-6) { minX -= 1; maxX += 1; }
          if (maxY - minY < 1e-6) { minY -= 1; maxY += 1; }

          const canvas = app.canvas as HTMLCanvasElement;
          const canvasWidth = canvas.width / dpr;
          const canvasHeight = canvas.height / dpr;
          const padPx = 40;
          const worldW = maxX - minX;
          const worldH = maxY - minY;
          const scaleX = (canvasWidth - 2 * padPx) / worldW;
          const scaleY = (canvasHeight - 2 * padPx) / worldH;
          const newScale = Math.max(0.0001, Math.min(scaleX, scaleY));
          const cx = 0.5 * (minX + maxX);
          const cy = 0.5 * (minY + maxY);
          const tx = canvasWidth / 2 - cx * newScale;
          const ty = canvasHeight / 2 + cy * newScale; // y flipped in rendering
          useSceneStore.getState().setView({ scale: newScale, rotation: 0, translate: { x: tx, y: ty } });
          e.preventDefault();
        };
        window.addEventListener('keydown', onKey as any, { capture: true } as any);
        onKeyHandler = onKey;

        // Initial view is set centrally by App.tsx setDefaultView; do not override here

        // Initial render
        render();
        // console.debug('PixiJS ready, initial render done');
      } catch (err) {
        console.error('PixiJS initialization error:', err);
      }
    })();

    return () => {
      mounted = false;
      if (unsubscribe) unsubscribe();
      if (onKeyHandler) window.removeEventListener('keydown', onKeyHandler as any, { capture: true } as any);
      if (app) app.destroy(true);
    };
  }, [dpr]);

  return (
    <div ref={containerRef} style={{
      width: '100%',
      height: '100%',
      position: 'relative',
      overflow: 'visible'
    }}>
      <PointerOverlay overlayRef={overlayRef} />
      <MathLabels />
      <MathTextOverlay />
      <SegmentControls />
      <BezierControls />
      <ArrowControls />
    </div>
  );
}
// Convert physical millimeters to world units so that diameter is scale-independent on screen
function mmToWorld(mm: number, scale: number): number {
  // CSS pixel assumed at 96 DPI => 1 inch = 96 px
  // 1 inch = 25.4 mm; diameter in px = (mm / 25.4) * 96 * dpr
  // world units = px / scale
  const px = (mm / 25.4) * 96;
  return px / Math.max(1e-6, scale);
}

function drawPoint(g: PIXI.Graphics, node: PointNode, scale: number, yScale: number = 1, isHovered: boolean = false) {
  const diameterMm = node.diameterMm ?? 2.3;
  const color = new PIXI.Color(node.color ?? '#000000').toNumber();
  const radiusWorld = mmToWorld(diameterMm, scale) / 2;

  // Draw hover effect (larger, semi-transparent circle behind)
  if (isHovered) {
    const hoverRadius = radiusWorld * 2.2;
    drawSmoothCircle(g, node.position.x, node.position.y * yScale, hoverRadius);
    g.fill({ color: 0x2196F3, alpha: 0.45 });
  }

  // Draw main point with smooth circle
  drawSmoothCircle(g, node.position.x, node.position.y * yScale, radiusWorld);
  g.fill(color);

  // Draw stroke if specified
  if (node.strokeColor && node.strokeWidth) {
    const strokeColor = new PIXI.Color(node.strokeColor).toNumber();
    const strokeWidthPt = node.strokeWidth;
    const strokeWidthWorld = (strokeWidthPt * (96 / 72) * 2.2) / scale;
    drawSmoothCircle(g, node.position.x, node.position.y * yScale, radiusWorld);
    g.stroke({ width: strokeWidthWorld, color: strokeColor });
  }
}

// Helper function to draw smooth circles with many segments
function drawSmoothCircle(g: PIXI.Graphics, x: number, y: number, radius: number) {
  const segments = 64; // Use 64 segments for perfectly smooth circles
  g.moveTo(x + radius, y);
  for (let i = 1; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    g.lineTo(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
  }
  g.closePath();
}

// Draw intersection point (3.3.8 style: blue semi-transparent circle, cherry blossom on hover)
// Note: scale parameter is actually drawScale (scale / magnification) for magnification support
function drawIntersectionPoint(g: PIXI.Graphics, pt: Vec2, scale: number, isHovered: boolean, yScale: number = 1) {
  const sizeMm = 3.2; // doubled diameter (was 2.4mm)
  const radiusWorld = mmToWorld(sizeMm, scale) / 2; // Convert mm to world units (scale is already drawScale)

  if (isHovered) {
    // Cherry blossom color (rgb(220, 20, 60) with 70% alpha)
    drawSmoothCircle(g, pt.x, pt.y * yScale, radiusWorld);
    g.fill({ color: 0xdc143c, alpha: 0.7 });
  } else {
    // Blue semi-transparent (rgb(0, 100, 200) with 47% alpha)
    drawSmoothCircle(g, pt.x, pt.y * yScale, radiusWorld);
    g.fill({ color: 0x0064c8, alpha: 0.47 });
  }
}

// Calculate clip bounds from all axes (regardless of visible state)
function calculateClipBounds(nodes: Record<string, SceneNode>): { xMin: number; xMax: number; yMin: number; yMax: number } | null {
  const axes = Object.values(nodes).filter((n: any) => n.kind === 'axis') as any[];

  if (axes.length === 0) return null;

  let xMin = -Infinity, xMax = Infinity, yMin = -Infinity, yMax = Infinity;

  for (const axis of axes) {
    const origin = nodes[axis.originId] as any;
    const endpoint = nodes[axis.endpointId] as any;

    if (!origin || !endpoint) continue;

    // Prefer explicit axis naming for robust bounds (dragging can make axes slightly diagonal).
    // Fallback to geometric heuristic for legacy/unnamed axes.
    const axisName = (axis as any).name;
    const isX = axisName === 'X';
    const isY = axisName === 'Y';
    if (isX) {
      xMin = Math.max(xMin, Math.min(origin.position.x, endpoint.position.x));
      xMax = Math.min(xMax, Math.max(origin.position.x, endpoint.position.x));
    } else if (isY) {
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

  // Only return bounds if at least one axis constrains each dimension
  if (xMin === -Infinity) xMin = -1000;
  if (xMax === Infinity) xMax = 1000;
  if (yMin === -Infinity) yMin = -1000;
  if (yMax === Infinity) yMax = 1000;

  return { xMin, xMax, yMin, yMax };
}

// Viewport world bounds from view
function getViewWorldBounds(view: { scale: number; translate: Vec2; rotation: number; yScale?: number }, canvasW: number, canvasH: number) {
  // Inverse transform of screen rect corners to world (rotation assumed small/0)
  const s = view.scale;
  const tx = view.translate.x;
  const ty = view.translate.y;
  const ys = view.yScale ?? 1; // Account for yScale in bounds calculation
  const xMin = (0 - tx) / s;
  const xMax = (canvasW - tx) / s;
  // Flip Y: screen y increases downward; world y increases upward
  // When yScale != 1, the effective screen scaling in Y is scale * yScale
  const yMax = (0 - ty) / (-s * ys);
  const yMin = (canvasH - ty) / (-s * ys);
  // add a small margin to avoid popping at edges
  const pad = 0.5 * (1 / Math.max(1, s));
  return { xMin: xMin - pad, xMax: xMax + pad, yMin: yMin - pad, yMax: yMax + pad };
}

function intersectBounds(a: { xMin: number; xMax: number; yMin: number; yMax: number } | null, b: { xMin: number; xMax: number; yMin: number; yMax: number } | null) {
  if (!a) return b;
  if (!b) return a;
  return {
    xMin: Math.max(a.xMin, b.xMin),
    xMax: Math.min(a.xMax, b.xMax),
    yMin: Math.max(a.yMin, b.yMin),
    yMax: Math.min(a.yMax, b.yMax),
  };
}

function drawLine(g: PIXI.Graphics, seg: LineSegmentNode, nodes: Record<string, SceneNode>, scale: number, yScale: number = 1) {
  const a = nodes[seg.a];
  const b = nodes[seg.b];
  if (!a || !b || a.kind !== 'anchor' || b.kind !== 'anchor') {
    console.warn('drawLine: invalid anchors', seg.id);
    return;
  }
  const stroke = seg.style?.stroke ?? { color: '#000000', width: 0.8 };
  const color = new PIXI.Color(stroke.color).toNumber();

  // Force axis thickness = 0.35pt with slight on-screen compensation
  const width = (0.35 * (96 / 72) * 2.2) / scale;

  // Get math label clip regions and clip the line
  const mathLabelClipRegions = useSceneStore.getState().mathLabelClipRegions;
  const state = useSceneStore.getState();

  // Convert to screen space for clipping
  const ox = a.position.x * scale + state.scene.view.translate.x;
  const oy = a.position.y * yScale * scale + state.scene.view.translate.y;
  const ex = b.position.x * scale + state.scene.view.translate.x;
  const ey = b.position.y * yScale * scale + state.scene.view.translate.y;

  // Find intersection intervals with clip regions (same logic as drawAxis)
  const clipIntervals: Array<{ t1: number; t2: number }> = [];

  for (const region of mathLabelClipRegions) {
    const halfW = region.width / 2;
    const halfH = region.height / 2;
    const left = region.screenX - halfW;
    const right = region.screenX + halfW;
    const top = region.screenY - halfH;
    const bottom = region.screenY + halfH;

    const dx = ex - ox;
    const dy = ey - oy;

    let tMin = 0;
    let tMax = 1;

    if (dx !== 0) {
      const t1 = (left - ox) / dx;
      const t2 = (right - ox) / dx;
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
    } else if (ox < left || ox > right) {
      continue;
    }

    if (dy !== 0) {
      const t1 = (top - oy) / dy;
      const t2 = (bottom - oy) / dy;
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
    } else if (oy < top || oy > bottom) {
      continue;
    }

    if (tMin <= tMax && tMax >= 0 && tMin <= 1) {
      clipIntervals.push({ t1: Math.max(0, tMin), t2: Math.min(1, tMax) });
    }
  }

  // Merge overlapping intervals
  clipIntervals.sort((a, b) => a.t1 - b.t1);
  const mergedIntervals: Array<{ t1: number; t2: number }> = [];
  for (const interval of clipIntervals) {
    if (mergedIntervals.length === 0 || mergedIntervals[mergedIntervals.length - 1].t2 < interval.t1) {
      mergedIntervals.push(interval);
    } else {
      mergedIntervals[mergedIntervals.length - 1].t2 = Math.max(mergedIntervals[mergedIntervals.length - 1].t2, interval.t2);
    }
  }

  // Draw line segments avoiding clip regions
  let currentT = 0;
  for (const clip of mergedIntervals) {
    if (currentT < clip.t1) {
      const x1 = a.position.x + (b.position.x - a.position.x) * currentT;
      const y1 = a.position.y + (b.position.y - a.position.y) * currentT;
      const x2 = a.position.x + (b.position.x - a.position.x) * clip.t1;
      const y2 = a.position.y + (b.position.y - a.position.y) * clip.t1;
      g.moveTo(x1, y1 * yScale);
      g.lineTo(x2, y2 * yScale);
      g.stroke({ width, color });
    }
    currentT = clip.t2;
  }

  if (currentT < 1) {
    const x1 = a.position.x + (b.position.x - a.position.x) * currentT;
    const y1 = a.position.y + (b.position.y - a.position.y) * currentT;
    g.moveTo(x1, y1 * yScale);
    g.lineTo(b.position.x, b.position.y * yScale);
    g.stroke({ width, color });
  }

  // debug log removed for performance
}

function drawBezier(g: PIXI.Graphics, seg: BezierSegmentNode, nodes: Record<string, SceneNode>, scale: number, yScale: number = 1, isSelectedOrHovered: boolean = false, hoveredBezierAnchorId: string | null = null) {
  const a = nodes[seg.a];
  const b = nodes[seg.b];
  const c1 = nodes[seg.c1];
  const c2 = nodes[seg.c2];
  if (!a || !b || !c1 || !c2) return;
  if (a.kind !== 'anchor' || b.kind !== 'anchor' || c1.kind !== 'anchor' || c2.kind !== 'anchor') return;

  // Draw anchor-handle dashed lines when selected (blue color)
  if (isSelectedOrHovered) {
    const handleLineColor = 0x2196F3; // Blue
    const handleLineWidth = 1.5 / scale;
    const dashLength = 8 / scale;
    const gapLength = 4 / scale;

    // Draw dashed line from a to c1
    drawDashedLine(g, a.position.x, a.position.y * yScale, c1.position.x, c1.position.y * yScale, handleLineWidth, handleLineColor, dashLength, gapLength);

    // Draw dashed line from b to c2
    drawDashedLine(g, b.position.x, b.position.y * yScale, c2.position.x, c2.position.y * yScale, handleLineWidth, handleLineColor, dashLength, gapLength);

    // Draw anchors and handles (same size as intersection points: 3.2mm)
    const sizeMm = 3.2;
    const radiusWorld = mmToWorld(sizeMm, scale) / 2;

    // Draw all 4 anchor/handle points
    const anchorPoints = [
      { id: seg.a, pos: a.position },
      { id: seg.b, pos: b.position },
      { id: seg.c1, pos: c1.position },
      { id: seg.c2, pos: c2.position }
    ];

    for (const anchor of anchorPoints) {
      const isHovered = hoveredBezierAnchorId === anchor.id;

      drawSmoothCircle(g, anchor.pos.x, anchor.pos.y * yScale, radiusWorld);
      if (isHovered) {
        // Yellow on hover (rgb(255, 215, 0) with 85% alpha)
        g.fill({ color: 0xFFD700, alpha: 0.85 });
      } else {
        // Blue semi-transparent (same as intersection points)
        g.fill({ color: 0x0064c8, alpha: 0.47 });
      }
    }
  }

  const stroke = seg.style?.stroke ?? { color: '#000000', width: 0.8 };
  const color = new PIXI.Color(stroke.color).toNumber();

  // Get math label clip regions
  const mathLabelClipRegions = useSceneStore.getState().mathLabelClipRegions;
  const state = useSceneStore.getState();

  // Helper: check if a point is inside any math label clip region
  const isInClipRegion = (worldX: number, worldY: number) => {
    const screenX = worldX * scale + state.scene.view.translate.x;
    // IMPORTANT: yScale affects screen-space Y (effective scale is scale * yScale)
    const screenY = -worldY * yScale * scale + state.scene.view.translate.y;

    for (const region of mathLabelClipRegions) {
      const halfW = region.width / 2;
      const halfH = region.height / 2;
      if (
        screenX >= region.screenX - halfW &&
        screenX <= region.screenX + halfW &&
        screenY >= region.screenY - halfH &&
        screenY <= region.screenY + halfH
      ) {
        return true;
      }
    }
    return false;
  };

  // 화면 픽셀 기준으로 충분히 부드럽게 보이도록 세그먼트 수 결정
  const pxPerWorld = scale; // pixels per unit
  const approxLen = Math.hypot(b.position.x - a.position.x, (b.position.y - a.position.y) * yScale);
  const approxPx = Math.max(1, approxLen * pxPerWorld);
  const steps = Math.min(256, Math.max(16, Math.round(approxPx / 6))); // 대략 6px당 한 점

  // Sample bezier curve points
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = cubicBlend(a.position.x, c1.position.x, c2.position.x, b.position.x, t);
    const y = cubicBlend(a.position.y, c1.position.y, c2.position.y, b.position.y, t);
    points.push({ x, y });
  }

  // Use stroke width from style or default
  const strokeWidth = stroke.width || 0.8;
  const baseWidth = (strokeWidth * (96 / 72) * 2.2) / scale;
  const width = isSelectedOrHovered ? baseWidth + 2 / scale : baseWidth;

  // Convert dash pattern from pt to px with on-screen compensation
  const dashPt = stroke.dash;
  const dash = (dashPt && dashPt.length > 0) ? dashPt.map((d: number) => d * (96 / 72) * 2.2) : undefined;

  // Apply dash pattern to entire curve FIRST (before clipping)
  let segments: Array<{ a: Vec2; b: Vec2 }>;
  if (dash && dash.length > 0) {
    // Convert entire curve to dashed segments
    segments = computeDashedPolyline(points, dash, scale, yScale);
  } else {
    // Convert to solid line segments
    segments = [];
    for (let i = 0; i < points.length - 1; i++) {
      segments.push({ a: points[i], b: points[i + 1] });
    }
  }

  // IMPORTANT:
  // Avoid calling g.stroke() for every tiny segment.
  // That makes the curve look "cut" when thick because each segment gets its own end-cap.
  // Instead, build a single path (or a few continuous subpaths) and stroke once.
  let didDraw = false;
  const EPS = 1e-6;
  let hasLastEnd = false;
  let lastEndX = 0;
  let lastEndY = 0;
  const addSegmentToPath = (p1: Vec2, p2: Vec2) => {
    if (!hasLastEnd || Math.hypot(p1.x - lastEndX, p1.y - lastEndY) > EPS) {
      g.moveTo(p1.x, p1.y * yScale);
    }
    g.lineTo(p2.x, p2.y * yScale);
    lastEndX = p2.x;
    lastEndY = p2.y;
    hasLastEnd = true;
    didDraw = true;
  };

  // Now filter segments by clip regions and draw each one
  for (const segment of segments) {
    const p1 = segment.a;
    const p2 = segment.b;

    // Check if both endpoints are in clip regions
    const p1InClip = isInClipRegion(p1.x, p1.y);
    const p2InClip = isInClipRegion(p2.x, p2.y);

    if (!p1InClip && !p2InClip) {
      // Both points outside clip - draw entire segment
      addSegmentToPath(p1, p2);
    } else if (p1InClip && p2InClip) {
      // Both points inside clip - skip entirely
      continue;
    } else {
      // One point inside, one outside - find intersection and draw partial segment
      // For simplicity, we can use a simple midpoint approach or parametric intersection
      // This is an approximation but should work well for most cases
      const steps = 10;
      let lastInside = p1InClip;
      let lastPoint = p1;

      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const pt = {
          x: p1.x + (p2.x - p1.x) * t,
          y: p1.y + (p2.y - p1.y) * t
        };
        const inside = isInClipRegion(pt.x, pt.y);

        if (inside !== lastInside) {
          // Transition point - draw segment if we were outside
          if (!lastInside) {
            addSegmentToPath(lastPoint as any, pt as any);
          }
          lastInside = inside;
          lastPoint = pt;
        } else if (i === steps && !inside) {
          // Last segment and still outside
          addSegmentToPath(lastPoint as any, p2 as any);
        }
      }
    }
  }

  if (didDraw) {
    // Keep end-caps sharp (butt), but smooth the joins between segments.
    g.stroke({ width, color, cap: 'butt', join: 'round' } as any);
  }
}

function drawArrow(g: PIXI.Graphics, arrow: any, nodes: Record<string, SceneNode>, scale: number, yScale: number = 1, isSelectedOrHovered: boolean = false, hoveredBezierAnchorId: string | null = null) {
  const a = nodes[arrow.a];
  const b = nodes[arrow.b];
  const c1 = nodes[arrow.c1];
  const c2 = nodes[arrow.c2];
  if (!a || !b || !c1 || !c2) return;
  if (a.kind !== 'anchor' || b.kind !== 'anchor' || c1.kind !== 'anchor' || c2.kind !== 'anchor') return;

  // Draw anchor-handle dashed lines when selected (blue color)
  if (isSelectedOrHovered) {
    const handleLineColor = 0x2196F3; // Blue
    const handleLineWidth = 1.5 / scale;
    const dashLength = 8 / scale;
    const gapLength = 4 / scale;

    // Draw dashed line from a to c1
    drawDashedLine(g, a.position.x, a.position.y * yScale, c1.position.x, c1.position.y * yScale, handleLineWidth, handleLineColor, dashLength, gapLength);

    // Draw dashed line from b to c2
    drawDashedLine(g, b.position.x, b.position.y * yScale, c2.position.x, c2.position.y * yScale, handleLineWidth, handleLineColor, dashLength, gapLength);

    // Draw anchors and handles (same size as intersection points: 3.2mm)
    const sizeMm = 3.2;
    const radiusWorld = mmToWorld(sizeMm, scale) / 2;

    // Draw all 4 anchor/handle points
    const anchorPoints = [
      { id: arrow.a, pos: a.position },
      { id: arrow.b, pos: b.position },
      { id: arrow.c1, pos: c1.position },
      { id: arrow.c2, pos: c2.position }
    ];

    for (const anchor of anchorPoints) {
      const isHovered = hoveredBezierAnchorId === anchor.id;

      drawSmoothCircle(g, anchor.pos.x, anchor.pos.y * yScale, radiusWorld);
      if (isHovered) {
        // Yellow on hover (rgb(255, 215, 0) with 85% alpha)
        g.fill({ color: 0xFFD700, alpha: 0.85 });
      } else {
        // Blue semi-transparent (same as intersection points)
        g.fill({ color: 0x0064c8, alpha: 0.47 });
      }
    }
  }

  const stroke = arrow.style?.stroke ?? { color: '#000000', width: 0.35 };
  const color = new PIXI.Color(stroke.color).toNumber();

  // 화면 픽셀 기준으로 충분히 부드럽게 보이도록 세그먼트 수 결정
  const pxPerWorld = scale; // pixels per unit
  const approxLen = Math.hypot(b.position.x - a.position.x, (b.position.y - a.position.y) * yScale);
  const approxPx = Math.max(1, approxLen * pxPerWorld);
  const steps = Math.min(256, Math.max(16, Math.round(approxPx / 6))); // 대략 6px당 한 점

  // Sample bezier curve points
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = cubicBlend(a.position.x, c1.position.x, c2.position.x, b.position.x, t);
    const y = cubicBlend(a.position.y, c1.position.y, c2.position.y, b.position.y, t);
    points.push({ x, y });
  }

  // Use stroke width from style or default
  const strokeWidth = stroke.width || 0.35;
  const baseWidth = (strokeWidth * (96 / 72) * 2.2) / scale;
  const width = isSelectedOrHovered ? baseWidth + 2 / scale : baseWidth;

  // Convert dash pattern from pt to px with on-screen compensation
  const dashPt = stroke.dash;
  const dash = (dashPt && dashPt.length > 0) ? dashPt.map((d: number) => d * (96 / 72) * 2.2) : undefined;

  // Apply dash pattern to entire curve FIRST (before clipping)
  let segments: Array<{ a: Vec2; b: Vec2 }>;
  if (dash && dash.length > 0) {
    // Convert entire curve to dashed segments
    segments = computeDashedPolyline(points, dash, scale, yScale);
  } else {
    // Convert to solid line segments
    segments = [];
    for (let i = 0; i < points.length - 1; i++) {
      segments.push({ a: points[i], b: points[i + 1] });
    }
  }

  // Build a single path and stroke once
  let didDraw = false;
  const EPS = 1e-6;
  let hasLastEnd = false;
  let lastEndX = 0;
  let lastEndY = 0;
  const addSegmentToPath = (p1: Vec2, p2: Vec2) => {
    if (!hasLastEnd || Math.hypot(p1.x - lastEndX, p1.y - lastEndY) > EPS) {
      g.moveTo(p1.x, p1.y * yScale);
    }
    g.lineTo(p2.x, p2.y * yScale);
    lastEndX = p2.x;
    lastEndY = p2.y;
    hasLastEnd = true;
    didDraw = true;
  };

  // Draw all segments
  for (const segment of segments) {
    addSegmentToPath(segment.a, segment.b);
  }

  // Draw arrowheads at start and/or end
  const showStartArrow = arrow.showStartArrow ?? false;
  const showEndArrow = arrow.showEndArrow ?? true;
  const arrowSizeMultiplier = arrow.arrowSize ?? 1.0;

  // Extend curve into arrows to avoid gap (same as axis)
  // Extension should scale with arrow size
  const svgScale = 5 / scale;
  const extension = 2 * svgScale * arrowSizeMultiplier;

  if (showEndArrow && points.length >= 2) {
    // Extend end point into arrow
    const p1 = points[points.length - 2];
    const p2 = points[points.length - 1];
    const angle = Math.atan2((p2.y - p1.y) * yScale, p2.x - p1.x);
    const extendedEndX = p2.x + extension * Math.cos(angle);
    const extendedEndY = p2.y + extension * Math.sin(angle) / yScale; // Reverse yScale effect
    
    // Add extended point
    addSegmentToPath(p1, { x: extendedEndX, y: extendedEndY });
  }

  if (showStartArrow && points.length >= 2) {
    // Extend start point into arrow
    const p1 = points[1];
    const p2 = points[0];
    const angle = Math.atan2((p2.y - p1.y) * yScale, p2.x - p1.x);
    const extendedStartX = p2.x + extension * Math.cos(angle);
    const extendedStartY = p2.y + extension * Math.sin(angle) / yScale;
    
    // Prepend extended segment (draw from extended start to first point)
    const firstPoint = points[0];
    g.moveTo(extendedStartX, extendedStartY * yScale);
    g.lineTo(firstPoint.x, firstPoint.y * yScale);
    didDraw = true;
  }

  if (didDraw) {
    g.stroke({ width, color, cap: 'butt', join: 'round' } as any);
  }

  if (showEndArrow && points.length >= 2) {
    // End arrow: use last two points to determine direction
    const p1 = points[points.length - 2];
    const p2 = points[points.length - 1];
    drawArrowHead(g, { x: p1.x, y: p1.y * yScale }, { x: p2.x, y: p2.y * yScale }, color, width, scale, 1.0, arrowSizeMultiplier);
  }

  if (showStartArrow && points.length >= 2) {
    // Start arrow: use first two points to determine direction (reversed)
    const p1 = points[1];
    const p2 = points[0];
    drawArrowHead(g, { x: p1.x, y: p1.y * yScale }, { x: p2.x, y: p2.y * yScale }, color, width, scale, 1.0, arrowSizeMultiplier);
  }
}

function drawDashedLine(g: PIXI.Graphics, x1: number, y1: number, x2: number, y2: number, width: number, color: number, dashLength: number, gapLength: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const totalLength = Math.hypot(dx, dy);

  if (totalLength < 1e-6) return;

  const unitX = dx / totalLength;
  const unitY = dy / totalLength;
  const patternLength = dashLength + gapLength;

  let currentLength = 0;
  while (currentLength < totalLength) {
    const dashEnd = Math.min(currentLength + dashLength, totalLength);

    const startX = x1 + unitX * currentLength;
    const startY = y1 + unitY * currentLength;
    const endX = x1 + unitX * dashEnd;
    const endY = y1 + unitY * dashEnd;

    g.moveTo(startX, startY);
    g.lineTo(endX, endY);
    g.stroke({ width, color });

    currentLength += patternLength;
  }
}

function cubicBlend(p0: number, p1: number, p2: number, p3: number, t: number) {
  const mt = 1 - t;
  return (
    mt * mt * mt * p0 +
    3 * mt * mt * t * p1 +
    3 * mt * t * t * p2 +
    t * t * t * p3
  );
}

function drawAxis(g: PIXI.Graphics, axis: AxisNode, nodes: Record<string, SceneNode>, scale: number, isVisible: boolean = true, yScale: number = 1) {
  const origin = nodes[axis.originId];
  const endpoint = nodes[axis.endpointId];
  if (!origin || (origin as any).kind !== 'anchor') return;
  if (!endpoint || (endpoint as any).kind !== 'anchor') return;

  const originPos = (origin as any).position;
  const endpointPos = (endpoint as any).position;
  const stroke = axis.style ?? { color: '#000', width: 0.8 };
  const color = new PIXI.Color(stroke.color).toNumber();

  // Force axis thickness = 0.35pt with on-screen compensation
  const width = (0.35 * (96 / 72) * 2.2) / scale;

  // Opacity based on visible state
  const alpha = isVisible ? 1.0 : 0.2;

  // Apply yScale to y coordinates
  const originY = originPos.y * yScale;
  const endpointY = endpointPos.y * yScale;

  // Extend axis line into the arrow to avoid gap
  const angle = Math.atan2(endpointY - originY, endpointPos.x - originPos.x);
  const svgScale = 5 / scale;
  const extension = 2 * svgScale; // Extend into the arrow

  const extendedEndX = endpointPos.x + extension * Math.cos(angle);
  const extendedEndY = endpointY + extension * Math.sin(angle);

  // Get math label clip regions and clip the axis line
  const mathLabelClipRegions = useSceneStore.getState().mathLabelClipRegions;
  const state = useSceneStore.getState();

  // Convert to screen space for clipping
  const ox = originPos.x * scale + state.scene.view.translate.x;
  // originY/extendedEndY are already in y-scaled drawing space; do NOT apply yScale again.
  const oy = -originY * scale + state.scene.view.translate.y;
  const ex = extendedEndX * scale + state.scene.view.translate.x;
  const ey = -extendedEndY * scale + state.scene.view.translate.y;

  // Find intersection intervals with clip regions
  const clipIntervals: Array<{ t1: number; t2: number }> = [];

  for (const region of mathLabelClipRegions) {
    const halfW = region.width / 2;
    const halfH = region.height / 2;
    const left = region.screenX - halfW;
    const right = region.screenX + halfW;
    const top = region.screenY - halfH;
    const bottom = region.screenY + halfH;

    // Line-rectangle intersection (parametric)
    const dx = ex - ox;
    const dy = ey - oy;

    let tMin = 0;
    let tMax = 1;

    // Check X bounds
    if (dx !== 0) {
      const t1 = (left - ox) / dx;
      const t2 = (right - ox) / dx;
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
    } else if (ox < left || ox > right) {
      continue; // No intersection
    }

    // Check Y bounds
    if (dy !== 0) {
      const t1 = (top - oy) / dy;
      const t2 = (bottom - oy) / dy;
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
    } else if (oy < top || oy > bottom) {
      continue; // No intersection
    }

    if (tMin <= tMax && tMax >= 0 && tMin <= 1) {
      clipIntervals.push({ t1: Math.max(0, tMin), t2: Math.min(1, tMax) });
    }
  }

  // Merge overlapping intervals
  clipIntervals.sort((a, b) => a.t1 - b.t1);
  const mergedIntervals: Array<{ t1: number; t2: number }> = [];
  for (const interval of clipIntervals) {
    if (mergedIntervals.length === 0 || mergedIntervals[mergedIntervals.length - 1].t2 < interval.t1) {
      mergedIntervals.push(interval);
    } else {
      mergedIntervals[mergedIntervals.length - 1].t2 = Math.max(mergedIntervals[mergedIntervals.length - 1].t2, interval.t2);
    }
  }

  // Draw axis line segments avoiding clip regions
  let currentT = 0;
  for (const clip of mergedIntervals) {
    if (currentT < clip.t1) {
      // Draw segment before clip region
      const x1 = originPos.x + (extendedEndX - originPos.x) * currentT;
      const y1 = originY + (extendedEndY - originY) * currentT;
      const x2 = originPos.x + (extendedEndX - originPos.x) * clip.t1;
      const y2 = originY + (extendedEndY - originY) * clip.t1;
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke({ width, color, alpha });
    }
    currentT = clip.t2;
  }

  // Draw final segment
  if (currentT < 1) {
    const x1 = originPos.x + (extendedEndX - originPos.x) * currentT;
    const y1 = originY + (extendedEndY - originY) * currentT;
    g.moveTo(x1, y1);
    g.lineTo(extendedEndX, extendedEndY);
    g.stroke({ width, color, alpha });
  }

  // Draw arrow at endpoint if enabled
  if (axis.showArrow !== false) {
    drawArrowHead(g, { x: originPos.x, y: originY }, { x: endpointPos.x, y: endpointY }, color, width, scale, alpha);
  }
}

function drawArrowHead(g: PIXI.Graphics, from: Vec2, to: Vec2, color: number, _width: number, scale: number, alpha: number = 1.0, sizeMultiplier: number = 1.0) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);

  // SVG viewBox: 5.042 x 3.078
  // Scale factor to convert SVG coordinates to world coordinates
  const svgScale = (3 / scale) * sizeMultiplier; // Apply size multiplier

  // Original SVG path points (relative to viewBox)
  // M0.991,1.538 L0.117,0.141 l0.051,-0.03 L2.51,1.016 c0.818,0.172,1.636,0.35,2.454,0.524
  // C4.146,1.712,3.33,1.887,2.51,2.063 L0.168,2.967 L0.117,2.945 L0.991,1.538

  // Simplified arrow shape (the actual visible shape from SVG)
  // Flip the arrow so the left side (start) becomes the tip
  const points = [
    { x: 0.991, y: 1.538 },  // Middle point (this will be the tip)
    { x: 0.117, y: 0.141 },  // Top corner
    { x: 2.51, y: 1.016 },   // Inner curve point
    { x: 4.964, y: 1.540 },  // Right point (base)
    { x: 2.51, y: 2.063 },   // Inner curve point (bottom)
    { x: 0.168, y: 2.967 },  // Bottom corner
  ];

  // Transform points to world coordinates
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  // Center the arrow so the left tip is at 'to'
  const tipX = 0.117; // Leftmost point as tip
  const centerY = 1.539; // Center Y of viewBox

  const colorObj = new PIXI.Color(color);
  g.beginPath();

  points.forEach((p, i) => {
    // Translate so left tip is at origin, center vertically
    const localX = (p.x - tipX) * svgScale;
    const localY = (p.y - centerY) * svgScale;

    // Rotate according to axis angle
    const rotatedX = localX * cos - localY * sin;
    const rotatedY = localX * sin + localY * cos;

    // Translate to endpoint position
    const worldX = to.x + rotatedX;
    const worldY = to.y + rotatedY;

    if (i === 0) {
      g.moveTo(worldX, worldY);
    } else {
      g.lineTo(worldX, worldY);
    }
  });

  g.closePath();
  // Fill first
  g.fill({ color: colorObj.toNumber(), alpha });
  // Then add a very thin anti-aliasing stroke to smooth edges
  g.stroke({ width: Math.max(0.5 / scale, 0.25 / scale), color: colorObj.toNumber(), alpha });
}

function drawExplicitFunction(g: PIXI.Graphics, fn: ExplicitFunctionNode, scale: number, clipBounds: { xMin: number; xMax: number; yMin: number; yMax: number } | null, registry: Record<string, { arity: number; fn: (...args: number[]) => number; expr?: string }>, isInteracting: boolean, yScale: number = 1) {
  try {
    // Determine domain: when clipToAxes is true and clipBounds exist, ignore fn.domain and use axes range
    const domMin = (fn as any).clipToAxes && clipBounds ? clipBounds.xMin : fn.domain[0];
    const domMax = (fn as any).clipToAxes && clipBounds ? clipBounds.xMax : fn.domain[1];
    const xMinVis = domMin;
    const xMaxVis = domMax;
    if (!(xMaxVis > xMinVis)) {
      console.warn(`[drawExplicitFunction] Skipping function "${fn.expr}" - invalid domain: [${xMinVis}, ${xMaxVis}]`);
      return;
    }
    const visibleWidth = xMaxVis - xMinVis;

    // 줌과 완전히 독립적으로 domain 크기만으로 샘플링
    // domain 1단위당 최소 150개 샘플 (abs(x-1)(x-3) 같은 함수의 영점을 정확히 포착)
    // 이렇게 하면 줌 레벨과 무관하게 항상 고품질
    const baseSamplesPerUnit = isInteracting ? 120 : 150;
    const samples = Math.max(300, Math.min(8192, Math.round(visibleWidth * baseSamplesPerUnit)));

    // Find suspected vertical breaks (asymptotes) inside visible range, split domain
    const yRange = (clipBounds ? (clipBounds.yMax - clipBounds.yMin) : 16) || 16;
    const breaks = findExplicitVerticalBreaks(fn.expr, [xMinVis, xMaxVis], registry as any, yRange, Math.min(128, Math.max(64, Math.round(samples / 6))));
    const subDomains: Array<[number, number]> = [];
    let last = xMinVis;
    for (const b of breaks) {
      if (b > last) subDomains.push([last, b]);
      last = b;
    }
    if (last < xMaxVis) subDomains.push([last, xMaxVis]);

    // Cache key per function id + x-range bucket + y-range bucket + interaction bucket
    const clipKey = makeClipKey(clipBounds);
    const scaleKey = scaleBucket(scale);
    const cacheKey = `${fn.id}|${clipKey}|${scaleKey}|${isInteracting ? 'i' : 's'}|${yScale.toFixed(3)}`;
    let cached = explicitFunctionPolylineCache.get(cacheKey);
    if (cached) {
      // Draw from cache
      const width = (0.8 * (96 / 72) * 2.2) / scale;
      const color = (fn as any).isPreview ? 0x2196F3 : 0x000000;
      for (const segment of cached) {
        if (segment.length < 2) continue;
        g.moveTo(segment[0].x, segment[0].y * yScale);
        for (let i = 1; i < segment.length; i++) g.lineTo(segment[i].x, segment[i].y * yScale);
        g.stroke({ width, color, cap: 'butt', join: 'round' } as any);
      }
      return;
    }

    // Sample each subdomain separately and keep them as separate arrays
    // This prevents connecting across asymptotes or domain discontinuities
    const allSegments: Array<{ x: number; y: number }[]> = [];
    for (const [a, b] of subDomains) {
      const w = b - a;
      // 줌과 무관하게 domain 크기만으로 샘플링
      const localSamples = Math.max(150, Math.min(4096, Math.round(w * baseSamplesPerUnit)));
      const seg = sampleExplicitWithRegistry(fn.expr, fn.variable, [a, b], localSamples, registry as any);

      // Filter out segments where the actual x range is much smaller than the requested domain
      // This happens when function is only defined in a small part of the subdomain (e.g., sqrt(x) for x<0)
      if (seg.length >= 2) {
        const actualXMin = seg[0].x;
        const actualXMax = seg[seg.length - 1].x;
        const actualWidth = actualXMax - actualXMin;
        const requestedWidth = b - a;

        // If the actual sampled range is less than 30% of requested range,
        // check if it's at the edge - if so, this indicates a domain boundary
        if (actualWidth < requestedWidth * 0.3) {
          // Check if the valid domain starts significantly after 'a' or ends significantly before 'b'
          const startsLate = actualXMin > a + requestedWidth * 0.2;
          const endsEarly = actualXMax < b - requestedWidth * 0.2;

          // If domain starts late or ends early, this is a partial domain - keep it separate
          if (startsLate || endsEarly) {
            // Mark this segment as having domain boundaries
            allSegments.push(seg);
            continue;
          }
        }

        allSegments.push(seg);
      }
    }

    if (allSegments.length === 0) return;

    // 미리보기 함수는 푸른색, 일반 함수는 검정색으로 렌더
    // Force curves thickness = 0.8pt with on-screen compensation
    const width = (0.8 * (96 / 72) * 2.2) / scale; // scale-independent
    const color = (fn as any).isPreview ? 0x2196F3 : 0x000000;

    // Discontinuity-aware drawing: 보이는 y-구간 안에서만 선을 그리고, 경계를 벗어나면 바로 끊는다
    const yMin = clipBounds ? clipBounds.yMin : -1e9;
    const yMax = clipBounds ? clipBounds.yMax : 1e9;

    // Build final draw segments (discontinuity-aware) and cache exactly what we draw.
    // IMPORTANT: If we cache the raw sampled segments (allSegments), later renders that hit the cache
    // will skip this discontinuity splitting and can create "mystery straight segments" across gaps.
    const finalSegments: Array<{ x: number; y: number }[]> = [];

    // Process each sampled segment separately to detect gaps in valid domain
    for (const points of allSegments) {
      if (points.length < 2) continue;

      // Calculate expected dx from the points we have
      let avgDx = 0;
      let dxCount = 0;
      for (let i = 1; i < Math.min(points.length, 10); i++) {
        avgDx += points[i].x - points[i - 1].x;
        dxCount++;
      }
      avgDx = dxCount > 0 ? avgDx / dxCount : 0;
      const xGapThreshold = Math.max(avgDx * 1.8, visibleWidth / samples * 2.0);

      // Build separate continuous segments within this subdomain
      let currentSegment: { x: number; y: number }[] = [];

      for (let i = 0; i < points.length; i++) {
        const cur = points[i];
        const finiteCur = Number.isFinite(cur.y) && Number.isFinite(cur.x);
        const outCur = cur.y < yMin || cur.y > yMax;

        // Check for large x gap if we have a previous point
        const hasXGap = currentSegment.length > 0 &&
          Math.abs(cur.x - currentSegment[currentSegment.length - 1].x) > xGapThreshold;

        if (!finiteCur || outCur || hasXGap) {
          // End current segment
          if (currentSegment.length >= 2) {
            finalSegments.push(currentSegment);
          }
          currentSegment = [];

          // If current point is valid and not out of bounds, start new segment with it
          if (finiteCur && !outCur && !hasXGap) {
            currentSegment.push(cur);
          }
        } else {
          currentSegment.push(cur);
        }
      }

      // Don't forget the last segment
      if (currentSegment.length >= 2) {
        finalSegments.push(currentSegment);
      }
    }

    // Draw each continuous segment separately
    for (const segment of finalSegments) {
      if (segment.length < 2) continue;
      g.moveTo(segment[0].x, segment[0].y * yScale);
      for (let i = 1; i < segment.length; i++) {
        g.lineTo(segment[i].x, segment[i].y * yScale);
      }
      // Stroke immediately after each segment to prevent connecting across segments
      g.stroke({ width, color, cap: 'butt', join: 'round' } as any);
    }

    // Save cache (cache what we actually draw)
    explicitFunctionPolylineCache.set(cacheKey, finalSegments);
  } catch (err) {
    console.error('drawExplicitFunction error:', err, 'expr:', fn.expr);
    // Don't crash rendering, just skip this function
  }
}

function drawImplicitFunction(g: PIXI.Graphics, fn: ImplicitFunctionNode, scale: number, clipBounds: { xMin: number; xMax: number; yMin: number; yMax: number } | null, registry: Record<string, { arity: number; fn: (...args: number[]) => number; expr?: string }>, isInteracting: boolean, yScale: number = 1) {
  // Choose sampling bounds dynamically:
  // - If clipToAxes is true and axis clipBounds are available, sample that region (with small padding)
  // - Otherwise, fall back to node's stored bounds
  let bounds = fn.bounds;
  if ((fn as any).clipToAxes && clipBounds) {
    const padX = (clipBounds.xMax - clipBounds.xMin) * 0.05;
    const padY = (clipBounds.yMax - clipBounds.yMin) * 0.05;
    bounds = {
      xMin: clipBounds.xMin - padX,
      xMax: clipBounds.xMax + padX,
      yMin: clipBounds.yMin - padY,
      yMax: clipBounds.yMax + padY,
    };
  }

  // Use adaptive marching squares resolution based on current view scale for higher visual quality
  // Cap resolution to avoid stalls at very high zooms
  // Cache key: function id + bounds bucket + scale bucket + interaction
  const clipKey = makeClipKey(bounds);
  const scaleKey = scaleBucket(scale);
  const cacheKey = `${fn.id}|${clipKey}|${scaleKey}|${isInteracting ? 'i' : 's'}|${yScale.toFixed(3)}`;
  let polylines = implicitFunctionPolylineCache.get(cacheKey);
  if (!polylines) {
    const res = computeAdaptiveResolution(bounds, scale, { base: isInteracting ? 96 : 128, min: 64, max: isInteracting ? 2048 : 4096, targetCellPx: isInteracting ? 2.0 : 1.0, quality: 1.5 });
    const segments = marchingSquaresSegmentsWithRegistry(fn.expr, fn.variables, bounds, res, registry as any);
    if (segments.length === 0) return;
    polylines = connectSegmentsToPolylines(segments as any);
    if (!polylines || polylines.length === 0) return;
    implicitFunctionPolylineCache.set(cacheKey, polylines);
  }

  // Apply clipping to display area only (for rendering, not sampling)
  let finalPolylines = polylines;
  if ((fn as any).clipToAxes && clipBounds) {
    const rect = { xMin: clipBounds.xMin, xMax: clipBounds.xMax, yMin: clipBounds.yMin, yMax: clipBounds.yMax };
    finalPolylines = [];
    for (const poly of polylines) {
      const clipped = clipPolylineToRect(poly, rect as any);
      finalPolylines.push(...clipped);
    }
  }

  // 미리보기 함수는 푸른색, 일반 함수는 검정색으로 렌더
  const width = ((fn.style?.stroke?.width ?? 0.8) * (96 / 72) * 2.2) / scale;
  const color = (fn as any).isPreview ? 0x2196F3 : 0x000000;

  // Draw each polyline - apply yScale to y coordinates
  for (const poly of finalPolylines) {
    if (!poly || poly.length < 2) continue;
    g.moveTo(poly[0].x, poly[0].y * yScale);
    for (let i = 1; i < poly.length; i++) {
      g.lineTo(poly[i].x, poly[i].y * yScale);
    }
      g.stroke({ width, color, cap: 'butt', join: 'round' } as any);
  }
}

function drawSegment(
  g: PIXI.Graphics,
  seg: SegmentNode,
  nodes: Record<string, SceneNode>,
  isSelected: boolean = false,
  scale: number = 1,
  yScale: number = 1,
  clipBoundsOverride?: { xMin: number; xMax: number; yMin: number; yMax: number } | null
) {
  if (seg.hidden) return;

  // For two-point segments (no functionId), use real-time anchor positions instead of stored samples
  const isTwoPointSegment = !seg.functionId;
  let actualSamples = seg.samples;

  if (isTwoPointSegment && seg.startAnchorId && seg.endAnchorId) {
    const startAnchor = nodes[seg.startAnchorId] as any;
    const endAnchor = nodes[seg.endAnchorId] as any;

    if (startAnchor && endAnchor && startAnchor.kind === 'anchor' && endAnchor.kind === 'anchor') {
      // Use real-time anchor positions
      actualSamples = [
        { x: startAnchor.position.x, y: startAnchor.position.y },
        { x: endAnchor.position.x, y: endAnchor.position.y }
      ];
    }
  }

  if (actualSamples.length < 2) return;

  // debug log removed for performance

  const stroke = seg.style?.stroke ?? { color: '#000000', width: 0.8 };
  const color = new PIXI.Color(stroke.color).toNumber();
  // Use actual stroke width from segment style, converted to screen-independent units
  const ptToPx = (96 / 72) * 2.2; // pt to px with on-screen compensation
  const baseWidth = ((stroke.width || 0.8) * ptToPx) / scale;
  const width = isSelected ? baseWidth + 2 / scale : baseWidth;

  // Convert dash pattern from pt to px and apply same on-screen compensation as stroke width
  const dashPt = stroke.dash;
  const dash = (dashPt && dashPt.length > 0) ? dashPt.map((d: number) => d * (96 / 72) * 2.2) : undefined;

  // Clip to bounds computed by the main render loop (typically viewBounds ∩ axesBounds).
  // IMPORTANT: do not try to "guess" canvas size inside drawSegment; that caused premature clipping.
  const state = useSceneStore.getState();

  // Get math label clip regions from store
  const mathLabelClipRegions = state.mathLabelClipRegions;
  const clipBoundsRaw = clipBoundsOverride ?? null;
  if (!clipBoundsRaw) return;
  // Small padding so strokes don't pop at the edge while panning.
  const padPx = 2;
  const padWorldX = padPx / Math.max(1e-6, scale);
  const padWorldY = padPx / Math.max(1e-6, scale * yScale);
  const clipBounds = {
    xMin: clipBoundsRaw.xMin - padWorldX,
    xMax: clipBoundsRaw.xMax + padWorldX,
    yMin: clipBoundsRaw.yMin - padWorldY,
    yMax: clipBoundsRaw.yMax + padWorldY,
  };

  // Extend start/end based on segment flags (open segments extend, closed ones don't)
  const extendStart = seg.extendStart ?? false;
  const extendEnd = seg.extendEnd ?? false;
  const samples = (extendStart || extendEnd)
    ? extendPolylineToRect(actualSamples, clipBounds as any, extendStart, extendEnd)
    : actualSamples;
  const polylines = clipPolylineToRect(samples, clipBounds as any);
  if (polylines.length === 0) return;

  // Helper: check if a point (in screen space) is inside any math label clip region
  const isInClipRegion = (worldX: number, worldY: number) => {
    if (!mathLabelClipRegions || mathLabelClipRegions.length === 0) return false;

    const screenX = worldX * scale + state.scene.view.translate.x;
    const screenY = -worldY * yScale * scale + state.scene.view.translate.y;

    for (const region of mathLabelClipRegions) {
      const halfW = region.width / 2;
      const halfH = region.height / 2;
      const left = region.screenX - halfW;
      const right = region.screenX + halfW;
      const top = region.screenY - halfH;
      const bottom = region.screenY + halfH;

      if (screenX >= left && screenX <= right && screenY >= top && screenY <= bottom) {
        return true;
      }
    }
    return false;
  };

  // Helper: find all intersection points of line segment with clip regions
  const findClipIntersections = (x1: number, y1: number, x2: number, y2: number) => {
    if (!mathLabelClipRegions || mathLabelClipRegions.length === 0) return [];

    const sx1 = x1 * scale + state.scene.view.translate.x;
    const sy1 = -y1 * yScale * scale + state.scene.view.translate.y;
    const sx2 = x2 * scale + state.scene.view.translate.x;
    const sy2 = -y2 * yScale * scale + state.scene.view.translate.y;

    const intersections: Array<{ t: number; entering: boolean }> = [];

    for (const region of mathLabelClipRegions) {
      const halfW = region.width / 2;
      const halfH = region.height / 2;
      const left = region.screenX - halfW;
      const right = region.screenX + halfW;
      const top = region.screenY - halfH;
      const bottom = region.screenY + halfH;

      const dx = sx2 - sx1;
      const dy = sy2 - sy1;

      const regionIntersections: Array<{ t: number }> = [];

      // Check intersection with each edge
      if (dx !== 0) {
        const tLeft = (left - sx1) / dx;
        if (tLeft >= 0 && tLeft <= 1) {
          const y = sy1 + tLeft * dy;
          if (y >= top && y <= bottom) {
            regionIntersections.push({ t: tLeft });
          }
        }

        const tRight = (right - sx1) / dx;
        if (tRight >= 0 && tRight <= 1) {
          const y = sy1 + tRight * dy;
          if (y >= top && y <= bottom) {
            regionIntersections.push({ t: tRight });
          }
        }
      }

      if (dy !== 0) {
        const tTop = (top - sy1) / dy;
        if (tTop >= 0 && tTop <= 1) {
          const x = sx1 + tTop * dx;
          if (x >= left && x <= right) {
            regionIntersections.push({ t: tTop });
          }
        }

        const tBottom = (bottom - sy1) / dy;
        if (tBottom >= 0 && tBottom <= 1) {
          const x = sx1 + tBottom * dx;
          if (x >= left && x <= right) {
            regionIntersections.push({ t: tBottom });
          }
        }
      }

      // Sort and add to main intersections list
      regionIntersections.sort((a, b) => a.t - b.t);
      for (let i = 0; i < regionIntersections.length; i++) {
        intersections.push({
          t: regionIntersections[i].t,
          entering: i % 2 === 0
        });
      }
    }

    intersections.sort((a, b) => a.t - b.t);
    return intersections;
  };

  // Apply dash pattern first if needed, then filter by clip regions
  for (const poly of polylines) {
    let segments: Array<{ a: Vec2; b: Vec2 }>;

    const hasClipRegions = !!(mathLabelClipRegions && mathLabelClipRegions.length > 0);

    // PERF OPT:
    // For straight two-point segments, clipping *per dash segment* is extremely expensive at high zoom.
    // Instead:
    // - Clip the original line against label rectangles once (in screen space)
    // - Then apply dash pattern only to the remaining visible subsegments
    // This keeps visuals close while avoiding O(#dashes * #labels) work.
    if (dash && dash.length > 0 && hasClipRegions && poly.length === 2) {
      const a = poly[0];
      const b = poly[1];

      // Convert endpoints to screen space (note y-flip)
      const sx1 = a.x * scale + state.scene.view.translate.x;
      const sy1 = -a.y * yScale * scale + state.scene.view.translate.y;
      const sx2 = b.x * scale + state.scene.view.translate.x;
      const sy2 = -b.y * yScale * scale + state.scene.view.translate.y;

      const clipIntervals: Array<{ t1: number; t2: number }> = [];
      const dx = sx2 - sx1;
      const dy = sy2 - sy1;

      for (const region of mathLabelClipRegions) {
        const halfW = region.width / 2;
        const halfH = region.height / 2;
        const left = region.screenX - halfW;
        const right = region.screenX + halfW;
        const top = region.screenY - halfH;
        const bottom = region.screenY + halfH;

        let tMin = 0;
        let tMax = 1;

        if (dx !== 0) {
          const tx1 = (left - sx1) / dx;
          const tx2 = (right - sx1) / dx;
          tMin = Math.max(tMin, Math.min(tx1, tx2));
          tMax = Math.min(tMax, Math.max(tx1, tx2));
        } else if (sx1 < left || sx1 > right) {
          continue;
        }

        if (dy !== 0) {
          const ty1 = (top - sy1) / dy;
          const ty2 = (bottom - sy1) / dy;
          tMin = Math.max(tMin, Math.min(ty1, ty2));
          tMax = Math.min(tMax, Math.max(ty1, ty2));
        } else if (sy1 < top || sy1 > bottom) {
          continue;
        }

        if (tMin <= tMax && tMax >= 0 && tMin <= 1) {
          clipIntervals.push({ t1: Math.max(0, tMin), t2: Math.min(1, tMax) });
        }
      }

      // Merge overlaps
      clipIntervals.sort((x, y) => x.t1 - y.t1);
      const merged: Array<{ t1: number; t2: number }> = [];
      for (const interval of clipIntervals) {
        if (merged.length === 0 || merged[merged.length - 1].t2 < interval.t1) merged.push({ ...interval });
        else merged[merged.length - 1].t2 = Math.max(merged[merged.length - 1].t2, interval.t2);
      }

      // Produce visible (outside) intervals
      const visible: Array<{ t1: number; t2: number }> = [];
      let cur = 0;
      for (const c of merged) {
        if (cur < c.t1) visible.push({ t1: cur, t2: c.t1 });
        cur = Math.max(cur, c.t2);
      }
      if (cur < 1) visible.push({ t1: cur, t2: 1 });

      // Dash each visible subsegment
      segments = [];
      for (const v of visible) {
        if (!(v.t2 - v.t1 > 1e-6)) continue;
        const p1 = { x: a.x + (b.x - a.x) * v.t1, y: a.y + (b.y - a.y) * v.t1 };
        const p2 = { x: a.x + (b.x - a.x) * v.t2, y: a.y + (b.y - a.y) * v.t2 };
        const dashed = computeDashedPolyline([p1, p2], dash, scale, yScale);
        for (const s of dashed) segments.push(s);
      }

      // Draw all dashed segments (already clipped)
      for (const s of segments) {
        g.moveTo(s.a.x, s.a.y * yScale);
        g.lineTo(s.b.x, s.b.y * yScale);
      }
    } else {
      // Default path: dash first (if any), then clip each tiny segment.
      if (dash && dash.length > 0) {
        // First apply dash pattern to entire polyline
        segments = computeDashedPolyline(poly, dash, scale, yScale);
      } else {
        // Convert polyline to segments
        segments = [];
        for (let i = 0; i < poly.length - 1; i++) {
          segments.push({ a: poly[i], b: poly[i + 1] });
        }
      }

      // Now filter segments based on clip regions
      for (const seg of segments) {
        const p1 = seg.a;
        const p2 = seg.b;

        // Check if this segment should be drawn (not in clip region)
        const intersections = findClipIntersections(p1.x, p1.y, p2.x, p2.y);

        if (intersections.length === 0) {
          // No intersections - check if entire segment is outside clip regions
          if (!isInClipRegion(p1.x, p1.y) && !isInClipRegion(p2.x, p2.y)) {
            // Draw entire segment
            g.moveTo(p1.x, p1.y * yScale);
            g.lineTo(p2.x, p2.y * yScale);
          }
          // If inside, skip entirely
        } else {
          // Has intersections - split and draw only parts outside
          let lastT = 0;
          let lastInside = isInClipRegion(p1.x, p1.y);

          for (const intersection of intersections) {
            if (!lastInside) {
              // We were outside, now entering - draw from lastT to intersection.t
              const startX = p1.x + (p2.x - p1.x) * lastT;
              const startY = p1.y + (p2.y - p1.y) * lastT;
              const endX = p1.x + (p2.x - p1.x) * intersection.t;
              const endY = p1.y + (p2.y - p1.y) * intersection.t;
              g.moveTo(startX, startY * yScale);
              g.lineTo(endX, endY * yScale);
            }

            lastT = intersection.t;
            lastInside = !lastInside;
          }

          // Draw final part if we're outside at the end
          if (!lastInside && lastT < 1) {
            const startX = p1.x + (p2.x - p1.x) * lastT;
            const startY = p1.y + (p2.y - p1.y) * lastT;
            g.moveTo(startX, startY * yScale);
            g.lineTo(p2.x, p2.y * yScale);
          }
        }
      }
    }

    g.stroke({ width, color, cap: 'butt', join: 'round' } as any);
  }

  // Center mark(s) at segment midpoint, perpendicular to segment
  const centerMark = (seg as any).centerMark as ('single' | 'double' | undefined);
  if (centerMark && seg.samples && seg.samples.length >= 2) {
    const a = seg.samples[0];
    const b = seg.samples[seg.samples.length - 1];
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dxScreen = b.x - a.x; // x scales only by 'scale'
    const dyScreen = (b.y - a.y) * yScale; // y scales by 'yScale * scale'
    const len = Math.hypot(dxScreen, dyScreen);
    if (len > 1e-6) {
      const tx = dxScreen / len;  // screen-space unit tangent x
      const ty = dyScreen / len;  // screen-space unit tangent y
      const nx = -ty;             // screen-space unit normal x
      const ny = tx;              // screen-space unit normal y
      const tickThicknessPt = 0.35; // visual thickness
      const tickLengthPt = 6.0;     // visual length
      const ptToPx = (96 / 72) * 2.2;
      const tickThicknessPx = tickThicknessPt * ptToPx;
      const tickLengthPx = tickLengthPt * ptToPx;
      const halfLenPx = tickLengthPx / 2;

      // Convert desired screen offsets to world offsets
      const offXHalfWorld = (nx * halfLenPx) / scale;
      const offYHalfWorld = (ny * halfLenPx) / (scale * yScale);
      const tickWidthWorld = tickThicknessPx / scale;

      if (centerMark === 'single') {
        // one tick centered at midpoint, perpendicular to the segment
        g.moveTo(mx - offXHalfWorld, (my - offYHalfWorld) * yScale);
        g.lineTo(mx + offXHalfWorld, (my + offYHalfWorld) * yScale);
        g.stroke({ width: tickWidthWorld, color });
      } else if (centerMark === 'double') {
        // two parallel ticks (perpendicular to segment), offset along tangent direction, gap between them
        const gapPt = 2.0; // gap between the two lines in pt
        const gapPx = gapPt * ptToPx;
        const gapHalfWorldX = (tx * (gapPx / 2)) / scale;
        const gapHalfWorldY = (ty * (gapPx / 2)) / (scale * yScale);

        // Left tick (at -tangent offset)
        const lx = mx - gapHalfWorldX;
        const ly = my - gapHalfWorldY;
        g.moveTo(lx - offXHalfWorld, (ly - offYHalfWorld) * yScale);
        g.lineTo(lx + offXHalfWorld, (ly + offYHalfWorld) * yScale);
        g.stroke({ width: tickWidthWorld, color });

        // Right tick (at +tangent offset)
        const rx = mx + gapHalfWorldX;
        const ry = my + gapHalfWorldY;
        g.moveTo(rx - offXHalfWorld, (ry - offYHalfWorld) * yScale);
        g.lineTo(rx + offXHalfWorld, (ry + offYHalfWorld) * yScale);
        g.stroke({ width: tickWidthWorld, color });
      }
    }
  }

  // Selection highlight (skip for now as it complicates the clipping logic)
}

// Draw filled region using flood-fill style approach
function drawFilledRegion(
  g: PIXI.Graphics,
  region: FilledRegionNode,
  nodes: Record<string, SceneNode>,
  clipBounds: { xMin: number; xMax: number; yMin: number; yMax: number } | null,
  _scale: number,
  yScale: number = 1
) {
  if (!clipBounds) return;

  // Parse color from RGB string
  const colorMatch = region.fillColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!colorMatch) return;
  const r = parseInt(colorMatch[1]);
  const g_ = parseInt(colorMatch[2]);
  const b = parseInt(colorMatch[3]);
  const color = (r << 16) | (g_ << 8) | b;

  // Cache key (without isInteracting - always use same quality)
  const cacheKey = `${region.id}|${yScale.toFixed(3)}`;
  let polygon = filledRegionPolygonCache.get(cacheKey);

  if (!polygon) {
    const centerX = region.centerPoint.x;
    const centerY = region.centerPoint.y * yScale;

    // Try to get boundaries from cache
    const boundariesCacheKey = `boundaries|${yScale.toFixed(3)}`;
    let boundaries = filledRegionBoundariesCache.get(boundariesCacheKey);

    if (!boundaries) {
      // Collect all boundary segments (axes and segments) with yScale applied
      boundaries = [];
      const axes = Object.values(nodes).filter((n: any) => n.kind === 'axis') as any[];
      for (const axis of axes) {
        const origin = nodes[axis.originId] as any;
        const endpoint = nodes[axis.endpointId] as any;
        if (origin && endpoint) {
          boundaries.push({
            start: { x: origin.position.x, y: origin.position.y * yScale },
            end: { x: endpoint.position.x, y: endpoint.position.y * yScale }
          });
        }
      }
      const segments = Object.values(nodes).filter((n: any) => n.kind === 'segment' && !n.hidden) as any[];
      for (const seg of segments) {
        if (seg.samples && seg.samples.length >= 2) {
          for (let i = 0; i < seg.samples.length - 1; i++) {
            boundaries.push({
              start: { x: seg.samples[i].x, y: seg.samples[i].y * yScale },
              end: { x: seg.samples[i + 1].x, y: seg.samples[i + 1].y * yScale }
            });
          }
        }
      }
      filledRegionBoundariesCache.set(boundariesCacheKey, boundaries);
    }

    // Cast rays from center point to find boundaries
    // Use high quality for initial computation (cached afterwards)
    const baseRays = 720; // Very high quality for initial render
    const minRays = 360;
    const numRays = Math.max(minRays, Math.min(baseRays, baseRays - Math.floor(boundaries.length / 100) * 120));
    const maxDistance = Math.max(
      Math.abs(clipBounds.xMax - clipBounds.xMin),
      Math.abs((clipBounds.yMax - clipBounds.yMin) * yScale)
    ) * 2;

    const points: Vec2[] = [];
    for (let i = 0; i < numRays; i++) {
      const angle = (i / numRays) * 2 * Math.PI;
      const dirX = Math.cos(angle);
      const dirY = Math.sin(angle);

      let closestDist = maxDistance;
      let foundIntersection = false;

      for (const boundary of boundaries) {
        const intersection = raySegmentIntersection(
          centerX, centerY, dirX, dirY,
          boundary.start.x, boundary.start.y,
          boundary.end.x, boundary.end.y
        );
        if (intersection && intersection.distance < closestDist) {
          closestDist = intersection.distance;
          foundIntersection = true;
        }
      }

      const clipIntersection = rayRectIntersection(
        centerX, centerY, dirX, dirY, {
        xMin: clipBounds.xMin,
        xMax: clipBounds.xMax,
        yMin: clipBounds.yMin * yScale,
        yMax: clipBounds.yMax * yScale
      }
      );
      if (clipIntersection && clipIntersection < closestDist) {
        closestDist = clipIntersection;
        foundIntersection = true;
      }

      if (foundIntersection) {
        points.push({ x: centerX + dirX * closestDist, y: centerY + dirY * closestDist });
      }
    }

    if (points.length >= 3) {
      polygon = points;
      filledRegionPolygonCache.set(cacheKey, points);
    }
    // If polygon is still not found, return early
    if (!polygon) return;
  }

  if (polygon && polygon.length >= 3) {
    g.beginPath();
    g.moveTo(polygon[0].x, polygon[0].y);
    for (let i = 1; i < polygon.length; i++) {
      g.lineTo(polygon[i].x, polygon[i].y);
    }
    g.closePath();
    g.fill({ color, alpha: 1.0 });
  }
}

// Ray-segment intersection test
function raySegmentIntersection(
  rayX: number, rayY: number, rayDirX: number, rayDirY: number,
  segX1: number, segY1: number, segX2: number, segY2: number
): { distance: number } | null {
  const segDx = segX2 - segX1;
  const segDy = segY2 - segY1;

  const cross = rayDirX * segDy - rayDirY * segDx;
  if (Math.abs(cross) < 1e-10) return null; // Parallel

  const t = ((segX1 - rayX) * segDy - (segY1 - rayY) * segDx) / cross;
  const u = ((segX1 - rayX) * rayDirY - (segY1 - rayY) * rayDirX) / cross;

  if (t >= 0 && u >= 0 && u <= 1) {
    return { distance: t };
  }

  return null;
}

// Ray-rectangle intersection (returns closest distance)
function rayRectIntersection(
  rayX: number, rayY: number, rayDirX: number, rayDirY: number,
  rect: { xMin: number; xMax: number; yMin: number; yMax: number }
): number | null {
  const edges = [
    { x1: rect.xMin, y1: rect.yMin, x2: rect.xMax, y2: rect.yMin }, // Bottom
    { x1: rect.xMax, y1: rect.yMin, x2: rect.xMax, y2: rect.yMax }, // Right
    { x1: rect.xMax, y1: rect.yMax, x2: rect.xMin, y2: rect.yMax }, // Top
    { x1: rect.xMin, y1: rect.yMax, x2: rect.xMin, y2: rect.yMin }, // Left
  ];

  let minDist: number | null = null;

  for (const edge of edges) {
    const result = raySegmentIntersection(
      rayX, rayY, rayDirX, rayDirY,
      edge.x1, edge.y1, edge.x2, edge.y2
    );

    if (result && (minDist === null || result.distance < minDist)) {
      minDist = result.distance;
    }
  }

  return minDist;
}

// Draw angle arc between two segments or axes
function drawAngle(
  g: PIXI.Graphics,
  angle: any,
  nodes: Record<string, any>,
  scale: number,

  yScale: number = 1,
  isSelected: boolean = false,
  opacity: number = 1.0
) {
  const getActualSegmentSamplesForAngle = (seg: any): Array<{ x: number; y: number }> | null => {
    if (!seg || seg.kind !== 'segment') return null;
    if (!seg.samples || seg.samples.length < 2) return null;
    // Two-point segments (user drawn) have falsy functionId (often empty string).
    // Render using real-time anchor positions to avoid stale `samples` after moving anchors.
    const isTwoPointSegment = !seg.functionId;
    if (isTwoPointSegment && seg.startAnchorId && seg.endAnchorId) {
      const a = nodes[seg.startAnchorId] as any;
      const b = nodes[seg.endAnchorId] as any;
      if (a && b && a.kind === 'anchor' && b.kind === 'anchor' && a.position && b.position) {
        return [{ x: a.position.x, y: a.position.y }, { x: b.position.x, y: b.position.y }];
      }
    }
    return seg.samples as Array<{ x: number; y: number }>;
  };

  // Get the two segments or axes
  const item1 = nodes[angle.segment1Id];
  const item2 = nodes[angle.segment2Id];

  if (!item1 || !item2) {
    console.warn('drawAngle: invalid items', angle.id);
    return;
  }

  // Get samples for both items (segments have samples, axes need to be converted)
  let samples1: Array<{ x: number; y: number }> = [];
  let samples2: Array<{ x: number; y: number }> = [];

  if (item1.kind === 'segment') {
    const s = getActualSegmentSamplesForAngle(item1);
    if (!s || s.length < 2) {
      console.warn('drawAngle: segment1 has no samples', angle.id);
      return;
    }
    samples1 = s;
  } else if (item1.kind === 'axis') {
    const origin = nodes[item1.originId] as any;
    const endpoint = nodes[item1.endpointId] as any;
    if (!origin || !endpoint) {
      console.warn('drawAngle: axis1 has no anchors', angle.id);
      return;
    }
    samples1 = [origin.position, endpoint.position];
  } else {
    console.warn('drawAngle: item1 is not segment or axis', angle.id);
    return;
  }

  if (item2.kind === 'segment') {
    const s = getActualSegmentSamplesForAngle(item2);
    if (!s || s.length < 2) {
      console.warn('drawAngle: segment2 has no samples', angle.id);
      return;
    }
    samples2 = s;
  } else if (item2.kind === 'axis') {
    const origin = nodes[item2.originId] as any;
    const endpoint = nodes[item2.endpointId] as any;
    if (!origin || !endpoint) {
      console.warn('drawAngle: axis2 has no anchors', angle.id);
      return;
    }
    samples2 = [origin.position, endpoint.position];
  } else {
    console.warn('drawAngle: item2 is not segment or axis', angle.id);
    return;
  }

  // Find actual intersection point between polylines
  let intersection: { x: number; y: number } | null = null;

  // Check all segment-segment intersections
  for (let i = 0; i < samples1.length - 1; i++) {
    for (let j = 0; j < samples2.length - 1; j++) {
      const inter = segmentIntersection(
        samples1[i].x, samples1[i].y * yScale,
        samples1[i + 1].x, samples1[i + 1].y * yScale,
        samples2[j].x, samples2[j].y * yScale,
        samples2[j + 1].x, samples2[j + 1].y * yScale
      );

      if (inter) {
        intersection = inter;
        break;
      }
    }
    if (intersection) break;
  }

  // If no actual intersection found, try infinite line intersection
  if (!intersection) {
    const p1Start = samples1[0];
    const p1End = samples1[samples1.length - 1];
    const p2Start = samples2[0];
    const p2End = samples2[samples2.length - 1];

    intersection = lineIntersection(
      p1Start.x, p1Start.y * yScale,
      p1End.x, p1End.y * yScale,
      p2Start.x, p2Start.y * yScale,
      p2End.x, p2End.y * yScale
    );

    if (!intersection) {
      console.warn('drawAngle: items do not intersect', angle.id);
      return;
    }
  }

  // Get direction vectors from line slope (not click position)
  const getDirectionFromSegment = (samples: any[], intPoint: { x: number; y: number }) => {
    // Find the closest sample point to the intersection (but not at the intersection)
    let closestIdx = -1;
    let minDist = Infinity;

    for (let i = 0; i < samples.length; i++) {
      const dx = samples[i].x - intPoint.x;
      const dy = samples[i].y * yScale - intPoint.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Must be at least some distance away from intersection
      if (dist > 0.01 && dist < minDist) {
        minDist = dist;
        closestIdx = i;
      }
    }

    // If we found a nearby point, use direction from intersection to that point
    if (closestIdx >= 0) {
      const dx = samples[closestIdx].x - intPoint.x;
      const dy = samples[closestIdx].y * yScale - intPoint.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 1e-6) {
        return { dx: dx / len, dy: dy / len };
      }
    }

    // Fallback: use direction from start to end of segment
    if (samples.length >= 2) {
      const start = samples[0];
      const end = samples[samples.length - 1];
      const dx = end.x - start.x;
      const dy = end.y * yScale - start.y * yScale;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 1e-6) {
        return { dx: dx / len, dy: dy / len };
      }
    }

    // Final fallback
    return { dx: 1, dy: 0 };
  };

  let dir1 = getDirectionFromSegment(samples1, intersection);
  let dir2 = getDirectionFromSegment(samples2, intersection);

  // If click positions exist, flip the direction vectors so they point toward the click
  if (angle.segment1ClickPos) {
    const vx = angle.segment1ClickPos.x - intersection.x;
    const vy = angle.segment1ClickPos.y * yScale - intersection.y;
    if (vx * dir1.dx + vy * dir1.dy < 0) {
      dir1 = { dx: -dir1.dx, dy: -dir1.dy };
    }
  }
  if (angle.segment2ClickPos) {
    const vx = angle.segment2ClickPos.x - intersection.x;
    const vy = angle.segment2ClickPos.y * yScale - intersection.y;
    if (vx * dir2.dx + vy * dir2.dy < 0) {
      dir2 = { dx: -dir2.dx, dy: -dir2.dy };
    }
  }

  // Calculate angles from segment directions
  const angle1 = Math.atan2(dir1.dy, dir1.dx);
  const angle2 = Math.atan2(dir2.dy, dir2.dx);

  // Calculate the counter-clockwise angle difference
  let ccwAngle = angle2 - angle1;

  // Normalize to [0, 2π]
  while (ccwAngle < 0) ccwAngle += 2 * Math.PI;
  while (ccwAngle >= 2 * Math.PI) ccwAngle -= 2 * Math.PI;

  // Determine which side to draw based on click positions
  let startAngle: number = angle1;
  let endAngle: number;

  const wantLargeAngle = angle.isLargeAngle || false;

  // Use click positions to determine which side of the angle to draw
  let preferCCW = ccwAngle < Math.PI; // default to smaller angle

  if (angle.segment1ClickPos || angle.segment2ClickPos) {
    // Calculate average click direction
    let sumX = 0, sumY = 0, count = 0;
    if (angle.segment1ClickPos) {
      sumX += angle.segment1ClickPos.x - intersection.x;
      sumY += angle.segment1ClickPos.y * yScale - intersection.y;
      count++;
    }
    if (angle.segment2ClickPos) {
      sumX += angle.segment2ClickPos.x - intersection.x;
      sumY += angle.segment2ClickPos.y * yScale - intersection.y;
      count++;
    }

    if (count > 0) {
      const avgClickAngle = Math.atan2(sumY / count, sumX / count);

      // Determine if avgClickAngle is in the CCW region
      let relAngle = avgClickAngle - angle1;
      while (relAngle < 0) relAngle += 2 * Math.PI;
      while (relAngle >= 2 * Math.PI) relAngle -= 2 * Math.PI;

      // If click is in CCW region (between angle1 and angle2), prefer CCW
      preferCCW = relAngle < ccwAngle;
    }
  }

  // Choose angle based on preference and size requirement
  if (wantLargeAngle) {
    // Want large angle
    if (preferCCW) {
      // Prefer CCW: use CCW if large, else use CW
      endAngle = (ccwAngle > Math.PI) ? angle2 : (angle2 - 2 * Math.PI);
    } else {
      // Prefer CW: use CW if large, else use CCW
      endAngle = (ccwAngle < Math.PI) ? (angle2 - 2 * Math.PI) : angle2;
    }
  } else {
    // Want small angle
    if (preferCCW) {
      // Prefer CCW: use CCW if small, else use CW
      endAngle = (ccwAngle < Math.PI) ? angle2 : (angle2 - 2 * Math.PI);
    } else {
      // Prefer CW: use CW if small, else use CCW
      endAngle = (ccwAngle > Math.PI) ? (angle2 - 2 * Math.PI) : angle2;
    }
  }

  // Convert radius from pt to world units (scale-independent)
  const radiusPt = angle.arcRadiusPt || 20;
  const radiusPx = (radiusPt / 72) * 96;
  const radiusWorld = radiusPx / Math.max(1e-6, scale);

  // Draw style
  const stroke = angle.style?.stroke ?? { color: '#000000', width: 0.35 };
  const color = new PIXI.Color(stroke.color).toNumber();
  const strokeWidth = ((stroke.width || 0.35) * (96 / 72) * 2.2) / scale;
  const width = isSelected ? strokeWidth + 2 / scale : strokeWidth;

  // Check if right angle style (square)
  if (angle.isRightAngle) {
    // Draw square for right angle
    const size = radiusWorld;

    // Calculate three corners of the square (starting from intersection)
    const c1X = intersection.x + size * Math.cos(angle1);
    const c1Y = intersection.y + size * Math.sin(angle1);
    const c2X = c1X + size * Math.cos(angle2);
    const c2Y = c1Y + size * Math.sin(angle2);
    const c3X = intersection.x + size * Math.cos(angle2);
    const c3Y = intersection.y + size * Math.sin(angle2);

    // Draw square
    g.moveTo(c1X, c1Y);
    g.lineTo(c2X, c2Y);
    g.lineTo(c3X, c3Y);
    g.stroke({ width, color, alpha: opacity });
  } else {
    // Draw arc (original behavior)
    let totalAngle = endAngle - startAngle;

    // Use more segments for smoother arc (1 segment per 5 degrees)
    const segments = Math.max(8, Math.ceil((Math.abs(totalAngle) * 180 / Math.PI) / 5));

    // Start at the first point
    const startX = intersection.x + radiusWorld * Math.cos(startAngle);
    const startY = intersection.y + radiusWorld * Math.sin(startAngle);
    g.moveTo(startX, startY);

    // Draw arc with line segments
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const currentAngle = startAngle + totalAngle * t;
      const x = intersection.x + radiusWorld * Math.cos(currentAngle);
      const y = intersection.y + radiusWorld * Math.sin(currentAngle);
      g.lineTo(x, y);
    }

    g.stroke({ width, color, alpha: opacity });
  }
}

// Segment-segment intersection (finite segments, not infinite lines)
function segmentIntersection(
  x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number
): { x: number; y: number } | null {
  if (![x1, y1, x2, y2, x3, y3, x4, y4].every(Number.isFinite)) return null;
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);

  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-10) {
    return null; // Parallel or coincident
  }

  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
  if (!Number.isFinite(t) || !Number.isFinite(u)) return null;

  // Check if intersection is within both segments
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    const ix = x1 + t * (x2 - x1);
    const iy = y1 + t * (y2 - y1);
    if (!Number.isFinite(ix) || !Number.isFinite(iy)) return null;
    return { x: ix, y: iy };
  }

  return null;
}

// Line-line intersection helper
function lineIntersection(
  x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number
): { x: number; y: number } | null {
  if (![x1, y1, x2, y2, x3, y3, x4, y4].every(Number.isFinite)) return null;
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);

  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-10) {
    // Lines are parallel or coincident
    return null;
  }

  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  if (!Number.isFinite(t)) return null;

  const ix = x1 + t * (x2 - x1);
  const iy = y1 + t * (y2 - y1);
  if (!Number.isFinite(ix) || !Number.isFinite(iy)) return null;
  return { x: ix, y: iy };
}