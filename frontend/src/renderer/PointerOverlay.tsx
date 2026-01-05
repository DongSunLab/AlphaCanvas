import { useEffect, useRef, useState } from 'react';
import { renderMathToHtml } from './MathLabels';
import { useSceneStore } from '../state/store';
import { generateStableId } from '../shared/types';
import { findNearestCurvePoint, computeTangentAtPoint, makeTangentFunctionNode } from '../interaction/curveTools';
import { cubicNearestPoint } from '../geometry/bezier';
import { getFilledRegionPolygon } from './PixiStage';

export function PointerOverlay({ overlayRef }: { overlayRef: React.MutableRefObject<HTMLDivElement | null> }) {
  const ref = overlayRef;
  const [hoverAnchor, setHoverAnchor] = useState<{ x: number; y: number } | null>(null);
  const [previewEndPoint, setPreviewEndPoint] = useState<{ x: number; y: number } | null>(null);
  const [colorPickerState, setColorPickerState] = useState<{ regionId: string; position: { x: number; y: number } } | null>(null);
  const [paintPreview, setPaintPreview] = useState<{ points: { x: number; y: number }[]; color: string } | null>(null);
  // Paint preview perf: throttle heavy ray-casting + rerendering.
  const paintPreviewRafIdRef = useRef<number | null>(null);
  const paintPreviewLatestRef = useRef<{
    x: number;
    y: number;
    clipBounds: { xMin: number; xMax: number; yMin: number; yMax: number };
    yScale: number;
    nodesRef: Record<string, any>;
  } | null>(null);
  const paintPreviewLastScreenRef = useRef<{ sx: number; sy: number } | null>(null);
  const paintBoundariesCacheRef = useRef<{
    nodesRef: Record<string, any>;
    yScale: number;
    boundaries: Array<{ start: { x: number; y: number }; end: { x: number; y: number } }>;
  } | null>(null);
  const [editingMathId, setEditingMathId] = useState<string | null>(null);
  const [editingPos, setEditingPos] = useState<{ x: number; y: number } | null>(null);
  const [pointStyleState, setPointStyleState] = useState<{ pointId: string; position: { x: number; y: number } } | null>(null);
  const [angleStyleState, setAngleStyleState] = useState<{ angleId: string; position: { x: number; y: number } } | null>(null);
  // Illustrator-like horizontal alignment guide for math labels (Y-center snapping)
  const [snapGuideY, _setSnapGuideY] = useState<number | null>(null);
  const snapGuideYRef = useRef<number | null>(null);
  const setSnapGuideY = (v: number | null) => {
    if (snapGuideYRef.current === v) return;
    snapGuideYRef.current = v;
    _setSnapGuideY(v);
  };

  // Popup position helper to keep within viewport for translate(-50%, -100%) anchored popups
  function clampPopupToViewport(left: number, top: number, popupWidth: number, popupHeight: number) {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1920;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 1080;
    const MARGIN = 8;

    // Given transform translate(-50%, -100%):
    // rect.left = left - W/2, rect.right = left + W/2, rect.top = top - H, rect.bottom = top
    let clampedLeft = left;
    let clampedTop = top;

    const leftEdge = clampedLeft - popupWidth / 2;
    const rightEdge = clampedLeft + popupWidth / 2;
    const topEdge = clampedTop - popupHeight;
    const bottomEdge = clampedTop;

    if (leftEdge < MARGIN) {
      clampedLeft += (MARGIN - leftEdge);
    }
    if (rightEdge > vw - MARGIN) {
      clampedLeft -= (rightEdge - (vw - MARGIN));
    }
    if (topEdge < MARGIN) {
      clampedTop += (MARGIN - topEdge);
    }
    if (bottomEdge > vh - MARGIN) {
      clampedTop -= (bottomEdge - (vh - MARGIN));
    }

    return { left: clampedLeft, top: clampedTop };
  }

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      console.log('PointerOverlay: ref is null');
      return;
    }
    console.log('PointerOverlay: mounted', el);
    try { 
      (el as any).setAttribute('tabindex', '0');
      // Remove focus outline
      el.style.outline = 'none';
    } catch {}
    
    let draggingId: string | null = null;
    let draggingType: 'anchor' | 'segment' | 'math-text' | 'bezier-curve' | null = null;
    let draggingBezierT: number | null = null; // t parameter on bezier curve when dragging starts
    let lastSnapGuideY: number | null = null;
    const setGuide = (v: number | null) => {
      if (lastSnapGuideY === v) return;
      lastSnapGuideY = v;
      setSnapGuideY(v);
    };

    // Events originating from popups (DOM overlays) should not trigger canvas interactions.
    // Popups are rendered inside this overlay, so their pointer events bubble to `el`.
    const isFromPopup = (ev: Event): boolean => {
      try {
        const target = ev.target as any;
        if (target && typeof target.closest === 'function' && target.closest('[data-ac-popup="1"]')) return true;
        const path = typeof (ev as any).composedPath === 'function' ? (ev as any).composedPath() : [];
        for (const p of path as any[]) {
          if (p && typeof p.getAttribute === 'function' && p.getAttribute('data-ac-popup') === '1') return true;
          if (p && typeof p.closest === 'function' && p.closest('[data-ac-popup="1"]')) return true;
        }
      } catch { }
      return false;
    };

    // Compute math-text center in screen space (matches MathLabels positioning: left/top at center with translate(-50%,-50%))
    const getMathTextScreenCenter = (mt: any, scene: any): { sx: number; sy: number } | null => {
      const { scale, translate, yScale: viewYScale, magnification } = scene.view as any;
      const yScale = viewYScale ?? 1;
      const mag = magnification ?? 1;

      // Bezier-attached label: position from bezierT
      if (mt?.bezierParentId && typeof mt.bezierT === 'number') {
        const bezier = scene.nodes[mt.bezierParentId] as any;
        if (bezier && bezier.kind === 'bezier') {
          const a = scene.nodes[bezier.a] as any;
          const b = scene.nodes[bezier.b] as any;
          const c1 = scene.nodes[bezier.c1] as any;
          const c2 = scene.nodes[bezier.c2] as any;
          if (a && b && c1 && c2 && a.kind === 'anchor' && b.kind === 'anchor' && c1.kind === 'anchor' && c2.kind === 'anchor') {
            const t = mt.bezierT;
            const mt0 = 1 - t;
            const wx = mt0 * mt0 * mt0 * a.position.x + 3 * mt0 * mt0 * t * c1.position.x + 3 * mt0 * t * t * c2.position.x + t * t * t * b.position.x;
            const wy = mt0 * mt0 * mt0 * a.position.y + 3 * mt0 * mt0 * t * c1.position.y + 3 * mt0 * t * t * c2.position.y + t * t * t * b.position.y;
            return { sx: wx * scale + translate.x, sy: -wy * yScale * scale + translate.y };
          }
        }
        // Fallback to stored position if curve data missing
        if (mt?.position) return { sx: mt.position.x * scale + translate.x, sy: -mt.position.y * yScale * scale + translate.y };
        return null;
      }

      // Axis-attached label: endpoint + offsetPx (offset stored un-magnified)
      if (mt?.axisId && mt?.offsetPx) {
        const axis = scene.nodes[mt.axisId] as any;
        const endpoint = axis ? (scene.nodes[axis.endpointId] as any) : null;
        if (endpoint && endpoint.kind === 'anchor') {
          const ex = endpoint.position.x * scale + translate.x;
          const ey = -endpoint.position.y * yScale * scale + translate.y;
          return { sx: ex + mt.offsetPx.x * mag, sy: ey + mt.offsetPx.y * mag };
        }
      }

      // Offset-based label relative to its base world position (offset stored un-magnified)
      if (mt?.offsetPx && mt?.position) {
        const bx = mt.position.x * scale + translate.x;
        const by = -mt.position.y * yScale * scale + translate.y;
        return { sx: bx + mt.offsetPx.x * mag, sy: by + mt.offsetPx.y * mag };
      }

      if (mt?.position) {
        return { sx: mt.position.x * scale + translate.x, sy: -mt.position.y * yScale * scale + translate.y };
      }
      return null;
    };

    const getPointScreenCenter = (pt: any, scene: any): { sx: number; sy: number } | null => {
      if (!pt?.position) return null;
      const { scale, translate, yScale: viewYScale } = scene.view as any;
      const yScale = viewYScale ?? 1;
      return { sx: pt.position.x * scale + translate.x, sy: -pt.position.y * yScale * scale + translate.y };
    };

    const findSnapY = (sy: number, draggingNodeId: string, scene: any, thresholdPx: number): number | null => {
      let bestY: number | null = null;
      let bestD = Infinity;

      for (const n of Object.values(scene.nodes) as any[]) {
        if (!n || n.id === draggingNodeId) continue;
        if (n.kind === 'math-text') {
          const p = getMathTextScreenCenter(n, scene);
          if (!p) continue;
          const d = Math.abs(p.sy - sy);
          if (d < bestD) { bestD = d; bestY = p.sy; }
        } else if (n.kind === 'point') {
          const p = getPointScreenCenter(n, scene);
          if (!p) continue;
          const d = Math.abs(p.sy - sy);
          if (d < bestD) { bestD = d; bestY = p.sy; }
        }
      }

      if (bestY !== null && bestD <= thresholdPx) return bestY;
      return null;
    };

    // Get constrained position for axis anchors
    const getConstrainedPosition = (anchorId: string, newX: number, newY: number, nodes: Record<string, any>) => {
      // Find if this anchor is used by any axis
      const axes = Object.values(nodes).filter((n: any) => n.kind === 'axis') as any[];
      
      for (const axis of axes) {
        if (axis.endpointId === anchorId || axis.originId === anchorId) {
          // This is an endpoint or origin of an axis - constrain based on axis direction
          const otherAnchorId = axis.endpointId === anchorId ? axis.originId : axis.endpointId;
          const otherAnchor = nodes[otherAnchorId];
          if (!otherAnchor) return { x: newX, y: newY };
          
          const otherPos = otherAnchor.position;
          
          // Determine if this is primarily X or Y axis based on name
          if (axis.name === 'X') {
            // X axis: allow horizontal movement only (keep Y same as other anchor)
            return { x: newX, y: otherPos.y };
          } else if (axis.name === 'Y') {
            // Y axis: allow vertical movement only (keep X same as other anchor)
            return { x: otherPos.x, y: newY };
          }
        }
      }
      
      // Not an axis anchor, allow free movement
      return { x: newX, y: newY };
    };

    const hitAnchorAt = (x: number, y: number) => {
      const state = useSceneStore.getState();
      const { scene } = state;
      const anchors = Object.values(scene.nodes).filter(n => (n as any).kind === 'anchor') as any[];
      const threshold = 10 / scene.view.scale; // 10 pixels in world coords

      // Axis anchors must always be interactable, even if some segments reuse them.
      const axisAnchorIds = new Set<string>();
      Object.values(scene.nodes).forEach((node: any) => {
        if (node && node.kind === 'axis') {
          axisAnchorIds.add(node.originId);
          axisAnchorIds.add(node.endpointId);
        }
      });
      
      // Collect anchor IDs that belong to segments (should not be hoverable)
      // Exception: allow anchors of selected two-point segments (segments without functionId)
      const hiddenAnchorIds = new Set<string>();
      const selectedSegmentAnchorIds = new Set<string>();
      
      Object.values(scene.nodes).forEach((node: any) => {
        if (node.kind === 'segment') {
          const isSelected = state.selectedIds.includes(node.id);
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
      
      for (let i = anchors.length - 1; i >= 0; i--) {
        const an = anchors[i];
        // Skip anchors that belong to non-selected segments
        // Allow axis anchors and selected two-point segment anchors
        if (!axisAnchorIds.has(an.id) && hiddenAnchorIds.has(an.id) && !selectedSegmentAnchorIds.has(an.id)) continue;
        
        const dx = an.position.x - x;
        const dy = an.position.y - y;
        if (Math.sqrt(dx*dx + dy*dy) <= threshold) return an.id;
      }
      return null;
    };

    const hitSegmentAt = (x: number, y: number) => {
      const { scene } = useSceneStore.getState();
      // Respect clip bounds: ignore hits outside of axes/view rect
      const overlayRect = (el as HTMLElement).getBoundingClientRect();
      const yScale = scene.view.yScale ?? 1;
      const viewBounds = {
        xMin: (0 - scene.view.translate.x) / scene.view.scale,
        xMax: (overlayRect.width - scene.view.translate.x) / scene.view.scale,
        yMax: (0 - scene.view.translate.y) / (-scene.view.scale * yScale),
        yMin: (overlayRect.height - scene.view.translate.y) / (-scene.view.scale * yScale)
      };
      const axes = Object.values(scene.nodes).filter((n: any) => n.kind === 'axis') as any[];
      let xMin = viewBounds.xMin, xMax = viewBounds.xMax, yMin = viewBounds.yMin, yMax = viewBounds.yMax;
      for (const axis of axes) {
        const o = scene.nodes[axis.originId] as any;
        const e = scene.nodes[axis.endpointId] as any;
        if (!o || !e) continue;
        const axisName = (axis as any).name;
        if (axisName === 'X') {
          xMin = Math.max(xMin, Math.min(o.position.x, e.position.x));
          xMax = Math.min(xMax, Math.max(o.position.x, e.position.x));
        } else if (axisName === 'Y') {
          yMin = Math.max(yMin, Math.min(o.position.y, e.position.y));
          yMax = Math.min(yMax, Math.max(o.position.y, e.position.y));
        } else {
          const dx = e.position.x - o.position.x;
          const dy = e.position.y - o.position.y;
          if (Math.abs(dx) > Math.abs(dy)) {
            xMin = Math.max(xMin, Math.min(o.position.x, e.position.x));
            xMax = Math.min(xMax, Math.max(o.position.x, e.position.x));
          } else {
            yMin = Math.max(yMin, Math.min(o.position.y, e.position.y));
            yMax = Math.min(yMax, Math.max(o.position.y, e.position.y));
          }
        }
      }
      if (!(x >= xMin && x <= xMax && y >= yMin && y <= yMax)) return null;
      const segments = Object.values(scene.nodes).filter(n => (n as any).kind === 'segment') as any[];
      const threshold = 10 / scene.view.scale;
      
      for (const seg of segments) {
        if (seg.hidden) continue;
        
        // For two-point segments (no functionId), use real-time anchor positions
        const isTwoPointSegment = !seg.functionId;
        let actualSamples = seg.samples;
        
        if (isTwoPointSegment && seg.startAnchorId && seg.endAnchorId) {
          const startAnchor = scene.nodes[seg.startAnchorId] as any;
          const endAnchor = scene.nodes[seg.endAnchorId] as any;
          
          if (startAnchor && endAnchor && startAnchor.kind === 'anchor' && endAnchor.kind === 'anchor') {
            // Use real-time anchor positions for hit testing
            actualSamples = [
              { x: startAnchor.position.x, y: startAnchor.position.y },
              { x: endAnchor.position.x, y: endAnchor.position.y }
            ];
          }
        }
        
        for (let i = 0; i < actualSamples.length - 1; i++) {
          const dist = pointToLineSegmentDistanceWithYScale(
            { x, y },
            actualSamples[i],
            actualSamples[i + 1],
            yScale
          );
          if (dist <= threshold) return seg.id;
        }
      }
      return null;
    };

    const hitBezierAt = (x: number, y: number) => {
      const { scene } = useSceneStore.getState();
      const beziers = Object.values(scene.nodes).filter(n => ((n as any).kind === 'bezier' || (n as any).kind === 'arrow')) as any[];
      const threshold = 10 / scene.view.scale;
      
      for (const bez of beziers) {
        const a = scene.nodes[bez.a] as any;
        const b = scene.nodes[bez.b] as any;
        const c1 = scene.nodes[bez.c1] as any;
        const c2 = scene.nodes[bez.c2] as any;
        
        if (!a || !b || !c1 || !c2) continue;
        if (a.kind !== 'anchor' || b.kind !== 'anchor' || c1.kind !== 'anchor' || c2.kind !== 'anchor') continue;
        
        const result = cubicNearestPoint(
          a.position,
          c1.position,
          c2.position,
          b.position,
          { x, y }
        );
        
        if (result.distance <= threshold) {
          return bez.id;
        }
      }
      
      return null;
    };

    const hitMathTextAt = (x: number, y: number) => {
      const { scene } = useSceneStore.getState();
      const mathTexts = Object.values(scene.nodes).filter(n => (n as any).kind === 'math-text') as any[];
      const { scale, translate, yScale: viewYScale } = scene.view as any;
      const yScale = viewYScale ?? 1;
      
      // Pointer screen coords
      const sx = x * scale + translate.x;
      const sy = -y * yScale * scale + translate.y;
      
      for (let i = mathTexts.length - 1; i >= 0; i--) {
        const mt: any = mathTexts[i];
        let labelSx: number;
        let labelSy: number;
        
        if (mt.bezierParentId && typeof mt.bezierT === 'number') {
          const bezier = scene.nodes[mt.bezierParentId] as any;
          if (bezier && bezier.kind === 'bezier') {
            const a = scene.nodes[bezier.a] as any;
            const b = scene.nodes[bezier.b] as any;
            const c1 = scene.nodes[bezier.c1] as any;
            const c2 = scene.nodes[bezier.c2] as any;
            
            if (a && b && c1 && c2 && a.kind === 'anchor' && b.kind === 'anchor' && c1.kind === 'anchor' && c2.kind === 'anchor') {
              const t = mt.bezierT;
              const mt_val = 1 - t;
              const wx = mt_val*mt_val*mt_val*a.position.x + 3*mt_val*mt_val*t*c1.position.x + 3*mt_val*t*t*c2.position.x + t*t*t*b.position.x;
              const wy = mt_val*mt_val*mt_val*a.position.y + 3*mt_val*mt_val*t*c1.position.y + 3*mt_val*t*t*c2.position.y + t*t*t*b.position.y;
              
              labelSx = wx * scale + translate.x;
              labelSy = -wy * yScale * scale + translate.y;
            } else {
              labelSx = mt.position.x * scale + translate.x;
              labelSy = -mt.position.y * yScale * scale + translate.y;
            }
          } else {
            labelSx = mt.position.x * scale + translate.x;
            labelSy = -mt.position.y * yScale * scale + translate.y;
          }
        } else if (mt.axisId && mt.offsetPx) {
          const magnification = scene.view.magnification ?? 1;
          const axis = scene.nodes[mt.axisId] as any;
          const endpoint = axis ? scene.nodes[axis.endpointId] as any : null;
          if (endpoint && endpoint.kind === 'anchor') {
            const ex = endpoint.position.x * scale + translate.x;
            const ey = -endpoint.position.y * yScale * scale + translate.y;
            labelSx = ex + mt.offsetPx.x * magnification;
            labelSy = ey + mt.offsetPx.y * magnification;
          } else {
            labelSx = mt.position.x * scale + translate.x;
            labelSy = -mt.position.y * yScale * scale + translate.y;
          }
        } else if (mt.offsetPx) {
          const magnification = scene.view.magnification ?? 1;
          const bx = mt.position.x * scale + translate.x;
          const by = -mt.position.y * yScale * scale + translate.y;
          labelSx = bx + mt.offsetPx.x * magnification;
          labelSy = by + mt.offsetPx.y * magnification;
        } else {
          labelSx = mt.position.x * scale + translate.x;
          labelSy = -mt.position.y * yScale * scale + translate.y;
        }

        // Compute label bounds using getBBox
        let w = 140, h = 70; // fallback
        try {
          const el = document.querySelector(`[data-math-label-id="${mt.id}"]`) as HTMLElement | null;
          if (el) {
            const svgEl = el.querySelector('svg');
            if (svgEl) {
              try {
                const bbox = svgEl.getBBox();
                if (bbox && bbox.width > 0 && bbox.height > 0) {
                  const declaredWidth = parseFloat(svgEl.getAttribute('width') || '0');
                  const viewBox = svgEl.getAttribute('viewBox');
                  if (declaredWidth > 0 && viewBox) {
                    const vbParts = viewBox.split(/\s+/).map(parseFloat);
                    if (vbParts.length === 4) {
                      const [, , vbW, vbH] = vbParts;
                      const scale = declaredWidth / vbW;
                      w = bbox.width * scale;
                      h = bbox.height * scale;
                    }
                  }
                }
              } catch {
                const rect = el.getBoundingClientRect();
                w = rect.width;
                h = rect.height;
              }
            } else {
              const rect = el.getBoundingClientRect();
              w = rect.width;
              h = rect.height;
            }
          } else {
            // Fallback to HTML parsing if element not yet mounted
            const magnification = scene.view.magnification ?? 1;
            const rawSize = (mt as any).fontSize ?? 11;
            const paramPt = rawSize > 15 ? (rawSize / 24) * 11 : rawSize;
            const visualPx = (paramPt / 11) * 24 * magnification;
            const html = renderMathToHtml(mt.latex, visualPx, (mt as any).color ?? '#000000');
            const m = html.match(/width="([0-9.]+)px"[\s\S]*?height="([0-9.]+)px"/);
            if (m) {
              w = parseFloat(m[1]);
              h = parseFloat(m[2]);
            }
          }
        } catch {}
        const magnification = scene.view.magnification ?? 1;
        const pad = 8 * magnification; // scale padding with magnification
        if (Math.abs(sx - labelSx) <= (w + pad) / 2 && Math.abs(sy - labelSy) <= (h + pad) / 2) {
          return mt.id;
        }
      }
      return null;
    };

    const hitFilledRegionAt = (x: number, y: number) => {
      const { scene } = useSceneStore.getState();
      const regions = Object.values(scene.nodes).filter(n => (n as any).kind === 'filled-region') as any[];
      const yScale = scene.view.yScale ?? 1;
      
      // Point-in-polygon test using ray casting
      const isPointInPolygon = (px: number, py: number, polygon: Array<{ x: number; y: number }>): boolean => {
        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
          const xi = polygon[i].x;
          const yi = polygon[i].y;
          const xj = polygon[j].x;
          const yj = polygon[j].y;
          
          const intersect = ((yi > py) !== (yj > py)) && 
                           (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
          if (intersect) inside = !inside;
        }
        return inside;
      };
      
      // Check each region using cached polygon (reverse order for z-index)
      for (let i = regions.length - 1; i >= 0; i--) {
        const region = regions[i];
        
        // Get cached polygon from PixiStage
        const polygon = getFilledRegionPolygon(region.id, yScale);
        
        if (polygon && polygon.length >= 3) {
          // Test if point is inside this polygon
          if (isPointInPolygon(x, y, polygon)) {
            return region.id;
          }
        }
      }
      return null;
    };

    const hitPointAt = (x: number, y: number) => {
      const { scene } = useSceneStore.getState();
      const points = Object.values(scene.nodes).filter(n => (n as any).kind === 'point') as any[];
      const dpr = useSceneStore.getState().dpr;
      
      for (let i = points.length - 1; i >= 0; i--) {
        const point = points[i];
        const diameterMm = point.diameterMm ?? 2.3;
        // Convert mm to world units
        const px = (diameterMm / 25.4) * 96 * dpr;
        const radiusWorld = px / Math.max(1e-6, scene.view.scale);
        const hitRadius = radiusWorld * 1.5; // 50% larger hit area for easier selection
        
        const dx = x - point.position.x;
        const dy = y - point.position.y;
        if (Math.hypot(dx, dy) <= hitRadius) {
          return point.id;
        }
      }
      return null;
    };

    const hitAngleAt = (x: number, y: number) => {
      const { scene } = useSceneStore.getState();
      const angles = Object.values(scene.nodes).filter(n => (n as any).kind === 'angle') as any[];
      const dpr = useSceneStore.getState().dpr;
      const threshold = 10 / scene.view.scale; // 10 pixels in world coords
      const yScale = scene.view.yScale ?? 1;

      const getActualSegmentSamplesForAngleHit = (seg: any): Array<{ x: number; y: number }> | null => {
        if (!seg || seg.kind !== 'segment') return null;
        if (!seg.samples || seg.samples.length < 2) return null;
        const isTwoPointSegment = !seg.functionId;
        if (isTwoPointSegment && seg.startAnchorId && seg.endAnchorId) {
          const a = scene.nodes[seg.startAnchorId] as any;
          const b = scene.nodes[seg.endAnchorId] as any;
          if (a && b && a.kind === 'anchor' && b.kind === 'anchor' && a.position && b.position) {
            return [{ x: a.position.x, y: a.position.y }, { x: b.position.x, y: b.position.y }];
          }
        }
        return seg.samples as Array<{ x: number; y: number }>;
      };
      
      for (let i = angles.length - 1; i >= 0; i--) {
        const angleNode = angles[i];
        
        // Get the two segments or axes
        const item1 = scene.nodes[angleNode.segment1Id] as any;
        const item2 = scene.nodes[angleNode.segment2Id] as any;
        
        if (!item1 || !item2) continue;
        
        // Get samples for both items
        let samples1: Array<{ x: number; y: number }> = [];
        let samples2: Array<{ x: number; y: number }> = [];
        
        if (item1.kind === 'segment') {
          const s = getActualSegmentSamplesForAngleHit(item1);
          if (!s || s.length < 2) continue;
          samples1 = s;
        } else if (item1.kind === 'axis') {
          const origin = scene.nodes[item1.originId] as any;
          const endpoint = scene.nodes[item1.endpointId] as any;
          if (!origin || !endpoint) continue;
          samples1 = [origin.position, endpoint.position];
        } else {
          continue;
        }
        
        if (item2.kind === 'segment') {
          const s = getActualSegmentSamplesForAngleHit(item2);
          if (!s || s.length < 2) continue;
          samples2 = s;
        } else if (item2.kind === 'axis') {
          const origin = scene.nodes[item2.originId] as any;
          const endpoint = scene.nodes[item2.endpointId] as any;
          if (!origin || !endpoint) continue;
          samples2 = [origin.position, endpoint.position];
        } else {
          continue;
        }
        
        // Find intersection point (same logic as drawAngle)
        const p1Start = samples1[0];
        const p1End = samples1[samples1.length - 1];
        const p2Start = samples2[0];
        const p2End = samples2[samples2.length - 1];
        
        const intersection = lineIntersection(
          p1Start.x, p1Start.y * yScale,
          p1End.x, p1End.y * yScale,
          p2Start.x, p2Start.y * yScale,
          p2End.x, p2End.y * yScale
        );
        
        if (!intersection) continue;
        
        // Convert radius from pt to world units
        const radiusPt = angleNode.arcRadiusPt || 20;
        const radiusPx = (radiusPt / 72) * 96;
        const radiusWorld = radiusPx / Math.max(1e-6, scene.view.scale);
        
        // Check if point is near the arc/square
        const dx = x - intersection.x;
        const dy = y * yScale - intersection.y; // Use yScale correctly
        const dist = Math.hypot(dx, dy);
        
        // For right angle (square), check if point is near the square edges
        // For arc, check if point is near the arc radius
        if (angleNode.isRightAngle) {
          // For square: check if point is within reasonable distance
          if (dist > radiusWorld * 1.5 || dist < radiusWorld * 0.3) continue;
        } else {
          // For arc: check if point is near the arc radius
          if (Math.abs(dist - radiusWorld) > threshold) continue;
        }
        
        // Now check if the angle is within the arc range
        // Calculate mouse angle from intersection
        const mouseAngle = Math.atan2(dy, dx);
        
        // Calculate directions (same as drawAngle)
        const getClosestPoint = (samples: any[]) => {
          let closestIdx = 0;
          let minDist = Infinity;
          for (let j = 0; j < samples.length; j++) {
            const sdx = samples[j].x - intersection.x;
            const sdy = samples[j].y * yScale - intersection.y;
            const d = Math.sqrt(sdx * sdx + sdy * sdy);
            if (d > 0.01 && d < minDist) {
              minDist = d;
              closestIdx = j;
            }
          }
          const sdx = samples[closestIdx].x - intersection.x;
          const sdy = samples[closestIdx].y * yScale - intersection.y;
          const len = Math.sqrt(sdx * sdx + sdy * sdy);
          return len > 1e-6 ? { dx: sdx / len, dy: sdy / len } : { dx: 1, dy: 0 };
        };
        
        let dir1 = getClosestPoint(samples1);
        let dir2 = getClosestPoint(samples2);
        
        // Apply click position flips (same as drawAngle)
        if (angleNode.segment1ClickPos) {
          const vx = angleNode.segment1ClickPos.x - intersection.x;
          const vy = angleNode.segment1ClickPos.y * yScale - intersection.y;
          if (vx * dir1.dx + vy * dir1.dy < 0) {
            dir1 = { dx: -dir1.dx, dy: -dir1.dy };
          }
        }
        if (angleNode.segment2ClickPos) {
          const vx = angleNode.segment2ClickPos.x - intersection.x;
          const vy = angleNode.segment2ClickPos.y * yScale - intersection.y;
          if (vx * dir2.dx + vy * dir2.dy < 0) {
            dir2 = { dx: -dir2.dx, dy: -dir2.dy };
          }
        }
        
        const angle1 = Math.atan2(dir1.dy, dir1.dx);
        const angle2 = Math.atan2(dir2.dy, dir2.dx);
        
        let ccwAngle = angle2 - angle1;
        while (ccwAngle < 0) ccwAngle += 2 * Math.PI;
        while (ccwAngle >= 2 * Math.PI) ccwAngle -= 2 * Math.PI;
        
        // Determine which arc is drawn (same logic as drawAngle)
        const wantLargeAngle = angleNode.isLargeAngle || false;
        let preferCCW = ccwAngle < Math.PI;
        
        if (angleNode.segment1ClickPos || angleNode.segment2ClickPos) {
          let sumX = 0, sumY = 0, count = 0;
          if (angleNode.segment1ClickPos) {
            sumX += angleNode.segment1ClickPos.x - intersection.x;
            sumY += angleNode.segment1ClickPos.y * yScale - intersection.y;
            count++;
          }
          if (angleNode.segment2ClickPos) {
            sumX += angleNode.segment2ClickPos.x - intersection.x;
            sumY += angleNode.segment2ClickPos.y * yScale - intersection.y;
            count++;
          }
          if (count > 0) {
            const avgClickAngle = Math.atan2(sumY / count, sumX / count);
            let relAngle = avgClickAngle - angle1;
            while (relAngle < 0) relAngle += 2 * Math.PI;
            while (relAngle >= 2 * Math.PI) relAngle -= 2 * Math.PI;
            preferCCW = relAngle < ccwAngle;
          }
        }
        
        let startAngle = angle1;
        let endAngle;
        
        if (wantLargeAngle) {
          if (preferCCW) {
            endAngle = (ccwAngle > Math.PI) ? angle2 : (angle2 - 2 * Math.PI);
          } else {
            endAngle = (ccwAngle < Math.PI) ? (angle2 - 2 * Math.PI) : angle2;
          }
        } else {
          if (preferCCW) {
            endAngle = (ccwAngle < Math.PI) ? angle2 : (angle2 - 2 * Math.PI);
          } else {
            endAngle = (ccwAngle > Math.PI) ? (angle2 - 2 * Math.PI) : angle2;
          }
        }
        
        // Check if mouseAngle is within the arc range
        let relMouseAngle = mouseAngle - startAngle;
        while (relMouseAngle < 0) relMouseAngle += 2 * Math.PI;
        while (relMouseAngle >= 2 * Math.PI) relMouseAngle -= 2 * Math.PI;
        
        let arcSpan = endAngle - startAngle;
        // Keep arcSpan's sign to preserve CW vs CCW direction
        if (arcSpan < -Math.PI) arcSpan += 2 * Math.PI;
        if (arcSpan > Math.PI) arcSpan -= 2 * Math.PI;
        
        // Check if mouse is within arc: handle both positive (CCW) and negative (CW) spans
        const inArc = arcSpan >= 0 
          ? (relMouseAngle >= 0 && relMouseAngle <= arcSpan)
          : (relMouseAngle >= arcSpan + 2 * Math.PI || relMouseAngle <= 0);
        
        if (inArc) {
          return angleNode.id;
        }
      }
      return null;
    };

    // Helper function for line intersection
    const lineIntersection = (
      x1: number, y1: number, x2: number, y2: number,
      x3: number, y3: number, x4: number, y4: number
    ): { x: number; y: number } | null => {
      const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
      if (Math.abs(denom) < 1e-10) return null;
      const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
      return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
    };

    const worldCoords = (ev: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const { scene } = useSceneStore.getState();
      const x = (ev.clientX - rect.left - scene.view.translate.x) / scene.view.scale;
      // Y axis is flipped in PixiJS (scale.y = -scale), so we need to flip it back
      // Apply yScale for vertical stretching
      const yScale = scene.view.yScale ?? 1;
      const y = -(ev.clientY - rect.top - scene.view.translate.y) / (scene.view.scale * yScale);
      return { x, y };
    };

    const onDown = (ev: PointerEvent) => {
      try { (el as any).focus(); } catch {}
      if (isFromPopup(ev)) return;
      const { currentTool, createAnchor, upsertNode, scene, setSelected, convertFunctionsToSegments, twoPointFirstClick, setTwoPointFirstClick, setZIndex, setInteracting } = useSceneStore.getState() as any;
      
      // Pan tool: let D3 handle everything
      if (currentTool === 'pan') return;
      
      // Magnifier tool: left click = zoom in, right click = zoom out
      if (currentTool === 'magnifier') {
        ev.stopPropagation();
        ev.preventDefault();
        
        const state = useSceneStore.getState();
        const currentMag = state.scene.view.magnification ?? 1;
        const currentScale = state.scene.view.scale;
        const currentYScale = state.scene.view.yScale ?? 1;
        const currentTranslate = state.scene.view.translate;
        
        // Determine zoom direction: left click (button 0) = in, right click (button 2) = out
        const isZoomIn = ev.button === 0;
        const factor = isZoomIn ? 1.3 : (1 / 1.3);
        
        const newMag = Math.max(0.1, Math.min(10, currentMag * factor));
        const newScale = Math.max(0.01, Math.min(500, currentScale * factor));
        
        // Zoom to click position
        const rect = el.getBoundingClientRect();
        const mouseX = ev.clientX - rect.left;
        const mouseY = ev.clientY - rect.top;
        
        // Calculate world position before zoom
        const worldXBefore = (mouseX - currentTranslate.x) / currentScale;
        const worldYBefore = -(mouseY - currentTranslate.y) / (currentScale * currentYScale);
        
        // Calculate new translate to keep world position under cursor
        const newTranslateX = mouseX - worldXBefore * newScale;
        const newTranslateY = mouseY + worldYBefore * newScale * currentYScale;
        
        state.setView({
          scale: newScale,
          rotation: 0,
          translate: { x: newTranslateX, y: newTranslateY },
          yScale: currentYScale,
          magnification: newMag
        });
        
        return;
      }
      
      const { x, y } = worldCoords(ev);
      
      console.log('pointerdown:', { tool: currentTool, x: Math.round(x), y: Math.round(y) });
      
      // Two-point angle tool
      if (currentTool === 'two-point-angle') {
        ev.stopPropagation();
        ev.preventDefault();
        
        const { twoPointAngleFirstSegment, twoPointAngleFirstClickPos, setTwoPointAngleFirstSegment } = useSceneStore.getState() as any;
        
        // Check if clicking on a segment or axis
        let hitId = hitSegmentAt(x, y);
        let hitType: 'segment' | 'axis' | null = hitId ? 'segment' : null;
        
        // If no segment, check for axis
        if (!hitId) {
          const axes = Object.values(scene.nodes).filter((n: any) => n.kind === 'axis') as any[];
          const threshold = 10 / scene.view.scale;
          
          for (const axis of axes) {
            const origin = scene.nodes[axis.originId] as any;
            const endpoint = scene.nodes[axis.endpointId] as any;
            if (!origin || !endpoint) continue;
            
            const dist = pointToLineSegmentDistance(
              { x, y },
              origin.position,
              endpoint.position
            );
            
            if (dist <= threshold) {
              hitId = axis.id;
              hitType = 'axis';
              break;
            }
          }
        }
        
        if (!hitId) {
          console.log('Angle mode: no segment or axis hit');
          return;
        }
        
        if (!twoPointAngleFirstSegment) {
          // First segment/axis clicked - save ID and click position
          setTwoPointAngleFirstSegment(hitId, { x, y });
          console.log('Angle mode: first', hitType, 'selected', hitId, 'at', x, y);
        } else {
          // Second segment/axis clicked
          if (hitId === twoPointAngleFirstSegment) {
            console.log('Angle mode: same segment/axis clicked, ignoring');
            return;
          }
          
          // Create angle node with click positions
          const angleId = generateStableId('angle');
          const angleNode = {
            id: angleId,
            kind: 'angle',
            segment1Id: twoPointAngleFirstSegment,
            segment2Id: hitId,
            segment1ClickPos: twoPointAngleFirstClickPos,
            segment2ClickPos: { x, y },
            isLargeAngle: false, // default to small angle
            isRightAngle: false, // default to arc style
            arcRadiusPt: 20, // default radius in pt
            style: { stroke: { color: '#000000', width: 0.35 } }
          };
          
          upsertNode(angleNode as any);
          setTwoPointAngleFirstSegment(null);
          console.log('Created angle:', angleId, 'between', twoPointAngleFirstSegment, 'and', hitId);
        }
        return;
      }
      
      // Circle tools
      if (currentTool === 'circle-center' || currentTool === 'circle-3pt' || currentTool === 'circle-radius') {
        ev.stopPropagation();
        ev.preventDefault();
        const hoveredIntersection = useSceneStore.getState().hoveredIntersection;
        const clickPos = hoveredIntersection || { x, y };

        const circleFirstClick = useSceneStore.getState().circleFirstClick;
        const circleSecondClick = useSceneStore.getState().circleSecondClick;
        const setCircleFirstClick = useSceneStore.getState().setCircleFirstClick;
        const setCircleSecondClick = useSceneStore.getState().setCircleSecondClick;
        const upsertNode = useSceneStore.getState().upsertNode;
        const allocateFunctionSymbol = useSceneStore.getState().allocateFunctionSymbol;

        // Helper to get axis-aligned bounds from current axes
        const getAxisBounds = () => {
          const scene = useSceneStore.getState().scene;
          const axes = Object.values(scene.nodes).filter((n: any) => n && n.kind === 'axis') as any[];
          let xMin = -10, xMax = 10, yMin = -10, yMax = 10;
          if (axes.length > 0) {
            let xmn = -Infinity, xmx = Infinity, ymn = -Infinity, ymx = Infinity;
            for (const axis of axes) {
              const o = scene.nodes[axis.originId] as any; const e = scene.nodes[axis.endpointId] as any;
              if (!o || !e) continue;
              const axisName = (axis as any).name;
              if (axisName === 'X') {
                xmn = Math.max(xmn, Math.min(o.position.x, e.position.x));
                xmx = Math.min(xmx, Math.max(o.position.x, e.position.x));
              } else if (axisName === 'Y') {
                ymn = Math.max(ymn, Math.min(o.position.y, e.position.y));
                ymx = Math.min(ymx, Math.max(o.position.y, e.position.y));
              } else {
                const dx = e.position.x - o.position.x; const dy = e.position.y - o.position.y;
                if (Math.abs(dx) > Math.abs(dy)) {
                  xmn = Math.max(xmn, Math.min(o.position.x, e.position.x));
                  xmx = Math.min(xmx, Math.max(o.position.x, e.position.x));
                } else {
                  ymn = Math.max(ymn, Math.min(o.position.y, e.position.y));
                  ymx = Math.min(ymx, Math.max(o.position.y, e.position.y));
                }
              }
            }
            if (isFinite(xmn) && isFinite(xmx)) { xMin = xmn; xMax = xmx; }
            if (isFinite(ymn) && isFinite(ymx)) { yMin = ymn; yMax = ymx; }
          }
          return { xMin, xMax, yMin, yMax };
        };

        // Helper to compute circle from three points (world coords)
        const circleFromThree = (p1: any, p2: any, p3: any) => {
          const x1 = p1.x, y1 = p1.y, x2 = p2.x, y2 = p2.y, x3 = p3.x, y3 = p3.y;
          const a = x1*(y2 - y3) - y1*(x2 - x3) + x2*y3 - x3*y2;
          const eps = 1e-9;
          if (Math.abs(a) < eps) return null; // collinear
          const b = (x1*x1 + y1*y1)*(y3 - y2) + (x2*x2 + y2*y2)*(y1 - y3) + (x3*x3 + y3*y3)*(y2 - y1);
          const c = (x1*x1 + y1*y1)*(x2 - x3) + (x2*x2 + y2*y2)*(x3 - x1) + (x3*x3 + y3*y3)*(x1 - x2);
          const cx = -b / (2*a);
          const cy = -c / (2*a);
          const r = Math.hypot(cx - x1, cy - y1);
          return { cx, cy, r };
        };

        if (currentTool === 'circle-center') {
          if (!circleFirstClick) {
            setCircleFirstClick(clickPos);
          } else {
            const cx = circleFirstClick.x, cy = circleFirstClick.y;
            const r = Math.hypot(clickPos.x - cx, clickPos.y - cy);
            const expr = `(x-(${cx}))**2 + (y-(${cy}))**2 - (${r}**2)`;
            const id = generateStableId('fn-implicit');
            const bounds = getAxisBounds();
            const symbol = allocateFunctionSymbol();
            upsertNode({
              id,
              kind: 'function-implicit',
              expr,
              variables: ['x','y'],
              bounds,
              style: { stroke: { color: '#000000', width: 0.8 } },
              symbol,
              clipToAxes: true
            } as any);
            setCircleFirstClick(null);
            setPreviewEndPoint(null);
          }
        } else if (currentTool === 'circle-radius') {
          // Circle-radius: click center, then input radius
          const cx = clickPos.x, cy = clickPos.y;
          const radiusStr = prompt('반지름을 입력하세요:');
          if (radiusStr) {
            const r = parseFloat(radiusStr);
            if (!isNaN(r) && r > 0) {
              const expr = `(x-(${cx}))**2 + (y-(${cy}))**2 - (${r}**2)`;
              const id = generateStableId('fn-implicit');
              const bounds = getAxisBounds();
              const symbol = allocateFunctionSymbol();
              upsertNode({
                id,
                kind: 'function-implicit',
                expr,
                variables: ['x','y'],
                bounds,
                style: { stroke: { color: '#000000', width: 0.8 } },
                symbol,
                clipToAxes: true
              } as any);
            }
          }
        } else {
          // circle-3pt
          if (!circleFirstClick) {
            setCircleFirstClick(clickPos);
          } else if (!circleSecondClick) {
            setCircleSecondClick(clickPos);
          } else {
            const circle = circleFromThree(circleFirstClick, circleSecondClick, clickPos);
            if (circle) {
              const { cx, cy, r } = circle;
              const expr = `(x-(${cx}))**2 + (y-(${cy}))**2 - (${r}**2)`;
              const id = generateStableId('fn-implicit');
              const bounds = getAxisBounds();
              const symbol = allocateFunctionSymbol();
              upsertNode({
                id,
                kind: 'function-implicit',
                expr,
                variables: ['x','y'],
                bounds,
                style: { stroke: { color: '#000000', width: 0.8 } },
                symbol,
                clipToAxes: true
              } as any);
            }
            setCircleFirstClick(null);
            setCircleSecondClick(null);
            setPreviewEndPoint(null);
          }
        }
        return;
      }

      // Two-point tools
      if (currentTool === 'two-point-line' || currentTool === 'two-point-segment' || currentTool === 'two-point-dashed' || currentTool === 'two-point-ray') {
        ev.stopPropagation();
        ev.preventDefault();
        
        // Check if hovering over a special point and snap to it
        const hoveredIntersection = useSceneStore.getState().hoveredIntersection;
        const clickPos = hoveredIntersection || { x, y };
        
        if (!twoPointFirstClick) {
          // First click: save position (snapped to special point if hovering)
          setTwoPointFirstClick(clickPos);
          console.log('Two-point mode: first click at', clickPos, hoveredIntersection ? '(snapped to special point)' : '');
        } else {
          // Second click: create shape
          const p1 = twoPointFirstClick;
          const p2 = clickPos;
          
          // Create segment with two points
          const segId = generateStableId('seg');
          const a1 = createAnchor(p1);
          const a2 = createAnchor(p2);
          
          // Defaults (pt units for width and dash pattern lengths)
          let widthPt: number = 0.8; // default for line/segment/ray
          let dashPt: number[] | undefined = undefined; // default: solid
          let extendStart = false;
          let extendEnd = false;
          
          if (currentTool === 'two-point-line') {
            // Infinite line: extend both ends
            extendStart = true;
            extendEnd = true;
            widthPt = 0.8;
          } else if (currentTool === 'two-point-segment') {
            // Segment: no extension
            extendStart = false;
            extendEnd = false;
            widthPt = 0.8;
          } else if (currentTool === 'two-point-dashed') {
            // Dashed segment: no extension, add dash
            extendStart = false;
            extendEnd = false;
            widthPt = 0.35; // requested default for dashed tool
            dashPt = [1.6, 0.9]; // Illustrator-style pattern in pt
          } else if (currentTool === 'two-point-ray') {
            // Ray: start from first point, extend towards second
            extendStart = false;
            extendEnd = true;
            widthPt = 0.8;
          }
          
          const segNode = {
            id: segId,
            kind: 'segment',
            functionId: '', // no parent function
            startAnchorId: a1,
            endAnchorId: a2,
            samples: [p1, p2],
            style: { stroke: { color: '#000000', width: widthPt, dash: dashPt } },
            extendStart,
            extendEnd,
            // Legacy behavior: split two-point segments at intersections (creates tpseg_ pieces)
            autoSplitAtIntersections: true
          };
          
          upsertNode(segNode as any);
          setTwoPointFirstClick(null);
          console.log('Created two-point shape:', currentTool, segId);
        }
        return;
      }

      // Curve tools: point on curve / tangent
      if (currentTool === 'curve-point' || currentTool === 'curve-tangent') {
        ev.stopPropagation();
        ev.preventDefault();
        const state = useSceneStore.getState();
        const { scene, addPoint, upsertNode, allocateFunctionSymbol } = state as any;
        // snap to hovered intersection if close; otherwise snap to nearest curve polyline
        const hovered = state.hoveredIntersection;
        let target: { point: { x: number; y: number }; functionId: string } | null = null;
        const view = scene.view;
        const thresholdWorld = 12.0 / Math.max(1e-6, view.scale);
        if (hovered) {
          // Find nearest function polyline to hovered (should be on curve already)
          const res = findNearestCurvePoint(scene.nodes as any, hovered, thresholdWorld);
          if (res) target = res;
        }
        if (!target) {
          const res = findNearestCurvePoint(scene.nodes as any, { x, y }, thresholdWorld);
          if (res) target = res;
        }

        // Add point on curve or at clicked position (2.7mm diameter)
        if (currentTool === 'curve-point') {
          // If hovering over an intersection, use it directly (snap to special point)
          const pointPos = hovered ? hovered : (target ? target.point : { x, y });
          addPoint(pointPos, 2.3, '#000000');
          return;
        }
        
        if (!target) return; // no nearby curve for tangent tool

        // Add tangent line function
        if (currentTool === 'curve-tangent') {
          const spec = computeTangentAtPoint(scene.nodes as any, target.functionId, target.point);
          if (!spec) return;
          // Build function node by view bounds (clip to current view)
          const overlayRect = (el as HTMLElement).getBoundingClientRect();
          const viewBounds = {
            xMin: (0 - scene.view.translate.x) / scene.view.scale,
            xMax: (overlayRect.width - scene.view.translate.x) / scene.view.scale,
            yMax: (0 - scene.view.translate.y) / -scene.view.scale,
            yMin: (overlayRect.height - scene.view.translate.y) / -scene.view.scale
          };
          const node = makeTangentFunctionNode(spec, viewBounds, allocateFunctionSymbol);
          upsertNode(node as any);
          return;
        }
      }
      
      if (currentTool === 'line') {
        ev.stopPropagation();
        ev.preventDefault();
        try { el.setPointerCapture(ev.pointerId); } catch {}
        // Create at a fixed screen length converted to world units so 단위가 일관됨
        const s = useSceneStore.getState().scene.view.scale;
        const lenPx = 200; // 200px on screen
        const dx = lenPx / Math.max(1e-6, s);
        const a = createAnchor({ x, y });
        const b = createAnchor({ x: x + dx, y });
        const lineId = generateStableId('line');
        upsertNode({ id: lineId, kind: 'line', a, b, style: { stroke: { color: '#000000', width: 0.8 } } } as any);
        console.log('Created line:', lineId, 'anchors:', a, b);
      } else if (currentTool === 'bezier') {
        ev.stopPropagation();
        ev.preventDefault();
        try { el.setPointerCapture(ev.pointerId); } catch {}
        // Screen-space template converted to world units (일관된 체감 스케일)
        const s = useSceneStore.getState().scene.view.scale;
        const bx = 240 / Math.max(1e-6, s); // end point x offset
        const c1x = 80 / Math.max(1e-6, s), c1y = 120 / Math.max(1e-6, s);
        const c2x = 160 / Math.max(1e-6, s), c2y = 120 / Math.max(1e-6, s);
        const a = createAnchor({ x, y });
        const b = createAnchor({ x: x + bx, y });
        const c1 = createAnchor({ x: x + c1x, y: y - c1y });
        const c2 = createAnchor({ x: x + c2x, y: y + c2y });
        const bezId = generateStableId('bezier');
        upsertNode({ id: bezId, kind: 'bezier', a, b, c1, c2, style: { stroke: { color: '#000000', width: 0.8 } } } as any);
        console.log('Created bezier:', bezId, 'anchors:', a, b, c1, c2);
      } else if (currentTool === 'arrow') {
        // Two-click arrow tool (similar to length-dashed)
        ev.stopPropagation();
        ev.preventDefault();
        const state = useSceneStore.getState();
        const firstClick = state.arrowFirstClick;
        
        // Snap to hovered intersection if available
        const hoveredIntersection = state.hoveredIntersection;
        const clickPos = hoveredIntersection || { x, y };
        
        if (!firstClick) {
          // First click: save position (use snapped position)
          state.setArrowFirstClick(clickPos);
          console.log('Arrow: first click at', clickPos);
        } else {
          // Second click: create arrow with C-shape (use snapped position)
          const dx = clickPos.x - firstClick.x;
          const dy = clickPos.y - firstClick.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          
          // C-shape: control points on same side (both below the line)
          const perpX = -dy / Math.max(1e-6, dist);
          const perpY = dx / Math.max(1e-6, dist);
          const offset = dist * 0.25; // 곡률 정도
          
          const a = createAnchor({ x: firstClick.x, y: firstClick.y });
          const b = createAnchor({ x: clickPos.x, y: clickPos.y });
          const c1 = createAnchor({ x: firstClick.x + dx * 0.33 + perpX * offset, y: firstClick.y + dy * 0.33 + perpY * offset });
          const c2 = createAnchor({ x: firstClick.x + dx * 0.67 + perpX * offset, y: firstClick.y + dy * 0.67 + perpY * offset });
          
          const arrowId = generateStableId('arrow');
          // Default: 0.35pt solid line with end arrow only
          upsertNode({ 
            id: arrowId, 
            kind: 'arrow', 
            a, 
            b, 
            c1, 
            c2, 
            style: { stroke: { color: '#000000', width: 0.35 } }, 
            showStartArrow: false, 
            showEndArrow: true 
          } as any);
          console.log('Created arrow:', arrowId, 'anchors:', a, b, c1, c2);
          
          // Reset first click
          state.setArrowFirstClick(null);
        }
      } else if (currentTool === 'length-dashed') {
        // Two-click length-dashed tool
        ev.stopPropagation();
        ev.preventDefault();
        const state = useSceneStore.getState();
        const firstClick = state.lengthDashedFirstClick;
        
        // Snap to hovered intersection if available
        const hoveredIntersection = state.hoveredIntersection;
        const clickPos = hoveredIntersection || { x, y };
        
        if (!firstClick) {
          // First click: save position (use snapped position)
          state.setLengthDashedFirstClick(clickPos);
          console.log('Length-dashed: first click at', clickPos);
        } else {
          // Second click: create bezier with C-shape (use snapped position)
          const dx = clickPos.x - firstClick.x;
          const dy = clickPos.y - firstClick.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          
          // C-shape: control points on same side (both below the line)
          const perpX = -dy / Math.max(1e-6, dist);
          const perpY = dx / Math.max(1e-6, dist);
          const offset = dist * 0.25; // 곡률 정도
          
          const a = createAnchor({ x: firstClick.x, y: firstClick.y });
          const b = createAnchor({ x: clickPos.x, y: clickPos.y });
          const c1 = createAnchor({ x: firstClick.x + dx * 0.33 + perpX * offset, y: firstClick.y + dy * 0.33 + perpY * offset });
          const c2 = createAnchor({ x: firstClick.x + dx * 0.67 + perpX * offset, y: firstClick.y + dy * 0.67 + perpY * offset });
          
          const bezId = generateStableId('bezier');
          // Use dashed style: 0.35pt thickness, [1.6, 0.9] dash pattern
          upsertNode({ id: bezId, kind: 'bezier', a, b, c1, c2, style: { stroke: { color: '#000000', width: 0.35, dash: [1.6, 0.9] } }, labelIds: [] } as any);
          console.log('Created length-dashed bezier:', bezId, 'anchors:', a, b, c1, c2);
          
          // Reset first click
          state.setLengthDashedFirstClick(null);
        }
      } else if (currentTool === 'paint') {
        ev.stopPropagation();
        ev.preventDefault();
        
        // Check if clicking on existing filled region
        const hitRegionId = hitFilledRegionAt(x, y);
        if (hitRegionId) {
          // Show color picker for existing region
          const rect = el.getBoundingClientRect();
          setColorPickerState({
            regionId: hitRegionId,
            position: { x: ev.clientX - rect.left, y: ev.clientY - rect.top }
          });
          console.log('Clicked existing region:', hitRegionId);
        } else {
          // Create new filled region at clicked point with default color
          const regionId = generateStableId('region');
          const defaultColor = 'rgb(230, 230, 230)';
          upsertNode({
            id: regionId,
            kind: 'filled-region',
            centerPoint: { x, y },
            fillColor: defaultColor
          } as any);
          // Ensure region renders beneath segments
          try { setZIndex(regionId, -100); } catch {}
          console.log('Created filled region:', regionId, 'at', { x, y });
        }
        setPaintPreview(null);
      } else if (currentTool === 'select') {
        // Priority: anchor > math-text > point > filled-region > segment
        const hitAnchorId = hitAnchorAt(x, y);
        if (hitAnchorId) {
          draggingId = hitAnchorId;
          draggingType = 'anchor';
          // Check if this is an axis anchor and set flag immediately
          const axes = Object.values(scene.nodes).filter((n: any) => n.kind === 'axis') as any[];
          const isAxisAnchor = axes.some((axis: any) => 
            axis.endpointId === hitAnchorId || axis.originId === hitAnchorId
          );
          
          // Check if this is a bezier anchor/handle
          const beziers = Object.values(scene.nodes).filter((n: any) => n.kind === 'bezier') as any[];
          const isBezierAnchor = beziers.some((bez: any) => 
            bez.a === hitAnchorId || bez.b === hitAnchorId || bez.c1 === hitAnchorId || bez.c2 === hitAnchorId
          );
          
          // Use 'bezier-curve' type if it's a bezier anchor to trigger reconversion
          const nodeType = isBezierAnchor ? 'bezier-curve' : 'anchor';
          useSceneStore.setState({ isDraggingAxisAnchor: isAxisAnchor, draggingNodeType: nodeType });
          // begin batch interaction for history
          try { setInteracting(true); } catch {}
          console.log('Start drag anchor', draggingId, isAxisAnchor ? '(axis anchor)' : isBezierAnchor ? '(bezier anchor)' : '');
          ev.stopPropagation();
          ev.preventDefault();
          try { el.setPointerCapture(ev.pointerId); } catch {}
        } else {
        const hitMathTextId = hitMathTextAt(x, y);
          if (hitMathTextId) {
            draggingId = hitMathTextId;
            draggingType = 'math-text';
          try { setSelected([hitMathTextId]); } catch {}
            try { setInteracting(true); } catch {}
            useSceneStore.setState({ draggingNodeType: 'math-text' });
            console.log('Start drag math-text', draggingId);
            ev.stopPropagation();
            ev.preventDefault();
            try { el.setPointerCapture(ev.pointerId); } catch {}
        } else {
          // Check for point hit
          const hitPtId = hitPointAt(x, y);
          if (hitPtId) {
            setSelected([hitPtId]);
            const rect = el.getBoundingClientRect();
            setPointStyleState({
              pointId: hitPtId,
              position: { x: ev.clientX - rect.left, y: ev.clientY - rect.top }
            });
            console.log('Selected point', hitPtId);
            ev.stopPropagation();
            ev.preventDefault();
            return;
          }
          // Check for angle hit
          const hitAngleId = hitAngleAt(x, y);
          if (hitAngleId) {
            setSelected([hitAngleId]);
            const rect = el.getBoundingClientRect();
            setAngleStyleState({
              angleId: hitAngleId,
              position: { x: ev.clientX - rect.left, y: ev.clientY - rect.top }
            });
            console.log('Selected angle', hitAngleId);
            ev.stopPropagation();
            ev.preventDefault();
            return;
          }
          // If clicking a filled region, open color picker
          const hitRegionId = hitFilledRegionAt(x, y);
          if (hitRegionId) {
            setSelected([hitRegionId]);
            const rect = el.getBoundingClientRect();
            setColorPickerState({
              regionId: hitRegionId,
              position: { x: ev.clientX - rect.left, y: ev.clientY - rect.top }
            });
            console.log('Selected filled region', hitRegionId);
            ev.stopPropagation();
            ev.preventDefault();
            return;
          }
            const hitBezId = hitBezierAt(x, y);
            if (hitBezId) {
              // Check if clicking on the curve itself (not on control points)
              // If so, start dragging the curve
              const bezier = scene.nodes[hitBezId] as any;
              if (bezier && (bezier.kind === 'bezier' || bezier.kind === 'arrow')) {
                const a = scene.nodes[bezier.a] as any;
                const b = scene.nodes[bezier.b] as any;
                const c1 = scene.nodes[bezier.c1] as any;
                const c2 = scene.nodes[bezier.c2] as any;
                
                if (a && b && c1 && c2) {
                  const result = cubicNearestPoint(
                    a.position,
                    c1.position,
                    c2.position,
                    b.position,
                    { x, y }
                  );
                  
                  // Start dragging the curve
                  draggingId = hitBezId;
                  draggingType = 'bezier-curve';
                  draggingBezierT = result.t;
                  setSelected([hitBezId]);
                  try { setInteracting(true); } catch {}
                  useSceneStore.setState({ draggingNodeType: 'bezier-curve' });
                  console.log('Start drag bezier curve', hitBezId, 'at t =', result.t);
                  ev.stopPropagation();
                  ev.preventDefault();
                  try { el.setPointerCapture(ev.pointerId); } catch {}
                }
              }
            } else {
              const hitSegId = hitSegmentAt(x, y);
              if (hitSegId) {
                // Select segment
                setSelected([hitSegId]);
                console.log('Selected segment', hitSegId);
                ev.stopPropagation();
              } else {
                // Empty canvas click: clear selection
                setSelected([]);
                // Convert only if there are NO segments at all (avoid resetting styles)
                const hasAnySegments = Object.values(scene.nodes).some((n: any) => n && n.kind === 'segment');
                const hasFunctions = Object.values(scene.nodes).some((n: any) => n && (n.kind === 'function-explicit' || n.kind === 'function-implicit'));
                if (!hasAnySegments && hasFunctions) {
                  convertFunctionsToSegments();
                  const hitAfter = hitSegmentAt(x, y);
                  if (hitAfter) {
                    setSelected([hitAfter]);
                    console.log('Selected segment (post-convert)', hitAfter);
                    ev.stopPropagation();
                  }
                }
              }
            }
          }
        }
        // else: let D3 zoom handle panning (do nothing)
      }
    };

    const onMove = (ev: PointerEvent) => {
      if (isFromPopup(ev)) return;
      const { currentTool, scene, upsertNode, setHovered, twoPointFirstClick, intersections, setHoveredIntersection, setHoveredBezierAnchor, selectedIds } = useSceneStore.getState();
      const { x, y } = worldCoords(ev);
      
      // Update current mouse position in store
      useSceneStore.setState({ currentMousePos: { x, y } });

      // Paint mode: skip expensive hover/intersection computations; only update preview (throttled).
      if (currentTool === 'paint') {
        // Clear hover artifacts if any (avoid repeated store writes)
        const st = useSceneStore.getState() as any;
        if (st.hoveredIntersection) st.setHoveredIntersection(null);
        if (st.hoveredBezierAnchorId) st.setHoveredBezierAnchor(null);
        if (st.hoveredAxisAnchorId && typeof st.setHoveredAxisAnchor === 'function') st.setHoveredAxisAnchor(null);

        const overlayRect = (el as HTMLElement).getBoundingClientRect();
        const yScale = scene.view.yScale ?? 1;

        // View bounds in world coords (account for yScale)
        const viewBounds = {
          xMin: (0 - scene.view.translate.x) / scene.view.scale,
          xMax: (overlayRect.width - scene.view.translate.x) / scene.view.scale,
          yMax: -(0 - scene.view.translate.y) / (scene.view.scale * yScale),
          yMin: -(overlayRect.height - scene.view.translate.y) / (scene.view.scale * yScale),
        };

        // Intersect with axis bounds (so preview doesn't leak outside custom axes)
        const axes = Object.values(scene.nodes).filter((n: any) => n.kind === 'axis') as any[];
        let xMin = viewBounds.xMin, xMax = viewBounds.xMax, yMin = viewBounds.yMin, yMax = viewBounds.yMax;
        for (const axis of axes) {
          const o = scene.nodes[axis.originId] as any;
          const e = scene.nodes[axis.endpointId] as any;
          if (!o || !e) continue;
          const axisName = (axis as any).name;
          if (axisName === 'X') {
            xMin = Math.max(xMin, Math.min(o.position.x, e.position.x));
            xMax = Math.min(xMax, Math.max(o.position.x, e.position.x));
          } else if (axisName === 'Y') {
            yMin = Math.max(yMin, Math.min(o.position.y, e.position.y));
            yMax = Math.min(yMax, Math.max(o.position.y, e.position.y));
          } else {
            const dx = e.position.x - o.position.x;
            const dy = e.position.y - o.position.y;
            if (Math.abs(dx) > Math.abs(dy)) {
              xMin = Math.max(xMin, Math.min(o.position.x, e.position.x));
              xMax = Math.min(xMax, Math.max(o.position.x, e.position.x));
            } else {
              yMin = Math.max(yMin, Math.min(o.position.y, e.position.y));
              yMax = Math.min(yMax, Math.max(o.position.y, e.position.y));
            }
          }
        }
        const clipBounds = { xMin, xMax, yMin, yMax };

        // Movement threshold in screen space (avoid recompute for tiny jitter)
        const sx = ev.clientX - overlayRect.left;
        const sy = ev.clientY - overlayRect.top;
        const last = paintPreviewLastScreenRef.current;
        const minMovePx = 2.0;
        if (last && Math.hypot(sx - last.sx, sy - last.sy) < minMovePx) {
          return;
        }
        paintPreviewLastScreenRef.current = { sx, sy };

        paintPreviewLatestRef.current = { x, y, clipBounds, yScale, nodesRef: scene.nodes as any };

        if (paintPreviewRafIdRef.current === null) {
          paintPreviewRafIdRef.current = requestAnimationFrame(() => {
            paintPreviewRafIdRef.current = null;
            const latest = paintPreviewLatestRef.current;
            if (!latest) return;

            const cached = paintBoundariesCacheRef.current;
            let boundaries: Array<{ start: { x: number; y: number }; end: { x: number; y: number } }>;

            if (cached && cached.nodesRef === latest.nodesRef && cached.yScale === latest.yScale) {
              boundaries = cached.boundaries;
            } else {
              boundaries = [];

              // Axes
              const axes = Object.values(latest.nodesRef).filter((n: any) => n && (n as any).kind === 'axis') as any[];
              for (const axis of axes) {
                const o = (latest.nodesRef as any)[axis.originId] as any;
                const e = (latest.nodesRef as any)[axis.endpointId] as any;
                if (!o || !e) continue;
                boundaries.push({
                  start: { x: o.position.x, y: o.position.y * latest.yScale },
                  end: { x: e.position.x, y: e.position.y * latest.yScale },
                });
              }

              // Segments (downsample aggressively for preview)
              const segments = Object.values(latest.nodesRef).filter((n: any) => n && (n as any).kind === 'segment' && !(n as any).hidden) as any[];
              const maxSegmentsPerNode = 240;
              for (const seg of segments) {
                const samples = (seg as any).samples as Array<{ x: number; y: number }> | undefined;
                if (!samples || samples.length < 2) continue;
                const n = samples.length;
                const step = Math.max(1, Math.ceil((n - 1) / maxSegmentsPerNode));
                for (let i = 0; i < n - 1; i += step) {
                  const j = Math.min(n - 1, i + step);
                  const a = samples[i];
                  const b = samples[j];
                  boundaries.push({
                    start: { x: a.x, y: a.y * latest.yScale },
                    end: { x: b.x, y: b.y * latest.yScale },
                  });
                }
              }

              paintBoundariesCacheRef.current = { nodesRef: latest.nodesRef, yScale: latest.yScale, boundaries };
            }

            const numRays = boundaries.length > 8000 ? 64 : 96;
            const poly = computePaintPreviewPolygon(
              { x: latest.x, y: latest.y },
              latest.nodesRef as any,
              latest.clipBounds,
              numRays,
              latest.yScale,
              boundaries
            );
            if (poly && poly.length >= 3) setPaintPreview({ points: poly, color: 'rgb(230, 230, 230)' });
            else setPaintPreview(null);
          });
        }
        return;
      }
      
      // Bezier anchor/handle hover detection (for selected beziers only)
      const view = scene.view;
      const thresholdWorld = 12.0 / view.scale; // 12 pixels in world units
      let closestBezierAnchor: string | null = null;
      let minBezierDist = thresholdWorld;
      
      for (const selId of selectedIds) {
        const node = scene.nodes[selId];
        if (node && ((node as any).kind === 'bezier' || (node as any).kind === 'arrow')) {
          const bez = node as any;
          const a = scene.nodes[bez.a] as any;
          const b = scene.nodes[bez.b] as any;
          const c1 = scene.nodes[bez.c1] as any;
          const c2 = scene.nodes[bez.c2] as any;
          
          // Check all 4 anchors/handles
          const anchors = [
            { id: bez.a, pos: a?.position },
            { id: bez.b, pos: b?.position },
            { id: bez.c1, pos: c1?.position },
            { id: bez.c2, pos: c2?.position }
          ];
          
          for (const anchor of anchors) {
            if (!anchor.pos) continue;
            const dist = Math.hypot(anchor.pos.x - x, anchor.pos.y - y);
            if (dist < minBezierDist) {
              minBezierDist = dist;
              closestBezierAnchor = anchor.id;
            }
          }
        }
      }
      
      setHoveredBezierAnchor(closestBezierAnchor);

      // Axis anchor hover detection
      const thresholdWorldAxis = 12.0 / view.scale; // 12 pixels in world units
      let closestAxisAnchor: string | null = null;
      let minAxisDist = thresholdWorldAxis;
      
      // Find all axis anchors (origin and endpoint of each axis)
      const nodes = scene.nodes;
      const axisAnchorIds = new Set<string>();
      for (const nodeId in nodes) {
        const node = nodes[nodeId];
        if (node && (node as any).kind === 'axis') {
          const axis = node as any;
          axisAnchorIds.add(axis.originId);
          axisAnchorIds.add(axis.endpointId);
        }
      }
      
      // Check distance to each axis anchor
      for (const anchorId of axisAnchorIds) {
        const anchor = nodes[anchorId] as any;
        if (!anchor || anchor.kind !== 'anchor') continue;
        const dist = Math.hypot(anchor.position.x - x, anchor.position.y - y);
        if (dist < minAxisDist) {
          minAxisDist = dist;
          closestAxisAnchor = anchorId;
        }
      }
      
      useSceneStore.getState().setHoveredAxisAnchor(closestAxisAnchor);

      // Get current isDraggingAxisAnchor state (set in onDown)
      const isDraggingAxisAnchor = useSceneStore.getState().isDraggingAxisAnchor;

      // Intersection point hover detection (3.3.8 style) - only in drawing modes or when dragging non-axis anchors
      const showIntersections = (currentTool !== 'select' && currentTool !== 'pan') || (draggingType === 'anchor' && !isDraggingAxisAnchor);
      
      if (showIntersections) {
        const view = scene.view;
        const thresholdWorld = 12.0 / view.scale; // 12 pixels in world units
        let closestIntersection: { x: number; y: number } | null = null;
        let minDist = thresholdWorld;
        
        for (const pt of intersections || []) {
          const dist = Math.hypot(pt.x - x, pt.y - y);
          if (dist < minDist) {
            minDist = dist;
            closestIntersection = pt;
          }
        }
        
        setHoveredIntersection(closestIntersection);
      } else {
        setHoveredIntersection(null);
      }
      
      // Two-point, circle, length-dashed, and arrow mode preview (snap to special point if hovering)
      const lengthDashedFirstClick = useSceneStore.getState().lengthDashedFirstClick;
      const arrowFirstClick = useSceneStore.getState().arrowFirstClick;
      const circleFirstClick = useSceneStore.getState().circleFirstClick;
      const circleSecondClick = useSceneStore.getState().circleSecondClick;
      const isTwoPointTool = (currentTool === 'two-point-line' || currentTool === 'two-point-segment' || currentTool === 'two-point-dashed' || currentTool === 'two-point-ray');
      const isCirclePreviewActive = (currentTool === 'circle-center' && !!circleFirstClick) || (currentTool === 'circle-3pt' && !!circleFirstClick);
      if ((twoPointFirstClick && isTwoPointTool) || isCirclePreviewActive) {
        const hoveredIntersection = useSceneStore.getState().hoveredIntersection;
        const previewPos = hoveredIntersection || { x, y };
        setPreviewEndPoint(previewPos);
      } else if (lengthDashedFirstClick && currentTool === 'length-dashed') {
        const hoveredIntersection = useSceneStore.getState().hoveredIntersection;
        const previewPos = hoveredIntersection || { x, y };
        setPreviewEndPoint(previewPos);
      } else if (arrowFirstClick && currentTool === 'arrow') {
        const hoveredIntersection = useSceneStore.getState().hoveredIntersection;
        const previewPos = hoveredIntersection || { x, y };
        setPreviewEndPoint(previewPos);
      } else {
        setPreviewEndPoint(null);
      }

      // Paint preview polygon is throttled + handled in the early-return branch above.
      // When not painting, make sure preview is cleared.
      // NOTE: at this point currentTool is already narrowed to non-'paint' (paint branch early-returns).
      if (paintPreview) setPaintPreview(null);

      if (draggingId && draggingType === 'anchor') {
        const node = scene.nodes[draggingId];
        if (node && (node as any).kind === 'anchor') {
          // Check if this anchor belongs to an axis and constrain movement
          let finalPos = getConstrainedPosition(draggingId, x, y, scene.nodes);
          
          // Check if this anchor is constrained by an axis
          const axes = Object.values(scene.nodes).filter((n: any) => n.kind === 'axis') as any[];
          const belongsToAxis = axes.some((axis: any) => 
            axis.endpointId === draggingId || axis.originId === draggingId
          );
          
          // If not constrained by axis, try to snap to special points (intersections)
          if (!belongsToAxis) {
            const view = scene.view;
            const thresholdWorld = 12.0 / view.scale; // 12 pixels in world units
            let closestSpecialPoint: { x: number; y: number } | null = null;
            let minDist = thresholdWorld;
            
            for (const pt of intersections || []) {
              const dist = Math.hypot(pt.x - finalPos.x, pt.y - finalPos.y);
              if (dist < minDist) {
                minDist = dist;
                closestSpecialPoint = pt;
              }
            }
            
            if (closestSpecialPoint) {
              finalPos = closestSpecialPoint;
            }
          }
          
          upsertNode({ ...node, position: finalPos } as any);
        }
        ev.stopPropagation();
        return;
      }

      if (draggingId && draggingType === 'bezier-curve' && draggingBezierT !== null) {
        const bezier = scene.nodes[draggingId] as any;
        if (bezier && (bezier.kind === 'bezier' || bezier.kind === 'arrow')) {
          const a = scene.nodes[bezier.a] as any;
          const b = scene.nodes[bezier.b] as any;
          const c1 = scene.nodes[bezier.c1] as any;
          const c2 = scene.nodes[bezier.c2] as any;
          
          if (a && b && c1 && c2) {
            // Calculate current point on curve at t
            const t = draggingBezierT;
            const mt = 1 - t;
            const curveX = mt*mt*mt*a.position.x + 3*mt*mt*t*c1.position.x + 3*mt*t*t*c2.position.x + t*t*t*b.position.x;
            const curveY = mt*mt*mt*a.position.y + 3*mt*mt*t*c1.position.y + 3*mt*t*t*c2.position.y + t*t*t*b.position.y;
            
            // Calculate offset from current curve position to target (mouse) position
            const dx = x - curveX;
            const dy = y - curveY;
            
            // Adjust control points based on t value
            // When t is near 0, affect c1 more; when t is near 1, affect c2 more
            // Use Bernstein basis weights for control points at parameter t
            const weight1 = 3 * mt * mt * t; // weight of c1 at t
            const weight2 = 3 * mt * t * t;   // weight of c2 at t
            const totalWeight = weight1 + weight2;
            
            if (totalWeight > 0.01) { // Avoid division by zero near endpoints
              // Distribute the offset to control points proportionally
              const factor = 1.0 / totalWeight;
              const newC1 = {
                x: c1.position.x + dx * weight1 * factor,
                y: c1.position.y + dy * weight1 * factor
              };
              const newC2 = {
                x: c2.position.x + dx * weight2 * factor,
                y: c2.position.y + dy * weight2 * factor
              };
              
              // Update control points
              upsertNode({ ...c1, position: newC1 } as any);
              upsertNode({ ...c2, position: newC2 } as any);
            }
          }
        }
        ev.stopPropagation();
        return;
      }

      if (draggingId && draggingType === 'math-text') {
        const node = scene.nodes[draggingId] as any;
        if (node && node.kind === 'math-text') {
          const { scale, translate, yScale: viewYScale } = scene.view as any;
          const yScale = viewYScale ?? 1;
          // Pointer screen position
          const sx = x * scale + translate.x;
          let sy = -y * yScale * scale + translate.y;

          // Y-center snapping (horizontal guide) - default ON, hold Alt to disable
          const magnification = scene.view.magnification ?? 1;
          const snapThresholdPx = 7 * magnification;
          const enableSnap = !ev.altKey;
          if (enableSnap && !node.bezierParentId) {
            const snapped = findSnapY(sy, draggingId, scene, snapThresholdPx);
            if (snapped !== null) {
              sy = snapped;
              setGuide(snapped);
            } else {
              setGuide(null);
            }
          } else {
            setGuide(null);
          }
          
          if (node.bezierParentId) {
            // Constrain to bezier curve: find nearest point on curve and update bezierT
            const bezier = scene.nodes[node.bezierParentId] as any;
            if (bezier && bezier.kind === 'bezier') {
              const a = scene.nodes[bezier.a] as any;
              const b = scene.nodes[bezier.b] as any;
              const c1 = scene.nodes[bezier.c1] as any;
              const c2 = scene.nodes[bezier.c2] as any;
              
              if (a && b && c1 && c2 && a.kind === 'anchor' && b.kind === 'anchor' && c1.kind === 'anchor' && c2.kind === 'anchor') {
                // Find nearest point on bezier curve to pointer position
                const result = cubicNearestPoint(
                  a.position,
                  c1.position,
                  c2.position,
                  b.position,
                  { x, y }
                );
                
                // Update bezierT to move label along curve
                upsertNode({ ...node, bezierT: result.t } as any);
              }
            }
          } else if (node.axisId) {
            // Move via offset from axis endpoint
            const magnification = scene.view.magnification ?? 1;
            const axis = scene.nodes[node.axisId] as any;
            const endpoint = axis ? scene.nodes[axis.endpointId] as any : null;
            if (endpoint && endpoint.kind === 'anchor') {
              const ex = endpoint.position.x * scale + translate.x;
              const ey = -endpoint.position.y * yScale * scale + translate.y;
              // offsetPx is stored without magnification, so divide by magnification when setting
              const newOffset = { x: (sx - ex) / magnification, y: (sy - ey) / magnification };
              upsertNode({ ...node, offsetPx: newOffset } as any);
            } else {
              // Fallback to absolute move
              const snappedWorldY = -(sy - translate.y) / (yScale * scale);
              upsertNode({ ...node, position: { x, y: snappedWorldY } } as any);
            }
          } else if (node.offsetPx) {
            // Move rmO (offset-based) relative to its base world position
            const magnification = scene.view.magnification ?? 1;
            const bx = node.position.x * scale + translate.x;
            const by = -node.position.y * yScale * scale + translate.y;
            // offsetPx is stored without magnification, so divide by magnification when setting
            const newOffset = { x: (sx - bx) / magnification, y: (sy - by) / magnification };
            upsertNode({ ...node, offsetPx: newOffset } as any);
          } else {
            // Regular math-text without offset: move in world space
            const snappedWorldY = -(sy - translate.y) / (yScale * scale);
            upsertNode({ ...node, position: { x, y: snappedWorldY } } as any);
          }
        }
        ev.stopPropagation();
        return;
      }

      // Hover feedback (priority: anchor > math-text > point > region > segment)
      if (currentTool === 'select') {
        const hitAnchorId = hitAnchorAt(x, y);
        if (hitAnchorId) {
          const anchor = scene.nodes[hitAnchorId] as any;
          setHoverAnchor(anchor.position);
          setHovered(null);
          (el.style as any).cursor = 'pointer';
          return;
        }
        const hitMathTextId = hitMathTextAt(x, y);
        if (hitMathTextId) {
          setHoverAnchor(null);
          try { useSceneStore.getState().setHovered(hitMathTextId); } catch {}
          (el.style as any).cursor = 'move';
          return;
        }
        const hitPtId = hitPointAt(x, y);
        if (hitPtId) {
          setHoverAnchor(null);
          setHovered(hitPtId);
          (el.style as any).cursor = 'pointer';
          return;
        }
        const hitAngleId = hitAngleAt(x, y);
        if (hitAngleId) {
          setHoverAnchor(null);
          setHovered(hitAngleId);
          (el.style as any).cursor = 'pointer';
          return;
        }
        const hitRegionId = hitFilledRegionAt(x, y);
        if (hitRegionId) {
          setHoverAnchor(null);
          setHovered(null);
          (el.style as any).cursor = 'pointer';
          return;
        }
        const hitBezId = hitBezierAt(x, y);
        if (hitBezId) {
          setHoverAnchor(null);
          setHovered(hitBezId);
          (el.style as any).cursor = 'move'; // Use 'move' cursor for curve dragging
          return;
        }
        const hitSegId = hitSegmentAt(x, y);
        if (hitSegId) {
          setHoverAnchor(null);
          setHovered(hitSegId);
          (el.style as any).cursor = 'pointer';
        } else {
          setHoverAnchor(null);
          setHovered(null);
          (el.style as any).cursor = 'grab';
        }
      } else if (currentTool === 'two-point-angle') {
        // In angle mode, highlight segments and axes on hover
        let hitId = hitSegmentAt(x, y);
        
        // If no segment, check for axis
        if (!hitId) {
          const axes = Object.values(scene.nodes).filter((n: any) => n.kind === 'axis') as any[];
          const threshold = 10 / scene.view.scale;
          
          for (const axis of axes) {
            const origin = scene.nodes[axis.originId] as any;
            const endpoint = scene.nodes[axis.endpointId] as any;
            if (!origin || !endpoint) continue;
            
            const dist = pointToLineSegmentDistance(
              { x, y },
              origin.position,
              endpoint.position
            );
            
            if (dist <= threshold) {
              hitId = axis.id;
              break;
            }
          }
        }
        
        if (hitId) {
          setHovered(hitId);
          (el.style as any).cursor = 'crosshair';
        } else {
          setHovered(null);
          (el.style as any).cursor = 'crosshair';
        }
        setHoverAnchor(null);
      } else if (currentTool === 'pan') {
        (el.style as any).cursor = 'grab';
        setHoverAnchor(null);
        useSceneStore.getState().setHovered(null);
      } else {
        // Drawing tools: line, bezier, length-dashed, two-point tools, curve tools, paint
        const drawingTools = ['line', 'bezier', 'length-dashed', 'two-point-line', 'two-point-segment', 
                              'two-point-dashed', 'two-point-ray', 'two-point-angle', 
                              'curve-point', 'curve-tangent', 'paint'];
        if (drawingTools.includes(currentTool as any)) {
          (el.style as any).cursor = 'crosshair';
          setHoverAnchor(null);
          useSceneStore.getState().setHovered(null);
        }
      }
    };

    const onUp = (ev: PointerEvent) => {
      if (isFromPopup(ev)) return;
      if (draggingId) console.log('End drag', draggingId);
      // end batch
      try { useSceneStore.getState().setInteracting(false); } catch {}
      setGuide(null);
      draggingId = null;
      draggingType = null;
      draggingBezierT = null;
      useSceneStore.setState({ draggingNodeType: null });
      try { el.releasePointerCapture(ev.pointerId); } catch {}
      const tool = useSceneStore.getState().currentTool;
      const isTwoPointTool = tool === 'two-point-line' || tool === 'two-point-segment' || tool === 'two-point-dashed' || tool === 'two-point-ray' || tool === 'two-point-angle';
      const isDrawingTool = tool === 'line' || tool === 'bezier' || tool === 'length-dashed' || isTwoPointTool;
      (el.style as any).cursor = tool === 'select' ? 'grab' : (tool === 'pan' ? 'grab' : (isDrawingTool ? 'crosshair' : 'default'));
    };
    
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    
    // Double-click to edit math-text
    const onDblClick = (ev: PointerEvent) => {
      if (isFromPopup(ev)) return;
      const { scene } = useSceneStore.getState();
      const { x, y } = worldCoords(ev);
      const hitId = hitMathTextAt(x, y);
      if (!hitId) return;
      const mt = scene.nodes[hitId] as any;
      if (!mt || mt.kind !== 'math-text') return;
      
      // Don't allow editing labels attached to bezier (they're managed via BezierControls popup)
      if (mt.bezierParentId) {
        return;
      }
      
      // Compute screen position like in hitMathTextAt
      const { scale, translate, yScale: viewYScale } = scene.view as any;
      const yScale = viewYScale ?? 1;
      let labelSx: number;
      let labelSy: number;
      if (mt.axisId && mt.offsetPx) {
        const axis = scene.nodes[mt.axisId] as any;
        const endpoint = axis ? scene.nodes[axis.endpointId] as any : null;
        if (endpoint && endpoint.kind === 'anchor') {
          const ex = endpoint.position.x * scale + translate.x;
          const ey = -endpoint.position.y * yScale * scale + translate.y;
          labelSx = ex + mt.offsetPx.x;
          labelSy = ey + mt.offsetPx.y;
        } else {
          labelSx = mt.position.x * scale + translate.x;
          labelSy = -mt.position.y * yScale * scale + translate.y;
        }
      } else if (mt.offsetPx) {
        const bx = mt.position.x * scale + translate.x;
        const by = -mt.position.y * yScale * scale + translate.y;
        labelSx = bx + mt.offsetPx.x;
        labelSy = by + mt.offsetPx.y;
      } else {
        labelSx = mt.position.x * scale + translate.x;
        labelSy = -mt.position.y * yScale * scale + translate.y;
      }
      // Convert container-relative coords to viewport coords for position: fixed
      const rect = (el as HTMLElement).getBoundingClientRect();
      setEditingMathId(hitId);
      setEditingPos({ x: rect.left + labelSx, y: rect.top + labelSy });
      ev.preventDefault();
      ev.stopPropagation();
    };
    el.addEventListener('dblclick', onDblClick as any, { capture: true } as any);

    // Global delete/backspace and ESC handler (capture) to remove selected segments and reset tool
    const onKey = (e: KeyboardEvent) => {
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
      if (e.key === 'Delete') {
        const { selectedIds, hoveredId, removeNode, setSelected } = useSceneStore.getState() as any;
        console.log('Delete pressed. selected:', selectedIds, 'hovered:', hoveredId);
        const targets: string[] = (selectedIds && selectedIds.length > 0)
          ? [...selectedIds]
          : (hoveredId ? [hoveredId] : []);
        if (targets.length > 0) {
          for (const id of targets) removeNode(id);
          setSelected([]);
          e.preventDefault();
          e.stopPropagation();
        }
      } else if (e.key === 'Escape') {
        const state = useSceneStore.getState() as any;
        const { currentTool, setTool, setTwoPointFirstClick, setTwoPointAngleFirstSegment, setLengthDashedFirstClick, setView, savedViewBeforeMagnifier } = state;
        
        // If exiting magnifier mode, restore saved view
        if (currentTool === 'magnifier' && savedViewBeforeMagnifier) {
          setView(savedViewBeforeMagnifier);
          useSceneStore.setState({ savedViewBeforeMagnifier: null });
        }
        
        setTwoPointFirstClick(null); // Reset two-point mode
        setTwoPointAngleFirstSegment(null); // Reset angle mode
        setLengthDashedFirstClick(null); // Reset length-dashed mode
        setTool('select');
        console.log('ESC pressed. Tool reset to select.');
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('keydown', onKey, { capture: true } as any);
    window.addEventListener('keydown', onKey, { capture: true } as any);
    
    // Prevent context menu in magnifier mode
    const onContextMenu = (ev: MouseEvent) => {
      const { currentTool } = useSceneStore.getState() as any;
      if (currentTool === 'magnifier') {
        ev.preventDefault();
        ev.stopPropagation();
      }
    };
    el.addEventListener('contextmenu', onContextMenu as any);
    
    return () => {
      setGuide(null);
      // Cancel any scheduled paint preview computation
      if (paintPreviewRafIdRef.current !== null) {
        try { cancelAnimationFrame(paintPreviewRafIdRef.current); } catch {}
        paintPreviewRafIdRef.current = null;
      }
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('contextmenu', onContextMenu as any);
      document.removeEventListener('keydown', onKey as any, { capture: true } as any);
      window.removeEventListener('keydown', onKey as any, { capture: true } as any);
      el.removeEventListener('dblclick', onDblClick as any, { capture: true } as any);
    };
  }, []);

  // Render hover preview point and two-point mode preview
  const scene = useSceneStore((s) => s.scene);
  const twoPointFirstClick = useSceneStore((s) => s.twoPointFirstClick);
  const lengthDashedFirstClick = useSceneStore((s) => s.lengthDashedFirstClick);
  const arrowFirstClick = useSceneStore((s) => s.arrowFirstClick);
  const currentTool = useSceneStore((s) => s.currentTool);
  const selectedIds = useSceneStore((s) => s.selectedIds);
  const hoveredId = useSceneStore((s) => s.hoveredId);
  
  // Compute paint preview polygon (ray casting like Pixi renderer uses).
  // IMPORTANT:
  // - We pass in `boundaries` precomputed/cached in the pointermove rAF callback.
  // - Geometry is computed in y-scaled space, then converted back to world-y so `worldToScreen`
  //   applies yScale exactly once.
  function computePaintPreviewPolygon(
    center: { x: number; y: number },
    _nodes: Record<string, any>,
    clip: { xMin: number; xMax: number; yMin: number; yMax: number },
    numRays: number,
    yScale: number,
    boundaries: Array<{ start: { x: number; y: number }; end: { x: number; y: number } }>
  ): { x: number; y: number }[] {
    const ys = Math.max(1e-9, yScale);
    const invYS = 1 / ys;

    const cx = center.x;
    const cy = center.y * ys;
    const clipScaled = { xMin: clip.xMin, xMax: clip.xMax, yMin: clip.yMin * ys, yMax: clip.yMax * ys };
    const maxDist = Math.max(Math.abs(clipScaled.xMax - clipScaled.xMin), Math.abs(clipScaled.yMax - clipScaled.yMin)) * 2;

    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < numRays; i++) {
      const angle = (i / numRays) * Math.PI * 2;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      let best = maxDist;

      // rect
      const rectD = rayRectIntersection(cx, cy, dx, dy, clipScaled);
      if (rectD !== null) best = Math.min(best, rectD);

      // boundaries
      for (const b of boundaries) {
        const inter = raySegmentIntersection(cx, cy, dx, dy, b.start.x, b.start.y, b.end.x, b.end.y);
        if (inter && inter.distance < best) best = inter.distance;
      }

      const px = cx + dx * best;
      const pyScaled = cy + dy * best;
      pts.push({ x: px, y: pyScaled * invYS });
    }
    return pts;
  }

  // Convert world to screen coordinates
  const worldToScreen = (wx: number, wy: number) => {
    const yScale = scene.view.yScale ?? 1;
    const sx = wx * scene.view.scale + scene.view.translate.x;
    const sy = -wy * yScale * scene.view.scale + scene.view.translate.y;
    return { sx, sy };
  };

  return (
    <div ref={ref} style={{ position: 'absolute', inset: 0, touchAction: 'none', zIndex: 1, pointerEvents: 'auto' }}>
      {/* Horizontal guide line for math-text Y-center snapping */}
      {snapGuideY !== null && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: snapGuideY,
            height: 1,
            background: 'rgba(33,150,243,0.9)',
            boxShadow: '0 0 0 1px rgba(33,150,243,0.25)',
            pointerEvents: 'none',
            zIndex: 30
          }}
        />
      )}
      {/* Length-dashed mode preview */}
      {lengthDashedFirstClick && previewEndPoint && currentTool === 'length-dashed' && (() => {
        const { sx: sx1, sy: sy1 } = worldToScreen(lengthDashedFirstClick.x, lengthDashedFirstClick.y);
        const { sx: sx2, sy: sy2 } = worldToScreen(previewEndPoint.x, previewEndPoint.y);
        
        // C-shape bezier preview (screen coordinates, Y-down)
        const dx = sx2 - sx1;
        const dy = sy2 - sy1;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist < 1) return null;
        
        // Screen coordinates have Y-down, so perpendicular direction needs to be flipped
        const perpX = dy / dist;  // Flipped from world coordinates
        const perpY = -dx / dist; // Flipped from world coordinates
        const offset = dist * 0.25;
        
        const c1x = sx1 + dx * 0.33 + perpX * offset;
        const c1y = sy1 + dy * 0.33 + perpY * offset;
        const c2x = sx1 + dx * 0.67 + perpX * offset;
        const c2y = sy1 + dy * 0.67 + perpY * offset;
        
        const path = `M ${sx1} ${sy1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${sx2} ${sy2}`;
        
        return (
          <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}>
            <path
              d={path}
              stroke="#2196F3"
              strokeWidth={1}
              strokeDasharray="5,3"
              fill="none"
              strokeOpacity={0.6}
            />
            {/* First point marker */}
            <circle cx={sx1} cy={sy1} r={4} fill="#2196F3" opacity={0.8} />
            {/* Preview end point marker */}
            <circle cx={sx2} cy={sy2} r={4} fill="#2196F3" opacity={0.5} />
          </svg>
        );
      })()}
      
      {/* Arrow mode preview */}
      {arrowFirstClick && previewEndPoint && currentTool === 'arrow' && (() => {
        const { sx: sx1, sy: sy1 } = worldToScreen(arrowFirstClick.x, arrowFirstClick.y);
        const { sx: sx2, sy: sy2 } = worldToScreen(previewEndPoint.x, previewEndPoint.y);
        
        const dx = sx2 - sx1;
        const dy = sy2 - sy1;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist < 1) return null;
        
        const perpX = dy / dist;
        const perpY = -dx / dist;
        const offset = dist * 0.25;
        
        const c1x = sx1 + dx * 0.33 + perpX * offset;
        const c1y = sy1 + dy * 0.33 + perpY * offset;
        const c2x = sx1 + dx * 0.67 + perpX * offset;
        const c2y = sy1 + dy * 0.67 + perpY * offset;
        
        const path = `M ${sx1} ${sy1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${sx2} ${sy2}`;
        
        // Calculate arrow direction from bezier tangent at end point (t=1)
        // Tangent at t=1: 3(P3 - P2) where P2=c2, P3=end
        const tangentX = sx2 - c2x;
        const tangentY = sy2 - c2y;
        const tangentLen = Math.sqrt(tangentX * tangentX + tangentY * tangentY);
        
        // Arrow size
        const arrowLen = 10;
        const arrowWidth = 5;
        
        if (tangentLen > 0.1) {
          // Normalized tangent direction
          const tx = tangentX / tangentLen;
          const ty = tangentY / tangentLen;
          
          // Arrow vertices
          const arrowBase = { x: sx2 - tx * arrowLen, y: sy2 - ty * arrowLen };
          const arrowLeft = { x: arrowBase.x - ty * arrowWidth, y: arrowBase.y + tx * arrowWidth };
          const arrowRight = { x: arrowBase.x + ty * arrowWidth, y: arrowBase.y - tx * arrowWidth };
          
          return (
            <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}>
              <path
                d={path}
                stroke="#FFA726"
                strokeWidth={1}
                fill="none"
                strokeOpacity={0.6}
              />
              <circle cx={sx1} cy={sy1} r={4} fill="#FFA726" opacity={0.8} />
              <circle cx={sx2} cy={sy2} r={4} fill="#FFA726" opacity={0.5} />
              {/* Arrow with correct direction */}
              <path
                d={`M ${arrowLeft.x} ${arrowLeft.y} L ${sx2} ${sy2} L ${arrowRight.x} ${arrowRight.y}`}
                stroke="#FFA726"
                strokeWidth={2}
                fill="none"
                strokeOpacity={0.8}
              />
            </svg>
          );
        }
        
        return (
          <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}>
            <path
              d={path}
              stroke="#FFA726"
              strokeWidth={1}
              fill="none"
              strokeOpacity={0.6}
            />
            <circle cx={sx1} cy={sy1} r={4} fill="#FFA726" opacity={0.8} />
            <circle cx={sx2} cy={sy2} r={4} fill="#FFA726" opacity={0.5} />
          </svg>
        );
      })()}

      {/* Two-point mode preview line */}
      {twoPointFirstClick && previewEndPoint && (
        currentTool === 'two-point-line' || currentTool === 'two-point-segment' || 
        currentTool === 'two-point-dashed' || currentTool === 'two-point-ray'
      ) && (() => {
        const { sx: sx1, sy: sy1 } = worldToScreen(twoPointFirstClick.x, twoPointFirstClick.y);
        const { sx: sx2, sy: sy2 } = worldToScreen(previewEndPoint.x, previewEndPoint.y);
        
        // Calculate direction for infinite line/ray extension
        const dx = sx2 - sx1;
        const dy = sy2 - sy1;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1) return null;
        
        const dirX = dx / len;
        const dirY = dy / len;
        const extendLen = 10000; // Large enough to cover viewport
        
        let startX = sx1, startY = sy1, endX = sx2, endY = sy2;
        
        if (currentTool === 'two-point-line') {
          // Extend both directions
          startX = sx1 - dirX * extendLen;
          startY = sy1 - dirY * extendLen;
          endX = sx2 + dirX * extendLen;
          endY = sy2 + dirY * extendLen;
        } else if (currentTool === 'two-point-ray') {
          // Extend only end
          endX = sx2 + dirX * extendLen;
          endY = sy2 + dirY * extendLen;
        }
        
        const isDashed = currentTool === 'two-point-dashed';
        
        return (
          <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}>
            <line
              x1={startX}
              y1={startY}
              x2={endX}
              y2={endY}
              stroke="#2196F3"
              strokeWidth={2}
              strokeDasharray={isDashed ? '10,5' : undefined}
              strokeOpacity={0.6}
            />
            {/* First point marker */}
            <circle cx={sx1} cy={sy1} r={4} fill="#2196F3" opacity={0.8} />
            {/* Preview end point marker */}
            <circle cx={sx2} cy={sy2} r={4} fill="#2196F3" opacity={0.5} />
          </svg>
        );
      })()}

      {/* Circle-center preview: center to mouse */}
      {(() => {
        if (currentTool !== 'circle-center') return null;
        const center = useSceneStore.getState().circleFirstClick;
        if (!center || !previewEndPoint) return null;
        const { sx: cx, sy: cy } = worldToScreen(center.x, center.y);
        const { sx: px, sy: py } = worldToScreen(previewEndPoint.x, previewEndPoint.y);
        const r = Math.hypot(px - cx, py - cy);
        if (r < 1) return null;
        return (
          <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}>
            <circle cx={cx} cy={cy} r={r} stroke="#2196F3" strokeWidth={1} fill="none" strokeOpacity={0.6} />
            <circle cx={cx} cy={cy} r={3} fill="#2196F3" opacity={0.8} />
          </svg>
        );
      })()}

      {/* Circle-3pt preview: two clicks + mouse */}
      {(() => {
        if (currentTool !== 'circle-3pt') return null;
        const p1 = useSceneStore.getState().circleFirstClick;
        const p2 = useSceneStore.getState().circleSecondClick;
        if (!p1 || !p2 || !previewEndPoint) return null;
        const x1 = p1.x, y1 = p1.y, x2 = p2.x, y2 = p2.y, x3 = previewEndPoint.x, y3 = previewEndPoint.y;
        const A = x1*(y2 - y3) - y1*(x2 - x3) + x2*y3 - x3*y2;
        if (Math.abs(A) < 1e-9) return null;
        const B = (x1*x1 + y1*y1)*(y3 - y2) + (x2*x2 + y2*y2)*(y1 - y3) + (x3*x3 + y3*y3)*(y2 - y1);
        const C = (x1*x1 + y1*y1)*(x2 - x3) + (x2*x2 + y2*y2)*(x3 - x1) + (x3*x3 + y3*y3)*(x1 - x2);
        const cxw = -B / (2*A);
        const cyw = -C / (2*A);
        const { sx: cx, sy: cy } = worldToScreen(cxw, cyw);
        const r = Math.hypot(worldToScreen(x1, y1).sx - cx, worldToScreen(x1, y1).sy - cy);
        if (!Number.isFinite(r) || r < 1) return null;
        return (
          <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}>
            <circle cx={cx} cy={cy} r={r} stroke="#2196F3" strokeWidth={1} fill="none" strokeOpacity={0.6} />
          </svg>
        );
      })()}

      {/* Math-text hover/selection highlight sized to actual label */}
      {(() => {
        const mtId = hoveredId && (scene.nodes[hoveredId] as any)?.kind === 'math-text' ? hoveredId : (selectedIds.find(id => (scene.nodes[id] as any)?.kind === 'math-text') || null);
        if (!mtId) return null;
        const mt = scene.nodes[mtId] as any;
        const { scale, translate, yScale: viewYScale } = scene.view as any;
        const yScale = viewYScale ?? 1;
        let sx: number; let sy: number;
        if (mt.bezierParentId && typeof mt.bezierT === 'number') {
          const bezier = scene.nodes[mt.bezierParentId] as any;
          if (bezier && bezier.kind === 'bezier') {
            const a = scene.nodes[bezier.a] as any;
            const b = scene.nodes[bezier.b] as any;
            const c1 = scene.nodes[bezier.c1] as any;
            const c2 = scene.nodes[bezier.c2] as any;
            
            if (a && b && c1 && c2 && a.kind === 'anchor' && b.kind === 'anchor' && c1.kind === 'anchor' && c2.kind === 'anchor') {
              const t = mt.bezierT;
              const mt_val = 1 - t;
              const wx = mt_val*mt_val*mt_val*a.position.x + 3*mt_val*mt_val*t*c1.position.x + 3*mt_val*t*t*c2.position.x + t*t*t*b.position.x;
              const wy = mt_val*mt_val*mt_val*a.position.y + 3*mt_val*mt_val*t*c1.position.y + 3*mt_val*t*t*c2.position.y + t*t*t*b.position.y;
              
              sx = wx * scale + translate.x;
              sy = -wy * yScale * scale + translate.y;
            } else {
              sx = mt.position.x * scale + translate.x;
              sy = -mt.position.y * yScale * scale + translate.y;
            }
          } else {
            sx = mt.position.x * scale + translate.x;
            sy = -mt.position.y * yScale * scale + translate.y;
          }
        } else if (mt.axisId && mt.offsetPx) {
          const magnification = scene.view.magnification ?? 1;
          const axis = scene.nodes[mt.axisId] as any;
          const endpoint = axis ? scene.nodes[axis.endpointId] as any : null;
          if (endpoint && endpoint.kind === 'anchor') {
            const ex = endpoint.position.x * scale + translate.x;
            const ey = -endpoint.position.y * yScale * scale + translate.y;
            sx = ex + mt.offsetPx.x * magnification;
            sy = ey + mt.offsetPx.y * magnification;
          } else {
            sx = mt.position.x * scale + translate.x;
            sy = -mt.position.y * yScale * scale + translate.y;
          }
        } else if (mt.offsetPx) {
          const magnification = scene.view.magnification ?? 1;
          const bx = mt.position.x * scale + translate.x;
          const by = -mt.position.y * yScale * scale + translate.y;
          sx = bx + mt.offsetPx.x * magnification;
          sy = by + mt.offsetPx.y * magnification;
        } else {
          sx = mt.position.x * scale + translate.x;
          sy = -mt.position.y * yScale * scale + translate.y;
        }
        let w = 140, h = 70;
        try {
          // Convert getBBox to pixels directly
          const el = document.querySelector(`[data-math-label-id="${mt.id}"]`) as HTMLElement | null;
          if (el) {
            const svgEl = el.querySelector('svg');
            if (svgEl) {
              try {
                const bbox = svgEl.getBBox();
                if (bbox && bbox.width > 0 && bbox.height > 0) {
                  const declaredWidth = parseFloat(svgEl.getAttribute('width') || '0');
                  const viewBox = svgEl.getAttribute('viewBox');
                  if (declaredWidth > 0 && viewBox) {
                    const vbParts = viewBox.split(/\s+/).map(parseFloat);
                    if (vbParts.length === 4) {
                      const [, , vbW, vbH] = vbParts;
                      const scale = declaredWidth / vbW;
                      w = bbox.width * scale;
                      h = bbox.height * scale;
                    }
                  }
                }
              } catch {
                const rect = el.getBoundingClientRect();
                w = rect.width;
                h = rect.height;
              }
            } else {
              const rect = el.getBoundingClientRect();
              w = rect.width;
              h = rect.height;
            }
          } else {
            // Fallback to HTML parsing
            const magnification = scene.view.magnification ?? 1;
            const rawSize = (mt as any).fontSize ?? 11;
            const paramPt = rawSize > 15 ? (rawSize / 24) * 11 : rawSize;
            const visualPx = (paramPt / 11) * 24 * magnification;
            const html = renderMathToHtml(mt.latex, visualPx, (mt as any).color ?? '#000000');
            const m = html.match(/width=\"([0-9.]+)px\"[\s\S]*?height=\"([0-9.]+)px\"/);
            if (m) {
              w = parseFloat(m[1]);
              h = parseFloat(m[2]);
            }
          }
        } catch {}
        const magnification = scene.view.magnification ?? 1;
        const pad = 8 * magnification;
        w += pad; h += pad;
        const bg = selectedIds.includes(mtId) ? 'rgba(0,0,0,0.12)' : 'rgba(0,0,0,0.06)';
        return (
          <div style={{ position: 'absolute', left: sx - w/2, top: sy - h/2, width: w, height: h, pointerEvents: 'none', border: 'none', borderRadius: 8, background: bg }} />
        );
      })()}

      {/* Math-text editor popup */}
      {editingMathId && editingPos && (() => {
        const mt = scene.nodes[editingMathId] as any;
        if (!mt || mt.kind !== 'math-text') return null;
        const rawSize = (mt as any).fontSize ?? 11;
        const paramPt = rawSize > 15 ? (rawSize / 24) * 11 : rawSize;
        return (
          <div 
            data-ac-popup="1"
            style={{ position: 'fixed', left: editingPos.x, top: editingPos.y + 24, transform: 'translate(-50%, 0)', background: 'rgba(58,58,60,0.92)', border: '1px solid rgba(0,0,0,0.35)', borderRadius: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.35)', padding: 12, zIndex: 2000, pointerEvents: 'auto', minWidth: 180, color: '#fff' }}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => { e.stopPropagation(); }}
            onPointerMove={(e) => { e.stopPropagation(); }}
            onPointerUp={(e) => { e.stopPropagation(); }}
            onPointerOver={(e) => { e.stopPropagation(); }}
            onPointerOut={(e) => { e.stopPropagation(); }}
            onMouseDown={(e) => { e.stopPropagation(); }}
            onMouseMove={(e) => { e.stopPropagation(); }}
            onMouseUp={(e) => { e.stopPropagation(); }}
            onMouseOver={(e) => { e.stopPropagation(); }}
            onMouseOut={(e) => { e.stopPropagation(); }}
            onWheel={(e) => { e.stopPropagation(); }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {/* @ts-expect-error custom element */}
                <math-field
                  value={mt.latex}
                  style={{ flex: 1, minWidth: 100, fontSize: '18px', padding: '6px 10px', border: '1px solid rgba(255,255,255,0.22)', borderRadius: 8, background: 'rgba(255,255,255,0.10)', color: '#fff', overflow: 'hidden' }}
                  onInput={(e: any) => {
                    const v = (e.currentTarget as any).value || '';
                    try { useSceneStore.getState().upsertNode({ ...mt, latex: v } as any); } catch {}
                  }}
                />
                <button
                  onClick={() => { setEditingMathId(null); setEditingPos(null); }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.18)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.10)'; }}
                  style={{ padding: '8px 12px', background: 'rgba(255,255,255,0.10)', border: 'none', borderRadius: 8, fontSize: 12, color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: 600, transition: 'background 0.2s' }}
                >닫기</button>
              </div>
              
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, justifyContent: 'space-between' }}>
                {/* Display above curves toggle - modern style */}
                <label 
                  style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: 10, 
                    cursor: 'pointer', 
                    padding: '0',
                    background: 'transparent',
                    borderRadius: 8,
                    border: 'none',
                    transition: 'all 0.2s',
                    flex: 1
                  }}
                >
                  <div style={{
                    width: 20,
                    height: 20,
                    borderRadius: 4,
                    background: mt.displayAboveCurves ? '#2196F3' : 'rgba(255,255,255,0.1)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'all 0.2s'
                  }}>
                    {mt.displayAboveCurves && (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                        <path d="M5 12l5 5L20 7" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </div>
                  <input
                    type="checkbox"
                    checked={!!mt.displayAboveCurves}
                    onChange={(e) => {
                      try {
                        useSceneStore.getState().upsertNode({ ...mt, displayAboveCurves: e.target.checked } as any);
                      } catch {}
                    }}
                    style={{ display: 'none' }}
                  />
                  <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.9)', fontWeight: 500 }}>곡선 위에 표시</span>
                </label>
                
                {/* Font size input - compact style */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    key={`font-size-${editingMathId}`}
                    type="text"
                    defaultValue={paramPt}
                    onChange={(e) => {
                      const val = e.currentTarget.value;
                      // Allow empty string for deletion (don't update state)
                      if (val === '') {
                        return;
                      }
                      const parsed = parseFloat(val);
                      if (!isNaN(parsed) && parsed > 0) {
                        try { useSceneStore.getState().upsertNode({ ...mt, fontSize: parsed } as any); } catch {}
                      }
                    }}
                    onBlur={(e) => {
                      // Reset to current value or default if empty on blur
                      const val = e.currentTarget.value;
                      if (val === '' || isNaN(parseFloat(val))) {
                        const currentSize = (mt as any).fontSize ?? 11;
                        const currentParamPt = currentSize > 15 ? (currentSize / 24) * 11 : currentSize;
                        e.currentTarget.value = String(currentParamPt);
                        try { useSceneStore.getState().upsertNode({ ...mt, fontSize: currentParamPt } as any); } catch {}
                      }
                    }}
                    style={{ 
                      width: 24, 
                      padding: '4px 6px', 
                      border: 'none', 
                      borderRadius: 4, 
                      background: 'rgba(255,255,255,0.10)', 
                      color: '#fff', 
                      fontSize: 11,
                      textAlign: 'center'
                    }}
                  />
                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>pt</span>
                </div>
              </div>
              
              {/* Color picker */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.1)' }}>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.9)' }}>색상</span>
                <input 
                  type="color" 
                  value={mt.color || '#000000'} 
                  onChange={(e) => {
                    try {
                      useSceneStore.getState().upsertNode({ ...mt, color: e.target.value } as any);
                    } catch {}
                  }}
                  style={{ 
                    width: 28, 
                    height: 28, 
                    border: 'none', 
                    padding: 0, 
                    background: 'none', 
                    cursor: 'pointer', 
                    borderRadius: 4 
                  }}
                />
              </div>
            </div>
          </div>
        );
      })()}

      {/* Color picker popup */}
      {colorPickerState && (() => {
        const region = scene.nodes[colorPickerState.regionId] as any;
        if (!region || region.kind !== 'filled-region') return null;
        
        const currentColor = region.fillColor || 'rgb(230, 230, 230)';
        
        // Parse RGB from string like "rgb(230, 230, 230)"
        const rgbMatch = currentColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        const [r, g, b] = rgbMatch ? [parseInt(rgbMatch[1]), parseInt(rgbMatch[2]), parseInt(rgbMatch[3])] : [230, 230, 230];
        
        const updateColor = (newR: number, newG: number, newB: number) => {
          const newColor = `rgb(${newR}, ${newG}, ${newB})`;
          useSceneStore.getState().upsertNode({
            ...region,
            fillColor: newColor
          } as any);
        };
        
        const clamp = (v: number) => Math.max(0, Math.min(255, v | 0));
        return (
          <div
            data-ac-popup="1"
            style={{
              position: 'absolute',
              left: colorPickerState.position.x,
              top: colorPickerState.position.y - 50,
              background: 'rgba(58,58,60,0.92)',
              padding: 12,
              border: '1px solid rgba(0,0,0,0.35)',
              borderRadius: 12,
              boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
              display: 'flex',
              flexDirection: 'column',
              gap: 5,
              zIndex: 1000,
              minWidth: 240,
              color: '#fff'
            }}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => { e.stopPropagation(); }}
            onPointerMove={(e) => { e.stopPropagation(); }}
            onPointerUp={(e) => { e.stopPropagation(); }}
            onPointerOver={(e) => { e.stopPropagation(); }}
            onPointerOut={(e) => { e.stopPropagation(); }}
            onMouseDown={(e) => { e.stopPropagation(); }}
            onMouseMove={(e) => { e.stopPropagation(); }}
            onMouseUp={(e) => { e.stopPropagation(); }}
            onMouseOver={(e) => { e.stopPropagation(); }}
            onMouseOut={(e) => { e.stopPropagation(); }}
            onWheel={(e) => { e.stopPropagation(); }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  background: currentColor,
                  borderRadius: 4,
                  border: '2px solid rgba(255,255,255,0.3)'
                }}
              />
              <span style={{ color: '#fff', fontSize: 12, fontWeight: 500 }}>색상 조정</span>
              <button
                onClick={() => setColorPickerState(null)}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.18)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.10)'; }}
                style={{
                  marginLeft: 'auto',
                  background: 'rgba(255,255,255,0.10)',
                  border: 'none',
                  borderRadius: 8,
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: 12,
                  padding: '8px 12px',
                  fontWeight: 600,
                  transition: 'background 0.2s',
                  whiteSpace: 'nowrap'
                }}
              >
                닫기
              </button>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <label style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto 48px', alignItems: 'center', gap: 8, color: '#fff', fontSize: 11 }}>
                <span style={{ width: 15 }}>R</span>
                <input
                  type="range"
                  min="0"
                  max="255"
                  value={r}
                  onChange={(e) => updateColor(clamp(parseInt(e.target.value)), g, b)}
                  style={{ width: '100%' }}
                />
                <span style={{ width: 30, textAlign: 'right' }}>{r}</span>
                <input
                  type="number"
                  min={0}
                  max={255}
                  value={r}
                  onChange={(e) => {
                    const v = clamp(parseInt(e.target.value || '0'));
                    updateColor(v, g, b);
                  }}
                  style={{ width: 48, padding: '2px 6px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 4, color: '#fff' }}
                />
              </label>
              <label style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto 48px', alignItems: 'center', gap: 8, color: '#fff', fontSize: 11 }}>
                <span style={{ width: 15 }}>G</span>
                <input
                  type="range"
                  min="0"
                  max="255"
                  value={g}
                  onChange={(e) => updateColor(r, clamp(parseInt(e.target.value)), b)}
                  style={{ width: '100%' }}
                />
                <span style={{ width: 30, textAlign: 'right' }}>{g}</span>
                <input
                  type="number"
                  min={0}
                  max={255}
                  value={g}
                  onChange={(e) => {
                    const v = clamp(parseInt(e.target.value || '0'));
                    updateColor(r, v, b);
                  }}
                  style={{ width: 48, padding: '2px 6px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 4, color: '#fff' }}
                />
              </label>
              <label style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto 48px', alignItems: 'center', gap: 8, color: '#fff', fontSize: 11 }}>
                <span style={{ width: 15 }}>B</span>
                <input
                  type="range"
                  min="0"
                  max="255"
                  value={b}
                  onChange={(e) => updateColor(r, g, clamp(parseInt(e.target.value)))}
                  style={{ width: '100%' }}
                />
                <span style={{ width: 30, textAlign: 'right' }}>{b}</span>
                <input
                  type="number"
                  min={0}
                  max={255}
                  value={b}
                  onChange={(e) => {
                    const v = clamp(parseInt(e.target.value || '0'));
                    updateColor(r, g, v);
                  }}
                  style={{ width: 48, padding: '2px 6px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 4, color: '#fff' }}
                />
              </label>
            </div>
          </div>
        );
      })()}

      {/* Point style popup */}
      {pointStyleState && (() => {
        const point = scene.nodes[pointStyleState.pointId] as any;
        if (!point || point.kind !== 'point') return null;
        
        // 글로벌하게 하나의 팝업만 표시 - 마지막 선택된 것이 현재 팝업의 점인 경우에만
        const lastSelectedId = selectedIds[selectedIds.length - 1];
        if (lastSelectedId !== pointStyleState.pointId) return null;
        
        const hasStroke = !!(point.strokeColor && point.strokeWidth);
        // Estimate popup size for clamping
        const EST_W = 240; // min width 200 + paddings/buttons
        const EST_H = 220; // rough height of the popup
        const clamped = clampPopupToViewport(pointStyleState.position.x, pointStyleState.position.y - 20, EST_W, EST_H);
        
        const applyStyle = (style: 'solid' | 'outlined') => {
          if (style === 'solid') {
            // Solid black point
            useSceneStore.getState().upsertNode({
              ...point,
              color: '#000000',
              strokeColor: undefined,
              strokeWidth: undefined
            } as any);
          } else {
            // White with black outline
            useSceneStore.getState().upsertNode({
              ...point,
              color: '#FFFFFF',
              strokeColor: '#000000',
              strokeWidth: 0.35
            } as any);
          }
        };
        
        return (
          <div
            data-ac-popup="1"
            style={{
              position: 'absolute',
              left: clamped.left,
              top: clamped.top,
              transform: 'translate(-50%, -100%)',
              background: 'rgba(58,58,60,0.92)',
              padding: 12,
              border: '1px solid rgba(0,0,0,0.35)',
              borderRadius: 12,
              boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
              display: 'flex',
              flexDirection: 'column',
              gap: 5,
              zIndex: 1000,
              minWidth: 200,
              color: '#fff'
            }}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => { e.stopPropagation(); }}
            onPointerMove={(e) => { e.stopPropagation(); }}
            onPointerUp={(e) => { e.stopPropagation(); }}
            onPointerOver={(e) => { e.stopPropagation(); }}
            onPointerOut={(e) => { e.stopPropagation(); }}
            onMouseDown={(e) => { e.stopPropagation(); }}
            onMouseMove={(e) => { e.stopPropagation(); }}
            onMouseUp={(e) => { e.stopPropagation(); }}
            onMouseOver={(e) => { e.stopPropagation(); }}
            onMouseOut={(e) => { e.stopPropagation(); }}
            onWheel={(e) => { e.stopPropagation(); }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ color: '#fff', fontSize: 12, fontWeight: 500 }}>점 스타일</span>
              <button
                onClick={() => setPointStyleState(null)}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.18)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.10)'; }}
                style={{
                  background: 'rgba(255,255,255,0.10)',
                  border: 'none',
                  borderRadius: 8,
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: 12,
                  padding: '8px 12px',
                  fontWeight: 600,
                  transition: 'background 0.2s',
                  whiteSpace: 'nowrap'
                }}
              >
                닫기
              </button>
            </div>
            
            <div style={{ display: 'flex', gap: 6 }}>
              {/* Solid black point */}
              <button
                onClick={() => applyStyle('solid')}
                style={{
                  flex: 1,
                  padding: '10px',
                  background: !hasStroke ? 'rgba(33, 150, 243, 0.15)' : 'rgba(255,255,255,0.10)',
                  border: 'none',
                  borderRadius: 8,
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 6,
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = !hasStroke ? 'rgba(33, 150, 243, 0.25)' : 'rgba(255,255,255,0.18)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = !hasStroke ? 'rgba(33, 150, 243, 0.15)' : 'rgba(255,255,255,0.10)';
                }}
              >
                <svg width="24" height="24" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="6" fill="#000000" />
                </svg>
                <span style={{ color: '#fff', fontSize: 10 }}>검정</span>
              </button>
              
              {/* White with black outline */}
              <button
                onClick={() => applyStyle('outlined')}
                style={{
                  flex: 1,
                  padding: '10px',
                  background: hasStroke ? 'rgba(33, 150, 243, 0.15)' : 'rgba(255,255,255,0.10)',
                  border: 'none',
                  borderRadius: 8,
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 6,
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = hasStroke ? 'rgba(33, 150, 243, 0.25)' : 'rgba(255,255,255,0.18)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = hasStroke ? 'rgba(33, 150, 243, 0.15)' : 'rgba(255,255,255,0.10)';
                }}
              >
                <svg width="24" height="24" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="6" fill="#FFFFFF" stroke="#000000" strokeWidth="1.5" />
                </svg>
                <span style={{ color: '#fff', fontSize: 10 }}>흰색</span>
              </button>
            </div>
          </div>
        );
      })()}
      
      {/* Angle style popup */}
      {angleStyleState && (() => {
        const angle = scene.nodes[angleStyleState.angleId] as any;
        if (!angle || angle.kind !== 'angle') return null;
        
        // 글로벌하게 하나의 팝업만 표시 - 마지막 선택된 것이 현재 팝업의 각도인 경우에만
        const lastSelectedId = selectedIds[selectedIds.length - 1];
        if (lastSelectedId !== angleStyleState.angleId) return null;
        // Estimate popup size for clamping
        const EST_W = 220;
        const EST_H = 200;
        const clamped = clampPopupToViewport(angleStyleState.position.x, angleStyleState.position.y - 20, EST_W, EST_H);
        
        return (
          <div
            data-ac-popup="1"
            style={{
              position: 'absolute',
              left: clamped.left,
              top: clamped.top,
              transform: 'translate(-50%, -100%)',
              background: 'rgba(58,58,60,0.92)',
              padding: 12,
              border: '1px solid rgba(0,0,0,0.35)',
              borderRadius: 12,
              boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
              display: 'flex',
              flexDirection: 'column',
              gap: 5,
              zIndex: 1000,
              minWidth: 180,
              color: '#fff'
            }}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => { e.stopPropagation(); }}
            onPointerMove={(e) => { e.stopPropagation(); }}
            onPointerUp={(e) => { e.stopPropagation(); }}
            onPointerOver={(e) => { e.stopPropagation(); }}
            onPointerOut={(e) => { e.stopPropagation(); }}
            onMouseDown={(e) => { e.stopPropagation(); }}
            onMouseMove={(e) => { e.stopPropagation(); }}
            onMouseUp={(e) => { e.stopPropagation(); }}
            onMouseOver={(e) => { e.stopPropagation(); }}
            onMouseOut={(e) => { e.stopPropagation(); }}
            onWheel={(e) => { e.stopPropagation(); }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginBottom: 5 }}>
              <button
                onClick={() => setAngleStyleState(null)}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.18)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.10)'; }}
                style={{
                  background: 'rgba(255,255,255,0.10)',
                  border: 'none',
                  borderRadius: 8,
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: 12,
                  padding: '6px 10px',
                  fontWeight: 600,
                  transition: 'background 0.2s',
                  whiteSpace: 'nowrap'
                }}
              >
                닫기
              </button>
            </div>
            
            <div>
              <label style={{ fontSize: 11, color: 'rgba(255,255,255,0.9)', display: 'block', marginBottom: 4 }}>
                각도 스타일
              </label>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => {
                    useSceneStore.getState().upsertNode({
                      ...angle,
                      isRightAngle: false
                    } as any);
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = !angle.isRightAngle ? 'rgba(33, 150, 243, 0.25)' : 'rgba(255,255,255,0.18)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = !angle.isRightAngle ? 'rgba(33, 150, 243, 0.15)' : 'rgba(255,255,255,0.10)';
                  }}
                  style={{
                    flex: 1,
                    padding: '8px',
                    background: !angle.isRightAngle ? 'rgba(33, 150, 243, 0.15)' : 'rgba(255,255,255,0.10)',
                    border: 'none',
                    borderRadius: 8,
                    color: '#fff',
                    cursor: 'pointer',
                    fontSize: 11,
                    fontWeight: 500,
                    transition: 'all 0.2s'
                  }}
                >
                  호
                </button>
                <button
                  onClick={() => {
                    useSceneStore.getState().upsertNode({
                      ...angle,
                      isRightAngle: true
                    } as any);
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = angle.isRightAngle ? 'rgba(33, 150, 243, 0.25)' : 'rgba(255,255,255,0.18)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = angle.isRightAngle ? 'rgba(33, 150, 243, 0.15)' : 'rgba(255,255,255,0.10)';
                  }}
                  style={{
                    flex: 1,
                    padding: '8px',
                    background: angle.isRightAngle ? 'rgba(33, 150, 243, 0.15)' : 'rgba(255,255,255,0.10)',
                    border: 'none',
                    borderRadius: 8,
                    color: '#fff',
                    cursor: 'pointer',
                    fontSize: 11,
                    fontWeight: 500,
                    transition: 'all 0.2s'
                  }}
                >
                  직각
                </button>
              </div>
            </div>

            {!angle.isRightAngle && (
              <div>
                <label style={{ fontSize: 11, color: 'rgba(255,255,255,0.9)', display: 'block', marginBottom: 4 }}>
                  각도 크기
                </label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => {
                      useSceneStore.getState().upsertNode({
                        ...angle,
                        isLargeAngle: false
                      } as any);
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = !angle.isLargeAngle ? 'rgba(33, 150, 243, 0.25)' : 'rgba(255,255,255,0.18)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = !angle.isLargeAngle ? 'rgba(33, 150, 243, 0.15)' : 'rgba(255,255,255,0.10)';
                    }}
                    style={{
                      flex: 1,
                      padding: '8px',
                      background: !angle.isLargeAngle ? 'rgba(33, 150, 243, 0.15)' : 'rgba(255,255,255,0.10)',
                      border: 'none',
                      borderRadius: 8,
                      color: '#fff',
                      cursor: 'pointer',
                      fontSize: 11,
                      fontWeight: 500,
                      transition: 'all 0.2s'
                    }}
                  >
                    작은 각
                  </button>
                  <button
                    onClick={() => {
                      useSceneStore.getState().upsertNode({
                        ...angle,
                        isLargeAngle: true
                      } as any);
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = angle.isLargeAngle ? 'rgba(33, 150, 243, 0.25)' : 'rgba(255,255,255,0.18)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = angle.isLargeAngle ? 'rgba(33, 150, 243, 0.15)' : 'rgba(255,255,255,0.10)';
                    }}
                    style={{
                      flex: 1,
                      padding: '8px',
                      background: angle.isLargeAngle ? 'rgba(33, 150, 243, 0.15)' : 'rgba(255,255,255,0.10)',
                      border: 'none',
                      borderRadius: 8,
                      color: '#fff',
                      cursor: 'pointer',
                      fontSize: 11,
                      fontWeight: 500,
                      transition: 'all 0.2s'
                    }}
                  >
                    큰 각
                  </button>
                </div>
              </div>
            )}

            <div>
              <label style={{ fontSize: 11, color: 'rgba(255,255,255,0.9)', display: 'block', marginBottom: 4 }}>
                {angle.isRightAngle ? '정사각형 크기' : '원호 반지름'}: {angle.arcRadiusPt || 20}pt
              </label>
              <input
                type="range"
                min="10"
                max="100"
                step="5"
                value={angle.arcRadiusPt || 20}
                onChange={(e) => {
                  useSceneStore.getState().upsertNode({
                    ...angle,
                    arcRadiusPt: parseFloat(e.target.value)
                  } as any);
                }}
                style={{ width: '100%' }}
              />
            </div>
          </div>
        );
      })()}
      
      {/* Paint preview polygon */}
      {paintPreview && currentTool === 'paint' && (() => {
        const pts = paintPreview.points.map(p => worldToScreen(p.x, p.y));
        if (pts.length < 3) return null;
        const d = `M ${pts[0].sx},${pts[0].sy} ` + pts.slice(1).map(p => `L ${p.sx},${p.sy}`).join(' ') + ' Z';
        return (
          <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}>
            <path d={d} fill="rgba(230,230,230,0.35)" stroke="none" />
          </svg>
        );
      })()}
    </div>
  );
}

