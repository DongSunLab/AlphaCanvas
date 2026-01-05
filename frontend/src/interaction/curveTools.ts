import type { SceneNode, Vec2, ExplicitFunctionNode, ImplicitFunctionNode } from '../shared/types';
import { generateStableId } from '../shared/types';
import { buildFunctionRegistry, evaluateWithRegistry } from '../geometry/mathEval';

export type NearestCurvePoint = { point: Vec2; functionId: string } | null;

function distancePointToSegment(p: Vec2, a: Vec2, b: Vec2) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const ab2 = abx * abx + aby * aby;
  if (ab2 <= 1e-12) {
    const dx = p.x - a.x;
    const dy = p.y - a.y;
    return { dist: Math.hypot(dx, dy), foot: { x: a.x, y: a.y } };
  }
  let t = (apx * abx + apy * aby) / ab2;
  t = Math.max(0, Math.min(1, t));
  const fx = a.x + t * abx;
  const fy = a.y + t * aby;
  return { dist: Math.hypot(p.x - fx, p.y - fy), foot: { x: fx, y: fy } };
}

// Find nearest point on any function polyline (segments) within threshold (world units)
export function findNearestCurvePoint(
  nodes: Record<string, SceneNode>,
  click: Vec2,
  thresholdWorld: number
): NearestCurvePoint {
  let best: NearestCurvePoint = null;
  let bestDist = thresholdWorld;
  for (const node of Object.values(nodes)) {
    const seg = node as any;
    if (!seg || seg.kind !== 'segment') continue;
    // Only consider segments that belong to a function
    const fn = nodes[seg.functionId] as any;
    if (!fn || (fn.kind !== 'function-explicit' && fn.kind !== 'function-implicit')) continue;
    const pts = seg.samples as Vec2[];
    for (let i = 0; i < pts.length - 1; i++) {
      const { dist, foot } = distancePointToSegment(click, pts[i], pts[i + 1]);
      if (dist < bestDist) {
        bestDist = dist;
        best = { point: foot, functionId: seg.functionId };
      }
    }
  }
  return best;
}

export type TangentSpec =
  | { type: 'explicit'; m: number; b: number; at: Vec2; fnId: string }
  | { type: 'vertical'; x0: number; at: Vec2; fnId: string };

// Compute tangent at a point lying on the curve of function node (explicit or implicit)
export function computeTangentAtPoint(
  nodes: Record<string, SceneNode>,
  functionId: string,
  at: Vec2
): TangentSpec | null {
  const fnNode = nodes[functionId] as SceneNode | undefined;
  if (!fnNode) return null;
  const registry = buildFunctionRegistry(nodes);

  if ((fnNode as any).kind === 'function-explicit') {
    const fn = fnNode as ExplicitFunctionNode & { variable: string; expr: string };
    const x0 = at.x;
    const y0 = at.y;
    const h = Math.max(1e-6, Math.abs(x0) * 1e-6);
    const yPlus = evaluateWithRegistry(fn.expr, { [fn.variable]: x0 + h }, registry);
    const yMinus = evaluateWithRegistry(fn.expr, { [fn.variable]: x0 - h }, registry);
    if (!isFinite(yPlus) || !isFinite(yMinus)) return null;
    const m = (yPlus - yMinus) / (2 * h);
    if (!isFinite(m)) return { type: 'vertical', x0, at, fnId: functionId };
    const b = y0 - m * x0;
    return { type: 'explicit', m, b, at, fnId: functionId };
  }

  if ((fnNode as any).kind === 'function-implicit') {
    const fn = fnNode as ImplicitFunctionNode & { variables: [string, string]; expr: string };
    const [xVar, yVar] = fn.variables;
    const x0 = at.x;
    const y0 = at.y;
    const h = 1e-4 * Math.max(1, Math.hypot(x0, y0));
    // Partial derivatives via central differences
    const Fx = (evaluateWithRegistry(fn.expr, { [xVar]: x0 + h, [yVar]: y0 }, registry) -
      evaluateWithRegistry(fn.expr, { [xVar]: x0 - h, [yVar]: y0 }, registry)) / (2 * h);
    const Fy = (evaluateWithRegistry(fn.expr, { [xVar]: x0, [yVar]: y0 + h }, registry) -
      evaluateWithRegistry(fn.expr, { [xVar]: x0, [yVar]: y0 - h }, registry)) / (2 * h);
    if (!isFinite(Fx) || !isFinite(Fy)) return null;
    if (Math.abs(Fy) < 1e-8) {
      // Vertical tangent at x = x0
      return { type: 'vertical', x0, at, fnId: functionId };
    }
    const m = -Fx / Fy; // dy/dx = -Fx/Fy
    const b = y0 - m * x0;
    if (!isFinite(m) || !isFinite(b)) return null;
    return { type: 'explicit', m, b, at, fnId: functionId };
  }
  return null;
}

// Build function nodes from tangent spec, using current view to set domain/bounds
export function makeTangentFunctionNode(
  spec: TangentSpec,
  viewBounds: { xMin: number; xMax: number; yMin: number; yMax: number },
  allocateSymbol: () => string
): SceneNode {
  if (spec.type === 'explicit') {
    const id = generateStableId('fn');
    const symbol = allocateSymbol();
    const expr = `${spec.m}*x+(${spec.b})`;
    const node: ExplicitFunctionNode = {
      id,
      kind: 'function-explicit',
      expr,
      variable: 'x',
      domain: [viewBounds.xMin, viewBounds.xMax],
      style: { stroke: { color: '#000000', width: 0.8 } },
      symbol,
    };
    return node as unknown as SceneNode;
  }
  // Vertical line: implicit equation (x - x0) = 0
  const id = generateStableId('fn');
  const symbol = allocateSymbol();
  const expr = `(x-(${spec.x0}))`;
  const node: ImplicitFunctionNode = {
    id,
    kind: 'function-implicit',
    expr,
    variables: ['x', 'y'],
    bounds: { ...viewBounds },
    style: { stroke: { color: '#000000', width: 0.8 } },
    symbol,
  };
  return node as unknown as SceneNode;
}


