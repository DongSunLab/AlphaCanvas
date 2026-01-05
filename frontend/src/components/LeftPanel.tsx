import { useRef, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import 'mathlive';
import type { MathfieldElement } from 'mathlive';
import { useSceneStore } from '../state/store';
import { generateStableId } from '../shared/types';
import { formatFunctionLabel } from '../shared/labels';
import katex from 'katex';
import { parseFunctionInput, parsePointInputAdvanced, findUnknownIdentifiers, parseFunctionPointTranslation } from '../shared/parse';
import { evaluateWithRegistry, sampleExplicitWithRegistry } from '../geometry/mathEval';
import { isExpressionComplete } from '../shared/expressionValidator';
import { buildSafeFunctionRegistry } from '../shared/registryBuilder';
import { getWorkerManager } from '../workers/workerManager';
import { latexToJS } from '../shared/latexToJS';

import { DonationModal } from './DonationModal';
import { HelpModal } from './HelpModal';

const PREVIEW_FUNCTION_ID = '__preview_function__';
const PREVIEW_POINT_ID = '__preview_point__';

// Apply translation to explicit y=f(x): (+dx,+dy) => y = f(x-dx) + dy
function applyExplicitTranslationExpr(baseExpr: string, dx: number, dy: number): string {
  let replaced = baseExpr.replace(/\bx\b/g, `(x-(${dx}))`);
  if (dy !== 0) {
    replaced = `(${replaced})+(${dy})`;
  }
  return replaced;
}

// Apply translation to implicit g(x,y)=0: (+dx,+dy) => g(x-dx, y-dy) = 0
function applyImplicitTranslationExpr(baseExpr: string, dx: number, dy: number): string {
  let replaced = baseExpr.replace(/\bx\b/g, `(x-(${dx}))`).replace(/\by\b/g, `(y-(${dy}))`);
  return replaced;
}

// Try to inline implicit symbol call g(x,y) into its underlying zero-level expr if available
function inlineImplicitSymbolCall(expr: string, functions: any[]): string | null {
  const m = expr.match(/^\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\(\s*x\s*,\s*y\s*\)\s*$/);
  if (!m) return null;
  const sym = m[1];
  const node = functions.find((fn: any) => fn && fn.kind === 'function-implicit' && fn.symbol === sym);
  if (!node || typeof node.expr !== 'string') return null;
  return `(${node.expr})`;
}

export function LeftPanel() {
  // Note: mathTextFieldRef is reserved for future use in label input overlay; not used here
  // const mathTextFieldRef = useRef<MathfieldElement | null>(null);
  const functionFieldRef = useRef<MathfieldElement | null>(null);
  const previewTimerRef = useRef<number | null>(null);
  const currentTool = useSceneStore(s => s.currentTool);
  const setTool = useSceneStore(s => s.setTool);
  const [showDonation, setShowDonation] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const scene = useSceneStore(s => s.scene);
  const upsertNode = useSceneStore(s => s.upsertNode);
  const addPoint = useSceneStore(s => s.addPoint);
  const allocateFunctionSymbol = useSceneStore(s => s.allocateFunctionSymbol);
  const removeNode = useSceneStore(s => s.removeNode);

  // Tooltip (portal) - prevents clipping by scroll/overflow containers
  const leftPanelRootRef = useRef<HTMLDivElement | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const tooltipAnchorElRef = useRef<HTMLElement | null>(null);
  const [tooltip, setTooltip] = useState<null | { text: string; left: number; top: number }>(null);

  const updateTooltipFromEl = (el: HTMLElement | null) => {
    if (!el) return;
    const text = el.getAttribute('data-tooltip') || '';
    if (!text) return;
    const r = el.getBoundingClientRect();
    setTooltip({ text, left: r.left + r.width / 2, top: r.bottom + 10 });
  };

  useEffect(() => {
    const root = leftPanelRootRef.current;
    if (!root) return;

    const onMouseOver = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const btn = target?.closest?.('button[data-tooltip]') as HTMLElement | null;
      if (!btn) return;
      tooltipAnchorElRef.current = btn;
      updateTooltipFromEl(btn);
    };

    const onMouseOut = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const btn = target?.closest?.('button[data-tooltip]') as HTMLElement | null;
      if (!btn) return;
      const related = e.relatedTarget as HTMLElement | null;
      if (related && btn.contains(related)) return;
      if (tooltipAnchorElRef.current === btn) tooltipAnchorElRef.current = null;
      setTooltip(null);
    };

    root.addEventListener('mouseover', onMouseOver, { passive: true } as any);
    root.addEventListener('mouseout', onMouseOut, { passive: true } as any);
    return () => {
      root.removeEventListener('mouseover', onMouseOver as any);
      root.removeEventListener('mouseout', onMouseOut as any);
    };
  }, []);

  useEffect(() => {
    const el = scrollAreaRef.current;
    if (!el) return;
    const onScroll = () => {
      if (tooltipAnchorElRef.current) updateTooltipFromEl(tooltipAnchorElRef.current);
    };
    el.addEventListener('scroll', onScroll, { passive: true } as any);
    return () => el.removeEventListener('scroll', onScroll as any);
  }, []);

  const axes = Object.values(scene.nodes).filter((n: any) => n.kind === 'axis') as any[];
  const functions = Object.values(scene.nodes).filter((n: any) => (n.kind === 'function-explicit' || n.kind === 'function-implicit') && !n.isPreview) as any[];
  const points = Object.values(scene.nodes).filter((n: any) => n.kind === 'point' && !n.isPreview) as any[];

  // (이동) 라벨 입력은 우측 상단 오버레이로 이전됨

  // Update preview function on input change
  const handleFunctionInput = async (latex: string) => {
    // SINGLE COMPLETENESS GATE - replaces all scattered guards
    const validation = isExpressionComplete(latex);
    if (!validation.isComplete) {
      // Expression incomplete, remove preview and skip all processing
      removeNode(PREVIEW_FUNCTION_ID);
      removeNode(PREVIEW_POINT_ID);
      // Cancel any pending worker tasks
      getWorkerManager().cancelAll();
      return;
    }

    // Get current functions for worker
    const currentFunctions = Object.values(useSceneStore.getState().scene.nodes).filter(
      (n: any) => (n.kind === 'function-explicit' || n.kind === 'function-implicit') && !n.isPreview
    ) as any[];

    // Build registry synchronously for immediate checks, worker will rebuild
    const functionRegistry = buildSafeFunctionRegistry(currentFunctions);
    console.log('🔍 함수 레지스트리:', Object.keys(functionRegistry));

    // Try advanced point parsing first (with timeout protection)
    console.log('🔍 함수 레지스트리:', Object.keys(functionRegistry));

    const looksLikePoint = /^\s*\(.*,.*\)\s*$/.test(latex);
    if (looksLikePoint) {
      const parseStartTime = performance.now();
      const ptAdvanced = parsePointInputAdvanced(
        latex,
        latexToJS,
        (expr: string) => {
          // Timeout guard: if parsing takes > 50ms, abort
          if (performance.now() - parseStartTime > 50) {
            console.warn('Point parsing timeout, aborting');
            return NaN;
          }
          const result = evaluateWithRegistry(expr, {}, functionRegistry);
          return result;
        }
      );

      if (ptAdvanced) {
        removeNode(PREVIEW_FUNCTION_ID);
        const previewPoint = {
          id: PREVIEW_POINT_ID,
          kind: 'point' as const,
          position: { x: ptAdvanced.x, y: ptAdvanced.y },
          radius: 2.3,
          color: '#2196F3',
          isPreview: true
        };
        upsertNode(previewPoint);
        return;
      }
    }

    // 보안: 기존 simple point parser는 내부적으로 Function/eval류를 사용해
    // 악성 입력(XSS/코드실행) 위험이 있어 제거했습니다.
    // (advanced 파서가 숫자/함수 호출 모두 처리)
    removeNode(PREVIEW_POINT_ID);

    // Get current axis bounds for preview
    const axisBounds = getAxisBounds();

    // 조기 검증: LaTeX에서 불완전한 괄호 체크
    const leftParens = (latex.match(/\\left\(|\(/g) || []).length;
    const rightParens = (latex.match(/\\right\)|\)/g) || []).length;
    if (leftParens !== rightParens) {
      removeNode(PREVIEW_FUNCTION_ID);
      return;
    }

    // 조기 검증: 빈 괄호 체크 (f(), g() 등)
    if (/[a-zA-Z][a-zA-Z0-9_]*\s*\\left\(\\right\)|[a-zA-Z][a-zA-Z0-9_]*\s*\(\)/.test(latex)) {
      removeNode(PREVIEW_FUNCTION_ID);
      return;
    }

    // Wrap entire preview logic in timeout protection
    const previewStartTime = performance.now();
    const PREVIEW_TIMEOUT_MS = 100; // Max 100ms for any preview operation

    const checkTimeout = () => {
      if (performance.now() - previewStartTime > PREVIEW_TIMEOUT_MS) {
        console.warn('Preview timeout, aborting');
        removeNode(PREVIEW_FUNCTION_ID);
        removeNode(PREVIEW_POINT_ID);
        return true;
      }
      return false;
    };

    try {
      if (checkTimeout()) return;
      const expr = latexToJS(latex);

      // 단독 함수 심볼 체크 (f, g 등 - 함수 레지스트리에 있지만 호출이 없는 경우)
      const trimmedExpr = expr.trim();
      if (Object.keys(functionRegistry).includes(trimmedExpr) && !trimmedExpr.includes('(')) {
        removeNode(PREVIEW_FUNCTION_ID);
        return;
      }

      // 등호 뒤에 불완전한 함수 체크 (x=f 같은 경우)
      if (expr.includes('=')) {
        const parts = expr.split('=');
        if (parts.length === 2) {
          const rhs = parts[1].trim();
          if (Object.keys(functionRegistry).includes(rhs) && !rhs.includes('(')) {
            removeNode(PREVIEW_FUNCTION_ID);
            return;
          }
        }
      }

      const isImplicit = expr.includes('=');
      // Check if expression contains y (treat as implicit function without equals)
      const hasY = /\by\b/.test(expr);
      // If expression has Y (with or without X), treat as implicit unless it's explicit
      const isBivariateWithoutEquals = hasY && !isImplicit;

      // Skip if expression contains unknown symbols (cycle detection already handled by registry builder)
      const definedSymbols = new Set([
        ...functions.map((fn: any) => fn.symbol).filter((s: any) => typeof s === 'string'),
        ...Object.keys(functionRegistry)
      ]);
      const unknown = findUnknownIdentifiers(expr, definedSymbols);
      if (unknown.length > 0) {
        console.log('🔴 미리보기: 알 수 없는 식별자 발견:', unknown);
        removeNode(PREVIEW_FUNCTION_ID);
        return;
      }

      // Guard: if expression contains bare function symbols (e.g., "+ f" without call), skip preview
      for (const sym of definedSymbols) {
        if (typeof sym !== 'string') continue;
        const reBare = new RegExp(`\\b${String(sym).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b(?!\\()`, 'g');
        const matches = expr.match(reBare);
        if (matches) {
          const isTrulyStandalone = matches.some(m => {
            const idx = expr.indexOf(m);
            const after = expr[idx + m.length];
            return !after || /[\s+\-*/,)]/.test(after);
          });
          if (isTrulyStandalone) {
            removeNode(PREVIEW_FUNCTION_ID);
            return;
          }
        }
      }

      console.log('🔵 미리보기 함수 레지스트리:', Object.keys(functionRegistry));

      // Translation pattern: f(x)±(a,b) or (a,b)±f(x), also for implicit
      const looksLikeTranslation = /[+\-]\s*\(.*,.+\)\s*$/.test(latex) || /^\(.*,.+\)\s*[+\-]/.test(latex);
      let translation = null;
      if (looksLikeTranslation) {
        try {
          translation = parseFunctionPointTranslation(
            latex,
            latexToJS,
            (e: string) => evaluateWithRegistry(e, {}, functionRegistry)
          );
        } catch (err) {
          console.warn('번역 패턴 파싱 중 오류:', err);
          translation = null;
        }
      }
      if (translation) {
        const definedSymbols = new Set([
          ...functions.map((fn: any) => fn.symbol).filter((s: any) => typeof s === 'string'),
          ...Object.keys(functionRegistry)
        ]);
        let baseExpr = translation.expr;
        // Inline g(x,y) symbol to its expr for implicit when given as a bare call
        if (translation.kind === 'implicit-translate') {
          const inlined = inlineImplicitSymbolCall(baseExpr, functions);
          if (inlined) baseExpr = inlined;
        }
        const translatedExpr = translation.kind === 'explicit-translate'
          ? applyExplicitTranslationExpr(baseExpr, translation.dx, translation.dy)
          : applyImplicitTranslationExpr(baseExpr, translation.dx, translation.dy);
        const unknownInTranslated = findUnknownIdentifiers(translatedExpr, definedSymbols);
        if (unknownInTranslated.length > 0) {
          removeNode(PREVIEW_FUNCTION_ID);
          return;
        }
        if (translation.kind === 'explicit-translate') {
          const previewFn = {
            id: PREVIEW_FUNCTION_ID,
            kind: 'function-explicit' as const,
            expr: translatedExpr,
            variable: 'x',
            domain: [axisBounds.xMin, axisBounds.xMax] as [number, number],
            style: { stroke: { color: '#2196F3', width: 0.8 } },
            label: latex,
            symbol: 'preview',
            clipToAxes: true,
            isPreview: true,
            functionRegistry
          };
          upsertNode(previewFn);
          return;
        } else {
          const previewFn = {
            id: PREVIEW_FUNCTION_ID,
            kind: 'function-implicit' as const,
            expr: translatedExpr,
            variables: ['x', 'y'] as [string, string],
            bounds: axisBounds,
            style: { stroke: { color: '#2196F3', width: 0.8 } },
            label: latex,
            symbol: 'preview',
            clipToAxes: true,
            isPreview: true,
            functionRegistry
          };
          upsertNode(previewFn);
          return;
        }
      }

      const named = parseFunctionInput(expr);
      if (named) {
        if (named.kind === 'explicit') {
          const previewFn = {
            id: PREVIEW_FUNCTION_ID,
            kind: 'function-explicit' as const,
            expr: named.expr,
            variable: 'x',
            domain: [axisBounds.xMin, axisBounds.xMax] as [number, number],
            style: { stroke: { color: '#2196F3', width: 0.8 } },
            label: latex,
            symbol: 'preview',
            clipToAxes: true,
            isPreview: true,
            functionRegistry // 함수 레지스트리 전달
          };
          console.log('🔵 미리보기 양함수 노드 생성:', previewFn);
          upsertNode(previewFn);
        } else {
          const previewFn = {
            id: PREVIEW_FUNCTION_ID,
            kind: 'function-implicit' as const,
            expr: named.expr,
            variables: ['x', 'y'] as [string, string],
            bounds: axisBounds,
            style: { stroke: { color: '#2196F3', width: 0.8 } },
            label: latex,
            symbol: 'preview',
            clipToAxes: true,
            isPreview: true,
            functionRegistry // 함수 레지스트리 전달
          };
          console.log('🔵 미리보기 음함수 노드 생성:', previewFn);
          upsertNode(previewFn);
        }
      } else if (isImplicit) {
        // Split by '=' and check both sides are non-empty
        const parts = expr.split('=');
        if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
          const normalizedExpr = `(${parts[0]}) - (${parts[1]})`;
          const previewFn = {
            id: PREVIEW_FUNCTION_ID,
            kind: 'function-implicit' as const,
            expr: normalizedExpr,
            variables: ['x', 'y'] as [string, string],
            bounds: axisBounds,
            style: { stroke: { color: '#2196F3', width: 0.8 } },
            label: latex,
            symbol: 'preview',
            clipToAxes: true,
            isPreview: true,
            functionRegistry // 함수 레지스트리 전달
          };
          upsertNode(previewFn);
        } else {
          // Incomplete equation, remove preview
          removeNode(PREVIEW_FUNCTION_ID);
        }
      } else if (isBivariateWithoutEquals) {
        // x와 y가 모두 포함된 식은 암묵적으로 = 0 으로 처리 (음함수)
        const previewFn = {
          id: PREVIEW_FUNCTION_ID,
          kind: 'function-implicit' as const,
          expr: expr,
          variables: ['x', 'y'] as [string, string],
          bounds: axisBounds,
          style: { stroke: { color: '#2196F3', width: 0.8 } },
          label: latex,
          symbol: 'preview',
          clipToAxes: true,
          isPreview: true,
          functionRegistry // 함수 레지스트리 전달
        };
        upsertNode(previewFn);
      } else {
        const previewFn = {
          id: PREVIEW_FUNCTION_ID,
          kind: 'function-explicit' as const,
          expr: expr,
          variable: 'x',
          domain: [axisBounds.xMin, axisBounds.xMax] as [number, number],
          style: { stroke: { color: '#2196F3', width: 0.8 } },
          label: latex,
          symbol: 'preview',
          clipToAxes: true,
          isPreview: true,
          functionRegistry // 함수 레지스트리 전달
        };
        upsertNode(previewFn);
      }
    } catch (e) {
      // Invalid expression, remove preview
      removeNode(PREVIEW_FUNCTION_ID);
    }
  };

  // Setup input listener for function field
  useEffect(() => {
    const mf = functionFieldRef.current as any;
    if (!mf) return;

    // Configure inline shortcuts and remove focus background
    mf.setOptions({
      inlineShortcuts: {
        ...mf.getOptions('inlineShortcuts'),
        abs: '\\left|#@\\right|',
      },
      // Remove default focus styles
      defaultMode: 'math',
    });

    // Remove focus background by setting styles directly in shadow DOM
    const style = document.createElement('style');
    style.textContent = `
      :host,
      :host(:focus),
      :host(:focus-within),
      .ML__fieldcontainer,
      .ML__fieldcontainer:focus-within,
      .ML__fieldcontainer--focused,
      .ML__focused,
      .ML__base,
      .ML__strut,
      .ML__mathlive {
        background-color: transparent !important;
        background: transparent !important;
        background-image: none !important;
      }
      .ML__selection,
      .ML__selected,
      .ML__placeholder-selected {
        background-color: rgba(255, 255, 255, 0.15) !important;
      }
      * {
        background-color: transparent !important;
      }
    `;
    mf.shadowRoot?.appendChild(style);

    const handleInput = () => {
      const latex = mf.value || '';
      if (previewTimerRef.current) {
        clearTimeout(previewTimerRef.current);
      }
      // Debounce preview updates: only trigger after stable pause + complete expression
      // 300ms delay ensures user has stopped typing
      previewTimerRef.current = window.setTimeout(() => {
        handleFunctionInput(latex);
      }, 100);
    };

    mf.addEventListener('input', handleInput);
    return () => mf.removeEventListener('input', handleInput);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Helper function to calculate current axis bounds
  const getAxisBounds = () => {
    let xMin = -Infinity, xMax = Infinity, yMin = -Infinity, yMax = Infinity;
    for (const axis of axes) {
      const origin = scene.nodes[axis.originId] as any;
      const endpoint = scene.nodes[axis.endpointId] as any;
      if (!origin || !endpoint) continue;
      const dx = endpoint.position.x - origin.position.x;
      const dy = endpoint.position.y - origin.position.y;
      if (Math.abs(dx) > Math.abs(dy)) {
        // X-axis
        xMin = Math.max(xMin, Math.min(origin.position.x, endpoint.position.x));
        xMax = Math.min(xMax, Math.max(origin.position.x, endpoint.position.x));
      } else {
        // Y-axis
        yMin = Math.max(yMin, Math.min(origin.position.y, endpoint.position.y));
        yMax = Math.min(yMax, Math.max(origin.position.y, endpoint.position.y));
      }
    }
    // Fallback to default if no valid axes
    if (!isFinite(xMin)) xMin = -10;
    if (!isFinite(xMax)) xMax = 10;
    if (!isFinite(yMin)) yMin = -10;
    if (!isFinite(yMax)) yMax = 10;
    return { xMin, xMax, yMin, yMax };
  };

  // Validate if an expression can be evaluated without errors
  const validateExpression = (
    expr: string,
    variables: string[],
    registry: Record<string, { arity: number; fn: (...args: number[]) => number; expr: string }>
  ): boolean => {
    // Test evaluation at multiple sample points with wider range
    const testPoints = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: -1, y: -1 },
      { x: 0.5, y: 0.5 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
      { x: 5, y: 5 },
      { x: 10, y: 10 },
      { x: -2, y: -2 },
      { x: -5, y: -5 },
    ];

    let hasValidResult = false;

    for (const point of testPoints) {
      const vars: Record<string, number> = {};
      for (const v of variables) {
        vars[v] = (point as any)[v] || 0;
      }

      try {
        const result = evaluateWithRegistry(expr, vars, registry);
        // If we get a finite number (not NaN, not Infinity), it's potentially valid
        if (isFinite(result)) {
          hasValidResult = true;
          break;
        }
      } catch {
        // Evaluation error, continue to next test point
        continue;
      }
    }

    // Fallback for explicit expressions: use the same compiled sampling path as rendering/segment conversion.
    // This prevents false negatives for composed function calls like f(2x-1) where direct evaluation may be overly strict.
    if (!hasValidResult && variables.length === 1 && variables[0] === 'x') {
      try {
        // Explicit functions should only depend on 1-arity functions
        const filtered: Record<string, { arity: number; fn: (...args: number[]) => number; expr: string }> = {};
        for (const [k, v] of Object.entries(registry)) {
          if (v && v.arity === 1) filtered[k] = v;
        }
        const pts = sampleExplicitWithRegistry(expr, 'x', [-2, 2], 24, filtered as any);
        if (pts.some(p => Number.isFinite(p.y))) {
          hasValidResult = true;
        }
      } catch {
        // ignore fallback errors
      }
    }

    return hasValidResult;
  };

  // Add function
  const handleAddFunction = () => {
    if (!functionFieldRef.current) return;
    const mf = functionFieldRef.current as any;
    const latex = mf.value.trim();

    // Remove preview
    removeNode(PREVIEW_FUNCTION_ID);
    removeNode(PREVIEW_POINT_ID);

    if (!latex) return;

    // Save snapshot before adding function (for undo)
    const stateBefore = useSceneStore.getState();
    const snapshot = {
      scene: JSON.parse(JSON.stringify(stateBefore.scene)),
      selectedIds: [...stateBefore.selectedIds],
      nextSymbolIndex: stateBefore.nextSymbolIndex
    };

    // Suppress history during function addition and segment conversion
    useSceneStore.setState({ suppressHistory: true });

    // Helper to commit history after function addition (delayed to allow segment conversion)
    const commitFunctionHistory = () => {
      // Wait for segment conversion to complete before committing history
      // Must wait longer than the convertFunctionsToSegments delay (50ms)
      setTimeout(() => {
        useSceneStore.setState((state) => ({
          suppressHistory: false,
          undoStack: [...state.undoStack, snapshot],
          redoStack: []
        }));
      }, 150);
    };

    // Helper to restore history flag without committing (for errors)
    const restoreHistoryFlag = () => {
      useSceneStore.setState({ suppressHistory: false });
    };

    // Build function registry with cycle detection and safety checks
    const currentFunctions = Object.values(useSceneStore.getState().scene.nodes).filter(
      (n: any) => (n.kind === 'function-explicit' || n.kind === 'function-implicit') && !n.isPreview
    ) as any[];

    const functionRegistry = buildSafeFunctionRegistry(currentFunctions);
    console.log('🔍 안전한 함수 레지스트리 구축:', Object.keys(functionRegistry));

    // 1) Check if input is a point like (1,2) or (1, f(3))
    // Try advanced point parsing first (handles function calls)
    console.log('🔍 함수 레지스트리:', Object.keys(functionRegistry));
    const ptAdvanced = parsePointInputAdvanced(
      latex,
      latexToJS,
      (expr: string) => {
        console.log('🔍 평가할 표현식:', expr);
        const result = evaluateWithRegistry(expr, {}, functionRegistry);
        console.log('🔍 평가 결과:', result);
        return result;
      }
    );
    console.log('🔍 고급 점 파싱 결과:', ptAdvanced);
    if (ptAdvanced) {
      // Point addition - restore history flag and let addPoint manage its own history
      restoreHistoryFlag();
      addPoint({ x: ptAdvanced.x, y: ptAdvanced.y }, 2.3, '#000000');
      mf.value = '';
      return;
    }

    // 보안: simple point parser 제거 (Function/eval류 사용 위험)

    console.log('입력 LaTeX:', latex);
    const expr = latexToJS(latex);
    console.log('변환된 JS:', expr);

    // Cycle detection is now handled by buildSafeFunctionRegistry during preview/rendering

    // 기본 함수 색은 위젯 아이콘 색과 동일하게 "검정"으로 고정
    // (랜덤 색을 기본으로 쓰면 사용자 의도와 다르게 함수/위젯 색이 바뀜)
    const defaultFunctionColor = '#000000';

    // Get current axis bounds for dynamic domain/bounds
    const axisBounds = getAxisBounds();

    // Check if it's an implicit function (contains '=')
    const isImplicit = expr.includes('=');

    // Check if expression contains both x and y (implicit function without equals)
    const hasX = /\bx\b/.test(expr);
    const hasY = /\by\b/.test(expr);
    const isBivariateWithoutEquals = hasX && hasY && !isImplicit;

    // Translation pattern: f(x)±(a,b), (a,b)±f(x) and implicit
    const translation = parseFunctionPointTranslation(
      latex,
      latexToJS,
      (e: string) => evaluateWithRegistry(e, {}, functionRegistry)
    );
    if (translation) {
      const axisBounds = getAxisBounds();
      // Unknown identifier guard: prevent creating broken nodes
      const definedSymbols = new Set([
        ...functions.map((fn: any) => fn.symbol).filter((s: any) => typeof s === 'string'),
        ...Object.keys(functionRegistry)
      ]);
      if (translation.kind === 'explicit-translate') {
        const translatedExpr = applyExplicitTranslationExpr(translation.expr, translation.dx, translation.dy);
        const unknown = findUnknownIdentifiers(translatedExpr, definedSymbols);
        if (unknown.length > 0) {
          console.warn('정의되지 않은 식별자:', unknown);
          restoreHistoryFlag();
          mf.value = '';
          return;
        }

        // Validate before adding to scene
        if (!validateExpression(translatedExpr, ['x'], functionRegistry)) {
          console.warn('Invalid translated explicit expression, cannot evaluate:', latex);
          restoreHistoryFlag();
          mf.value = '';
          return;
        }

        const fn = {
          id: generateStableId('fn'),
          kind: 'function-explicit' as const,
          expr: translatedExpr,
          variable: 'x',
          domain: [axisBounds.xMin, axisBounds.xMax] as [number, number],
          style: { stroke: { color: defaultFunctionColor, width: 0.8 } },
          label: latex,
          symbol: allocateFunctionSymbol(),
          clipToAxes: true
        };
        upsertNode(fn);
        commitFunctionHistory();
        mf.value = '';
        return;
      } else {
        let baseExpr = translation.expr;
        const inlined = inlineImplicitSymbolCall(baseExpr, functions);
        if (inlined) baseExpr = inlined;
        const translatedExpr = applyImplicitTranslationExpr(baseExpr, translation.dx, translation.dy);
        const unknown = findUnknownIdentifiers(translatedExpr, definedSymbols);
        if (unknown.length > 0) {
          console.warn('정의되지 않은 식별자:', unknown);
          restoreHistoryFlag();
          mf.value = '';
          return;
        }

        // Validate before adding to scene
        if (!validateExpression(translatedExpr, ['x', 'y'], functionRegistry)) {
          console.warn('Invalid translated implicit expression, cannot evaluate:', latex);
          restoreHistoryFlag();
          mf.value = '';
          return;
        }

        const fn = {
          id: generateStableId('fn-implicit'),
          kind: 'function-implicit' as const,
          expr: translatedExpr,
          variables: ['x', 'y'] as [string, string],
          bounds: axisBounds,
          style: { stroke: { color: defaultFunctionColor, width: 0.8 } },
          label: latex,
          symbol: allocateFunctionSymbol(),
          clipToAxes: true
        };
        upsertNode(fn);
        commitFunctionHistory();
        mf.value = '';
        return;
      }
    }

    // Named input handling: f(x)=..., f(x,y): ...
    const named = parseFunctionInput(expr);
    if (named) {
      if (named.kind === 'explicit') {
        // Validate before adding to scene
        if (!validateExpression(named.expr, ['x'], functionRegistry)) {
          console.warn('Invalid explicit (named) expression, cannot evaluate:', latex);
          restoreHistoryFlag();
          mf.value = '';
          return;
        }

        const fn = {
          id: generateStableId('fn'),
          kind: 'function-explicit' as const,
          expr: named.expr,
          variable: 'x',
          domain: [axisBounds.xMin, axisBounds.xMax] as [number, number],
          style: { stroke: { color: defaultFunctionColor, width: 0.8 } },
          label: latex,
          symbol: named.symbol || allocateFunctionSymbol(),
          clipToAxes: true
        };
        upsertNode(fn);
        commitFunctionHistory();
        console.log('Added explicit (named) function:', latex);
      } else {
        // Validate before adding to scene
        if (!validateExpression(named.expr, ['x', 'y'], functionRegistry)) {
          console.warn('Invalid implicit (named) expression, cannot evaluate:', latex);
          restoreHistoryFlag();
          mf.value = '';
          return;
        }

        const fn = {
          id: generateStableId('fn-implicit'),
          kind: 'function-implicit' as const,
          expr: named.expr,
          variables: ['x', 'y'] as [string, string],
          bounds: axisBounds,
          style: { stroke: { color: defaultFunctionColor, width: 0.8 } },
          label: latex,
          symbol: named.symbol || allocateFunctionSymbol(),
          clipToAxes: true
        };
        upsertNode(fn);
        commitFunctionHistory();
        console.log('Added implicit (named) function:', latex);
      }
    }
    else if (isImplicit) {
      // Split by '=' and convert to implicit form (LHS - RHS = 0)
      const parts = expr.split('=');
      if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
        const implicitExpr = `(${parts[0]}) - (${parts[1]})`;

        // Validate before adding to scene
        if (!validateExpression(implicitExpr, ['x', 'y'], functionRegistry)) {
          console.warn('Invalid implicit expression, cannot evaluate:', latex);
          restoreHistoryFlag();
          mf.value = '';
          return;
        }

        const fn = {
          id: generateStableId('fn-implicit'),
          kind: 'function-implicit' as const,
          expr: implicitExpr,
          variables: ['x', 'y'] as [string, string],
          bounds: axisBounds,
          style: { stroke: { color: defaultFunctionColor, width: 0.8 } },
          label: latex,
          symbol: allocateFunctionSymbol(),
          clipToAxes: true
        };
        upsertNode(fn);
        commitFunctionHistory();
        console.log('Added implicit function:', latex);
      } else {
        console.warn('Incomplete equation, ignoring:', latex);
        restoreHistoryFlag();
      }
    } else if (isBivariateWithoutEquals) {
      // x와 y가 모두 포함된 식은 암묵적으로 = 0 으로 처리 (음함수)

      // Validate before adding to scene
      if (!validateExpression(expr, ['x', 'y'], functionRegistry)) {
        console.warn('Invalid bivariate expression, cannot evaluate:', latex);
        restoreHistoryFlag();
        mf.value = '';
        return;
      }

      const fn = {
        id: generateStableId('fn-implicit'),
        kind: 'function-implicit' as const,
        expr: expr,
        variables: ['x', 'y'] as [string, string],
        bounds: axisBounds,
        style: { stroke: { color: defaultFunctionColor, width: 0.8 } },
        label: latex,
        symbol: allocateFunctionSymbol(),
        clipToAxes: true
      };
      upsertNode(fn);
      commitFunctionHistory();
      console.log('Added implicit function (bivariate):', latex);
    } else {
      // 2-arg function call like f(y-1,2*x-3) => interpret as implicit zero-level set: f(y-1,2*x-3) = 0
      const twoArgCall = /^[a-zA-Z][a-zA-Z0-9_]*\s*\([^,]+,\s*[^)]+\)$/;
      if (twoArgCall.test(expr)) {
        // Validate before adding to scene
        if (!validateExpression(expr, ['x', 'y'], functionRegistry)) {
          console.warn('Invalid function call expression, cannot evaluate:', latex);
          restoreHistoryFlag();
          mf.value = '';
          return;
        }

        const fn = {
          id: generateStableId('fn-implicit'),
          kind: 'function-implicit' as const,
          expr: expr, // zero-level set implicitly
          variables: ['x', 'y'] as [string, string],
          bounds: axisBounds,
          style: { stroke: { color: defaultFunctionColor, width: 0.8 } },
          label: latex,
          symbol: allocateFunctionSymbol(),
          clipToAxes: true
        };
        upsertNode(fn);
        commitFunctionHistory();
        console.log('Added implicit function (call form):', latex);
      } else {
        // Explicit function
        // Validate before adding to scene
        if (!validateExpression(expr, ['x'], functionRegistry)) {
          console.warn('Invalid explicit expression, cannot evaluate:', latex);
          restoreHistoryFlag();
          mf.value = '';
          return;
        }

        const fn = {
          id: generateStableId('fn'),
          kind: 'function-explicit' as const,
          expr,
          variable: 'x',
          domain: [axisBounds.xMin, axisBounds.xMax] as [number, number],
          style: { stroke: { color: defaultFunctionColor, width: 0.8 } },
          label: latex,
          symbol: allocateFunctionSymbol(),
          clipToAxes: true
        };
        upsertNode(fn);
        commitFunctionHistory();
        console.log('Added explicit function:', latex);
      }
    }

    mf.value = '';
  };

  useEffect(() => {
    const functionMf = functionFieldRef.current;

    const handleFunctionKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleAddFunction();
      }
    };

    if (functionMf) {
      functionMf.addEventListener('keydown', handleFunctionKeyDown as any);
    }

    return () => {
      if (functionMf) {
        functionMf.removeEventListener('keydown', handleFunctionKeyDown as any);
      }
    };
  }, []);

  return (
    <div ref={leftPanelRootRef} style={{
      width: 340,
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      padding: '16px',
      overflow: 'visible'
    }}>
      {/* 스크롤 가능한 영역 */}
      <div ref={scrollAreaRef} style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        overflowY: 'auto',
        overflowX: 'visible',
        marginBottom: '12px',
        position: 'relative',
        paddingBottom: '40px'
      }}>
        {/* 도형 도구 패널 - 통합 UI */}
        <div style={{
          background: 'rgba(0, 0, 0, 0.3)',
          backdropFilter: 'blur(20px)',
          borderRadius: 12,
          boxShadow: '0 2px 12px rgba(0,0,0,0.1)',
          padding: '12px',
          position: 'relative',
          overflow: 'visible'
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
            {/* 1. 두 점 직선 */}
            <button
              onClick={() => setTool('two-point-line')}
              data-tooltip="두 점 직선"
              style={{
                padding: 8,
                background: currentTool === 'two-point-line' ? '#2196F3' : 'rgba(255, 255, 255, 0.1)',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                outline: 'none'
              }}
              onMouseEnter={(e) => {
                if (currentTool !== 'two-point-line') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)';
                }
              }}
              onMouseLeave={(e) => {
                if (currentTool !== 'two-point-line') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                }
              }}
            >
              <img src="/line.svg" alt="직선" style={{ width: 24, height: 24 }} />
            </button>

            {/* 2. 두 점 반직선 */}
            <button
              onClick={() => setTool('two-point-ray')}
              data-tooltip="두 점 반직선"
              style={{
                padding: 8,
                background: currentTool === 'two-point-ray' ? '#2196F3' : 'rgba(255, 255, 255, 0.1)',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                outline: 'none'
              }}
              onMouseEnter={(e) => {
                if (currentTool !== 'two-point-ray') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)';
                }
              }}
              onMouseLeave={(e) => {
                if (currentTool !== 'two-point-ray') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                }
              }}
            >
              <img src="/halfline.svg" alt="반직선" style={{ width: 24, height: 24 }} />
            </button>

            {/* 3. 두 점 선분 */}
            <button
              onClick={() => setTool('two-point-segment')}
              data-tooltip="두 점 선분"
              style={{
                padding: 8,
                background: currentTool === 'two-point-segment' ? '#2196F3' : 'rgba(255, 255, 255, 0.1)',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                outline: 'none'
              }}
              onMouseEnter={(e) => {
                if (currentTool !== 'two-point-segment') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)';
                }
              }}
              onMouseLeave={(e) => {
                if (currentTool !== 'two-point-segment') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                }
              }}
            >
              <img src="/segment.svg" alt="선분" style={{ width: 24, height: 24 }} />
            </button>

            {/* 4. 두 점 점선 */}
            <button
              onClick={() => setTool('two-point-dashed')}
              data-tooltip="두 점 점선"
              style={{
                padding: 8,
                background: currentTool === 'two-point-dashed' ? '#2196F3' : 'rgba(255, 255, 255, 0.1)',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                outline: 'none'
              }}
              onMouseEnter={(e) => {
                if (currentTool !== 'two-point-dashed') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)';
                }
              }}
              onMouseLeave={(e) => {
                if (currentTool !== 'two-point-dashed') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                }
              }}
            >
              <img src="/dashed_segment.svg" alt="점선" style={{ width: 24, height: 24 }} />
            </button>

            {/* 5. 점 */}
            <button
              onClick={() => setTool('curve-point')}
              data-tooltip="점"
              style={{
                padding: 8,
                background: currentTool === 'curve-point' ? '#2196F3' : 'rgba(255, 255, 255, 0.1)',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                outline: 'none'
              }}
              onMouseEnter={(e) => {
                if (currentTool !== 'curve-point') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)';
                }
              }}
              onMouseLeave={(e) => {
                if (currentTool !== 'curve-point') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                }
              }}
            >
              <img src="/curve.svg" alt="점" style={{ width: 24, height: 24 }} />
            </button>

            {/* 6. 곡선 위의 접선 */}
            <button
              onClick={() => setTool('curve-tangent')}
              data-tooltip="곡선 위의 접선"
              style={{
                padding: 8,
                background: currentTool === 'curve-tangent' ? '#2196F3' : 'rgba(255, 255, 255, 0.1)',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                outline: 'none'
              }}
              onMouseEnter={(e) => {
                if (currentTool !== 'curve-tangent') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)';
                }
              }}
              onMouseLeave={(e) => {
                if (currentTool !== 'curve-tangent') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                }
              }}
            >
              <img src="/tangent.svg" alt="접선" style={{ width: 24, height: 24 }} />
            </button>

            {/* 7. 세 점 원 */}
            <button
              onClick={() => setTool('circle-3pt')}
              data-tooltip="세 점 원"
              style={{
                padding: 8,
                background: currentTool === 'circle-3pt' ? '#2196F3' : 'rgba(255, 255, 255, 0.1)',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                outline: 'none'
              }}
              onMouseEnter={(e) => {
                if (currentTool !== 'circle-3pt') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)';
                }
              }}
              onMouseLeave={(e) => {
                if (currentTool !== 'circle-3pt') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                }
              }}
            >
              <img src="/circle_three.svg" alt="세 점 원" style={{ width: 24, height: 24 }} />
            </button>

            {/* 8. 중심 한점 원 */}
            <button
              onClick={() => setTool('circle-center')}
              data-tooltip="중심 한 점 원"
              style={{
                padding: 8,
                background: currentTool === 'circle-center' ? '#2196F3' : 'rgba(255, 255, 255, 0.1)',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                outline: 'none'
              }}
              onMouseEnter={(e) => {
                if (currentTool !== 'circle-center') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)';
                }
              }}
              onMouseLeave={(e) => {
                if (currentTool !== 'circle-center') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                }
              }}
            >
              <img src="/circle_center.svg" alt="중심-한점 원" style={{ width: 24, height: 24 }} />
            </button>

            {/* 8-1. 중심 반지름 원 */}
            <button
              onClick={() => setTool('circle-radius')}
              data-tooltip="중심 반지름 원"
              style={{
                padding: 8,
                background: currentTool === 'circle-radius' ? '#2196F3' : 'rgba(255, 255, 255, 0.1)',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                outline: 'none'
              }}
              onMouseEnter={(e) => {
                if (currentTool !== 'circle-radius') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)';
                }
              }}
              onMouseLeave={(e) => {
                if (currentTool !== 'circle-radius') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                }
              }}
            >
              <img src="/circle_radius.svg" alt="중심-반지름 원" style={{ width: 24, height: 24 }} />
            </button>

            {/* 9. 베지에 곡선 */}
            <button
              onClick={() => setTool('bezier')}
              data-tooltip="베지에 곡선"
              style={{
                padding: 8,
                background: currentTool === 'bezier' ? '#2196F3' : 'rgba(255, 255, 255, 0.1)',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                outline: 'none'
              }}
              onMouseEnter={(e) => {
                if (currentTool !== 'bezier') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)';
                }
              }}
              onMouseLeave={(e) => {
                if (currentTool !== 'bezier') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                }
              }}
            >
              <img src="/bezier.svg" alt="베지에" style={{ width: 24, height: 24 }} />
            </button>

            {/* 9-1. 화살표 */}
            <button
              onClick={() => setTool('arrow')}
              data-tooltip="화살표"
              style={{
                padding: 8,
                background: currentTool === 'arrow' ? '#2196F3' : 'rgba(255, 255, 255, 0.1)',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                outline: 'none'
              }}
              onMouseEnter={(e) => {
                if (currentTool !== 'arrow') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)';
                }
              }}
              onMouseLeave={(e) => {
                if (currentTool !== 'arrow') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                }
              }}
            >
              <img src="/arrow.svg" alt="화살표" style={{ width: 24, height: 24 }} />
            </button>

            {/* 10. 길이 점선 */}
            <button
              onClick={() => setTool('length-dashed')}
              data-tooltip="길이 점선"
              style={{
                padding: 8,
                background: currentTool === 'length-dashed' ? '#2196F3' : 'rgba(255, 255, 255, 0.1)',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                outline: 'none'
              }}
              onMouseEnter={(e) => {
                if (currentTool !== 'length-dashed') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)';
                }
              }}
              onMouseLeave={(e) => {
                if (currentTool !== 'length-dashed') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                }
              }}
            >
              <img src="/dashed_bezier.svg" alt="길이 점선" style={{ width: 24, height: 24 }} />
            </button>

            {/* 11. 각도 */}
            <button
              onClick={() => setTool('two-point-angle')}
              data-tooltip="각도"
              style={{
                padding: 8,
                background: currentTool === 'two-point-angle' ? '#2196F3' : 'rgba(255, 255, 255, 0.1)',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                outline: 'none'
              }}
              onMouseEnter={(e) => {
                if (currentTool !== 'two-point-angle') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)';
                }
              }}
              onMouseLeave={(e) => {
                if (currentTool !== 'two-point-angle') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                }
              }}
            >
              <span style={{ fontSize: 18, color: '#fff' }}>∠</span>
            </button>

            {/* 12. 영역 페인트 */}
            <button
              onClick={() => setTool('paint')}
              data-tooltip="영역 페인트"
              style={{
                padding: 8,
                background: currentTool === 'paint' ? '#2196F3' : 'rgba(255, 255, 255, 0.1)',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                outline: 'none'
              }}
              onMouseEnter={(e) => {
                if (currentTool !== 'paint') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)';
                }
              }}
              onMouseLeave={(e) => {
                if (currentTool !== 'paint') {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                }
              }}
            >
              <img src="/fill.svg" alt="영역 페인트" style={{ width: 24, height: 24 }} />
            </button>
          </div>
        </div>

        {/* 수식 입력창: 우측 상단 오버레이로 이동됨 */}

        {/* 함수 입력창 */}
        <div style={{
          background: 'rgba(0, 0, 0, 0.3)',
          backdropFilter: 'blur(20px)',
          borderRadius: 12,
          boxShadow: '0 2px 12px rgba(0,0,0,0.1)',
          padding: '12px'
        }}>
          {/* @ts-expect-error - math-field is a custom element from mathlive */}
          <math-field
            ref={functionFieldRef}
            virtual-keyboard-mode="off"
            use-shared-virtual-keyboard={false}
            virtual-keyboard-container="none"
            onKeyDown={(e: any) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddFunction();
              }
            }}
            style={{
              width: '100%',
              fontSize: '16px',
              border: 'none',
              background: 'transparent',
              color: '#fff',
              fontWeight: 400
            }}
          />
        </div>

        {/* 함수 목록 - 동적 크기 */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          maxHeight: '50vh',
          overflowY: 'auto'
        }}>
          {functions.map((fn: any) => {
            let html = '';
            try {
              html = katex.renderToString(formatFunctionLabel(fn), {
                throwOnError: false,
                displayMode: false
              });
            } catch (e) {
              html = formatFunctionLabel(fn);
            }

            const isExplicit = fn.kind === 'function-explicit';

            return (
              <div
                key={fn.id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  padding: '12px',
                  gap: 8,
                  background: 'rgba(0, 0, 0, 0.3)',
                  backdropFilter: 'blur(20px)',
                  borderRadius: 12,
                  boxShadow: '0 2px 12px rgba(0,0,0,0.1)',
                  transition: 'background 0.2s'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(0, 0, 0, 0.4)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(0, 0, 0, 0.3)'}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: '50%',
                      background: fn.style?.stroke?.color || '#000000',
                      flexShrink: 0
                    }}
                  />

                  <div
                    style={{
                      flex: 1,
                      fontSize: 14,
                      fontFamily: 'KaTeX_Main, serif',
                      color: 'rgba(255, 255, 255, 0.95)'
                    }}
                    dangerouslySetInnerHTML={{ __html: html }}
                  />

                  <button
                    onClick={() => removeNode(fn.id)}
                    style={{
                      width: 24,
                      height: 24,
                      border: 'none',
                      background: 'transparent',
                      color: 'rgba(255, 255, 255, 0.6)',
                      cursor: 'pointer',
                      fontSize: 16,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 4,
                      flexShrink: 0
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(244, 67, 54, 0.2)';
                      e.currentTarget.style.color = '#f44336';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent';
                      e.currentTarget.style.color = 'rgba(255, 255, 255, 0.6)';
                    }}
                  >
                    ×
                  </button>
                </div>

                {/* 정의역 입력창 (양함수만) */}
                {isExplicit && (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginLeft: 20
                  }}>
                    <span style={{ fontSize: 11, color: 'rgba(255, 255, 255, 0.5)', whiteSpace: 'nowrap', fontWeight: 500 }}>정의역</span>
                    <input
                      key={`domain-min-${fn.id}-${fn.domain[0]}`}
                      type="text"
                      defaultValue={fn.domain[0]}
                      onBlur={(e) => {
                        const value = parseFloat(e.target.value);
                        if (!isNaN(value) && value !== fn.domain[0]) {
                          // 기존 segment와 앵커 정리 후 정의역 변경
                          const nodes = scene.nodes;
                          // 이 함수의 모든 segment 찾아서 삭제
                          Object.values(nodes).forEach((node: any) => {
                            if (node && node.kind === 'segment' && node.functionId === fn.id) {
                              removeNode(node.id);
                            }
                          });
                          // 정의역 변경 및 segment 재생성
                          upsertNode({ ...fn, domain: [value, fn.domain[1]], clipToAxes: false, segmentsOnly: false, suppressedSegmentIds: [] });
                        } else if (e.target.value.trim() === '' || isNaN(value)) {
                          // Blur 시 빈 값이거나 유효하지 않으면 원래 값으로 복원
                          e.target.value = String(fn.domain[0]);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.currentTarget.blur();
                        }
                      }}
                      style={{
                        width: 25,
                        padding: '4px 4px',
                        background: 'rgba(255, 255, 255, 0.08)',
                        border: 'none',
                        borderRadius: 4,
                        color: 'rgba(255, 255, 255, 0.95)',
                        fontSize: 11,
                        fontWeight: 500,
                        textAlign: 'center',
                        outline: 'none',
                        transition: 'all 0.15s'
                      }}
                      onFocus={(e) => {
                        e.currentTarget.style.background = 'rgba(33, 150, 243, 0.15)';
                      }}
                      onBlurCapture={(e) => {
                        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
                      }}
                    />
                    <span style={{ fontSize: 12, color: 'rgba(255, 255, 255, 0.35)', fontWeight: 300 }}>~</span>
                    <input
                      key={`domain-max-${fn.id}-${fn.domain[1]}`}
                      type="text"
                      defaultValue={fn.domain[1]}
                      onBlur={(e) => {
                        const value = parseFloat(e.target.value);
                        if (!isNaN(value) && value !== fn.domain[1]) {
                          // 기존 segment와 앵커 정리 후 정의역 변경
                          const nodes = scene.nodes;
                          // 이 함수의 모든 segment 찾아서 삭제
                          Object.values(nodes).forEach((node: any) => {
                            if (node && node.kind === 'segment' && node.functionId === fn.id) {
                              removeNode(node.id);
                            }
                          });
                          // 정의역 변경 및 segment 재생성
                          upsertNode({ ...fn, domain: [fn.domain[0], value], clipToAxes: false, segmentsOnly: false, suppressedSegmentIds: [] });
                        } else if (e.target.value.trim() === '' || isNaN(value)) {
                          // Blur 시 빈 값이거나 유효하지 않으면 원래 값으로 복원
                          e.target.value = String(fn.domain[1]);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.currentTarget.blur();
                        }
                      }}
                      style={{
                        width: 25,
                        padding: '4px 4px',
                        background: 'rgba(255, 255, 255, 0.08)',
                        border: 'none',
                        borderRadius: 4,
                        color: 'rgba(255, 255, 255, 0.95)',
                        fontSize: 11,
                        fontWeight: 500,
                        textAlign: 'center',
                        outline: 'none',
                        transition: 'all 0.15s'
                      }}
                      onFocus={(e) => {
                        e.currentTarget.style.background = 'rgba(33, 150, 243, 0.15)';
                      }}
                      onBlurCapture={(e) => {
                        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}

          {/* 점 목록 */}
          {points.map((pt: any) => {
            const xStr = Number(pt.position.x).toFixed(2);
            const yStr = Number(pt.position.y).toFixed(2);
            const latex = `\\left(${xStr}, ${yStr}\\right)`;
            let html = '';
            try {
              html = katex.renderToString(latex, {
                throwOnError: false,
                displayMode: false
              });
            } catch (e) {
              html = latex;
            }

            return (
              <div
                key={pt.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '12px',
                  gap: 8,
                  background: 'rgba(0, 0, 0, 0.3)',
                  backdropFilter: 'blur(20px)',
                  borderRadius: 12,
                  boxShadow: '0 2px 12px rgba(0,0,0,0.1)',
                  transition: 'background 0.2s'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(0, 0, 0, 0.4)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(0, 0, 0, 0.3)'}
              >
                <div
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: '50%',
                    background: pt.color || '#000000',
                    flexShrink: 0
                  }}
                />

                <div
                  style={{
                    flex: 1,
                    fontSize: 14,
                    color: '#fff',
                    fontFamily: 'KaTeX_Main, serif'
                  }}
                  dangerouslySetInnerHTML={{ __html: html }}
                />

                <button
                  onClick={() => removeNode(pt.id)}
                  style={{
                    width: 28,
                    height: 28,
                    border: 'none',
                    background: 'rgba(255,255,255,0.1)',
                    color: 'rgba(255,255,255,0.7)',
                    cursor: 'pointer',
                    fontSize: 18,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 8,
                    flexShrink: 0,
                    transition: 'all 0.2s'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = '#f44336';
                    e.currentTarget.style.color = '#fff';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.1)';
                    e.currentTarget.style.color = 'rgba(255,255,255,0.7)';
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>

        {/* 도구창 - 맨 아래 */}
        <div style={{
          padding: 12,
          background: 'rgba(0, 0, 0, 0.3)',
          backdropFilter: 'blur(20px)',
          borderRadius: 12,
          boxShadow: '0 2px 12px rgba(0,0,0,0.1)',
          display: 'flex',
          flexDirection: 'column',
          gap: 12
        }}>
          {/* Axis controls */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {axes.map(axis => (
              <div key={axis.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 12, color: 'rgba(255, 255, 255, 0.9)' }}>{axis.name}축</span>
                <button
                  onClick={() => upsertNode({ ...axis, visible: !axis.visible })}
                  style={{
                    padding: '2px 8px',
                    background: axis.visible !== false ? '#2196F3' : 'rgba(255, 255, 255, 0.3)',
                    border: 'none',
                    borderRadius: 4,
                    color: '#fff',
                    cursor: 'pointer',
                    fontSize: 11,
                    fontWeight: 500
                  }}
                >
                  {axis.visible !== false ? 'ON' : 'OFF'}
                </button>
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 8 }}>
              <span style={{ fontSize: 11, color: 'rgba(255, 255, 255, 0.5)', whiteSpace: 'nowrap', fontWeight: 500 }}>Y축 Scale</span>
              <input
                type="text"
                defaultValue={scene.view.yScale ?? 1}
                onBlur={(e) => {
                  const value = parseFloat(e.target.value);
                  if (!isNaN(value) && value > 0) {
                    const setView = useSceneStore.getState().setView;
                    setView({ ...scene.view, yScale: value });
                  } else if (e.target.value.trim() === '' || isNaN(value)) {
                    // Blur 시 빈 값이거나 유효하지 않으면 원래 값으로 복원
                    e.target.value = String(scene.view.yScale ?? 1);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                  }
                }}
                style={{
                  width: 25,
                  padding: '4px 4px',
                  background: 'rgba(255, 255, 255, 0.08)',
                  border: 'none',
                  borderRadius: 4,
                  color: 'rgba(255, 255, 255, 0.95)',
                  fontSize: 11,
                  fontWeight: 500,
                  textAlign: 'center',
                  outline: 'none',
                  transition: 'all 0.15s'
                }}
                onFocus={(e) => {
                  e.currentTarget.style.background = 'rgba(33, 150, 243, 0.15)';
                }}
                onBlurCapture={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
                }}
              />
            </div>
          </div>

        </div>
      </div>

      <style>{`
        /* KaTeX 기본 가중치 정상화 (전역 600의 영향 차단) */
        .katex, .katex * { font-weight: 400 !important; }
        
        /* MathLive 포커스 시 하늘색 배경 제거 */
        math-field,
        math-field:focus,
        math-field:focus-within,
        math-field:hover {
          background: transparent !important;
          background-color: transparent !important;
          background-image: none !important;
          outline: none !important;
          --ml-background: transparent !important;
          --ml-background-focused: transparent !important;
          --ml-selection-background-color: rgba(255, 255, 255, 0.15) !important;
          --selection-background-color: rgba(255, 255, 255, 0.15) !important;
        }
        
        math-field::part(content),
        math-field::part(container),
        math-field::part(virtual-keyboard-toggle) {
          background: transparent !important;
          background-color: transparent !important;
        }
        
        /* Custom tooltip styles */
        button[data-tooltip] {
          position: relative !important;
          overflow: visible !important;
        }
        
        button[data-tooltip]::before {
          content: attr(data-tooltip) !important;
          position: absolute !important;
          top: calc(100% + 8px) !important;
          left: 50% !important;
          transform: translateX(-50%) translateY(4px) !important;
          padding: 6px 14px 0px 14px !important;
          background: rgb(240, 240, 240) !important;
          color: rgba(40, 40, 40, 0.95) !important;
          font-size: 13px !important;
          font-weight: 500 !important;
          line-height: 1.0 !important;
          border-radius: 6px !important;
          white-space: nowrap !important;
          pointer-events: none !important;
          opacity: 0 !important;
          transition: opacity 0.2s ease, transform 0.2s ease !important;
          z-index: 99999 !important;
          box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15) !important;
          border: none !important;
          display: inline-block !important;
          vertical-align: middle !important;
          height: auto !important;
          min-height: 20px !important;
        }
        
        button[data-tooltip]::after {
          content: '' !important;
          position: absolute !important;
          top: calc(100% + 2px) !important;
          left: 50% !important;
          transform: translateX(-50%) !important;
          border: 6px solid transparent !important;
          border-bottom-color: rgb(240, 240, 240) !important;
          pointer-events: none !important;
          opacity: 0 !important;
          transition: opacity 0.2s ease !important;
          z-index: 99999 !important;
        }
        
        button[data-tooltip]::after {
          content: '' !important;
          position: absolute !important;
          top: calc(100% + 2px) !important;
          left: 50% !important;
          transform: translateX(-50%) !important;
          border: 6px solid transparent !important;
          border-bottom-color: rgb(240, 240, 240) !important;
          pointer-events: none !important;
          opacity: 0 !important;
          transition: opacity 0.2s ease !important;
          z-index: 10000 !important;
        }
        
        button[data-tooltip]:hover::before {
          opacity: 1 !important;
          transform: translateX(-50%) translateY(0) !important;
        }
        
        button[data-tooltip]:hover::after {
          opacity: 1 !important;
        }

        /* Pseudo-element tooltips are clipped by overflow/scroll containers. Use portal tooltip instead. */
        button[data-tooltip]::before,
        button[data-tooltip]::after {
          display: none !important;
        }
      `}</style>
      <div style={{ marginTop: 'auto', display: 'flex', gap: 6, marginBottom: 8 }}>
        <button
          onClick={() => setShowHelp(true)}
          style={{
            background: 'rgba(0, 0, 0, 0.4)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: 8,
            color: 'rgba(255, 255, 255, 0.6)',
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 500,
            padding: '8px 8px',
            textAlign: 'center',
            transition: 'all 0.2s',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            flex: 1,
            justifyContent: 'center'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(0, 0, 0, 0.6)';
            e.currentTarget.style.color = '#fff';
            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.15)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(0, 0, 0, 0.4)';
            e.currentTarget.style.color = 'rgba(255, 255, 255, 0.6)';
            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          도움말
        </button>

        <button
          onClick={() => window.dispatchEvent(new CustomEvent('open-terms-modal'))}
          style={{
            background: 'rgba(0, 0, 0, 0.4)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: 8,
            color: 'rgba(255, 255, 255, 0.6)',
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 500,
            padding: '8px 8px',
            textAlign: 'center',
            transition: 'all 0.2s',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            flex: 1,
            justifyContent: 'center'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(0, 0, 0, 0.6)';
            e.currentTarget.style.color = '#fff';
            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.15)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(0, 0, 0, 0.4)';
            e.currentTarget.style.color = 'rgba(255, 255, 255, 0.6)';
            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          약관
        </button>

        <button
          onClick={() => setShowDonation(true)}
          style={{
            background: '#ff5252',
            border: 'none',
            borderRadius: 8,
            color: '#ffffff',
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 700,
            padding: '8px 8px',
            textAlign: 'center',
            transition: 'all 0.2s',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
            flex: 1.2,
            textDecoration: 'none',
            boxShadow: '0 2px 8px rgba(255, 82, 82, 0.4)'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = '#ff1744';
            e.currentTarget.style.transform = 'translateY(-1px)';
            e.currentTarget.style.boxShadow = '0 4px 12px rgba(255, 82, 82, 0.6)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = '#ff5252';
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.boxShadow = '0 2px 8px rgba(255, 82, 82, 0.4)';
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
          후원
        </button>
      </div>
      {tooltip && typeof document !== 'undefined' && createPortal(
        <div style={{ position: 'fixed', left: tooltip.left, top: tooltip.top, transform: 'translate(-50%, 0)', zIndex: 999999, pointerEvents: 'none' }}>
          <div style={{ width: 0, height: 0, margin: '0 auto', borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderBottom: '6px solid rgb(240, 240, 240)', marginBottom: '-1px' }} />
          <div style={{ background: 'rgb(240, 240, 240)', color: 'rgba(40, 40, 40, 0.95)', fontSize: 13, fontWeight: 500, lineHeight: 1.2, padding: '6px 14px 5px 14px', borderRadius: 6, whiteSpace: 'nowrap', boxShadow: '0 2px 12px rgba(0, 0, 0, 0.15)' }}>
            {tooltip.text}
          </div>
        </div>,
        document.body
      )}
      <DonationModal isOpen={showDonation} onClose={() => setShowDonation(false)} />
      <HelpModal isOpen={showHelp} onClose={() => setShowHelp(false)} />
    </div>
  );
}