function pointToLineSegmentDistance(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  
  if (lengthSq === 0) {
    return Math.sqrt((p.x - a.x) ** 2 + (p.y - a.y) ** 2);
  }
  
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  
  return Math.sqrt((p.x - projX) ** 2 + (p.y - projY) ** 2);
}

// Version that accounts for yScale in distance calculation
function pointToLineSegmentDistanceWithYScale(
  p: { x: number; y: number }, 
  a: { x: number; y: number }, 
  b: { x: number; y: number },
  yScale: number
): number {
  // Apply yScale to y coordinates for distance calculation in scaled space
  const px = p.x, py = p.y * yScale;
  const ax = a.x, ay = a.y * yScale;
  const bx = b.x, by = b.y * yScale;
  
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  
  if (lengthSq === 0) {
    return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2);
  }
  
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  
  const projX = ax + t * dx;
  const projY = ay + t * dy;
  
  return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
}

// Ray-segment intersection test for paint preview polygon
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

// Ray-rectangle intersection (closest distance) for paint preview polygon
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
  for (const e of edges) {
    const res = raySegmentIntersection(rayX, rayY, rayDirX, rayDirY, e.x1, e.y1, e.x2, e.y2);
    if (res && (minDist === null || res.distance < minDist)) {
      minDist = res.distance;
    }
  }
  return minDist;
}
// (removed duplicate stub)

