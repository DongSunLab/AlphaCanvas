// Shared scene graph and message protocol types (TS)

export type StableId = string;

export type Vec2 = { x: number; y: number };

export type StrokeStyle = {
  color: string;
  width: number;
  dash?: number[];
  opacity?: number;
};

export type FillStyle = {
  color: string;
  opacity?: number;
};

export type StrokeFill = { stroke?: StrokeStyle; fill?: FillStyle };

export type AnchorNode = {
  id: StableId;
  kind: 'anchor';
  position: Vec2; // world space
  constraints?: { locked?: boolean; snap?: boolean };
};

export type LineSegmentNode = {
  id: StableId;
  kind: 'line';
  a: StableId;
  b: StableId;
  style?: StrokeFill;
};

export type BezierSegmentNode = {
  id: StableId;
  kind: 'bezier';
  a: StableId; // start anchor id
  b: StableId; // end anchor id
  c1: StableId; // handle 1 anchor id
  c2: StableId; // handle 2 anchor id
  style?: StrokeFill;
  labelIds?: StableId[]; // connected math-text labels (for length-dashed mode)
};

export type ArrowNode = {
  id: StableId;
  kind: 'arrow';
  a: StableId; // start anchor id
  b: StableId; // end anchor id
  c1: StableId; // handle 1 anchor id
  c2: StableId; // handle 2 anchor id
  style?: StrokeFill;
  showStartArrow?: boolean; // default false
  showEndArrow?: boolean; // default true
  arrowSize?: number; // default 1.0 (multiplier for arrow head size)
};

export type AxisNode = {
  id: StableId;
  kind: 'axis';
  originId: StableId; // anchor ID for origin
  endpointId: StableId; // anchor ID for endpoint (draggable)
  style?: StrokeStyle;
  showArrow?: boolean;
  visible?: boolean; // default true
  name?: string; // e.g. 'X', 'Y'
  labelId?: StableId; // connected label (x or y) that follows endpoint
};

export type ExplicitFunctionNode = {
  id: StableId;
  kind: 'function-explicit';
  expr: string; // e.g. "x^2 + 2*x - 1"
  variable: string; // e.g. "x"
  domain: [number, number]; // [xMin, xMax]
  style?: StrokeFill;
  label?: string; // optional LaTeX label
  clipToAxes?: boolean; // default false
  symbol?: string; // display and dependency symbol, e.g., 'f', 'g'
  segmentsOnly?: boolean; // when true, suppress direct function rendering (segments are authoritative)
  suppressedSegmentIds?: string[]; // stableSegmentIds suppressed (deleted) by user
  // 삭제 복원 방지를 위해, 도메인 양끝 세그먼트(좌/우) 억제 플래그
  suppressedEnds?: { left?: boolean; right?: boolean };
  functionRegistry?: Record<string, { arity: number; fn: (...args: number[]) => number; expr: string }>; // for function calls like f(x)+4
  isPreview?: boolean; // preview mode
};

export type ImplicitFunctionNode = {
  id: StableId;
  kind: 'function-implicit';
  expr: string; // e.g. "x^2 + y^2 - 4" (equals 0)
  variables: [string, string]; // e.g. ["x", "y"]
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number };
  style?: StrokeFill;
  label?: string;
  clipToAxes?: boolean; // default false
  symbol?: string; // display and dependency symbol, e.g., 'f', 'g'
  segmentsOnly?: boolean; // when true, suppress direct function rendering (segments are authoritative)
  suppressedSegmentIds?: string[]; // stableSegmentIds suppressed (deleted) by user
  suppressedSegmentCenters?: Array<{ x: number; y: number; dx: number; dy: number }>; // 음함수 억제 세그먼트의 중심점과 방향 벡터
  // 음함수는 다른 도형 삭제/축 이동 등으로 샘플링/분할이 바뀌면서 세그먼트가 합쳐질 수 있다.
  // 사용자가 지운 조각이 "부활"하지 않도록, 지운 세그먼트의 끝점(분할 포인트)을 저장해두고
  // convertFunctionsToSegments에서 추가 split points로 넣어 다시 같은 곳에서 분할되게 한다.
  suppressedSplitPoints?: Array<{ x: number; y: number }>;
  functionRegistry?: Record<string, { arity: number; fn: (...args: number[]) => number; expr: string }>; // for function calls like f(x)+4
  isPreview?: boolean; // preview mode
};

