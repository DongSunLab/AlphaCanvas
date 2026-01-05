import RBush from 'rbush';
import type { BezierSegmentNode, LineSegmentNode, SceneNode, Vec2 } from '../shared/types';
import { cubicNearestPoint } from './bezier';

type BBox = { minX: number; minY: number; maxX: number; maxY: number; id: string };

export class HitIndex {
  private tree = new RBush<BBox>();
  rebuild(nodes: Record<string, SceneNode>) {
    const items: BBox[] = [];
    for (const node of Object.values(nodes)) {
      if (node.kind === 'line') {
        const seg = node as LineSegmentNode;
        const a = nodes[seg.a] as any;
        const b = nodes[seg.b] as any;
        if (!a || !b) continue;
        const minX = Math.min(a.position.x, b.position.x);
        const maxX = Math.max(a.position.x, b.position.x);
        const minY = Math.min(a.position.y, b.position.y);
        const maxY = Math.max(a.position.y, b.position.y);
        items.push({ minX, minY, maxX, maxY, id: node.id });
      } else if (node.kind === 'bezier') {
        const seg = node as BezierSegmentNode;
        const a = nodes[seg.a] as any;
        const b = nodes[seg.b] as any;
        const c1 = nodes[seg.c1] as any;
        const c2 = nodes[seg.c2] as any;
        if (!a || !b || !c1 || !c2) continue;
        const xs = [a.position.x, b.position.x, c1.position.x, c2.position.x];
        const ys = [a.position.y, b.position.y, c1.position.y, c2.position.y];
        items.push({ minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys), id: node.id });
      }
    }
    this.tree.clear();
    this.tree.load(items);
  }

  queryPoint(p: Vec2, nodes: Record<string, SceneNode>, radiusPx = 6, scale = 1) {
    // radius in world space
    const r = radiusPx / Math.max(1e-6, scale);
    const hits = this.tree.search({ minX: p.x - r, minY: p.y - r, maxX: p.x + r, maxY: p.y + r } as any);
    let best: { id: string; distance: number } | null = null;
    for (const h of hits) {
      const node = nodes[h.id];
      if (!node) continue;
      let dist = Infinity;
      if (node.kind === 'line') {
        const seg = node as LineSegmentNode;
        const a = (nodes[seg.a] as any).position as Vec2;
        const b = (nodes[seg.b] as any).position as Vec2;
        dist = pointToSegmentDistance(p, a, b);
      } else if (node.kind === 'bezier') {
        const seg = node as BezierSegmentNode;
        const a = (nodes[seg.a] as any).position as Vec2;
        const b = (nodes[seg.b] as any).position as Vec2;
        const c1 = (nodes[seg.c1] as any).position as Vec2;
        const c2 = (nodes[seg.c2] as any).position as Vec2;
        dist = cubicNearestPoint(a, c1, c2, b, p).distance;
      }
      if (dist < r && (!best || dist < best.distance)) best = { id: node.id, distance: dist };
    }
    return best?.id ?? null;
  }
}

export function pointToSegmentDistance(p: Vec2, a: Vec2, b: Vec2) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const denom = abx * abx + aby * aby;
  const t = denom === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / denom));
  const cx = a.x + abx * t;
  const cy = a.y + aby * t;
  return Math.hypot(p.x - cx, p.y - cy);
}


