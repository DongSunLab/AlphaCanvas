import type { Vec2 } from '../shared/types';

/**
 * Enhanced intersection solver that detects both crossing and tangent points
 * Handles explicit-explicit, implicit-implicit, and explicit-implicit combinations
 */

export interface IntersectionSolverOptions {
  tolerance?: number;
  maxIterations?: number;
  gridSamples?: number;
}

const DEFAULT_OPTIONS: Required<IntersectionSolverOptions> = {
  tolerance: 1e-6,
  maxIterations: 50,
  gridSamples: 100,
};

/**
 * Find intersections between two explicit functions: y = f1(x) and y = f2(x)
 * This includes both crossing points and tangent points
 */
export function findExplicitExplicitIntersections(
  f1: (x: number) => number,
  f2: (x: number) => number,
  domain: [number, number],
  options?: IntersectionSolverOptions
): Vec2[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const [xMin, xMax] = domain;
  const dx = (xMax - xMin) / opts.gridSamples;

  // Find potential intersection regions by scanning
  const candidates: [number, number][] = [];
  let prevDiff = f1(xMin) - f2(xMin);

  for (let i = 1; i <= opts.gridSamples; i++) {
    const x = xMin + i * dx;
    const diff = f1(x) - f2(x);

    // Sign change or near-zero indicates potential intersection
    if (!isFinite(prevDiff) || !isFinite(diff)) {
      prevDiff = diff;
      continue;
    }

    // Sign change (crossing) or one value is exactly zero (direct hit)
    if (prevDiff * diff < 0 || (prevDiff * diff === 0 && (Math.abs(prevDiff) < 0.5 || Math.abs(diff) < 0.5))) {
      candidates.push([x - dx, x]);
    }
    // Both values near zero (potential tangent)
    else if (Math.abs(prevDiff) < 0.1 && Math.abs(diff) < 0.1) {
      candidates.push([x - dx, x]);
    }

    prevDiff = diff;
  }

  // Refine each candidate using Newton's method or bisection
  const intersections: Vec2[] = [];
  const seen = new Set<string>();

  for (const [a, b] of candidates) {
    const result = refineIntersectionExplicitExplicit(f1, f2, a, b, opts);
    if (result) {
      const key = `${result.x.toFixed(6)},${result.y.toFixed(6)}`;
      if (!seen.has(key)) {
        seen.add(key);
        intersections.push(result);
      }
    }
  }

  return intersections;
}

/**
 * Refine intersection point for explicit-explicit case
 * Uses Newton's method with fallback to bisection
 */
function refineIntersectionExplicitExplicit(
  f1: (x: number) => number,
  f2: (x: number) => number,
  xLeft: number,
  xRight: number,
  opts: Required<IntersectionSolverOptions>
): Vec2 | null {
  // Define difference function g(x) = f1(x) - f2(x)
  const g = (x: number) => f1(x) - f2(x);

  // Numerical derivative of g
  const dg = (x: number) => {
    const h = Math.max(1e-7, Math.abs(x) * 1e-7);
    return (g(x + h) - g(x - h)) / (2 * h);
  };

  // Try Newton's method first
  let x = (xLeft + xRight) / 2;
  for (let iter = 0; iter < opts.maxIterations; iter++) {
    const gx = g(x);
    if (Math.abs(gx) < opts.tolerance) {
      const y = f1(x);
      if (isFinite(y)) {
        return { x, y };
      }
    }

    const dgx = dg(x);
    if (Math.abs(dgx) < 1e-12) {
      // Derivative too small, switch to bisection
      break;
    }

    const xNew = x - gx / dgx;

    // Keep within bounds
    if (xNew < xLeft || xNew > xRight) {
      break;
    }

    x = xNew;

    if (Math.abs(gx) < opts.tolerance) {
      const y = f1(x);
      if (isFinite(y)) {
        return { x, y };
      }
    }
  }

  // Fallback to bisection
  let a = xLeft;
  let b = xRight;
  let ga = g(a);
  let gb = g(b);

  if (!isFinite(ga) || !isFinite(gb)) {
    return null;
  }

  // If same sign, try to find zero using minimum absolute value
  if (ga * gb > 0) {
    // Check if either endpoint is close to zero
    if (Math.abs(ga) < opts.tolerance) {
      const y = f1(a);
      if (isFinite(y)) return { x: a, y };
    }
    if (Math.abs(gb) < opts.tolerance) {
      const y = f1(b);
      if (isFinite(y)) return { x: b, y };
    }

    // Find minimum in interval
    let minX = a;
    let minVal = Math.abs(ga);
    const steps = 20;
    for (let i = 1; i < steps; i++) {
      const testX = a + (b - a) * i / steps;
      const val = Math.abs(g(testX));
      if (val < minVal) {
        minVal = val;
        minX = testX;
      }
    }

    if (minVal < 0.01) { // More lenient threshold for tangent points
      const y = f1(minX);
      if (isFinite(y)) return { x: minX, y };
    }

    return null;
  }

  // Standard bisection for sign change
  for (let iter = 0; iter < opts.maxIterations; iter++) {
    const mid = (a + b) / 2;
    const gmid = g(mid);

    if (Math.abs(gmid) < opts.tolerance || Math.abs(b - a) < opts.tolerance) {
      const y = f1(mid);
      if (isFinite(y)) {
        return { x: mid, y };
      }
    }

    if (gmid * ga < 0) {
      b = mid;
      gb = gmid;
    } else {
      a = mid;
      ga = gmid;
    }
  }

  const finalX = (a + b) / 2;
  const finalY = f1(finalX);
  if (isFinite(finalY)) {
    return { x: finalX, y: finalY };
  }

  return null;
}

