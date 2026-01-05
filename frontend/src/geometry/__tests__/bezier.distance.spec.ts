import { describe, it, expect } from 'vitest'
import { cubicNearestPoint } from '../../geometry/bezier'

describe('cubicNearestPoint', () => {
  it('projects onto a simple curve and returns finite distance', () => {
    const a = { x: 0, y: 0 }
    const c1 = { x: 0, y: 100 }
    const c2 = { x: 100, y: 0 }
    const b = { x: 100, y: 100 }
    const p = { x: 50, y: 50 }
    const r = cubicNearestPoint(a, c1, c2, b, p)
    expect(r.distance).toBeGreaterThanOrEqual(0)
    expect(r.t).toBeGreaterThanOrEqual(0)
    expect(r.t).toBeLessThanOrEqual(1)
  })
})


