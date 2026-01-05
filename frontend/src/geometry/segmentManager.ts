import type { Vec2, StableId, SceneNode, ExplicitFunctionNode, ImplicitFunctionNode, SegmentNode } from '../shared/types';
import { generateStableId } from '../shared/types';
import {
  findExplicitExplicitIntersections,
  findImplicitImplicitIntersections,
  findExplicitImplicitIntersections,
  type IntersectionSolverOptions
} from './intersectionSolver';

export class SegmentManager {
  private anchorRegistry: Map<string, StableId> = new Map();
  private quantDigits = 6;
  private nearEps = 1e-3;

  /**
   * Get or create stable anchor ID for a coordinate
   */
  getOrCreateAnchor(x: number, y: number, createAnchorFn: (pos: Vec2) => StableId): StableId {
    const key = this.coordKey(x, y);

    // Check exact match
    if (this.anchorRegistry.has(key)) {
      return this.anchorRegistry.get(key)!;
    }

    // Check nearby anchors (tolerance)
    for (const [existingKey, anchorId] of this.anchorRegistry.entries()) {
      const [ex, ey] = this.parseKey(existingKey);
      if (Math.abs(ex - x) <= this.nearEps && Math.abs(ey - y) <= this.nearEps) {
        return anchorId;
      }
    }

    // Create new anchor
    const anchorId = createAnchorFn({ x, y });
    this.anchorRegistry.set(key, anchorId);
    return anchorId;
  }

  private coordKey(x: number, y: number): string {
    return `${this.quantize(x)}_${this.quantize(y)}`;
  }

  private quantize(v: number): string {
    return v.toFixed(this.quantDigits);
  }

  private parseKey(key: string): [number, number] {
    const [xs, ys] = key.split('_');
    return [parseFloat(xs), parseFloat(ys)];
  }

  /**
   * Find intersections between two functions (legacy method for polyline-based detection)
   * This is kept for backward compatibility and as fallback
   */
  findIntersections(fn1Samples: Vec2[], fn2Samples: Vec2[]): Vec2[] {
    const intersections: Vec2[] = [];

    // Simple line segment intersection check
    for (let i = 0; i < fn1Samples.length - 1; i++) {
      const a1 = fn1Samples[i];
      const a2 = fn1Samples[i + 1];

      for (let j = 0; j < fn2Samples.length - 1; j++) {
        const b1 = fn2Samples[j];
        const b2 = fn2Samples[j + 1];

        const intersection = lineSegmentIntersection(a1, a2, b1, b2);
        if (intersection) {
          intersections.push(intersection);
        }
      }
    }

    return intersections;
  }

  /**
   * Find intersections (including tangent points) between two explicit functions
   */
  findExplicitExplicitIntersections(
    f1: (x: number) => number,
    f2: (x: number) => number,
    domain: [number, number],
    options?: IntersectionSolverOptions
  ): Vec2[] {
    return findExplicitExplicitIntersections(f1, f2, domain, options);
  }

  /**
   * Find intersections (including tangent points) between two implicit functions
   */
  findImplicitImplicitIntersections(
    poly1: Vec2[],
    poly2: Vec2[],
    f1: (x: number, y: number) => number,
    f2: (x: number, y: number) => number,
    options?: IntersectionSolverOptions
  ): Vec2[] {
    return findImplicitImplicitIntersections(poly1, poly2, f1, f2, options);
  }

  /**
   * Find intersections (including tangent points) between explicit and implicit functions
   */
  findExplicitImplicitIntersections(
    fExplicit: (x: number) => number,
    fImplicit: (x: number, y: number) => number,
    polyImplicit: Vec2[],
    domain: [number, number],
    options?: IntersectionSolverOptions
  ): Vec2[] {
    return findExplicitImplicitIntersections(fExplicit, fImplicit, polyImplicit, domain, options);
  }