export type SegmentNode = {
  id: StableId;
  kind: 'segment';
  functionId: StableId; // parent function
  startAnchorId: StableId;
  endAnchorId: StableId;
  samples: Array<Vec2>; // polyline points
  style?: StrokeFill;
  hidden?: boolean;
  stableSegmentId?: string; // persists across intersection recalc
  extendStart?: boolean; // if true, extend start point to clip bounds
  extendEnd?: boolean; // if true, extend end point to clip bounds
  // Center mark decoration drawn at visual midpoint, perpendicular to segment
  // 'single' draws one 0.35pt tick; 'double' draws two ticks with a gap between
  centerMark?: 'single' | 'double';
};

export type MathTextNode = {
  id: StableId;
  kind: 'math-text';
  latex: string; // LaTeX expression to render
  position: Vec2; // world coordinates
  fontSize?: number; // in points
  color?: string;
  axisId?: StableId; // if set, this label follows the axis endpoint
  offsetPx?: Vec2; // pixel offset from axis endpoint (only used when axisId is set)
  displayAboveCurves?: boolean; // if true, display with white background above all curves with perpendicular cut effect
  bezierParentId?: StableId; // if set, this label is constrained to move along the bezier curve
  bezierT?: number; // parametric position (0-1) along the bezier curve
};

export type PointNode = {
  id: StableId;
  kind: 'point';
  position: Vec2; // world coordinates
  diameterMm?: number; // default 2.3
  color?: string; // default black
  strokeColor?: string; // border color (optional)
  strokeWidth?: number; // border width in pt (optional)
};

export type FilledRegionNode = {
  id: StableId;
  kind: 'filled-region';
  centerPoint: Vec2; // Representative point inside the region
  fillColor: string; // RGB color string like "rgb(230,230,230)"
};

export type AngleNode = {
  id: StableId;
  kind: 'angle';
  segment1Id: StableId; // First segment/axis ID
  segment2Id: StableId; // Second segment/axis ID
  segment1ClickPos?: Vec2; // Where segment1 was clicked (to determine direction)
  segment2ClickPos?: Vec2; // Where segment2 was clicked (to determine direction)
  isLargeAngle?: boolean; // true for large angle, false for small angle (default: false)
  isRightAngle?: boolean; // true for right angle (90°), displays as square (default: false)
  arcRadiusPt?: number; // Arc radius in pt (default: 20pt, zoom-independent)
  style?: StrokeStyle;
};

export type SceneNode = AnchorNode | LineSegmentNode | BezierSegmentNode | ArrowNode | AxisNode | ExplicitFunctionNode | ImplicitFunctionNode | SegmentNode | MathTextNode | PointNode | FilledRegionNode | AngleNode;

export type Scene = {
  id: StableId;
  nodes: Record<StableId, SceneNode>;
  zIndex: Record<StableId, number>;
  view: { scale: number; rotation: number; translate: Vec2; yScale?: number; magnification?: number };
  clipBounds?: { xMin: number; xMax: number; yMin: number; yMax: number }; // global clip bounds from axes
};

export type WsRequest =
  | {
      type: 'Compute/Intersections.Request';
      requestId: string;
      payload: {
        segments: StableId[]; // two ids
        tolerance?: number;
        polySample?: number;
      };
    };

export type WsResponse =
  | {
      type: 'Compute/Intersections.Result';
      requestId: string;
      payload: { points: Vec2[]; diagnostics?: Record<string, unknown> };
    }
  | { type: 'Error'; requestId?: string; message: string };

export function generateStableId(prefix: string = 'id'): StableId {
  const random = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${prefix}_${time}_${random}`;
}
