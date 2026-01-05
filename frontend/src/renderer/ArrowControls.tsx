import { useMemo, useRef, useEffect, useState } from 'react';
import { useSceneStore } from '../state/store';
import type { SceneNode } from '../shared/types';

function getArrowScreenBounds(arrow: any, view: any): { minX: number; maxX: number; minY: number; maxY: number; centerX: number; centerY: number } {
  const state = useSceneStore.getState();
  const a = state.scene.nodes[arrow.a] as any;
  const b = state.scene.nodes[arrow.b] as any;
  const c1 = state.scene.nodes[arrow.c1] as any;
  const c2 = state.scene.nodes[arrow.c2] as any;
  
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
  arrowBounds: { minX: number; maxX: number; minY: number; maxY: number; centerX: number; centerY: number },
  canvasWidth: number,
  canvasHeight: number
): { transform: string; left: number; top: number } {
  const POPUP_WIDTH = 320;
  const POPUP_HEIGHT = 220;
  const MARGIN = 30;
  const GAP = 60; // 화살표와 팝업 사이 간격

  const { minX, maxX, minY, maxY, centerX, centerY } = arrowBounds;
  
  // 각 방향별로 팝업을 배치했을 때의 실제 좌표 계산
  const positions = [
    {
      name: 'below',
      left: centerX,
      top: maxY + GAP,
      transform: 'translate(-50%, 0%)',
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

export function ArrowControls() {
  const scene = useSceneStore((s) => s.scene);
  const selectedIds = useSceneStore((s) => s.selectedIds);
  const upsertNode = useSceneStore((s) => s.upsertNode);
  const setSelected = useSceneStore((s) => s.setSelected);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [customThickness, setCustomThickness] = useState<string>('');
  const [customArrowSize, setCustomArrowSize] = useState<string>('');

  const selectedArrows = useMemo(() => {
    const out: any[] = [];
    for (const id of selectedIds) {
      const n = scene.nodes[id] as SceneNode;
      if (n && (n as any).kind === 'arrow') out.push(n as any);
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
    if (selectedArrows.length > 0) {
      window.addEventListener('keydown', onKey as any, { capture: true } as any);
    }
    return () => {
      window.removeEventListener('keydown', onKey as any, { capture: true } as any);
    };
  }, [selectedArrows.length, setSelected]);

  if (selectedArrows.length === 0) return null;

  // 글로벌하게 하나의 팝업만 표시 - 마지막 선택된 화살표만
  const lastSelectedId = selectedIds[selectedIds.length - 1];
  const lastNode = scene.nodes[lastSelectedId];
  
  // 마지막 선택된 것이 화살표가 아니면 팝업 표시 안함
  if (!lastNode || (lastNode as any).kind !== 'arrow') return null;
  
  // 선택된 화살표 중에서 마지막 선택된 것만 표시
  const arrow = selectedArrows.find(a => a.id === lastSelectedId);
  if (!arrow) return null;

  const rect = containerRef.current?.getBoundingClientRect();
  const canvasWidth = (rect?.width ?? (typeof window !== 'undefined' ? window.innerWidth : 1920));
  const canvasHeight = (rect?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 1080));

  const currentWidth = arrow.style?.stroke?.width ?? 0.35;
  const isDashed = !!(arrow.style?.stroke?.dash && arrow.style.stroke.dash.length > 0);
  const currentArrowSize = arrow.arrowSize ?? 1.0;

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 6 }}>
      {(() => {
        const arrowBounds = getArrowScreenBounds(arrow, scene.view);
        const popupPos = getSmartPopupPosition(arrowBounds, canvasWidth, canvasHeight);

        const toggleDashed = () => {
          const updated = {
            ...arrow,
            style: {
              ...arrow.style,
              stroke: {
                ...arrow.style?.stroke,
                color: arrow.style?.stroke?.color ?? '#000000',
                width: arrow.style?.stroke?.width ?? 0.35,
                dash: isDashed ? undefined : [3, 3]
              }
            }
          };
          upsertNode(updated);
        };

        const setThickness = (width: number) => {
          const updated = {
            ...arrow,
            style: {
              ...arrow.style,
              stroke: {
                ...arrow.style?.stroke,
                color: arrow.style?.stroke?.color ?? '#000000',
                width
              }
            }
          };
          upsertNode(updated);
        };

        const applyCustomThickness = () => {
          const val = parseFloat(customThickness);
          if (!isNaN(val) && val > 0 && val <= 10) {
            setThickness(val);
            setCustomThickness('');
          }
        };

        const toggleStartArrow = () => {
          const updated = {
            ...arrow,
            showStartArrow: !arrow.showStartArrow
          };
          upsertNode(updated);
        };

        const toggleEndArrow = () => {
          const updated = {
            ...arrow,
            showEndArrow: !arrow.showEndArrow
          };
          upsertNode(updated);
        };

        const setArrowSize = (size: number) => {
          const updated = {
            ...arrow,
            arrowSize: size
          };
          upsertNode(updated);
        };

        const applyCustomArrowSize = () => {
          const val = parseFloat(customArrowSize);
          if (!isNaN(val) && val > 0 && val <= 5) {
            setArrowSize(val);
            setCustomArrowSize('');
          }
        };

        return (
          <div
            key={arrow.id}
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
              maxWidth: 320,
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h4 style={{ margin: 0, fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,0.9)' }}>
                  화살표
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

              {/* Arrow direction controls */}
              <div>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.9)', display: 'block', marginBottom: 6 }}>
                  화살표 방향
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={toggleStartArrow}
                    style={{
                      flex: 1,
                      padding: '8px',
                      fontSize: 11,
                      background: arrow.showStartArrow ? 'rgba(33, 150, 243, 0.25)' : 'rgba(255,255,255,0.10)',
                      border: 'none',
                      borderRadius: 8,
                      color: '#fff',
                      cursor: 'pointer',
                      fontWeight: 500,
                      transition: 'all 0.2s'
                    }}
                  >
                    ← 시작
                  </button>
                  <button
                    onClick={toggleEndArrow}
                    style={{
                      flex: 1,
                      padding: '8px',
                      fontSize: 11,
                      background: arrow.showEndArrow ? 'rgba(33, 150, 243, 0.25)' : 'rgba(255,255,255,0.10)',
                      border: 'none',
                      borderRadius: 8,
                      color: '#fff',
                      cursor: 'pointer',
                      fontWeight: 500,
                      transition: 'all 0.2s'
                    }}
                  >
                    끝 →
                  </button>
                </div>
              </div>

              {/* Thickness controls */}
              <div>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.9)', display: 'block', marginBottom: 6 }}>
                  두께 (현재: {currentWidth.toFixed(2)}pt)
                </span>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
                  {[0.35, 0.5, 0.8, 1.0, 1.5].map(w => (
                    <button
                      key={w}
                      onClick={() => setThickness(w)}
                      style={{
                        padding: '6px 10px',
                        fontSize: 10,
                        background: Math.abs(currentWidth - w) < 0.01 ? 'rgba(33, 150, 243, 0.25)' : 'rgba(255,255,255,0.10)',
                        border: 'none',
                        borderRadius: 6,
                        color: '#fff',
                        cursor: 'pointer',
                        fontWeight: 500,
                        transition: 'all 0.2s'
                      }}
                    >
                      {w}pt
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type="text"
                    value={customThickness}
                    onChange={(e) => setCustomThickness(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        applyCustomThickness();
                      }
                    }}
                    placeholder="커스텀"
                    style={{
                      flex: 1,
                      fontSize: 11,
                      padding: '6px 8px',
                      border: '1px solid rgba(255,255,255,0.22)',
                      borderRadius: 6,
                      background: 'rgba(255,255,255,0.10)',
                      color: '#fff',
                      outline: 'none'
                    }}
                  />
                  <button
                    onClick={applyCustomThickness}
                    style={{
                      padding: '6px 12px',
                      fontSize: 10,
                      background: 'rgba(33, 150, 243, 0.15)',
                      border: 'none',
                      borderRadius: 6,
                      color: '#fff',
                      cursor: 'pointer',
                      fontWeight: 500,
                      transition: 'all 0.2s'
                    }}
                  >
                    적용
                  </button>
                </div>
              </div>

              {/* Dashed toggle */}
              <div>
                <label 
                  style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: 10, 
                    cursor: 'pointer',
                    padding: '8px',
                    background: 'rgba(255,255,255,0.05)',
                    borderRadius: 8,
                    transition: 'all 0.2s'
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.10)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
                >
                  <div style={{
                    width: 20,
                    height: 20,
                    borderRadius: 4,
                    background: isDashed ? '#2196F3' : 'rgba(255,255,255,0.1)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'all 0.2s'
                  }}>
                    {isDashed && (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                        <path d="M5 12l5 5L20 7" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </div>
                  <input
                    type="checkbox"
                    checked={isDashed}
                    onChange={toggleDashed}
                    style={{ display: 'none' }}
                  />
                  <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.9)', fontWeight: 500 }}>점선</span>
                </label>
              </div>

              {/* Arrow size controls */}
              <div>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.9)', display: 'block', marginBottom: 6 }}>
                  화살표 크기 (현재: {currentArrowSize.toFixed(1)}x)
                </span>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
                  {[0.5, 0.75, 1.0, 1.5, 2.0].map(s => (
                    <button
                      key={s}
                      onClick={() => setArrowSize(s)}
                      style={{
                        padding: '6px 10px',
                        fontSize: 10,
                        background: Math.abs(currentArrowSize - s) < 0.01 ? 'rgba(33, 150, 243, 0.25)' : 'rgba(255,255,255,0.10)',
                        border: 'none',
                        borderRadius: 6,
                        color: '#fff',
                        cursor: 'pointer',
                        fontWeight: 500,
                        transition: 'all 0.2s'
                      }}
                    >
                      {s}x
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type="text"
                    value={customArrowSize}
                    onChange={(e) => setCustomArrowSize(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        applyCustomArrowSize();
                      }
                    }}
                    placeholder="커스텀"
                    style={{
                      flex: 1,
                      fontSize: 11,
                      padding: '6px 8px',
                      border: '1px solid rgba(255,255,255,0.22)',
                      borderRadius: 6,
                      background: 'rgba(255,255,255,0.10)',
                      color: '#fff',
                      outline: 'none'
                    }}
                  />
                  <button
                    onClick={applyCustomArrowSize}
                    style={{
                      padding: '6px 12px',
                      fontSize: 10,
                      background: 'rgba(33, 150, 243, 0.15)',
                      border: 'none',
                      borderRadius: 6,
                      color: '#fff',
                      cursor: 'pointer',
                      fontWeight: 500,
                      transition: 'all 0.2s'
                    }}
                  >
                    적용
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

