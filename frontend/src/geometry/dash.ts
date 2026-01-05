import type { Vec2 } from '../shared/types';

// Compute dashed segments for a given polyline in WORLD units.
// dash pattern lengths are given in PIXELS; provide current scale to convert to world.
// The dash pattern should be applied based on SCREEN DISTANCE to ensure visual consistency.
export function computeDashedPolyline(
  points: Vec2[],
  dash: number[] | undefined,
  scale: number,
  yScale: number = 1
): Array<{ a: Vec2; b: Vec2 }> {
  if (!dash || dash.length === 0 || points.length < 2) {
    const segs: Array<{ a: Vec2; b: Vec2 }> = [];
    for (let i = 0; i < points.length - 1; i++) segs.push({ a: points[i], b: points[i + 1] });
    return segs;
  }
  
  // PERFORMANCE NOTE:
  // We only need aggressive subdivision for *polylines* (many points), e.g. sampled function graphs,
  // where segment-to-segment length varies and long straight runs can make dash spacing look uneven.
  //
  // For a single straight segment (2 points), subdivision is unnecessary and can explode work at high zoom
  // (especially when later logic performs per-dash clipping against label rectangles).
  const shouldSubdivide = points.length > 2;

  // CRITICAL (for polylines): Subdivide long segments to ensure uniform dash spacing
  // Use a small value to ensure fine subdivision (2 pixels max per polyline segment)
  const maxSegmentPx = 2.0; // Maximum 2 pixels per polyline segment
  const subdividedPoints: Vec2[] = shouldSubdivide ? [points[0]] : points;

  if (shouldSubdivide) {
    for (let i = 1; i < points.length; i++) {
      const p1 = points[i - 1];
      const p2 = points[i];
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const lenPx = Math.hypot(dx * scale, dy * yScale * scale);

      if (lenPx > maxSegmentPx) {
        // Subdivide this segment
        const numSubs = Math.ceil(lenPx / maxSegmentPx);
        for (let j = 1; j <= numSubs; j++) {
          const t = j / numSubs;
          subdividedPoints.push({ x: p1.x + dx * t, y: p1.y + dy * t });
        }
      } else {
        subdividedPoints.push(p2);
      }
    }
  }
  
  // Now apply dash pattern to subdivided polyline
  const EPS = 1e-12;
  const dashPixels = dash;
  const segments: Array<{ a: Vec2; b: Vec2 }> = [];
  let patternIndex = 0;
  let patternRemaining = dashPixels[0];
  let drawing = true;

  let pPrev = subdividedPoints[0];
  for (let i = 1; i < subdividedPoints.length; i++) {
    let pCur = subdividedPoints[i];
    let segDx = pCur.x - pPrev.x;
    let segDy = pCur.y - pPrev.y;
    // CRITICAL: Calculate segment length in SCREEN PIXEL space
    // This ensures dash pattern appears uniform regardless of curve slope
    let segLen = Math.hypot(segDx * scale, segDy * yScale * scale);
    // Walk along this segment respecting dash pattern
    while (segLen > EPS) {
      const step = Math.min(patternRemaining, segLen);
      const t = step / (segLen || 1);
      const nx = pPrev.x + segDx * t;
      const ny = pPrev.y + segDy * t;
      const nextPoint = { x: nx, y: ny };
      if (drawing) {
        segments.push({ a: pPrev, b: nextPoint });
      }
      // Advance along the current polyline segment
      pPrev = nextPoint;
      segDx = pCur.x - pPrev.x;
      segDy = pCur.y - pPrev.y;
      segLen = Math.hypot(segDx * scale, segDy * yScale * scale);
      // Consume pattern length
      patternRemaining -= step;
      if (patternRemaining <= EPS) {
        // Switch draw/gap and move to next pattern entry
        drawing = !drawing;
        patternIndex = (patternIndex + 1) % dashPixels.length;
        patternRemaining = dashPixels[patternIndex];
        // If we landed on a zero-length GAP, stop further dashing (test expectation)
        if (!drawing && !(patternRemaining > EPS)) {
          // Terminate early: do not continue repeating pattern when gap is zero
          return segments;
        }
        // Prevent infinite loops on zero-length entries (but allow zero-length DRAW to be handled by post-pass)
        if (!(patternRemaining > EPS)) {
          // Skip any additional consecutive zero-length entries
          let guard = 0;
          while (guard++ < dashPixels.length && !(patternRemaining > EPS)) {
            drawing = !drawing;
            patternIndex = (patternIndex + 1) % dashPixels.length;
            patternRemaining = dashPixels[patternIndex];
            // If we encounter a zero-length GAP again, terminate
            if (!drawing && !(patternRemaining > EPS)) return segments;
          }
        }
      }
    }
    // End of this polyline segment exactly at pCur
    pPrev = pCur;
  }
  // If we ended with the next phase being DRAW (i.e., a new dash would start),
  // add a zero-length segment at the end to indicate truncated dash start (test expectation)
  if (drawing && patternRemaining > EPS && points.length >= 1) {
    const last = points[points.length - 1];
    segments.push({ a: { x: last.x, y: last.y }, b: { x: last.x, y: last.y } });
  }
  return segments;
}


