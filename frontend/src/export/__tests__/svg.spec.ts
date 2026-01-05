import { describe, it, expect } from 'vitest'
import { sceneToSVG, measureDrawnBoundsMm } from '../../export/svg'
import { Scene } from '../../shared/types'

describe('sceneToSVG', () => {
  it('generates an SVG path for a line segment', async () => {
    const scene: Scene = {
      id: 's1',
      nodes: {
        a: { id: 'a', kind: 'anchor', position: { x: 0, y: 0 } },
        b: { id: 'b', kind: 'anchor', position: { x: 100, y: 0 } },
        s: { id: 's', kind: 'line', a: 'a', b: 'b', style: { stroke: { color: '#000', width: 1 } } } as any
      },
      zIndex: { a: 0, b: 0, s: 1 },
      view: { scale: 1, rotation: 0, translate: { x: 0, y: 0 } }
    }
    const svg = await sceneToSVG(scene)
    expect(svg).toContain('<svg')
    expect(svg).toContain('M 0 0 L 100 0')
  })

  it('computes drawn bounds in mm mapped to 100mm canvas width', async () => {
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
    const viewport = { width: 500, height: 500 };
    const m = await measureDrawnBoundsMm(scene, viewport, { physicalCanvasMm: 100, includeLabels: false });
    // 10 world units * 50 px/unit = 500 px -> 100 mm across canvas width
    expect(Math.abs(m.widthMm - 100)).toBeLessThan(1e-6);
  })

  it('inlines MathJax SVG glyphs so re-saving in vector editors does not drop parts (no <use> refs)', async () => {
    const scene: Scene = {
      id: 's1',
      nodes: {
        t: {
          id: 't',
          kind: 'math-text',
          latex: '\\frac{1}{2}+\\sqrt{x}+\\log(x)',
          position: { x: 0, y: 0 },
          color: '#000000',
          fontSize: 11,
        } as any,
      },
      zIndex: { t: 1 },
      view: { scale: 50, rotation: 0, translate: { x: 0, y: 0 } },
    } as any;

    const svg = await sceneToSVG(scene, { includeLabels: true, fitToContent: true, padding: 0 });

    // With fontCache: 'none', MathJax should inline paths (no <use> indirections).
    expect(svg).not.toContain('<use');
    // Sanity: some MathJax nodes should exist.
    expect(svg).toMatch(/data-mml-node="mfrac"|data-mml-node="msqrt"|data-mml-node="mlog"/);
  })
})


