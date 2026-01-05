import { useEffect } from 'react';
import type { RefObject } from 'react';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - d3 types not installed
import { zoom, zoomIdentity, ZoomTransform, select } from 'd3';
import { useSceneStore } from '../state/store';

export function useD3Zoom(containerRef: RefObject<HTMLElement | null>) {
  const setView = useSceneStore((s) => s.setView);
  // const setInteracting = useSceneStore((s) => s.setInteracting);
  const scene = useSceneStore((s) => s.scene);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const isFromPopup = (ev: Event): boolean => {
      try {
        const target = (ev as any)?.target as any;
        if (target && typeof target.closest === 'function' && target.closest('[data-ac-popup="1"]')) return true;
        const path = (typeof (ev as any)?.composedPath === 'function') ? (ev as any).composedPath() : [];
        for (const p of path as any[]) {
          if (p && typeof p.getAttribute === 'function' && p.getAttribute('data-ac-popup') === '1') return true;
          if (p && typeof p.closest === 'function' && p.closest('[data-ac-popup="1"]')) return true;
        }
      } catch { }
      return false;
    };

    // Add direct wheel event listener for Alt+Wheel or Ctrl+Wheel magnification (real zoom)
    const handleWheel = (ev: WheelEvent) => {
      if (isFromPopup(ev)) return;
      // Check if Alt or Ctrl key is pressed for magnification mode
      if (ev.altKey || ev.ctrlKey) {
        ev.preventDefault(); // Prevent D3 from handling this
        ev.stopPropagation();

        const state = useSceneStore.getState();
        const currentScale = state.scene.view.scale;
        const currentMag = state.scene.view.magnification ?? 1;
        const currentYScale = state.scene.view.yScale ?? 1;
        const currentTranslate = state.scene.view.translate;

        const deltaMode = ev.deltaMode;
        const deltaY = ev.deltaY;
        let delta: number;

        if (deltaMode === 1) {
          delta = -deltaY * 0.015;
        } else if (deltaMode) {
          delta = -deltaY * 0.3;
        } else {
          delta = -deltaY * 0.0005;
        }

        // Apply zoom factor (exponential)
        const factor = Math.exp(delta);
        const newScale = Math.max(0.01, Math.min(500, currentScale * factor));
        const newMag = Math.max(0.1, Math.min(10, currentMag * factor));

        // Calculate mouse position in screen space
        const rect = container.getBoundingClientRect();
        const mouseX = ev.clientX - rect.left;
        const mouseY = ev.clientY - rect.top;

        // Calculate world position before zoom
        const worldXBefore = (mouseX - currentTranslate.x) / currentScale;
        const worldYBefore = -(mouseY - currentTranslate.y) / (currentScale * currentYScale);

        // Calculate world position after zoom (should stay the same)
        // newTranslate.x + worldXBefore * newScale = mouseX
        // newTranslate.y - worldYBefore * newScale * currentYScale = mouseY
        const newTranslateX = mouseX - worldXBefore * newScale;
        const newTranslateY = mouseY + worldYBefore * newScale * currentYScale;

        // Update view with new scale, magnification, and translate (zoom to mouse cursor)
        setView({
          scale: newScale,
          rotation: 0,
          translate: { x: newTranslateX, y: newTranslateY },
          yScale: currentYScale,
          magnification: newMag
        });
      }
    };

    // Add wheel listener with capture to intercept before D3
    container.addEventListener('wheel', handleWheel, { passive: false, capture: true });

    const sel = select(container);
    const z = zoom<HTMLDivElement, unknown>()
      .filter((ev: any) => {
        try {
          if (isFromPopup(ev as any)) return false;
        } catch { }
        // Block zoom/pan in magnifier mode (handled by PointerOverlay)
        const currentTool = useSceneStore.getState().currentTool;
        if (currentTool === 'magnifier') {
          return false;
        }

        // Block all zoom/pan when interacting with editable fields (inputs, textareas, contenteditable, math-field)
        // or during IME composition
        try {
          const target = ev?.target as (HTMLElement | null);
          const active = (document.activeElement as (HTMLElement | null));

          const isEditableEl = (el: HTMLElement | null | undefined) => !!el && (
            el.tagName === 'INPUT' ||
            el.tagName === 'TEXTAREA' ||
            el.getAttribute('contenteditable') === 'true' ||
            // Within mathlive custom element
            el.tagName === 'MATH-FIELD' ||
            !!el.closest?.('math-field')
          );

          // Also inspect composedPath to detect shadow DOM children of <math-field>
          const composedHasMathField = (() => {
            const path = (typeof ev?.composedPath === 'function') ? ev.composedPath() : [];
            for (const p of path as any[]) {
              if (p && p.tagName === 'MATH-FIELD') return true;
              if (p && typeof p.closest === 'function' && p.closest('math-field')) return true;
            }
            return false;
          })();

          // Check if IME composition is active (Korean/Chinese/Japanese input)
          const isComposing = (() => {
            try {
              // Check if event itself has isComposing flag
              if ((ev as any)?.isComposing) return true;
              // Check activeElement for composition state
              if ((active as any)?.isComposing) return true;
              // For math-field, check internal composition state
              const mathFields = document.querySelectorAll('math-field');
              for (const mf of mathFields as any) {
                if (mf?.isComposing || (mf as any)?._isComposing) return true;
              }
            } catch { }
            return false;
          })();

          if (isEditableEl(target) || isEditableEl(active) || composedHasMathField || isComposing) {
            return false;
          }
        } catch { }

        // Block wheel events when Alt or Ctrl is pressed (handled by direct listener above)
        if (ev && (ev.type === 'wheel' || ev.type === 'mousewheel') && (ev.altKey || ev.ctrlKey)) {
          return false;
        }

        // Allow wheel zoom for normal scroll (not Alt/Ctrl)
        if (ev && (ev.type === 'wheel' || ev.type === 'mousewheel')) return true;
        // Block pan if pointer is over interactive (anchor / math-text / segment)
        try {
          const scene = useSceneStore.getState().scene as any;
          const rect = container.getBoundingClientRect();
          const yScale = scene.view.yScale ?? 1;
          const x = (ev.clientX - rect.left - scene.view.translate.x) / scene.view.scale;
          const y = -(ev.clientY - rect.top - scene.view.translate.y) / (scene.view.scale * yScale);
          const scale = scene.view.scale;
          const threshold = 10 / Math.max(1e-6, scale);
          // Anchors
          for (const n of Object.values(scene.nodes) as any[]) {
            if (n.kind === 'anchor') {
              const dx = n.position.x - x; const dy = n.position.y - y;
              if (Math.hypot(dx, dy) <= threshold) return false;
            }
          }
          // Math text (approx rect)
          for (const n of Object.values(scene.nodes) as any[]) {
            if (n.kind === 'math-text') {
              const dx = Math.abs(x - n.position.x);
              const dy = Math.abs(y - n.position.y);
              if (dx <= (100 / scale) / 2 && dy <= (50 / scale) / 2) return false;
            }
          }
          // Segments
          const pointToSegmentDistance = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
            // Apply yScale to y coordinates for distance calculation in scaled space
            const pyScaled = py * yScale;
            const ayScaled = ay * yScale;
            const byScaled = by * yScale;
            const abx = bx - ax; const aby = byScaled - ayScaled;
            const apx = px - ax; const apy = pyScaled - ayScaled;
            const denom = abx * abx + aby * aby;
            const t = denom === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / denom));
            const cx = ax + abx * t; const cy = ayScaled + aby * t;
            return Math.hypot(px - cx, pyScaled - cy);
          };
          for (const n of Object.values(scene.nodes) as any[]) {
            if (n.kind === 'segment' && !n.hidden && n.samples && n.samples.length > 1) {
              for (let i = 0; i < n.samples.length - 1; i++) {
                const a = n.samples[i]; const b = n.samples[i + 1];
                if (pointToSegmentDistance(x, y, a.x, a.y, b.x, b.y) <= threshold) return false;
              }
            }
          }
          // Else allow pan
          return true;
        } catch {
          return true;
        }
      })
      .scaleExtent([0.01, 500])
      .wheelDelta((ev: any) => {
        // Normal wheel: zoom (scale-independent line thickness)
        // Reduce wheel sensitivity to prevent overshooting
        const deltaMode = ev.deltaMode;
        const deltaY = ev.deltaY;
        let delta: number;

        if (deltaMode === 1) {
          // Line mode (Firefox): reduce sensitivity
          delta = -deltaY * 0.015;
        } else if (deltaMode) {
          // Page mode: reduce sensitivity
          delta = -deltaY * 0.3;
        } else {
          // Pixel mode (most browsers): reduce sensitivity significantly
          delta = -deltaY * 0.0005;
        }

        return delta;
      })
      .on('zoom', (ev: any) => {
        // Ignore programmatic transforms to avoid feedback loops
        if (!ev.sourceEvent) return;

        const t: ZoomTransform = ev.transform;
        const currentYScale = useSceneStore.getState().scene.view.yScale ?? 1;
        const currentMag = useSceneStore.getState().scene.view.magnification ?? 1;
        setView({ scale: t.k, rotation: 0, translate: { x: t.x, y: t.y }, yScale: currentYScale, magnification: currentMag });
      });

    // Initialize D3 zoom with current scene view
    const { scale, translate } = scene.view;
    sel.call(z as any).call((z as any).transform, zoomIdentity.translate(translate.x, translate.y).scale(scale));

    // Disable double-click to zoom to avoid conflicts
    sel.on('dblclick.zoom', null);

    // Listen for external reset to sync D3's internal transform to identity (or current view)
    const resetHandler = () => {
      const v = useSceneStore.getState().scene.view;
      const t = zoomIdentity.translate(v.translate.x, v.translate.y).scale(v.scale);
      try { (sel as any).call((z as any).transform, t); } catch { }
    };
    window.addEventListener('alphacanvas-reset-canvas', resetHandler as any);

    // No continuous store subscription (avoids heavy feedback during pan). We rely on explicit reset events and initial call above.
    return () => {
      sel.on('.zoom', null);
      container.removeEventListener('wheel', handleWheel, { capture: true } as any);
      window.removeEventListener('alphacanvas-reset-canvas', resetHandler as any);
    };
  }, [containerRef, setView, scene.view.scale, scene.view.translate.x, scene.view.translate.y]);
}


