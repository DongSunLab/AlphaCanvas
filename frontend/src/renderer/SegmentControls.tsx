import { useMemo, useState, useEffect } from 'react';
import { useSceneStore } from '../state/store';
import type { SceneNode, SegmentNode } from '../shared/types';

type ScreenPoint = { x: number; y: number };

const THICKNESS_PRESETS = [
  { label: '0.35', value: 0.35 },
  { label: '0.5', value: 0.5 },
  { label: '0.8', value: 0.8 },
  { label: '1.2', value: 1.2 },
];

const DASH_PRESETS = [
  { label: '실선', dash: undefined, thickness: null, title: '실선' },
  { label: '점선1', dash: [1.6, 0.9], thickness: 0.35, title: '0.35pt 두께: 1.6pt, 0.9pt' },
  { label: '점선2', dash: [3.0, 1.6], thickness: 0.8, title: '0.8pt 두께: 3.0pt, 1.6pt' },
];

function worldToScreen(x: number, y: number, view: { scale: number; translate: { x: number; y: number }; yScale?: number }): ScreenPoint {
  const yScale = view.yScale ?? 1;
  const sx = x * view.scale + view.translate.x;
  const sy = -y * yScale * view.scale + view.translate.y; // flip Y with yScale
  return { x: sx, y: sy };
}

function getSegmentScreenMidpoint(seg: SegmentNode, view: { scale: number; translate: { x: number; y: number }; yScale?: number }): ScreenPoint {
  const pts = seg.samples;
  if (!pts || pts.length === 0) return { x: 0, y: 0 } as ScreenPoint;
  // Use mid sample for placement (simple and stable)
  const mid = pts[Math.floor(pts.length / 2)];
  return worldToScreen(mid.x, mid.y, view);
}

// Calculate smart popup position that avoids covering the segment
function getSmartPopupPosition(segmentPos: ScreenPoint, canvasWidth: number, canvasHeight: number): { transform: string; left: number; top: number } {
  // Conservative popup size estimate for segment controls
  const POPUP_WIDTH = 320;
  const POPUP_HEIGHT = 260;
  const VERTICAL_GAP = 120; // ensure not covering the segment
  const MARGIN = 8;

  let x = segmentPos.x;
  let y: number;
  let transform: string;

  // Prefer placing below the segment when there is enough space
  const spaceBelow = canvasHeight - segmentPos.y;
  const spaceAbove = segmentPos.y;

  if (spaceBelow > POPUP_HEIGHT + VERTICAL_GAP + MARGIN) {
    y = segmentPos.y + VERTICAL_GAP;
    transform = 'translate(-50%, 0%)';
  } else if (spaceAbove > POPUP_HEIGHT + VERTICAL_GAP + MARGIN) {
    y = segmentPos.y - VERTICAL_GAP;
    transform = 'translate(-50%, -100%)';
  } else if (spaceBelow >= spaceAbove) {
    y = segmentPos.y + VERTICAL_GAP;
    transform = 'translate(-50%, 0%)';
  } else {
    y = segmentPos.y - VERTICAL_GAP;
    transform = 'translate(-50%, -100%)';
  }

  // Initial horizontal clamping using width estimate
  if (x - POPUP_WIDTH / 2 < MARGIN) x = POPUP_WIDTH / 2 + MARGIN;
  if (x + POPUP_WIDTH / 2 > canvasWidth - MARGIN) x = canvasWidth - POPUP_WIDTH / 2 - MARGIN;

  // Final viewport clamp based on transform model
  // translate(-50%, 0%): rect = { left: x - W/2, right: x + W/2, top: y, bottom: y + H }
  // translate(-50%, -100%): rect = { left: x - W/2, right: x + W/2, top: y - H, bottom: y }
  let rectLeft = x - POPUP_WIDTH / 2;
  let rectRight = x + POPUP_WIDTH / 2;
  let rectTop = transform === 'translate(-50%, -100%)' ? y - POPUP_HEIGHT : y;
  let rectBottom = transform === 'translate(-50%, -100%)' ? y : y + POPUP_HEIGHT;

  if (rectLeft < MARGIN) {
    const delta = MARGIN - rectLeft;
    x += delta;
    rectLeft += delta; rectRight += delta;
  }
  if (rectRight > canvasWidth - MARGIN) {
    const delta = rectRight - (canvasWidth - MARGIN);
    x -= delta;
    rectLeft -= delta; rectRight -= delta;
  }
  if (rectTop < MARGIN) {
    const delta = MARGIN - rectTop;
    y += delta;
    rectTop += delta; rectBottom += delta;
  }
  if (rectBottom > canvasHeight - MARGIN) {
    const delta = rectBottom - (canvasHeight - MARGIN);
    y -= delta;
    rectTop -= delta; rectBottom -= delta;
  }

  return { transform, left: x, top: y };
}

