import { describe, it, expect } from 'vitest';
import { connectSegmentsToPolylines, marchingSquaresSegments } from '../mathEval';

describe('connectSegmentsToPolylines', () => {
  it('connects simple chain into one polyline', () => {
    const segs = [
      { a: { x: 0, y: 0 }, b: { x: 1, y: 0 } },
      { a: { x: 1, y: 0 }, b: { x: 2, y: 0 } },
      { a: { x: 2, y: 0 }, b: { x: 3, y: 0 } }
    ];
    const polys = connectSegmentsToPolylines(segs);
    expect(polys.length).toBe(1);
    expect(polys[0].length).toBe(4);
    expect(polys[0][0].x).toBe(0);
    expect(polys[0][3].x).toBe(3);
  });

  it('handles disjoint sets as separate polylines', () => {
    const segs = [
      { a: { x: 0, y: 0 }, b: { x: 1, y: 0 } },
      { a: { x: 10, y: 0 }, b: { x: 11, y: 0 } }
    ];
    const polys = connectSegmentsToPolylines(segs);
    expect(polys.length).toBe(2);
  });
});

describe('marchingSquaresSegments (smoke)', () => {
  it('returns some segments for a simple circle', () => {
    const segs = marchingSquaresSegments('x*x + y*y - 1', ['x', 'y'], { xMin: -2, xMax: 2, yMin: -2, yMax: 2 }, 64);
    expect(Array.isArray(segs)).toBe(true);
    expect(segs.length).toBeGreaterThan(0);
  });
});