  /**
   * Split function samples at intersection points
   */
  splitAtIntersections(
    fn: Pick<ExplicitFunctionNode | ImplicitFunctionNode, 'id' | 'style' | 'kind'>,
    samples: Vec2[],
    intersections: Vec2[],
    createAnchorFn: (pos: Vec2) => StableId
  ): SegmentNode[] {
    // 경계 아티팩트 방지: 세그먼트 연장을 전역적으로 비활성화
    const shouldExtend = false;

    if (intersections.length === 0) {
      // No intersections, create single segment
      const startAnchorId = this.getOrCreateAnchor(samples[0].x, samples[0].y, createAnchorFn);
      const endAnchorId = this.getOrCreateAnchor(
        samples[samples.length - 1].x,
        samples[samples.length - 1].y,
        createAnchorFn
      );

      const stroke = {
        color: fn.style?.stroke?.color ?? '#000000',
        width: fn.style?.stroke?.width ?? 0.8,
        dash: fn.style?.stroke?.dash,
        opacity: fn.style?.stroke?.opacity,
      };
      return [{
        id: generateStableId('seg'),
        kind: 'segment',
        functionId: fn.id,
        startAnchorId,
        endAnchorId,
        samples,
        style: { stroke },
        stableSegmentId: this.generateStableSegmentId(samples[0], samples[samples.length - 1]),
        extendStart: shouldExtend,
        extendEnd: shouldExtend
      }];
    }

    // Calculate cumulative length parametrization
    const lengths: number[] = [0];
    let totalLength = 0;
    for (let i = 0; i < samples.length - 1; i++) {
      const dx = samples[i + 1].x - samples[i].x;
      const dy = samples[i + 1].y - samples[i].y;
      totalLength += Math.hypot(dx, dy);
      lengths.push(totalLength);
    }

    // Calculate fractional index 't' for each intersection relative to cumulative length
    // We map each intersection to a global 'distance' along the polyline
    const splits: Array<{ p: Vec2; dist: number; segIdx: number }> = [];
    // Tolerance: if an "intersection" is too far from the sampled polyline, don't split.
    // This avoids inserting off-curve points that create long, spurious straight segments.
    const avgStep = totalLength / Math.max(1, samples.length - 1);
    const snapTol = Math.max(1e-4, avgStep * 3); // world units
    const snapTol2 = snapTol * snapTol;

    for (const p of intersections) {
      let bestDist = -1;
      let minDist = Infinity;
      let bestSegIdx = -1;
      let bestProj: Vec2 | null = null;

      for (let i = 0; i < samples.length - 1; i++) {
        const a = samples[i];
        const b = samples[i + 1];

        // Project p onto segment ab
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        const len = Math.sqrt(len2);

        let t = 0;
        if (len2 > 1e-12) {
          t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
          t = Math.max(0, Math.min(1, t));
        }

        const projX = a.x + t * dx;
        const projY = a.y + t * dy;
        const dist = (p.x - projX) ** 2 + (p.y - projY) ** 2;

        if (dist < minDist) {
          minDist = dist;
          bestDist = lengths[i] + t * len;
          bestSegIdx = i;
          bestProj = { x: projX, y: projY };
        }
      }

      // Only accept if the intersection is sufficiently close to the sampled polyline.
      // Also, snap to the closest point on the polyline (projection) to prevent spikes.
      if (bestDist >= 0 && bestSegIdx >= 0 && minDist <= snapTol2 && bestProj) {
        splits.push({ p: bestProj, dist: bestDist, segIdx: bestSegIdx });
      }
    }

    // Sort splits by distance along the polyline
    splits.sort((a, b) => a.dist - b.dist);

    // Filter duplicates
    const uniqueSplits: typeof splits = [];
    if (splits.length > 0) {
      uniqueSplits.push(splits[0]);
      for (let i = 1; i < splits.length; i++) {
        const prev = uniqueSplits[uniqueSplits.length - 1];
        const curr = splits[i];
        if (curr.dist - prev.dist > 1e-6) { // Distance threshold
          uniqueSplits.push(curr);
        }
      }
    }

    const segments: SegmentNode[] = [];
    let currentSamples: Vec2[] = [];
    let sampleIndex = 0;

    // Helper to create segment node
    let segmentCount = 0;
    const createSegment = (pts: Vec2[]): SegmentNode => {
      const isFirst = segmentCount === 0;
      const isLast = segmentCount === uniqueSplits.length; // roughly check if last
      segmentCount++;

      const startAnchorId = this.getOrCreateAnchor(pts[0].x, pts[0].y, createAnchorFn);
      const endAnchorId = this.getOrCreateAnchor(
        pts[pts.length - 1].x,
        pts[pts.length - 1].y,
        createAnchorFn
      );

      const stroke = {
        color: fn.style?.stroke?.color ?? '#000000',
        width: fn.style?.stroke?.width ?? 0.8,
        dash: fn.style?.stroke?.dash,
        opacity: fn.style?.stroke?.opacity,
      };
      return {
        id: generateStableId('seg'),
        kind: 'segment',
        functionId: fn.id,
        startAnchorId,
        endAnchorId,
        samples: pts,
        style: { stroke },
        stableSegmentId: this.generateStableSegmentId(pts[0], pts[pts.length - 1]),
        // explicit function의 경우 첫 세그먼트만 extendStart (domain auto)
        extendStart: shouldExtend && isFirst,
        extendEnd: shouldExtend && isLast // and last one extends end
        // But logic is simplified to disable extensions to prevent artifacts
      };
    };

    for (const split of uniqueSplits) {
      const splitIndex = split.segIdx;

      // Add regular samples up to the split segment
      while (sampleIndex <= splitIndex && sampleIndex < samples.length) {
        currentSamples.push(samples[sampleIndex]);
        sampleIndex++;
      }

      // Add the intersection point
      // Avoid duplicate point if it's very close to the last sample
      const lastPt = currentSamples[currentSamples.length - 1];
      if (!lastPt || Math.hypot(split.p.x - lastPt.x, split.p.y - lastPt.y) > 1e-6) {
        currentSamples.push(split.p);
      } else {
        // Snap to precise intersection point
        currentSamples[currentSamples.length - 1] = split.p;
      }

      // Create segment
      if (currentSamples.length >= 2) {
        segments.push(createSegment(currentSamples));
      }

      // Start next segment with the intersection point
      currentSamples = [split.p];

      // Note: sampleIndex has advanced past splitIndex.
      // If t was 3.5, sampleIndex is 4 (samples[3] added).
      // If t was 3.0, sampleIndex is 4 (samples[3] added).
      // We are good.
    }

    // Add remaining samples
    while (sampleIndex < samples.length) {
      currentSamples.push(samples[sampleIndex]);
      sampleIndex++;
    }

    if (currentSamples.length >= 2) {
      // Logic for extension: if uniqueness check prevented segment creation before, currentSamples might be short?
      // No, createSegment logic handles checking length >= 2
      // For the last segment, we need to check extends
      const seg = createSegment(currentSamples);
      // Determine if this is truly the last segment relative to original domain
      // For now, disable extendEnd as per `shouldExtend = false`
      segments.push(seg);
    }

    return segments;
  }

