import { describe, it, expect } from 'vitest';
import { SegmentManager } from '../segmentManager';

describe('SegmentManager.splitAtIntersections', () => {
  it('splits polyline at given intersection points', () => {
    const mgr = new SegmentManager();
    const fn = { id: 'fn1', style: { stroke: { color: '#000', width: 2 } } } as any;
    const samples = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 }
    ];
    const intersections = [{ x: 1.0, y: 0 }, { x: 2.0, y: 0 }];
    const createAnchor = (_p: { x: number; y: number }) => `a_${Math.random()}`;
    const segs = mgr.splitAtIntersections(fn, samples, intersections, createAnchor);
    expect(segs.length).toBe(3);
    // Check stable IDs by endpoints
    expect(segs[0].samples[0].x).toBe(0);
    expect(segs[0].samples[segs[0].samples.length - 1].x).toBeCloseTo(1);
    expect(segs[1].samples[0].x).toBeCloseTo(1);
    expect(segs[1].samples[segs[1].samples.length - 1].x).toBeCloseTo(2);
    expect(segs[2].samples[0].x).toBeCloseTo(2);
    expect(segs[2].samples[segs[2].samples.length - 1].x).toBe(3);
  });

  it('snaps slightly-off intersections onto the polyline to avoid spikes', () => {
    const mgr = new SegmentManager();
    const fn = { id: 'fn1', style: { stroke: { color: '#000', width: 2 } } } as any;
    const samples = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 }
    ];
    // Off the polyline (y=0), but close enough to be a valid split; should snap to y=0.
    const intersections = [{ x: 1.0, y: 0.1 }];
    const createAnchor = (_p: { x: number; y: number }) => `a_${Math.random()}`;
    const segs = mgr.splitAtIntersections(fn, samples as any, intersections as any, createAnchor);
    expect(segs.length).toBe(2);
    expect(segs[0].samples[segs[0].samples.length - 1].x).toBeCloseTo(1);
    expect(segs[0].samples[segs[0].samples.length - 1].y).toBeCloseTo(0);
    expect(segs[1].samples[0].x).toBeCloseTo(1);
    expect(segs[1].samples[0].y).toBeCloseTo(0);
  });

  it('ignores intersections that are far from the polyline', () => {
    const mgr = new SegmentManager();
    const fn = { id: 'fn1', style: { stroke: { color: '#000', width: 2 } } } as any;
    const samples = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 }
    ];
    const intersections = [{ x: 1.0, y: 100 }];
    const createAnchor = (_p: { x: number; y: number }) => `a_${Math.random()}`;
    const segs = mgr.splitAtIntersections(fn, samples as any, intersections as any, createAnchor);
    expect(segs.length).toBe(1);
    expect(segs[0].samples[0].x).toBe(0);
    expect(segs[0].samples[segs[0].samples.length - 1].x).toBe(3);
  });
});


