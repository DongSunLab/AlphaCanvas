import { useMemo, useRef, useEffect } from 'react';
import { useSceneStore } from '../state/store';
import type { BezierSegmentNode, SceneNode, MathTextNode } from '../shared/types';
import { generateStableId } from '../shared/types';
import 'mathlive';
import type { MathfieldElement } from 'mathlive';

function getBezierScreenBounds(bez: BezierSegmentNode, view: any): { minX: number; maxX: number; minY: number; maxY: number; centerX: number; centerY: number } {
  const state = useSceneStore.getState();
  const a = state.scene.nodes[bez.a] as any;
  const b = state.scene.nodes[bez.b] as any;
  const c1 = state.scene.nodes[bez.c1] as any;
  const c2 = state.scene.nodes[bez.c2] as any;
  
  if (!a || !b) return { minX: 0, maxX: 0, minY: 0, maxY: 0, centerX: 0, centerY: 0 };
  
  // Calculate bounding box in screen space - 앵커(a, b)와 핸들(c1, c2) 모두 포함
  const { scale, translate, yScale: viewYScale } = view;
  const yScale = viewYScale ?? 1;
  
  const screenPoints = [
    { x: a.position.x * scale + translate.x, y: -a.position.y * yScale * scale + translate.y },
    { x: b.position.x * scale + translate.x, y: -b.position.y * yScale * scale + translate.y },
  ];
  
  // 핸들도 포함 (존재하는 경우)
  if (c1 && c1.position) {
    screenPoints.push({ x: c1.position.x * scale + translate.x, y: -c1.position.y * yScale * scale + translate.y });
  }
  if (c2 && c2.position) {
    screenPoints.push({ x: c2.position.x * scale + translate.x, y: -c2.position.y * yScale * scale + translate.y });
  }
  
  const xs = screenPoints.map(p => p.x);
  const ys = screenPoints.map(p => p.y);
  
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  
  // 바운딩 박스에 여유 공간 추가 (핸들 주변 여유)
  const PADDING = 20;
  
  return {
    minX: minX - PADDING,
    maxX: maxX + PADDING,
    minY: minY - PADDING,
    maxY: maxY + PADDING,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

function getSmartPopupPosition(
  bezierBounds: { minX: number; maxX: number; minY: number; maxY: number; centerX: number; centerY: number },
  canvasWidth: number,
  canvasHeight: number
): { transform: string; left: number; top: number } {
  const POPUP_WIDTH = 400;
  const POPUP_HEIGHT = 280;
  const MARGIN = 30;
  const GAP = 60; // 베지에와 팝업 사이 간격

  const { minX, maxX, minY, maxY, centerX, centerY } = bezierBounds;
  
  // 각 방향별로 팝업을 배치했을 때의 실제 좌표 계산
  const positions = [
    {
      name: 'below',
      left: centerX,
      top: maxY + GAP,
      transform: 'translate(-50%, 0%)',
      // 실제 팝업 영역
      getRect: (l: number, t: number) => ({
        left: l - POPUP_WIDTH / 2,
        right: l + POPUP_WIDTH / 2,
        top: t,
        bottom: t + POPUP_HEIGHT
      })
    },
    {
      name: 'above',
      left: centerX,
      top: minY - GAP,
      transform: 'translate(-50%, -100%)',
      getRect: (l: number, t: number) => ({
        left: l - POPUP_WIDTH / 2,
        right: l + POPUP_WIDTH / 2,
        top: t - POPUP_HEIGHT,
        bottom: t
      })
    },
    {
      name: 'right',
      left: maxX + GAP,
      top: centerY,
      transform: 'translate(0%, -50%)',
      getRect: (l: number, t: number) => ({
        left: l,
        right: l + POPUP_WIDTH,
        top: t - POPUP_HEIGHT / 2,
        bottom: t + POPUP_HEIGHT / 2
      })
    },
    {
      name: 'left',
      left: minX - GAP,
      top: centerY,
      transform: 'translate(-100%, -50%)',
      getRect: (l: number, t: number) => ({
        left: l - POPUP_WIDTH,
        right: l,
        top: t - POPUP_HEIGHT / 2,
        bottom: t + POPUP_HEIGHT / 2
      })
    }
  ];
  
  // 각 위치에서 화면을 벗어나는 정도 계산
  const scored = positions.map(pos => {
    const rect = pos.getRect(pos.left, pos.top);
    const overflow = {
      left: Math.max(0, MARGIN - rect.left),
      right: Math.max(0, rect.right - (canvasWidth - MARGIN)),
      top: Math.max(0, MARGIN - rect.top),
      bottom: Math.max(0, rect.bottom - (canvasHeight - MARGIN))
    };
    const totalOverflow = overflow.left + overflow.right + overflow.top + overflow.bottom;
    return { pos, overflow, totalOverflow };
  });
  
  // 가장 적게 벗어나는 위치 선택
  scored.sort((a, b) => a.totalOverflow - b.totalOverflow);
  const best = scored[0];
  
  let { left, top, transform } = best.pos;
  
  // 선택된 위치에서 화면 안으로 밀어넣기
  const finalRect = best.pos.getRect(left, top);
  
  if (finalRect.left < MARGIN) {
    left += MARGIN - finalRect.left;
  }
  if (finalRect.right > canvasWidth - MARGIN) {
    left -= finalRect.right - (canvasWidth - MARGIN);
  }
  if (finalRect.top < MARGIN) {
    top += MARGIN - finalRect.top;
  }
  if (finalRect.bottom > canvasHeight - MARGIN) {
    top -= finalRect.bottom - (canvasHeight - MARGIN);
  }

  return { transform, left, top };
}

export function BezierControls() {
  const scene = useSceneStore((s) => s.scene);
  const selectedIds = useSceneStore((s) => s.selectedIds);
  const upsertNode = useSceneStore((s) => s.upsertNode);
  const setSelected = useSceneStore((s) => s.setSelected);
  const removeNode = useSceneStore((s) => s.removeNode);

  const mathFieldRef = useRef<MathfieldElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const selectedBeziers = useMemo(() => {
    const out: BezierSegmentNode[] = [];
    for (const id of selectedIds) {
      const n = scene.nodes[id] as SceneNode;
      if (n && (n as any).kind === 'bezier') out.push(n as any);
    }
    return out;
  }, [selectedIds, scene.nodes]);

  // ESC to clear selection
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || (e as any).key === 'Esc') {
        setSelected([]);
        try { e.preventDefault(); } catch {}
        try { (e as any).stopPropagation?.(); } catch {}
      }
    };
    if (selectedBeziers.length > 0) {
      window.addEventListener('keydown', onKey as any, { capture: true } as any);
    }
    return () => {
      window.removeEventListener('keydown', onKey as any, { capture: true } as any);
    };
  }, [selectedBeziers.length, setSelected]);

  if (selectedBeziers.length === 0) return null;

  // 글로벌하게 하나의 팝업만 표시 - 마지막 선택된 베지에만
  const lastSelectedId = selectedIds[selectedIds.length - 1];
  const lastNode = scene.nodes[lastSelectedId];
  
  // 마지막 선택된 것이 베지에가 아니면 팝업 표시 안함
  if (!lastNode || (lastNode as any).kind !== 'bezier') return null;
  
  // 선택된 베지에 중에서 마지막 선택된 것만 표시
  const bez = selectedBeziers.find(b => b.id === lastSelectedId);
  if (!bez) return null;

  const rect = containerRef.current?.getBoundingClientRect();
  const canvasWidth = (rect?.width ?? (typeof window !== 'undefined' ? window.innerWidth : 1920));
  const canvasHeight = (rect?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 1080));

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 6 }}>
      {(() => {
        const bezierBounds = getBezierScreenBounds(bez, scene.view);
        const popupPos = getSmartPopupPosition(bezierBounds, canvasWidth, canvasHeight);

        // Get labels attached to this bezier
        const labelIds = (bez.labelIds || []) as string[];
        const labels = labelIds.map(id => scene.nodes[id] as MathTextNode).filter(Boolean);

        const addLabel = () => {
          if (!mathFieldRef.current) return;
          const mf = mathFieldRef.current as any;
          const latex = mf.value.trim();
          if (!latex) return;

          const labelId = generateStableId('math-text');
          const newLabel: MathTextNode = {
            id: labelId,
            kind: 'math-text',
            latex,
            position: { x: 0, y: 0 }, // Will be computed from bezierT
            fontSize: 11,
            color: '#000000',
            bezierParentId: bez.id,
            bezierT: 0.5, // Start at midpoint
            displayAboveCurves: true, // Always clip the curve
          };

          // Add label to scene
          upsertNode(newLabel);

          // Update bezier labelIds
          const updatedBezier = {
            ...bez,
            labelIds: [...labelIds, labelId],
          };
          upsertNode(updatedBezier as any);

          mf.value = '';
        };

        const removeLabel = (labelId: string) => {
          // Remove from scene
          removeNode(labelId);

          // Update bezier labelIds
          const updatedBezier = {
            ...bez,
            labelIds: labelIds.filter(id => id !== labelId),
          };
          upsertNode(updatedBezier as any);
        };

        return (
          <div
            key={bez.id}
            data-ac-popup="1"
            style={{
              position: 'absolute',
              left: popupPos.left,
              top: popupPos.top,
              transform: popupPos.transform,
              background: 'rgba(58,58,60,0.92)',
              border: '1px solid rgba(0,0,0,0.35)',
              borderRadius: 12,
              padding: 12,
              boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
              pointerEvents: 'auto',
              minWidth: 180,
              maxWidth: 400,
              zIndex: 10,
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h4 style={{ margin: 0, fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,0.9)' }}>
                  {bez.style?.stroke?.dash ? '길이 점선' : '베지에 곡선'}
                </h4>
                <button
                  onClick={() => setSelected([])}
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

              {/* Label list */}
              <div>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.9)', display: 'block', marginBottom: 4 }}>
                  수식 라벨
                </span>
                {labels.length === 0 ? (
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', fontStyle: 'italic' }}>
                    라벨이 없습니다
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {labels.map((label) => (
                      <div
                        key={label.id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '6px 8px',
                          background: 'rgba(255,255,255,0.10)',
                          borderRadius: 8,
                          border: 'none',
                        }}
                      >
                        <span style={{ fontSize: 11, fontFamily: 'monospace', flex: 1, color: '#fff' }}>
                          {label.latex}
                        </span>
                        <button
                          onClick={() => removeLabel(label.id)}
                          onMouseEnter={(e) => { e.currentTarget.style.background = '#d32f2f'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = '#f44336'; }}
                          style={{
                            padding: '4px 8px',
                            fontSize: 10,
                            background: '#f44336',
                            border: 'none',
                            borderRadius: 8,
                            color: '#fff',
                            cursor: 'pointer',
                            fontWeight: 500,
                            transition: 'all 0.2s'
                          }}
                        >
                          삭제
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Add label input */}
              <div>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.9)', display: 'block', marginBottom: 4 }}>
                  새 라벨 추가
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  {/* @ts-expect-error custom element */}
                  <math-field
                    ref={mathFieldRef as any}
                    style={{
                      flex: 1,
                      fontSize: 14,
                      padding: '6px 8px',
                      border: '1px solid rgba(255,255,255,0.22)',
                      borderRadius: 8,
                      background: 'rgba(255,255,255,0.10)',
                      color: '#fff'
                    }}
                    onKeyDown={(e: any) => {
                      if (e.key === 'Enter') {
                        addLabel();
                      }
                    }}
                  />
                  <button
                    onClick={addLabel}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(33, 150, 243, 0.25)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(33, 150, 243, 0.15)'; }}
                    style={{
                      background: 'rgba(33, 150, 243, 0.15)',
                      border: 'none',
                      borderRadius: 8,
                      color: '#fff',
                      cursor: 'pointer',
                      fontSize: 11,
                      padding: '6px 12px',
                      fontWeight: 500,
                      transition: 'all 0.2s'
                    }}
                  >
                    추가
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

