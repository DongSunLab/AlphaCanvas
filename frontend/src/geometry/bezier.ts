import { Bezier } from 'bezier-js';
import type { Vec2 } from '../shared/types';

export function cubicNearestPoint(a: Vec2, c1: Vec2, c2: Vec2, b: Vec2, p: Vec2) {
  const bz = new Bezier(a.x, a.y, c1.x, c1.y, c2.x, c2.y, b.x, b.y);
  const t = bz.project({ x: p.x, y: p.y }).t;
  const pt = bz.get(t);
  const dx = pt.x - p.x;
  const dy = pt.y - p.y;
  const dist = Math.hypot(dx, dy);
  return { t, point: { x: pt.x, y: pt.y }, distance: dist };
}

export function cubicToPath(a: Vec2, c1: Vec2, c2: Vec2, b: Vec2): string {
  return `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`;
}


