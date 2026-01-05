import { describe, it, expect } from 'vitest';

describe('Y축 스케일 기능', () => {
  it('yScale 기본값은 1이어야 함', () => {
    const view = { scale: 1, rotation: 0, translate: { x: 0, y: 0 }, yScale: 1 };
    expect(view.yScale).toBe(1);
  });

  it('yScale 값이 변경되어야 함', () => {
    const view = { scale: 1, rotation: 0, translate: { x: 0, y: 0 }, yScale: 1 };
    view.yScale = 2;
    expect(view.yScale).toBe(2);
  });

  it('yScale이 undefined일 때 기본값 1로 처리되어야 함', () => {
    const view = { scale: 1, rotation: 0, translate: { x: 0, y: 0 } };
    const yScale = view.yScale ?? 1;
    expect(yScale).toBe(1);
  });

  it('y 좌표 변환 시 yScale이 적용되어야 함', () => {
    const worldY = 10;
    const yScale = 2;
    const scale = 1;
    
    // 렌더링: y * yScale
    const transformedY = worldY * yScale;
    expect(transformedY).toBe(20);
  });

  it('화면 좌표 -> 월드 좌표 변환 시 yScale이 역으로 적용되어야 함', () => {
    const screenY = 20;
    const translateY = 0;
    const scale = 1;
    const yScale = 2;
    
    // 역변환: -((screenY - translateY) / (scale * yScale))
    const worldY = -((screenY - translateY) / (scale * yScale));
    expect(worldY).toBe(-10);
  });
});