export function SegmentControls() {
  const scene = useSceneStore((s) => s.scene);
  const selectedIds = useSceneStore((s) => s.selectedIds);
  const upsertNode = useSceneStore((s) => s.upsertNode);
  const setSelected = useSceneStore((s) => s.setSelected);

  const selectedSegments = useMemo(() => {
    const out: SegmentNode[] = [];
    for (const id of selectedIds) {
      const n = scene.nodes[id] as SceneNode;
      if (n && (n as any).kind === 'segment') out.push(n as any);
    }
    return out;
  }, [selectedIds, scene.nodes]);

  // Custom thickness input state for each segment
  const [customThicknessMap, setCustomThicknessMap] = useState<Record<string, string>>({});

  // ESC to clear selection (and thus close popups)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || (e as any).key === 'Esc') {
        setSelected([]);
        try { e.preventDefault(); } catch {}
        try { (e as any).stopPropagation?.(); } catch {}
      }
    };
    if (selectedSegments.length > 0) {
      window.addEventListener('keydown', onKey as any, { capture: true } as any);
    }
    return () => {
      window.removeEventListener('keydown', onKey as any, { capture: true } as any);
    };
  }, [selectedSegments.length, setSelected]);

  if (selectedSegments.length === 0) return null;

  // 글로벌하게 하나의 팝업만 표시 - 마지막 선택된 세그먼트만
  const lastSelectedId = selectedIds[selectedIds.length - 1];
  const lastNode = scene.nodes[lastSelectedId];
  
  // 마지막 선택된 것이 세그먼트가 아니면 팝업 표시 안함
  if (!lastNode || (lastNode as any).kind !== 'segment') return null;
  
  // 선택된 세그먼트 중에서 마지막 선택된 것만 표시
  const seg = selectedSegments.find(s => s.id === lastSelectedId);
  if (!seg) return null;

  // Get canvas dimensions for smart positioning
  const canvasWidth = typeof window !== 'undefined' ? window.innerWidth : 1920;
  const canvasHeight = typeof window !== 'undefined' ? window.innerHeight : 1080;

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 6 }}>
      {(() => {
        const segmentPos = getSegmentScreenMidpoint(seg, scene.view);
        const popupPos = getSmartPopupPosition(segmentPos, canvasWidth, canvasHeight);
        
        // Always use existing stroke or create default with all properties
        const stroke = seg.style?.stroke || { color: '#000000', width: 0.8, dash: undefined };
        const dash = stroke.dash || [];

        const updateColor = (color: string) => {
          const currentStroke = seg.style?.stroke || { color: '#000000', width: 0.8 };
          const newStroke = { ...currentStroke, color };
          upsertNode({
            ...seg,
            style: { ...seg.style, stroke: newStroke }
          } as any);
        };
        const updateWidth = (width: number) => {
          const currentStroke = seg.style?.stroke || { color: '#000000', width: 0.8 };
          const newStroke = { ...currentStroke, width };
          upsertNode({
            ...seg,
            style: { ...seg.style, stroke: newStroke }
          } as any);
        };
        // removed unused updateDash (dash is applied atomically with thickness button)

        // Custom input state for this segment
        const customThickness = customThicknessMap[seg.id] ?? String(stroke.width || 0.8);
        const setCustomThickness = (val: string) => {
          setCustomThicknessMap(prev => ({ ...prev, [seg.id]: val }));
        };

        return (
          <div key={seg.id} style={{ position: 'absolute', left: popupPos.left, top: popupPos.top, transform: popupPos.transform, pointerEvents: 'none' }}>
            {/* Unified popup */}
            <div
              data-ac-popup="1"
              style={{ pointerEvents: 'auto', background: 'rgba(58,58,60,0.92)', border: '1px solid rgba(0,0,0,0.35)', borderRadius: 12, padding: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.35)', minWidth: 180 }}
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
              {/* Color selector and close button in one line */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.9)' }}>색상</span>
                <input type="color" value={stroke.color || '#333333'} onChange={(e) => updateColor(e.target.value)} style={{ width: 28, height: 28, border: 'none', padding: 0, background: 'none', cursor: 'pointer', borderRadius: 4 }}/>
                <button
                  onClick={() => setSelected([])}
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
                    padding: '6px 10px',
                    fontWeight: 600,
                    transition: 'background 0.2s',
                    whiteSpace: 'nowrap'
                  }}
                >
                  닫기
                </button>
              </div>
              
              {/* Thickness presets */}
              <div style={{ marginBottom: 5 }}>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.9)', display: 'block', marginBottom: 4 }}>두께</span>
                <div style={{ display: 'flex', gap: 4 }}>
                  {THICKNESS_PRESETS.map(preset => {
                    const active = Math.abs((stroke.width || 0.8) - preset.value) < 0.001;
                    // Match canvas rendering: pt to px with compensation
                    const ptToPx = (96 / 72) * 1.8;
                    const previewHeight = Math.max(1, preset.value * ptToPx);
                    return (
                      <button 
                        key={preset.value} 
                        onClick={() => updateWidth(preset.value)} 
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = active ? 'rgba(33, 150, 243, 0.25)' : 'rgba(255,255,255,0.18)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = active ? 'rgba(33, 150, 243, 0.15)' : 'rgba(255,255,255,0.10)';
                        }}
                        style={{
                          ...btnStyle(active),
                          flex: 1,
                          height: 32,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: '0 4px'
                        }}
                        title={`${preset.label}pt`}
                      >
                        <div style={{
                          width: '100%',
                          height: `${previewHeight}px`,
                          backgroundColor: active ? '#2196F3' : '#fff',
                          borderRadius: '1px'
                        }} />
                      </button>
                    );
                  })}
                </div>
              </div>
              {/* Custom thickness input */}
              <div style={{ marginBottom: 5 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                  <input 
                    type="text" 
                    value={customThickness}
                    onChange={(e) => setCustomThickness(e.target.value)}
                    onBlur={() => {
                      const val = parseFloat(customThickness);
                      if (isFinite(val) && val > 0) updateWidth(val);
                    }}
                    placeholder="커스텀"
                    style={{
                      width: 24,
                      padding: '4px 6px',
                      border: 'none',
                      background: 'rgba(255,255,255,0.10)',
                      borderRadius: 4,
                      fontSize: 11,
                      outline: 'none',
                      color: '#fff',
                      textAlign: 'center'
                    }}
                  />
                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>pt</span>
                </div>
              </div>
              {/* Dash style presets with visual preview */}
              <div>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.9)', display: 'block', marginBottom: 4 }}>선 스타일</span>
                <div style={{ display: 'flex', gap: 4 }}>
                  {DASH_PRESETS.map((preset, idx) => {
                    const active = arrEq(dash, preset.dash);
                    return (
                      <button 
                        key={idx} 
                        onClick={() => {
                          // Apply dash and optional thickness in a single atomic update
                          const state = useSceneStore.getState();
                          const latest = (state.scene.nodes as any)[seg.id];
                          const latestStroke = latest?.style?.stroke || { color: '#000000', width: (stroke.width || 0.8) };
                          const newStroke: any = { ...latestStroke, dash: preset.dash };
                          if (preset.thickness !== null) newStroke.width = preset.thickness;
                          upsertNode({
                            ...seg,
                            style: { ...seg.style, stroke: newStroke }
                          } as any);
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = active ? 'rgba(33, 150, 243, 0.25)' : 'rgba(255,255,255,0.18)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = active ? 'rgba(33, 150, 243, 0.15)' : 'rgba(255,255,255,0.10)';
                        }}
                        style={{
                          ...btnStyle(active),
                          flex: 1,
                          height: 24,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: '0 4px',
                          minWidth: 0
                        }}
                        title={preset.title}
                      >
                        <svg width="24" height="6" viewBox="0 0 24 6" style={{ display: 'block' }}>
                          <line 
                            x1="0" 
                            y1="3" 
                            x2="24" 
                            y2="3" 
                            stroke={active ? '#2196F3' : '#fff'} 
                            strokeWidth="2"
                            strokeDasharray={preset.dash ? preset.dash.map(v => v * 2).join(',') : undefined}
                          />
                        </svg>
                      </button>
                    );
                  })}
                </div>
              </div>
              
              {/* Custom dash pattern input - two separate inputs */}
              <div style={{ marginTop: 5 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input 
                    type="text" 
                    value={dash && dash.length > 0 ? String(dash[0] || '') : ''}
                    onChange={(e) => {
                      const val = e.target.value.trim();
                      if (val === '') return;
                      const num = parseFloat(val);
                      if (isFinite(num) && num > 0) {
                        const currentStroke = seg.style?.stroke || { color: '#000000', width: 0.8 };
                        const currentDash = currentStroke.dash || [1.6, 0.9];
                        const newStroke = { ...currentStroke, dash: [num, currentDash[1] || 0.9] };
                        upsertNode({
                          ...seg,
                          style: { ...seg.style, stroke: newStroke }
                        } as any);
                      }
                    }}
                    placeholder="1.6"
                    style={{
                      width: 32,
                      padding: '4px 6px',
                      border: 'none',
                      background: 'rgba(255,255,255,0.10)',
                      borderRadius: 4,
                      fontSize: 11,
                      outline: 'none',
                      color: '#fff',
                      textAlign: 'center'
                    }}
                  />
                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>:</span>
                  <input 
                    type="text" 
                    value={dash && dash.length > 1 ? String(dash[1] || '') : ''}
                    onChange={(e) => {
                      const val = e.target.value.trim();
                      if (val === '') return;
                      const num = parseFloat(val);
                      if (isFinite(num) && num > 0) {
                        const currentStroke = seg.style?.stroke || { color: '#000000', width: 0.8 };
                        const currentDash = currentStroke.dash || [1.6, 0.9];
                        const newStroke = { ...currentStroke, dash: [currentDash[0] || 1.6, num] };
                        upsertNode({
                          ...seg,
                          style: { ...seg.style, stroke: newStroke }
                        } as any);
                      }
                    }}
                    placeholder="0.9"
                    style={{
                      width: 32,
                      padding: '4px 6px',
                      border: 'none',
                      background: 'rgba(255,255,255,0.10)',
                      borderRadius: 4,
                      fontSize: 11,
                      outline: 'none',
                      color: '#fff',
                      textAlign: 'center'
                    }}
                  />
                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', whiteSpace: 'nowrap' }}>dash</span>
                </div>
              </div>

              {/* Center mark style */}
              <div style={{ marginTop: 8 }}>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.9)', display: 'block', marginBottom: 4 }}>중앙 표식</span>
                <div style={{ display: 'flex', gap: 4 }}>
                  {[
                    { key: 'none', label: '없음', value: undefined as any },
                    { key: 'single', label: 'ㅣ', value: 'single' as const },
                    { key: 'double', label: 'ㅣㅣ', value: 'double' as const }
                  ].map((opt) => {
                    const active = ((seg as any).centerMark ?? undefined) === opt.value;
                    return (
                      <button
                        key={opt.key}
                        onClick={() => {
                          const next = { ...seg } as any;
                          if (opt.value === undefined) delete next.centerMark; else next.centerMark = opt.value;
                          upsertNode(next);
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = active ? 'rgba(33, 150, 243, 0.25)' : 'rgba(255,255,255,0.18)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = active ? 'rgba(33, 150, 243, 0.15)' : 'rgba(255,255,255,0.10)';
                        }}
                        style={{
                          ...btnStyle(active),
                          flex: 1,
                          height: 28,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: '0 6px',
                          minWidth: 0
                        }}
                        title={opt.label}
                      >
                        <span style={{ fontSize: 12 }}>{opt.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function arrEq(a?: number[], b?: number[]) {
  const aa = a || [];
  const bb = b || [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false;
  return true;
}

function btnStyle(active: boolean) {
  return {
    padding: '6px 10px',
    border: 'none',
    background: active ? 'rgba(33, 150, 243, 0.15)' : 'rgba(255,255,255,0.10)',
    borderRadius: 8,
    fontSize: 11,
    color: '#fff',
    cursor: 'pointer',
    transition: 'all 0.2s',
    fontWeight: 500
  } as React.CSSProperties;
}