/**
 * Find intersections between two implicit functions: f1(x,y) = 0 and f2(x,y) = 0
 * Uses polyline approximations from marching squares
 */
export function findImplicitImplicitIntersections(
  poly1: Vec2[],
  poly2: Vec2[],
  f1: (x: number, y: number) => number,
  f2: (x: number, y: number) => number,
  options?: IntersectionSolverOptions
): Vec2[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const nearValTol = 0.02; // "near zero" for candidate generation (avoid flooding)

  // Detect coincident/overlapping curves: if most sampled points of poly1 satisfy f2≈0
  // AND most sampled points of poly2 satisfy f1≈0, there is no discrete set of intersections.
  const sampleRatio = (poly: Vec2[], fn: (x: number, y: number) => number) => {
    const n = poly.length;
    if (n === 0) return 0;
    const samples = Math.min(64, n);
    const step = Math.max(1, Math.floor(n / samples));
    let ok = 0;
    let total = 0;
    for (let i = 0; i < n; i += step) {
      const p = poly[i];
      const v = fn(p.x, p.y);
      if (!isFinite(v)) continue;
      total++;
      if (Math.abs(v) < nearValTol) ok++;
      if (total >= samples) break;
    }
    return total > 0 ? ok / total : 0;
  };

  const r12 = sampleRatio(poly1, f2);
  const r21 = sampleRatio(poly2, f1);
  if (r12 > 0.8 && r21 > 0.8) {
    return [];
  }

  // First, find approximate intersections using polyline intersection
  const approxIntersections: Vec2[] = [];

  for (let i = 0; i < poly1.length - 1; i++) {
    const a1 = poly1[i];
    const a2 = poly1[i + 1];

    for (let j = 0; j < poly2.length - 1; j++) {
      const b1 = poly2[j];
      const b2 = poly2[j + 1];

      const intersection = lineSegmentIntersection(a1, a2, b1, b2);
      if (intersection) {
        approxIntersections.push(intersection);
      }
    }
  }

  // Also check for near-misses (potential tangent points or endpoints on surface)
  const pushNearPoints = (poly: Vec2[], fn: (x: number, y: number) => number) => {
    const n = poly.length;
    if (n === 0) return;
    const maxPush = 64;
    const step = Math.max(1, Math.floor(n / maxPush));
    for (let i = 0; i < n; i += step) {
      const p = poly[i];
      const v = fn(p.x, p.y);
      if (!isFinite(v)) continue;
      if (Math.abs(v) < nearValTol) approxIntersections.push(p);
      if (approxIntersections.length > 256) return;
    }
  };

  pushNearPoints(poly1, f2);
  pushNearPoints(poly2, f1);

  // Refine each approximate intersection using 2D Newton's method
  const intersections: Vec2[] = [];
  const seen = new Set<string>();

  for (const approx of approxIntersections) {
    const result = refineIntersectionImplicitImplicit(f1, f2, approx, opts);
    if (result) {
      const key = `${result.x.toFixed(6)},${result.y.toFixed(6)}`;
      if (!seen.has(key)) {
        seen.add(key);
        intersections.push(result);
      }
    }
  }

  return intersections;
}

/**
 * Refine intersection point for implicit-implicit case using 2D Newton's method
 */
function refineIntersectionImplicitImplicit(
  f1: (x: number, y: number) => number,
  f2: (x: number, y: number) => number,
  initial: Vec2,
  opts: Required<IntersectionSolverOptions>
): Vec2 | null {
  let x = initial.x;
  let y = initial.y;

  for (let iter = 0; iter < opts.maxIterations; iter++) {
    const f1Val = f1(x, y);
    const f2Val = f2(x, y);

    // Check convergence
    if (Math.abs(f1Val) < opts.tolerance && Math.abs(f2Val) < opts.tolerance) {
      return { x, y };
    }

    // Compute Jacobian using numerical derivatives
    const h = 1e-7;
    const df1dx = (f1(x + h, y) - f1(x - h, y)) / (2 * h);
    const df1dy = (f1(x, y + h) - f1(x, y - h)) / (2 * h);
    const df2dx = (f2(x + h, y) - f2(x - h, y)) / (2 * h);
    const df2dy = (f2(x, y + h) - f2(x, y - h)) / (2 * h);

    // Solve 2x2 linear system: J * delta = -F
    const det = df1dx * df2dy - df1dy * df2dx;

    if (Math.abs(det) < 1e-12) {
      // Singular Jacobian, can't continue
      break;
    }

    const dx = (-f1Val * df2dy + f2Val * df1dy) / det;
    const dy = (-f2Val * df1dx + f1Val * df2dx) / det;

    // Update with damping to avoid divergence
    const alpha = 0.5;
    x += alpha * dx;
    y += alpha * dy;

    // Check for convergence
    if (Math.abs(dx) < opts.tolerance && Math.abs(dy) < opts.tolerance) {
      const finalF1 = f1(x, y);
      const finalF2 = f2(x, y);
      if (Math.abs(finalF1) < opts.tolerance && Math.abs(finalF2) < opts.tolerance) {
        return { x, y };
      }
    }
  }

  // Check if final position is close enough
  const finalF1 = f1(x, y);
  const finalF2 = f2(x, y);
  if (Math.abs(finalF1) < 0.01 && Math.abs(finalF2) < 0.01) {
    return { x, y };
  }

  return null;
}

