import { describe, it, expect } from 'vitest'
import { sceneToSVG } from '../../export/svg'
import type { Scene } from '../../shared/types'

function parseViewBox(svg: string) {
  const m = svg.match(/viewBox="([^"]+)"/);
  if (!m) return null;
  const parts = m[1].split(/\s+/).map(Number);
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

describe('sceneToSVG WYSIWYG', () => {
  it('uses viewport when provided and clips to view', () => {
    const scene: Scene = {
      id: 's1',
      nodes: {
        o: { id: 'o', kind: 'anchor', position: { x: 0, y: 0 } },
        e: { id: 'e', kind: 'anchor', position: { x: 8, y: 0 } },
        x: { id: 'x', kind: 'axis', originId: 'o', endpointId: 'e', name: 'X', style: { color: '#000', width: 2 } },
      },
      zIndex: { o: 0, e: 0, x: 1 },
      view: { scale: 50, rotation: 0, translate: { x: 200, y: 200 } },
    } as any;

    const svg = sceneToSVG(scene, { viewportPx: { width: 800, height: 600 }, clipToView: true });
    expect(svg).toContain('<svg');
    const vb = parseViewBox(svg)!;
    expect(vb).toBeTruthy();
    // Expect non-zero width/height and not NaN
    expect(Number.isFinite(vb.w)).toBe(true);
    expect(Number.isFinite(vb.h)).toBe(true);
    expect(vb.w).toBeGreaterThan(0);
    expect(vb.h).toBeGreaterThan(0);
    // Should contain an axis path M ... L ... with flipped y
    expect(svg).toMatch(/<path d="M\s*0\s*0\s*L\s*8\s*0"/);
  });

  it('sets SVG width/height in mm when fitToContent + physicalCanvasMm', () => {
    const scene: Scene = {
      id: 's1',
      nodes: {
        a: { id: 'a', kind: 'anchor', position: { x: 0, y: 0 } },
        b: { id: 'b', kind: 'anchor', position: { x: 10, y: 0 } },
        s: { id: 's', kind: 'line', a: 'a', b: 'b', style: { stroke: { color: '#000', width: 1 } } } as any
      },
      zIndex: { a: 0, b: 0, s: 1 },
      view: { scale: 50, rotation: 0, translate: { x: 0, y: 0 } }
    } as any;
    const svg = sceneToSVG(scene, {
      viewportPx: { width: 500, height: 400 },
      fitToContent: true,
      physicalCanvasMm: 100,
      padding: 0
    });
    // width="100mm" should be present (10 * 50 px = 500 px => 100 mm)
    expect(svg).toMatch(/width="100mm"/);
  });
});


