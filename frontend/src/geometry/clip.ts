import type { Vec2 } from '../shared/types';

export type Rect = { xMin: number; xMax: number; yMin: number; yMax: number };

const isFiniteVec2 = (p: Vec2 | null | undefined): p is Vec2 =>
  !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

const isPointInsideRect = (p: Vec2, r: Rect) =>
  p.x >= r.xMin && p.x <= r.xMax && p.y >= r.yMin && p.y <= r.yMax;

// Liang–Barsky line clipping against axis-aligned rect
export function clipLineToRect(a: Vec2, b: Vec2, r: Rect): [Vec2, Vec2] | null {
  if (!isFiniteVec2(a) || !isFiniteVec2(b)) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  // Degenerate segment: treat as a point.
  // If it's inside the rect, keep it; otherwise clip it out.
  if (Math.abs(dx) <= 1e-12 && Math.abs(dy) <= 1e-12) {
    return isPointInsideRect(a, r) ? [{ x: a.x, y: a.y }, { x: a.x, y: a.y }] : null;
  }

  let t0 = 0;
  let t1 = 1;

  const p = [-dx, dx, -dy, dy];
  const q = [a.x - r.xMin, r.xMax - a.x, a.y - r.yMin, r.yMax - a.y];

  for (let i = 0; i < 4; i++) {
    const pi = p[i];
    const qi = q[i];
    if (pi === 0) {
      if (qi < 0) return null; // parallel and outside
    } else {
      const t = qi / pi;
      if (pi < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }

  const nx0 = a.x + t0 * dx;
  const ny0 = a.y + t0 * dy;
  const nx1 = a.x + t1 * dx;
  const ny1 = a.y + t1 * dy;

  if (![nx0, ny0, nx1, ny1].every(Number.isFinite)) return null;
  return [{ x: nx0, y: ny0 }, { x: nx1, y: ny1 }];
}

// Clip a polyline to rect, returning zero or more polylines
export function clipPolylineToRect(points: Vec2[], r: Rect): Vec2[][] {
  if (!points || points.length < 2) return [];
  const result: Vec2[][] = [];
  let current: Vec2[] = [];
  const same = (p: Vec2, q: Vec2) => Math.abs(p.x - q.x) <= 1e-9 && Math.abs(p.y - q.y) <= 1e-9;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];

    // Break the polyline on invalid samples so NaN/Infinity never propagates into rendering.
    if (!isFiniteVec2(a) || !isFiniteVec2(b)) {
      if (current.length >= 2) result.push(current);
      current = [];
      continue;
    }

    const seg = clipLineToRect(a, b, r);
    if (seg) {
      const [s, e] = seg;
      if (!isFiniteVec2(s) || !isFiniteVec2(e)) continue;
      if (current.length === 0) {
        current.push(s, e);
      } else {
        // Connect or start new
        if (!same(current[current.length - 1], s)) {
          if (current.length >= 2) result.push(current);
          current = [s, e];
        } else {
          current.push(e);
        }
      }
    } else {
      if (current.length >= 2) {
        result.push(current);
      }
      current = [];
    }
  }
  if (current.length >= 2) result.push(current);
  return result;
}


// Compute intersection of a ray p + t * dir (t >= 0) with an axis-aligned rect
// Returns null if the ray does not hit the rect
export function intersectRayWithRect(p: Vec2, dir: Vec2, r: Rect): Vec2 | null {
  const eps = 1e-12;
  if (!isFiniteVec2(p) || !isFiniteVec2(dir)) return null;
  if (Math.abs(dir.x) <= eps && Math.abs(dir.y) <= eps) return null;
  let tMin = Infinity;

  // Vertical sides
  if (Math.abs(dir.x) > eps) {
    const t1 = (r.xMin - p.x) / dir.x;
    if (t1 >= 0) {
      const y = p.y + t1 * dir.y;
      if (y >= r.yMin - eps && y <= r.yMax + eps) tMin = Math.min(tMin, t1);
    }
    const t2 = (r.xMax - p.x) / dir.x;
    if (t2 >= 0) {
      const y = p.y + t2 * dir.y;
      if (y >= r.yMin - eps && y <= r.yMax + eps) tMin = Math.min(tMin, t2);
    }
  }

  // Horizontal sides
  if (Math.abs(dir.y) > eps) {
    const t3 = (r.yMin - p.y) / dir.y;
    if (t3 >= 0) {
      const x = p.x + t3 * dir.x;
      if (x >= r.xMin - eps && x <= r.xMax + eps) tMin = Math.min(tMin, t3);
    }
    const t4 = (r.yMax - p.y) / dir.y;
    if (t4 >= 0) {
      const x = p.x + t4 * dir.x;
      if (x >= r.xMin - eps && x <= r.xMax + eps) tMin = Math.min(tMin, t4);
    }
  }

  if (!Number.isFinite(tMin) || tMin === Infinity) return null;
  return { x: p.x + tMin * dir.x, y: p.y + tMin * dir.y };
}

// Extend polyline endpoints so that the first and last segments reach the rect boundary.
// Does not modify the middle points; returns a new array of points.
// extendStart and extendEnd control which endpoints to extend (default both true)
export function extendPolylineToRect(points: Vec2[], r: Rect, extendStart: boolean = true, extendEnd: boolean = true): Vec2[] {
  if (!points || points.length < 2) return points?.slice() ?? [];
  const out = points.slice();

  // Extend start backwards along direction (p0 <- p1)
  if (extendStart) {
    const p0 = out[0];
    const p1 = out[1];
    if (isFiniteVec2(p0) && isFiniteVec2(p1)) {
      const dirStart = { x: p0.x - p1.x, y: p0.y - p1.y };
      const startHit = intersectRayWithRect(p0, dirStart, r);
      if (startHit) out[0] = startHit;
    }
  }

  // Extend end forwards along direction (pN -> pN-1 direction reversed)
  if (extendEnd) {
    const n = out.length - 1;
    const pn_1 = out[n - 1];
    const pn = out[n];
    if (isFiniteVec2(pn_1) && isFiniteVec2(pn)) {
      const dirEnd = { x: pn.x - pn_1.x, y: pn.y - pn_1.y };
      const endHit = intersectRayWithRect(pn, dirEnd, r);
      if (endHit) out[n] = endHit;
    }
  }

  return out;
}