/**
 * Find intersections between explicit function y = f(x) and implicit function g(x,y) = 0
 */
export function findExplicitImplicitIntersections(
  fExplicit: (x: number) => number,
  fImplicit: (x: number, y: number) => number,
  polyImplicit: Vec2[],
  domain: [number, number],
  options?: IntersectionSolverOptions
): Vec2[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const [xMin, xMax] = domain;
  const nearValTol = 0.02;

  // Sample the explicit function
  const dx = (xMax - xMin) / opts.gridSamples;
  const explicitSamples: Vec2[] = [];
  for (let i = 0; i <= opts.gridSamples; i++) {
    const x = xMin + i * dx;
    const y = fExplicit(x);
    if (isFinite(y)) {
      explicitSamples.push({ x, y });
    }
  }

  // Find approximate intersections between explicit samples and implicit polyline
  const approxIntersections: Vec2[] = [];

  for (let i = 0; i < explicitSamples.length - 1; i++) {
    const a1 = explicitSamples[i];
    const a2 = explicitSamples[i + 1];

    for (let j = 0; j < polyImplicit.length - 1; j++) {
      const b1 = polyImplicit[j];
      const b2 = polyImplicit[j + 1];

      const intersection = lineSegmentIntersection(a1, a2, b1, b2);
      if (intersection) {
        approxIntersections.push(intersection);
      }
    }
  }

  // Also check for near points (tangent candidates or endpoints on surface)
  // If the explicit curve lies on the implicit one for most of the sampled domain,
  // treat as coincident (no discrete intersection set).
  {
    let ok = 0;
    let total = 0;
    const maxCheck = Math.min(64, explicitSamples.length);
    const step = Math.max(1, Math.floor(explicitSamples.length / Math.max(1, maxCheck)));
    for (let i = 0; i < explicitSamples.length; i += step) {
      const pe = explicitSamples[i];
      const val = fImplicit(pe.x, pe.y);
      if (!isFinite(val)) continue;
      total++;
      if (Math.abs(val) < nearValTol) ok++;
      if (total >= maxCheck) break;
    }
    if (total > 0 && ok / total > 0.8) return [];
  }

  for (const pe of explicitSamples) {
    const val = fImplicit(pe.x, pe.y);
    if (isFinite(val) && Math.abs(val) < nearValTol) {
      approxIntersections.push(pe);
    }
    if (approxIntersections.length > 256) break;
  }

  // Refine each approximate intersection
  const intersections: Vec2[] = [];
  const seen = new Set<string>();

  for (const approx of approxIntersections) {
    const result = refineIntersectionExplicitImplicit(fExplicit, fImplicit, approx, opts);
    if (result) {
      const key = `${result.x.toFixed(6)},${result.y.toFixed(6)}`;
      if (!seen.has(key)) {
        seen.add(key);
        intersections.push(result);
      }
    }
  }

  return intersections;
}

/**
 * Refine intersection point for explicit-implicit case
 * We want to solve: y = f(x) and g(x,y) = 0
 */
function refineIntersectionExplicitImplicit(
  fExplicit: (x: number) => number,
  fImplicit: (x: number, y: number) => number,
  initial: Vec2,
  opts: Required<IntersectionSolverOptions>
): Vec2 | null {
  // We can reduce this to 1D: find x such that g(x, f(x)) = 0
  const h = (x: number) => fImplicit(x, fExplicit(x));

  // Numerical derivative
  const dh = (x: number) => {
    const eps = Math.max(1e-7, Math.abs(x) * 1e-7);
    return (h(x + eps) - h(x - eps)) / (2 * eps);
  };

  let x = initial.x;

  for (let iter = 0; iter < opts.maxIterations; iter++) {
    const hx = h(x);

    if (Math.abs(hx) < opts.tolerance) {
      const y = fExplicit(x);
      if (isFinite(y)) {
        return { x, y };
      }
    }

    const dhx = dh(x);

    if (Math.abs(dhx) < 1e-12) {
      break;
    }

    x -= hx / dhx;
  }

  // Check final result
  const finalH = h(x);
  if (Math.abs(finalH) < 0.01) {
    const y = fExplicit(x);
    if (isFinite(y)) {
      return { x, y };
    }
  }

  return null;
}

/**
 * Utility: Line segment intersection (for polyline approximations)
 */
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

