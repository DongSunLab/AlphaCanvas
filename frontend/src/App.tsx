import './App.css'
import { PixiStage } from './renderer/PixiStage'
import { useSceneStore } from './state/store'
import { sceneToSVG, sceneToSVGWithMetrics, measureDrawnBoundsMm } from './export/svg'
import { LeftPanel } from './components/LeftPanel'
import { AgentPanel } from './components/AgentPanel'
import { TermsModal } from './components/TermsModal'
import { useEffect, useRef, useState } from 'react'

function App() {
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const [showToast, setShowToast] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const didInitView = useRef(false);
  const [bboxMm, setBboxMm] = useState<{ w: number; h: number } | null>(null);
  const [isExportHovered, setIsExportHovered] = useState(false);
  const [isPngHovered, setIsPngHovered] = useState(false);

  const setDefaultView = () => {
    const container = canvasContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const width = rect.width; const height = rect.height;
    const state = useSceneStore.getState() as any;
    const setView = state.setView as any;
    const nodes = state.scene.nodes as any;
    const yScale = state.scene.view.yScale ?? 1;

    // Compute axis-extents if available
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    let hasAxis = false;
    for (const n of Object.values(nodes) as any[]) {
      if (n && n.kind === 'axis') {
        const o = nodes[n.originId];
        const e = nodes[n.endpointId];
        if (o && e && o.kind === 'anchor' && e.kind === 'anchor') {
          hasAxis = true;
          xMin = Math.min(xMin, o.position.x, e.position.x);
          xMax = Math.max(xMax, o.position.x, e.position.x);
          yMin = Math.min(yMin, o.position.y, e.position.y);
          yMax = Math.max(yMax, o.position.y, e.position.y);
        }
      }
    }
    // Fallback to a reasonable default world box when axes are missing
    if (!hasAxis || !isFinite(xMin) || !isFinite(xMax) || !isFinite(yMin) || !isFinite(yMax)) {
      xMin = -11; xMax = 11; yMin = -11; yMax = 11;
    }
    const xRange = Math.max(1e-6, xMax - xMin);
    const yRange = Math.max(1e-6, yMax - yMin);
    // Add padding so content isn't tight to edges
    const pad = 1.4; // Adjusted for 78mm bounding box
    const targetX = xRange * pad;
    const targetY = yRange * pad;
    // Because screen Y uses yScale * scale, include yScale in fit
    const fitScaleX = width / targetX;
    const fitScaleY = height / (targetY * Math.max(1e-6, yScale));
    const scale = Math.max(0.01, Math.min(fitScaleX, fitScaleY));
    // Center world box to screen center (account for yScale in Y translation)
    const cx = (xMin + xMax) / 2;
    const cy = (yMin + yMax) / 2;
    const tx = width / 2 - scale * cx;
    const ty = height / 2 + scale * yScale * cy;
    setView({ scale, rotation: 0, translate: { x: tx, y: ty }, yScale });
    try { window.dispatchEvent(new Event('alphacanvas-reset-canvas')); } catch { }
  };

  // Initialize intersections with existing points on mount
  useEffect(() => {
    useSceneStore.getState().updateIntersectionsWithPoints();
  }, []);

  // Global delete key to remove selected drawable nodes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Delete') {
        const { selectedIds, scene, removeNode, setSelected } = useSceneStore.getState() as any;
        if (selectedIds && selectedIds.length > 0) {
          const id = selectedIds[0];
          const node = scene.nodes[id] as any;
          if (node && (node.kind === 'segment' || node.kind === 'math-text' || node.kind === 'line' || node.kind === 'bezier' || node.kind === 'point')) {
            removeNode(id);
            setSelected([]);
            e.preventDefault();
            e.stopPropagation();
          }
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        // Ctrl+Z -> undo, Ctrl+Shift+Z -> redo
        const { undo, redo } = useSceneStore.getState() as any;
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
        e.preventDefault();
        e.stopPropagation();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        // Ctrl+C -> copy SVG to clipboard
        // Check if user is not typing in an input field
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
          return; // Allow normal copy in input fields
        }

        e.preventDefault();
        e.stopPropagation();

        // Copy SVG to clipboard
        const container = canvasContainerRef.current;
        const scene = useSceneStore.getState().scene;

        if (!container) {
          console.warn('Canvas container not found');
          return;
        }

        const rect = container.getBoundingClientRect();
        const width = rect.width;
        const height = rect.height;

        sceneToSVG(scene, {
          viewportPx: { width, height },
          clipToView: true,
          padding: 0,
          includeLabels: true,
          fitToContent: true,
          physicalCanvasMm: 100
        }).then(svg => {
          // Copy as HTML with embedded SVG data URI for broad paste compatibility (HTML mode)
          const svgBase64 = btoa(unescape(encodeURIComponent(svg)));
          const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><img src="data:image/svg+xml;base64,${svgBase64}"/></body></html>`;
          const item = new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }) });

          navigator.clipboard.write([item]).then(() => {
            setShowToast(true);
            setTimeout(() => setShowToast(false), 2000);
          }).catch(err => {
            console.error('Failed to copy SVG to clipboard:', err);
          });
        });
      }
    };
    window.addEventListener('keydown', onKey, { capture: true } as any);
    return () => window.removeEventListener('keydown', onKey as any, { capture: true } as any);
  }, []);

  // Event listener to open Terms Modal from other components
  useEffect(() => {
    const handleOpenTerms = () => setShowTerms(true);
    window.addEventListener('open-terms-modal', handleOpenTerms);
    return () => window.removeEventListener('open-terms-modal', handleOpenTerms);
  }, []);

  // Event listener for AI agent's fit-to-screen command
  useEffect(() => {
    const handleFitToScreen = () => {
      try { setDefaultView(); } catch { }
    };
    window.addEventListener('alphacanvas-fit-to-screen', handleFitToScreen);
    return () => window.removeEventListener('alphacanvas-fit-to-screen', handleFitToScreen);
  }, []);

  const scene = useSceneStore((s) => s.scene)
  const currentTool = useSceneStore((s) => s.currentTool)

  // Measure drawn bounds in mm whenever scene or canvas size changes
  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) {
      setBboxMm(null);
      return;
    }
    let cancelled = false;
    const recalc = () => {
      const rect = container.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      measureDrawnBoundsMm(scene, { width, height }, { includeLabels: true, physicalCanvasMm: 100 })
        .then(({ widthMm, heightMm }) => { if (!cancelled) setBboxMm({ w: widthMm, h: heightMm }); })
        .catch(() => { if (!cancelled) setBboxMm(null); });
    };
    // Initial
    const timer = setTimeout(recalc, 30);
    // Observe resize for live updates
    let ro: ResizeObserver | null = null;
    if ('ResizeObserver' in window) {
      ro = new ResizeObserver(() => recalc());
      ro.observe(container);
    } else {
      (window as Window).addEventListener('resize', recalc);
    }
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (ro) ro.disconnect();
      else (window as Window).removeEventListener('resize', recalc);
    };
  }, [scene]);
  // Initialize view to the same zoom/center as the reset button on first mount
  useEffect(() => {
    if (didInitView.current) return;
    let ro: ResizeObserver | null = null;
    const tryInit = () => {
      if (didInitView.current) return;
      if (!canvasContainerRef.current) return;
      setDefaultView();
      didInitView.current = true;
    };
    // Initialize after first layout with ResizeObserver to ensure final size
    if ('ResizeObserver' in window) {
      ro = new ResizeObserver(() => tryInit());
      if (canvasContainerRef.current) ro.observe(canvasContainerRef.current);
      // Fallback in case observer doesn't fire
      const raf = requestAnimationFrame(tryInit);
      return () => { cancelAnimationFrame(raf); if (ro && canvasContainerRef.current) ro.disconnect(); };
    } else {
      const raf = requestAnimationFrame(tryInit);
      return () => cancelAnimationFrame(raf);
    }
  }, []);

  const getToolName = (tool: string) => {
    switch (tool) {
      case 'select': return '선택 모드'
      case 'pan': return '팬 모드'
      case 'line': return '직선 모드'
      case 'bezier': return '베지에 모드'
      case 'arrow': return '화살표 모드'
      case 'two-point-line': return '두 점 직선 모드'
      case 'two-point-segment': return '두 점 선분 모드'
      case 'two-point-dashed': return '두 점 점선 모드'
      case 'two-point-ray': return '두 점 반직선 모드'
      case 'two-point-angle': return '각도 모드'
      case 'curve-tangent': return '곡선 접선 모드'
      case 'curve-point': return '점 모드'
      case 'paint': return '영역 페인트 모드'
      case 'length-dashed': return '길이 점선 모드'
      case 'circle-3pt': return '세 점 원 모드'
      case 'circle-center': return '중심·한점 원 모드'
      case 'circle-radius': return '중심·반지름 원 모드'
      case 'magnifier': return '돋보기 모드'
      default: return '모드없음'
    }
  }

  const exportSvg = async () => {
    // Get canvas container size for WYSIWYG export
    const container = canvasContainerRef.current;
    if (!container) {
      console.warn('Canvas container not found, exporting with default bounds');
      const svg = await sceneToSVG(scene);
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'alphacanvas.svg';
      a.click();
      URL.revokeObjectURL(url);
      return;
    }

    const rect = container.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    // Export tight to content, with physical mapping of 100mm across canvas width
    const svg = await sceneToSVG(scene, {
      viewportPx: { width, height },
      clipToView: true,
      padding: 0,
      includeLabels: true,
      fitToContent: true,
      physicalCanvasMm: 100
    });

    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'alphacanvas.svg';
    a.click();
    URL.revokeObjectURL(url);
  }

  const exportPng = async () => {
    // Get canvas container size for WYSIWYG export
    const container = canvasContainerRef.current;
    if (!container) {
      console.warn('Canvas container not found');
      return;
    }

    const rect = container.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    // Generate SVG first.
    // For PNG, we want:
    // - stroke widths computed with the same physical mapping as SVG export (physicalCanvasMm)
    // - BUT root <svg> width/height in px-like units matching viewBox to avoid rasterizer letterboxing.
    const { svg: rawSvg } = await sceneToSVGWithMetrics(scene, {
      viewportPx: { width, height },
      clipToView: true,
      padding: 0,
      includeLabels: true,
      fitToContent: true,
      physicalCanvasMm: 100
    });

    // Normalize root svg width/height to match viewBox (in px-like user units).
    // This preserves correct aspect ratio during rasterization while keeping physically-derived stroke widths.
    let svg = rawSvg;
    let vbW = width;
    let vbH = height;
    try {
      const m = svg.match(/viewBox="([^"]+)"/);
      if (m && m[1]) {
        const parts = m[1].trim().split(/\s+/).map(Number);
        if (parts.length === 4) {
          const w = parts[2];
          const h = parts[3];
          if (Number.isFinite(w) && Number.isFinite(h) && w > 1e-9 && h > 1e-9) {
            vbW = w;
            vbH = h;
          }
        }
      }
    } catch { }
    svg = svg.replace(/<svg\b([^>]*)>/, (_full, attrs) => {
      let next = String(attrs);
      if (/\bwidth=/.test(next)) next = next.replace(/\bwidth="[^"]*"/, `width="${vbW}"`);
      else next += ` width="${vbW}"`;
      if (/\bheight=/.test(next)) next = next.replace(/\bheight="[^"]*"/, `height="${vbH}"`);
      else next += ` height="${vbH}"`;
      if (!/\bpreserveAspectRatio=/.test(next)) next += ` preserveAspectRatio="xMidYMid meet"`;
      return `<svg${next}>`;
    });

    // Determine aspect ratio from the exported SVG's viewBox (fitToContent bounds),
    // NOT from the on-screen container (which is forced square via CSS).
    // This makes PNG export reflect cases where the content is wide or tall.
    const exportAspectRatio = vbW / vbH;

    // 4K resolution - apply to the longer side, maintain aspect ratio
    const target4K = 3840;
    let targetWidth: number;
    let targetHeight: number;

    if (exportAspectRatio >= 1) {
      targetWidth = target4K;
      targetHeight = Math.round(target4K / exportAspectRatio);
    } else {
      targetHeight = target4K;
      targetWidth = Math.round(target4K * exportAspectRatio);
    }

    // Create an image from SVG
    const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const svgUrl = URL.createObjectURL(svgBlob);

    const img = new Image();
    img.onload = () => {
      // Create high-res canvas with correct aspect ratio
      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext('2d');

      if (!ctx) {
        console.error('Could not get canvas context');
        URL.revokeObjectURL(svgUrl);
        return;
      }

      // Fill with white background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, targetWidth, targetHeight);

      // Draw SVG image scaled to target dimensions
      ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

      // Convert to PNG and download
      canvas.toBlob((blob) => {
        if (!blob) {
          console.error('Failed to create PNG blob');
          return;
        }
        const pngUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = pngUrl;
        a.download = 'alphacanvas_4k.png';
        a.click();
        URL.revokeObjectURL(pngUrl);
      }, 'image/png', 1.0);

      URL.revokeObjectURL(svgUrl);
    };

    img.onerror = () => {
      console.error('Failed to load SVG for PNG conversion');
      URL.revokeObjectURL(svgUrl);
    };

    img.src = svgUrl;
  }
  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      overflow: 'hidden',
      display: 'flex',
      backgroundImage: 'url(/background.png)',
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat',
      padding: '16px',
      gap: '8px',
      boxSizing: 'border-box'
    }}>
      {/* Left Panel - Function/Math Text Lists */}
      <LeftPanel />

      {/* Center - Canvas */}
      <div className="canvas-container" style={{
        flex: 1,
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center'
      }}>
        {/* Canvas with white background and rounded corners - Square */}
        <div ref={canvasContainerRef} style={{
          aspectRatio: '1',
          width: '100%',
          maxWidth: 'min(calc(100vh - 32px), 100%)',
          maxHeight: '100%',
          background: '#ffffff',
          borderRadius: 16,
          overflow: 'visible',
          boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
          position: 'relative'
        }}>
          <PixiStage />
          {/* Canvas Toolbar (Top-Left) */}
          <div style={{
            position: 'absolute',
            top: 16,
            left: 16,
            zIndex: 120,
            display: 'flex',
            alignItems: 'center',
            background: '#4a4a4a', // Solid dark background
            padding: '6px',
            borderRadius: 12,
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.2)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            gap: 6
          }}>
            {/* Reset Button */}
            <button
              aria-label="캔버스 리셋"
              title="캔버스 리셋"
              onClick={() => {
                const reset = (useSceneStore.getState() as any).resetScene;
                reset();
                try { setDefaultView(); } catch { }
                try { window.dispatchEvent(new Event('alphacanvas-reset-canvas')); } catch { }
              }}
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: 'transparent',
                border: 'none',
                color: '#ffffff', // Explicit white
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.15)';
                e.currentTarget.style.transform = 'rotate(-30deg)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.transform = 'rotate(0deg)';
              }}
            >
              {/* Reset Icon (Rotate CCW) */}
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18, minWidth: 18, minHeight: 18, display: 'block', flexShrink: 0 }}>
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>

            {/* Divider */}
            <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.2)', margin: '0 2px' }} />

            {/* Magnifier Button */}
            <button
              aria-label="돋보기 모드"
              title="돋보기 모드 (왼클릭: 확대, 오른클릭: 축소)"
              onClick={() => {
                const state = useSceneStore.getState() as any;
                const isCurrentlyMagnifier = state.currentTool === 'magnifier';
                const newTool = isCurrentlyMagnifier ? 'select' : 'magnifier';

                if (isCurrentlyMagnifier) {
                  if (state.savedViewBeforeMagnifier) {
                    state.setView(state.savedViewBeforeMagnifier);
                    useSceneStore.setState({ savedViewBeforeMagnifier: null });
                  }
                } else {
                  useSceneStore.setState({ savedViewBeforeMagnifier: { ...state.scene.view } });
                }

                state.setTool(newTool);
              }}
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: currentTool === 'magnifier' ? 'rgba(33, 150, 243, 0.5)' : 'transparent',
                border: 'none',
                color: '#ffffff',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => {
                if (currentTool !== 'magnifier') {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.15)';
                }
              }}
              onMouseLeave={(e) => {
                if (currentTool !== 'magnifier') {
                  e.currentTarget.style.background = 'transparent';
                }
              }}
            >
              {/* Search/Magnifier Icon */}
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18, minWidth: 18, minHeight: 18, display: 'block', flexShrink: 0 }}>
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
            </button>

            {/* Divider */}
            <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.2)', margin: '0 2px' }} />

            {/* Fit to Axes Button (크기 맞춤) */}
            <button
              aria-label="크기 맞춤"
              title="크기 맞춤 (축에 맞게 배율 조절)"
              onClick={() => {
                setDefaultView();
              }}
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: 'transparent',
                border: 'none',
                color: '#ffffff',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.15)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              {/* Fit/Expand Icon */}
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18, minWidth: 18, minHeight: 18, display: 'block', flexShrink: 0 }}>
                <path d="M15 3h6v6" />
                <path d="M9 21H3v-6" />
                <path d="M21 3l-7 7" />
                <path d="M3 21l7-7" />
              </svg>
            </button>

            {/* Zoom Level Display */}
            <div style={{
              height: 32,
              padding: '0 10px',
              borderRadius: 8,
              background: 'rgba(0,0,0,0.3)',
              color: '#ffffff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 12,
              fontWeight: 700,
              fontVariantNumeric: 'tabular-nums',
              minWidth: 48,
              cursor: 'default',
              userSelect: 'none'
            }}>
              {Math.round((scene.view.magnification ?? 1) * 100)}%
            </div>
          </div>

          {/* Bottom info bar - inside canvas */}
          <div style={{
            position: 'absolute',
            bottom: 16,
            left: 16,
            zIndex: 100,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            pointerEvents: 'none'
          }}>
            {/* Unified Info Bar */}
            <div style={{
              padding: '6px 14px',
              background: '#4a4a4a',
              backdropFilter: 'blur(10px)',
              borderRadius: 8,
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              color: '#fff',
              fontSize: 12,
              fontWeight: 500,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              pointerEvents: 'auto'
            }}>
              {/* Current Mode */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: currentTool === 'select' ? '#4CAF50' : '#2196F3',
                  boxShadow: currentTool === 'select' ? '0 0 6px rgba(76, 175, 80, 0.5)' : '0 0 6px rgba(33, 150, 243, 0.5)'
                }} />
                <span style={{ fontWeight: 600 }}>{getToolName(currentTool)}</span>
              </div>

              {/* Divider */}
              <div style={{ width: 1, height: 14, background: 'rgba(255, 255, 255, 0.2)' }} />

              {/* Size */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: 'rgba(255, 255, 255, 0.5)', fontSize: 11 }}>SIZE</span>
                <span style={{ color: 'rgba(255, 255, 255, 0.9)' }}>
                  {bboxMm ? `${bboxMm.w.toFixed(2)} × ${bboxMm.h.toFixed(2)} mm` : '--'}
                </span>
              </div>

              {/* Divider */}
              <div style={{ width: 1, height: 14, background: 'rgba(255, 255, 255, 0.2)' }} />

              {/* Canvas Scale */}
              <span style={{ color: 'rgba(255, 255, 255, 0.7)', fontSize: 11 }}>
                100mm
              </span>
            </div>
          </div>

          <div style={{
            position: 'absolute',
            bottom: 16,
            right: 16,
            zIndex: 100,
            display: 'flex',
            gap: 8
          }}>

            <button
              onClick={exportPng}
              disabled={Math.abs((scene.view.magnification ?? 1) - 1) > 0.01}
              onMouseEnter={() => setIsPngHovered(true)}
              onMouseLeave={() => setIsPngHovered(false)}
              style={{
                padding: '8px 16px',
                background: Math.abs((scene.view.magnification ?? 1) - 1) > 0.01 ? 'rgba(0,0,0,0.1)' : (isPngHovered ? '#3a3a3a' : '#4a4a4a'),
                border: 'none',
                borderRadius: 8,
                color: Math.abs((scene.view.magnification ?? 1) - 1) > 0.01 ? 'rgba(0,0,0,0.3)' : '#fff',
                cursor: Math.abs((scene.view.magnification ?? 1) - 1) > 0.01 ? 'not-allowed' : 'pointer',
                fontWeight: 600,
                fontSize: 12,
                transition: 'all 0.2s',
                boxShadow: Math.abs((scene.view.magnification ?? 1) - 1) > 0.01 ? 'none' : (isPngHovered ? '0 4px 12px rgba(0, 0, 0, 0.3)' : '0 2px 8px rgba(0, 0, 0, 0.15)'),
                transform: Math.abs((scene.view.magnification ?? 1) - 1) > 0.01 ? 'translateY(0)' : (isPngHovered ? 'translateY(-1px)' : 'translateY(0)'),
                pointerEvents: 'auto'
              }}
              title={Math.abs((scene.view.magnification ?? 1) - 1) > 0.01 ? '줌 레벨을 100%로 복구한 후 내보내기 가능합니다' : 'PNG 4K 내보내기'}>
              PNG
            </button>

            <button
              onClick={exportSvg}
              disabled={Math.abs((scene.view.magnification ?? 1) - 1) > 0.01}
              onMouseEnter={() => setIsExportHovered(true)}
              onMouseLeave={() => setIsExportHovered(false)}
              style={{
                padding: '8px 16px',
                background: Math.abs((scene.view.magnification ?? 1) - 1) > 0.01 ? 'rgba(0,0,0,0.1)' : (isExportHovered ? '#1976D2' : '#2196F3'),
                border: 'none',
                borderRadius: 8,
                color: Math.abs((scene.view.magnification ?? 1) - 1) > 0.01 ? 'rgba(0,0,0,0.3)' : '#fff',
                cursor: Math.abs((scene.view.magnification ?? 1) - 1) > 0.01 ? 'not-allowed' : 'pointer',
                fontWeight: 600,
                fontSize: 12,
                transition: 'all 0.2s',
                backdropFilter: 'blur(10px)',
                boxShadow: Math.abs((scene.view.magnification ?? 1) - 1) > 0.01 ? 'none' : (isExportHovered ? '0 4px 12px rgba(33, 150, 243, 0.4)' : '0 2px 8px rgba(33, 150, 243, 0.2)'),
                transform: Math.abs((scene.view.magnification ?? 1) - 1) > 0.01 ? 'translateY(0)' : (isExportHovered ? 'translateY(-1px)' : 'translateY(0)'),
                pointerEvents: 'auto'
              }}
              title={Math.abs((scene.view.magnification ?? 1) - 1) > 0.01 ? '줌 레벨을 100%로 복구한 후 내보내기 가능합니다' : 'SVG 내보내기'}>
              SVG
            </button>
          </div>
        </div>
      </div>

      {/* Right Panel - Agent */}
      <div style={{
        width: 400,
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden'
      }}>
        <AgentPanel />
      </div>

      <TermsModal isOpen={showTerms} onClose={() => setShowTerms(false)} />

      {/* Toast notification */}
      {showToast && (
        <div style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          background: 'rgba(0, 0, 0, 0.85)',
          color: '#fff',
          padding: '16px 32px',
          borderRadius: 12,
          fontSize: 16,
          fontWeight: 500,
          zIndex: 9999,
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
          animation: 'fadeInOut 2s ease-in-out',
          pointerEvents: 'none'
        }}>
          SVG가 복사되었습니다.
        </div>
      )}

    </div>
  )
}

export default App