  private generateStableSegmentId(start: Vec2, end: Vec2): string {
    return `stable_seg_${this.quantize(start.x)}_${this.quantize(start.y)}_${this.quantize(end.x)}_${this.quantize(end.y)}`;
  }

  /**
   * Hit test: find closest segment to a point
   */
  hitTestSegment(
    point: Vec2,
    segments: SegmentNode[],
    _nodes: Record<StableId, SceneNode>,
    threshold: number = 10
  ): SegmentNode | null {
    let closestSegment: SegmentNode | null = null;
    let minDist = threshold;

    for (const segment of segments) {
      if (segment.hidden) continue;

      for (let i = 0; i < segment.samples.length - 1; i++) {
        const a = segment.samples[i];
        const b = segment.samples[i + 1];
        const dist = pointToLineSegmentDistance(point, a, b);

        if (dist < minDist) {
          minDist = dist;
          closestSegment = segment;
        }
      }
    }

    return closestSegment;
  }
}

// Utility functions
function lineSegmentIntersection(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): Vec2 | null {
  const dx1 = a2.x - a1.x;
  const dy1 = a2.y - a1.y;
  const dx2 = b2.x - b1.x;
  const dy2 = b2.y - b1.y;

  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-10) return null; // parallel

  const t = ((b1.x - a1.x) * dy2 - (b1.y - a1.y) * dx2) / denom;
  const u = ((b1.x - a1.x) * dy1 - (b1.y - a1.y) * dx1) / denom;

  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return {
      x: a1.x + t * dx1,
      y: a1.y + t * dy1
    };
  }

  return null;
}

function pointToLineSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq === 0) {
    return Math.sqrt((p.x - a.x) ** 2 + (p.y - a.y) ** 2);
  }

  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));

  const projX = a.x + t * dx;
  const projY = a.y + t * dy;

  return Math.sqrt((p.x - projX) ** 2 + (p.y - projY) ** 2);
}

export const segmentManager = new SegmentManager();