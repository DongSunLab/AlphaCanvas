import { describe, it, expect } from 'vitest';
import { computeDashedPolyline } from '../dash';

describe('computeDashedPolyline', () => {
  it('returns solid segments when no dash', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    const segs = computeDashedPolyline(pts, undefined, 1);
    expect(segs.length).toBe(1);
    expect(segs[0].a.x).toBe(0);
    expect(segs[0].b.x).toBe(10);
  });

  it('splits by dash pattern in pixels', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    const segs = computeDashedPolyline(pts, [5, 5], 1); // 5px dash, 5px gap
    // Expect first dash 0->5, then gap, then dash 10-length sums to 10 total
    expect(segs.length).toBe(2);
    expect(segs[0].a.x).toBeCloseTo(0);
    expect(segs[0].b.x).toBeCloseTo(5);
    expect(segs[1].a.x).toBeCloseTo(10);
    expect(segs[1].b.x).toBeCloseTo(10);
  });

  it('scales dash by current scale (pixels per world unit)', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    const segs = computeDashedPolyline(pts, [10, 0], 2); // 10px dash at scale=2 => 5 world units
    expect(segs.length).toBe(1);
    expect(segs[0].a.x).toBeCloseTo(0);
    expect(segs[0].b.x).toBeCloseTo(5);
  });
});


