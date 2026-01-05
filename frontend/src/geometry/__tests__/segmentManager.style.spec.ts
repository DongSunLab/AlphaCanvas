import { describe, it, expect } from 'vitest';
import { SegmentManager } from '../segmentManager';

describe('SegmentManager.splitAtIntersections style propagation', () => {
  it('preserves stroke color/dash/opacity from fn.style when creating segments (no intersections)', () => {
    const mgr = new SegmentManager();
    const fn: any = {
      id: 'fn1',
      kind: 'function-explicit',
      style: { stroke: { color: '#ff0000', width: 0.35, dash: [1.6, 0.9], opacity: 0.5 } }
    };
    const samples = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    const createAnchorFn = (pos: any) => `a_${pos.x}_${pos.y}`;
    const segs = mgr.splitAtIntersections(fn, samples as any, [], createAnchorFn as any);
    expect(segs.length).toBe(1);
    expect(segs[0].style?.stroke?.color).toBe('#ff0000');
    expect(segs[0].style?.stroke?.width).toBe(0.35);
    expect(segs[0].style?.stroke?.dash).toEqual([1.6, 0.9]);
    expect(segs[0].style?.stroke?.opacity).toBe(0.5);
  });
});


