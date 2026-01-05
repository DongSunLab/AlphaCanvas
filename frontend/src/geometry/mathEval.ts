// Simple math expression evaluator
// For production, consider using math.js or similar
import type { SceneNode, Vec2 } from '../shared/types';

// -----------------------------------------------------------------------------
// Security: expression evaluation hardening
// -----------------------------------------------------------------------------
// 이 파일은 사용자 입력(수식)을 평가하므로, eval/new Function 사용 시
// XSS/코드 실행 위험이 큽니다. 아래 검증은 "수학 식" 문법만 허용하도록
// 보수적으로 차단합니다.

const DISALLOWED_RAW_CHARS_RE = /[;{}\[\]`"<>\\]/; // raw expr에서는 따옴표도 금지
const DISALLOWED_CODE_CHARS_RE = /[;{}\[\]`<>\\]/; // compiled code에서는 따옴표는 허용(DF("f") 등)
const DISALLOWED_SEQS = ['//', '/*', '*/'] as const;
const DISALLOWED_WORDS_RE = /\b(?:constructor|prototype|__proto__|window|document|globalThis|Function|eval|import|require|process)\b/;

const ALLOWED_MATH_PROPS = new Set<string>([
  'sqrt', 'cbrt', 'abs', 'sign',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
  'log', 'log2', 'log10', 'exp',
  'floor', 'ceil', 'round', 'trunc',
  'min', 'max', 'pow', 'hypot',
  'PI', 'E'
]);

function isDigit(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57;
}

function validateRawExpr(expr: string): boolean {
  if (!expr) return true;
  if (DISALLOWED_RAW_CHARS_RE.test(expr)) return false;
  for (const s of DISALLOWED_SEQS) {
    if (expr.includes(s)) return false;
  }
  if (DISALLOWED_WORDS_RE.test(expr)) return false;
  return true;
}

function validateCompiledCode(code: string, allowedVarNames: Set<string>, allowedFProps: Set<string>): boolean {
  if (!code) return true;
  if (DISALLOWED_CODE_CHARS_RE.test(code)) return false;
  for (const s of DISALLOWED_SEQS) {
    if (code.includes(s)) return false;
  }
  if (DISALLOWED_WORDS_RE.test(code)) return false;

  // Dot usage: only decimals (1.23) or Math.<prop> or F.<prop> are allowed.
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '.') continue;
    const prev = i > 0 ? code[i - 1] : '';
    const next = i + 1 < code.length ? code[i + 1] : '';
    const isDecimal = isDigit(prev) && isDigit(next);
    const isMathDot = i >= 4 && code.slice(i - 4, i + 1) === 'Math.';
    // F.<symbol> access is allowed only for known function symbols.
    // Note: '.' is at index i, so the two-character prefix is at [i-1, i+1).
    const isFDot = i >= 1 && code.slice(i - 1, i + 1) === 'F.';
    if (!isDecimal && !isMathDot && !isFDot) return false;
  }

  // Restrict Math.<prop> to allowlist
  {
    const re = /\bMath\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      const prop = m[1];
      if (!ALLOWED_MATH_PROPS.has(prop)) return false;
    }
  }

  // Restrict F.<prop> to known function symbols only
  {
    const re = /\bF\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      const prop = m[1];
      if (!allowedFProps.has(prop)) return false;
    }
  }

  // Bare identifiers (not preceded by ".") must be in allowlist
  {
    // IMPORTANT: Ignore identifiers inside string literals.
    // We intentionally allow DF("f") syntax for derivatives; without stripping strings,
    // the token "f" would be parsed as a bare identifier and incorrectly blocked.
    const codeNoStrings = code
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''");
    const re = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(codeNoStrings))) {
      const name = m[0];
      const idx = m.index;
      const prev = idx > 0 ? codeNoStrings[idx - 1] : '';
      if (prev === '.') continue; // property identifiers handled above
      if (name === 'Math' || name === 'F' || name === 'DF') continue;
      if (allowedVarNames.has(name)) continue;
      return false;
    }
  }

  return true;
}

export function evaluateExpr(expr: string, vars: Record<string, number>): number {
  try {
    if (!validateRawExpr(expr)) return NaN;
    // Replace variable names with values
    let code = expr;
    for (const [name, val] of Object.entries(vars)) {
      const regex = new RegExp(`\\b${name}\\b`, 'g');
      code = code.replace(regex, `(${val})`);
    }
    // Replace ^ with ** for exponentiation
    code = code.replace(/\^/g, '**');

    // Convert standard math functions to Math.*
    const mathFunctions = [
      'sqrt', 'cbrt', 'abs', 'sign',
      'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
      'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
      'log', 'log2', 'log10', 'exp',
      'floor', 'ceil', 'round', 'trunc',
      'min', 'max', 'pow', 'hypot'
    ];
    for (const fn of mathFunctions) {
      const fnRe = new RegExp(`(?<![.a-zA-Z])\\b${fn}\\s*\\(`, 'g');
      code = code.replace(fnRe, `Math.${fn}(`);
    }
    // Handle 'ln' as alias for Math.log
    code = code.replace(/(?<![.a-zA-Z])\bln\s*\(/g, 'Math.log(');
    // Handle pi and e
    code = code.replace(/(?<![.a-zA-Z])\bpi\b/gi, 'Math.PI');
    code = code.replace(/(?<![.a-zA-Z])\be\b(?![a-zA-Z])/g, 'Math.E');

    // Validate compiled code and evaluate
    const allowedVars = new Set<string>(); // vars already substituted
    const allowedFProps = new Set<string>();
    if (!validateCompiledCode(code, allowedVars, allowedFProps)) return NaN;

    // eslint-disable-next-line no-new-func
    const fn = new Function(`"use strict"; return (${code});`);
    const out = fn();
    return typeof out === 'number' ? out : Number(out);
  } catch {
    return NaN;
  }
}

// Safety limits for evaluation
const MAX_RECURSION_DEPTH = 8;
const MAX_EVAL_TIME_MS = 100; // Increased to 100ms for complex expressions

// Evaluate with function registry support (explicit/implicit dependencies)
// Now includes recursion depth and time budget protection
export function evaluateWithRegistry(
  expr: string,
  vars: Record<string, number>,
  registry: Record<string, { arity: number; fn: (...args: number[]) => number }>,
  _depth: number = 0
): number {
  // Rate-limited warning logger to avoid console spam during sampling
  const nowTime = (typeof performance !== 'undefined' && performance.now) ? () => performance.now() : () => Date.now();
  type WarnState = { lastWindowStart: number; count: number };
  const warnBuckets: Record<string, WarnState> = (evaluateWithRegistry as any)._warnBuckets || {};
  const warnOnce = (key: string, ...args: any[]) => {
    const WINDOW_MS = 500; // time window per key
    const MAX_PER_WINDOW = 2; // at most 2 logs per window per key
    const t = nowTime();
    const st = warnBuckets[key] || { lastWindowStart: t, count: 0 };
    if (t - st.lastWindowStart > WINDOW_MS) {
      st.lastWindowStart = t;
      st.count = 0;
    }
    if (st.count < MAX_PER_WINDOW) {
      // eslint-disable-next-line no-console
      console.warn(...args);
      st.count++;
    }
    warnBuckets[key] = st;
    (evaluateWithRegistry as any)._warnBuckets = warnBuckets;
  };
  // Guard: max recursion depth
  if (_depth > MAX_RECURSION_DEPTH) {
    warnOnce('max-depth', 'evaluateWithRegistry: max recursion depth exceeded');
    return NaN;
  }

  const startTime = performance.now();

  try {
    if (!validateRawExpr(expr)) return NaN;
    let code = expr.replace(/\^/g, '**');

    // Fix: JavaScript doesn't allow unary minus directly before ** (e.g., -x**2 is a syntax error)
    // We need to wrap in parentheses: -x**2 → -(x**2)
    code = code.replace(/([+\-*/=(,\s]|^)-(\w+)\*\*(\w+)/g, (_m: string, prefix: string, base: string, exp: string) => {
      const p = prefix === '-' ? '' : prefix;
      return `${p}-(${base}**${exp})`;
    });

    // Map function symbols to registry: f(x) -> F.f(x)
    const symbols = Object.keys(registry);
    if (symbols.length > 0) {
      // Derivative notation: f'(x) -> DF("f")(x)
      for (const s of symbols) {
        const derivRe = new RegExp(`\\b${s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\'\\s*\\(`, 'g');
        code = code.replace(derivRe, `DF(\"${s}\")(`);
      }
      const re = new RegExp(`\\b(${symbols.map(s => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})\\s*\\(`, 'g');
      code = code.replace(re, (_m, s) => `F.${s}(`);
    }

    // Convert standard math functions to Math.* (must come BEFORE pi/e replacement)
    const mathFunctions = [
      'sqrt', 'cbrt', 'abs', 'sign',
      'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
      'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
      'log', 'log2', 'log10', 'exp',
      'floor', 'ceil', 'round', 'trunc',
      'min', 'max', 'pow', 'hypot'
    ];
    for (const fn of mathFunctions) {
      const fnRe = new RegExp(`(?<![.a-zA-Z])\\b${fn}\\s*\\(`, 'g');
      code = code.replace(fnRe, `Math.${fn}(`);
    }
    // Handle 'ln' as alias for Math.log
    code = code.replace(/(?<![.a-zA-Z])\bln\s*\(/g, 'Math.log(');

    // Standard math identifiers (avoid duplicating Math.)
    code = code
      .replace(/\bpi\b/gi, (m: string, offset: number, str: string) => {
        const prev = offset > 0 ? str[offset - 1] : '';
        return prev === '.' ? m : 'Math.PI';
      })
      .replace(/\be\b/g, (m: string, offset: number, str: string) => {
        const prev = offset > 0 ? str[offset - 1] : '';
        return prev === '.' ? m : 'Math.E';
      })
      .replace(/\bMath\.Math\b/g, 'Math');
    // Build args
    const argNames = Object.keys(vars);
    const argValues = Object.values(vars);

    // Numeric derivative helper: DF("f")(x) with depth tracking
    const DF = (name: string) => {
      const entry = registry[name];
      if (!entry || entry.arity !== 1) {
        return (_x: number) => NaN;
      }
      return (x: number) => {
        // Check time budget
        if (performance.now() - startTime > MAX_EVAL_TIME_MS) {
          warnOnce('time-budget', 'evaluateWithRegistry: time budget exceeded');
          return NaN;
        }
        const h = Math.max(1e-6, Math.abs(x) * 1e-6);
        return (entry.fn(x + h) - entry.fn(x - h)) / (2 * h);
      };
    };

    // Validate code (allow variables + F.<symbols> only)
    const allowedVars = new Set<string>(argNames);
    const allowedFProps = new Set<string>(Object.keys(registry));
    if (!validateCompiledCode(code, allowedVars, allowedFProps)) return NaN;

    // eslint-disable-next-line no-new-func
    const fn = new Function('F', 'DF', ...argNames, `"use strict"; return (${code});`) as (...args: any[]) => number;

    // Wrap registry functions with depth+time tracking
    const wrappedF = Object.fromEntries(
      symbols.map((s) => [
        s,
        (...args: number[]) => {
          // Check time budget before each call
          if (performance.now() - startTime > MAX_EVAL_TIME_MS) {
            warnOnce('time-budget-call', 'evaluateWithRegistry: time budget exceeded in function call');
            return NaN;
          }
          return registry[s].fn(...args);
        }
      ])
    );

    return fn(wrappedF, DF, ...argValues);
  } catch (err) {
    warnOnce('eval-error', 'evaluateWithRegistry error:', err);
    return NaN;
  }
}

// ---- Compilation helpers (cache) ----
const compiledCache = new Map<string, Function>();

function preprocessExpr(expr: string, symbols: string[]): string {
  let code = expr.replace(/\^/g, '**');

  // Fix: JavaScript doesn't allow unary minus directly before ** (e.g., -x**2 is a syntax error)
  // We need to wrap in parentheses: -x**2 → -(x**2)
  code = code.replace(/([+\-*/=(,\s]|^)-(\w+)\*\*(\w+)/g, (_m: string, prefix: string, base: string, exp: string) => {
    const p = prefix === '-' ? '' : prefix;
    return `${p}-(${base}**${exp})`;
  });

  // Derivative notation: f'(x)
  for (const s of symbols) {
    const derivRe = new RegExp(`\\b${s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\'\\s*\\(`, 'g');
    code = code.replace(derivRe, `DF(\"${s}\")(`);
  }
  if (symbols.length > 0) {
    const re = new RegExp(`\\b(${symbols.map(s => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})\\s*\\(`, 'g');
    code = code.replace(re, (_m, s) => `F.${s}(`);
  }

  // Convert standard math functions to Math.* (must come BEFORE pi/e replacement)
  // Only replace if not already prefixed with Math. or F.
  const mathFunctions = [
    'sqrt', 'cbrt', 'abs', 'sign',
    'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
    'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
    'log', 'log2', 'log10', 'exp',
    'floor', 'ceil', 'round', 'trunc',
    'min', 'max', 'pow', 'hypot'
  ];
  for (const fn of mathFunctions) {
    // Match function name followed by ( but not preceded by Math. or F. or other letter
    const fnRe = new RegExp(`(?<![.a-zA-Z])\\b${fn}\\s*\\(`, 'g');
    code = code.replace(fnRe, `Math.${fn}(`);
  }
  // Handle 'ln' as alias for Math.log
  code = code.replace(/(?<![.a-zA-Z])\bln\s*\(/g, 'Math.log(');

  code = code
    .replace(/\bpi\b/gi, (m: string, offset: number, str: string) => {
      const prev = offset > 0 ? str[offset - 1] : '';
      return prev === '.' ? m : 'Math.PI';
    })
    .replace(/\be\b/g, (m: string, offset: number, str: string) => {
      const prev = offset > 0 ? str[offset - 1] : '';
      return prev === '.' ? m : 'Math.E';
    })
    .replace(/\bMath\.Math\b/g, 'Math');
  return code;
}

function getCompiledFunction(expr: string, argNames: string[], symbols: string[]): Function {
  const key = `${expr}__args:${argNames.join(',')}__syms:${symbols.sort().join(',')}`;
  const cached = compiledCache.get(key);
  if (cached) return cached;
  const code = preprocessExpr(expr, symbols);
  try {
    // Validate code (variables + F.<symbols> only)
    const allowedVars = new Set<string>(argNames);
    const allowedFProps = new Set<string>(symbols);
    if (!validateCompiledCode(code, allowedVars, allowedFProps)) {
      const safe = function _invalidExprBlocked() { return NaN; } as unknown as Function;
      compiledCache.set(key, safe);
      return safe;
    }
    // eslint-disable-next-line no-new-func
    const fn = new Function('F', 'DF', ...argNames, `"use strict"; return (${code});`);
    compiledCache.set(key, fn);
    return fn;
  } catch (err) {
    // Log the error to help debug expression compilation failures
    console.error(`[mathEval] Failed to compile expression: "${expr}" -> "${code}"`, err);
    // Fallback: return a function that yields NaN to avoid crashing the app
    const safe = function _invalidExprFallback() { return NaN; } as unknown as Function;
    compiledCache.set(key, safe);
    return safe;
  }
}

// Build a simple registry from scene nodes (explicit/implicit)
export function buildFunctionRegistry(nodes: Record<string, SceneNode>): Record<string, { arity: number; fn: (...args: number[]) => number; expr: string }> {
  const registry: Record<string, { arity: number; fn: (...args: number[]) => number; expr: string }> = {};
  const functions = Object.values(nodes).filter((n: any) => (n.kind === 'function-explicit' || n.kind === 'function-implicit') && n.symbol) as any[];
  for (const f of functions) {
    const sym = f.symbol as string;
    if (!sym || registry[sym]) continue;
    if (f.kind === 'function-explicit') {
      registry[sym] = {
        arity: 1,
        fn: (x: number) => evaluateWithRegistry(f.expr, { x }, registry),
        expr: f.expr
      };
    } else {
      registry[sym] = {
        arity: 2,
        fn: (x: number, y: number) => evaluateWithRegistry(f.expr, { x, y }, registry),
        expr: f.expr
      };
    }
  }
  return registry;
}

export function sampleExplicit(
  expr: string,
  variable: string,
  domain: [number, number],
  samples: number = 200
): Array<{ x: number; y: number }> {
  const [xMin, xMax] = domain;
  const dx = (xMax - xMin) / samples;
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= samples; i++) {
    const x = xMin + i * dx;
    const y = evaluateExpr(expr, { [variable]: x });
    if (isFinite(y)) {
      points.push({ x, y });
    }
  }
  return points;
}

export function sampleExplicitWithRegistry(
  expr: string,
  variable: string,
  domain: [number, number],
  samples: number,
  registry: Record<string, { arity: number; fn: (...args: number[]) => number; expr: string }>
): Array<{ x: number; y: number }> {
  const [xMin, xMax] = domain;
  const dx = (xMax - xMin) / samples;
  // Filter registry to only include 1-arity functions (explicit functions can only reference other explicit functions)
  const filteredRegistry: Record<string, { arity: number; fn: (...args: number[]) => number; expr: string }> = {};
  for (const [key, value] of Object.entries(registry)) {
    if (value.arity === 1) {
      filteredRegistry[key] = value;
    }
  }

  const symbols = Object.keys(filteredRegistry);
  const fn = getCompiledFunction(expr, [variable], symbols) as (...args: any[]) => number;
  // Precompile symbol functions and build F once to avoid per-call overhead
  const compiledPerSymbol: Record<string, Function> = {};
  for (const s of symbols) {
    const entry = filteredRegistry[s];
    const args = entry.arity === 1 ? ['x'] : ['x', 'y'];
    compiledPerSymbol[s] = getCompiledFunction(entry.expr, args, symbols);
  }
  const F: Record<string, (...args: number[]) => number> = {};
  const DF = (name: string) => {
    const entry = filteredRegistry[name];
    if (!entry || entry.arity !== 1) return (_x: number) => NaN;
    const cf = compiledPerSymbol[name];
    return (x: number) => {
      const h = Math.max(1e-6, Math.abs(x) * 1e-6);
      return ((cf(F, DF, x + h) as number) - (cf(F, DF, x - h) as number)) / (2 * h);
    };
  };
  for (const s of symbols) {
    const cf = compiledPerSymbol[s];
    F[s] = (...args: number[]) => cf(F, DF, ...args) as number;
  }

  // Helper to evaluate function
  const evaluate = (x: number): number => {
    try {
      return fn(F, DF, x);
    } catch {
      return evaluateWithRegistry(expr, { [variable]: x }, filteredRegistry);
    }
  };

  // Initial uniform sampling with domain boundary detection
  const initialPoints: Array<{ x: number; y: number }> = [];
  let prevX: number | null = null;
  let prevYsFinite = false;

  for (let i = 0; i <= samples; i++) {
    const x = xMin + i * dx;
    const y = evaluate(x);
    const isFin = Number.isFinite(y);

    if (prevX !== null) {
      // Check for domain entry (NaN -> Finite)
      if (!prevYsFinite && isFin) {
        let a = prevX;
        let b = x;
        // Bisection to find entry point
        for (let k = 0; k < 16; k++) {
          const m = (a + b) / 2;
          if (Number.isFinite(evaluate(m))) b = m;
          else a = m;
        }
        // b is the start of valid domain
        const yb = evaluate(b);
        if (Number.isFinite(yb)) initialPoints.push({ x: b, y: yb });
      }

      // Check for domain exit (Finite -> NaN)
      if (prevYsFinite && !isFin) {
        let a = prevX;
        let b = x;
        // Bisection to find exit point
        for (let k = 0; k < 16; k++) {
          const m = (a + b) / 2;
          if (Number.isFinite(evaluate(m))) a = m;
          else b = m;
        }
        // a is the end of valid domain
        const ya = evaluate(a);
        if (Number.isFinite(ya)) initialPoints.push({ x: a, y: ya });
      }
    }

    if (isFin) {
      initialPoints.push({ x, y });
    }

    prevX = x;
    prevYsFinite = isFin;
  }

  // Find zeros (sign changes) and add refined points
  const refinedPoints: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < initialPoints.length; i++) {
    refinedPoints.push(initialPoints[i]);

    // Check for sign change between this point and next
    if (i < initialPoints.length - 1) {
      const p1 = initialPoints[i];
      const p2 = initialPoints[i + 1];

      // Sign change detected (zero crossing)
      if (p1.y * p2.y < 0) {
        // Use bisection to find accurate zero location
        let a = p1.x;
        let b = p2.x;
        let ya = p1.y;

        // Bisection for up to 20 iterations
        for (let iter = 0; iter < 20 && Math.abs(b - a) > (xMax - xMin) * 1e-10; iter++) {
          const mid = (a + b) / 2;
          const ymid = evaluate(mid);

          if (!isFinite(ymid)) break;

          if (Math.abs(ymid) < 1e-10) {
            // Found exact zero
            refinedPoints.push({ x: mid, y: ymid });
            break;
          }

          if (ya * ymid < 0) {
            b = mid;
          } else {
            a = mid;
            ya = ymid;
          }
        }

        // Add the refined zero point
        const zeroX = (a + b) / 2;
        const zeroY = evaluate(zeroX);
        if (isFinite(zeroY)) {
          refinedPoints.push({ x: zeroX, y: zeroY });
        }
      }

      // Check for sharp changes in derivative (like abs() kink points)
      // where the function is continuous but not differentiable
      // 1) Near zero check
      if (Math.abs(p1.y) < dx * 2 || Math.abs(p2.y) < dx * 2) {
        // Near zero - add extra points for precision
        const mid = (p1.x + p2.x) / 2;
        const ymid = evaluate(mid);
        if (isFinite(ymid)) {
          refinedPoints.push({ x: mid, y: ymid });
        }
      }

      // 2) Detect sharp slope changes (cusp/kink points in abs functions)
      if (i > 0 && i < initialPoints.length - 1) {
        const p0 = initialPoints[i - 1];
        const slope1 = (p1.y - p0.y) / (p1.x - p0.x);
        const slope2 = (p2.y - p1.y) / (p2.x - p1.x);

        // If slopes have opposite signs or differ significantly, likely a kink
        if (isFinite(slope1) && isFinite(slope2)) {
          const slopeChange = Math.abs(slope2 - slope1);
          const avgSlope = (Math.abs(slope1) + Math.abs(slope2)) / 2;

          // Detect discontinuous derivative (kink point)
          if (slopeChange > Math.max(2, avgSlope * 1.5)) {
            // Add multiple refined points around the kink
            for (let k = 1; k <= 3; k++) {
              const t = k / 4;
              const xMid = p1.x * (1 - t) + p2.x * t;
              const yMid = evaluate(xMid);
              if (isFinite(yMid)) {
                refinedPoints.push({ x: xMid, y: yMid });
              }
            }
          }
        }
      }
    }
  }

  // Sort by x coordinate and remove duplicates
  refinedPoints.sort((a, b) => a.x - b.x);
  const finalPoints: Array<{ x: number; y: number }> = [];
  const epsilon = (xMax - xMin) * 1e-8;

  for (const p of refinedPoints) {
    if (finalPoints.length === 0 || Math.abs(p.x - finalPoints[finalPoints.length - 1].x) > epsilon) {
      finalPoints.push(p);
    }
  }

  return finalPoints;
}

export function sampleImplicit(
  expr: string,
  variables: [string, string],
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number },
  resolution: number = 100
): Array<{ x: number; y: number }> {
  // Simplified and faster implicit function sampling
  const [xVar, yVar] = variables;
  const { xMin, xMax, yMin, yMax } = bounds;
  const dx = (xMax - xMin) / resolution;
  const dy = (yMax - yMin) / resolution;
  const points: Array<{ x: number; y: number }> = [];

  // For each row, find zero-crossings
  for (let j = 0; j <= resolution; j++) {
    const y = yMin + j * dy;
    for (let i = 0; i < resolution; i++) {
      const x0 = xMin + i * dx;
      const x1 = x0 + dx;

      const v0 = evaluateExpr(expr, { [xVar]: x0, [yVar]: y });
      const v1 = evaluateExpr(expr, { [xVar]: x1, [yVar]: y });

      // Check for zero-crossing
      if (v0 * v1 < 0) {
        // Linear interpolation
        const t = Math.abs(v0) / (Math.abs(v0) + Math.abs(v1));
        points.push({ x: x0 + t * dx, y });
      }
    }
  }

  // Also scan columns for better coverage
  for (let i = 0; i <= resolution; i++) {
    const x = xMin + i * dx;
    for (let j = 0; j < resolution; j++) {
      const y0 = yMin + j * dy;
      const y1 = y0 + dy;

      const v0 = evaluateExpr(expr, { [xVar]: x, [yVar]: y0 });
      const v1 = evaluateExpr(expr, { [xVar]: x, [yVar]: y1 });

      // Check for zero-crossing
      if (v0 * v1 < 0) {
        // Linear interpolation
        const t = Math.abs(v0) / (Math.abs(v0) + Math.abs(v1));
        points.push({ x, y: y0 + t * dy });
      }
    }
  }

  return points;
}

// Marching Squares segments for implicit contour f(x,y)=0
export function marchingSquaresSegments(
  expr: string,
  variables: [string, string],
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number },
  resolution: number = 512
): Array<{ a: { x: number; y: number }; b: { x: number; y: number } }> {
  const [xVar, yVar] = variables;
  const { xMin, xMax, yMin, yMax } = bounds;
  const cols = resolution;
  const rows = resolution;
  const dx = (xMax - xMin) / cols;
  const dy = (yMax - yMin) / rows;

  // Compile expression once for performance (uses hardened compiler)
  const compiled = getCompiledFunction(expr, [xVar, yVar], []) as (...args: any[]) => number;
  const evalFn = (x: number, y: number): number => {
    try {
      // Provide empty F/DF for non-registry mode
      return compiled({}, (_name: string) => (_t: number) => NaN, x, y) as number;
    } catch {
      return evaluateExpr(expr, { [xVar]: x, [yVar]: y });
    }
  };

  // Precompute scalar field
  const values: number[][] = new Array(rows + 1);
  for (let j = 0; j <= rows; j++) {
    values[j] = new Array(cols + 1);
    const y = yMin + j * dy;
    for (let i = 0; i <= cols; i++) {
      const x = xMin + i * dx;
      let v: number;
      try {
        v = evalFn(x, y);
      } catch {
        v = evaluateExpr(expr, { [xVar]: x, [yVar]: y });
      }
      values[j][i] = v;
    }
  }

  // Helper: interpolate along edge
  const interp = (v0: number, v1: number, t0: number, t1: number) => {
    const t = v0 === v1 ? 0.5 : Math.abs(v0) / (Math.abs(v0) + Math.abs(v1));
    return t0 + t * (t1 - t0);
  };

  const segments: Array<{ a: { x: number; y: number }; b: { x: number; y: number } }> = [];

  // Marching Squares over each cell
  for (let j = 0; j < rows; j++) {
    const y0 = yMin + j * dy;
    const y1 = y0 + dy;
    for (let i = 0; i < cols; i++) {
      const x0 = xMin + i * dx;
      const x1 = x0 + dx;

      const v00 = values[j][i];       // bottom-left
      const v10 = values[j][i + 1];   // bottom-right
      const v11 = values[j + 1][i + 1]; // top-right
      const v01 = values[j + 1][i];     // top-left

      // Build case index (1 if value > 0)
      let idx = 0;
      if (v00 > 0) idx |= 1;      // bit 0
      if (v10 > 0) idx |= 2;      // bit 1
      if (v11 > 0) idx |= 4;      // bit 2
      if (v01 > 0) idx |= 8;      // bit 3

      if (idx === 0 || idx === 15) continue; // no intersections

      // Compute edge intersections
      const p: Array<{ x: number; y: number }> = new Array(4);
      // edge 0: bottom (x0,y0) -> (x1,y0)
      p[0] = { x: interp(v00, v10, x0, x1), y: y0 };
      // edge 1: right (x1,y0) -> (x1,y1)
      p[1] = { x: x1, y: interp(v10, v11, y0, y1) };
      // edge 2: top (x0,y1) -> (x1,y1)
      p[2] = { x: interp(v01, v11, x0, x1), y: y1 };
      // edge 3: left (x0,y0) -> (x0,y1)
      p[3] = { x: x0, y: interp(v00, v01, y0, y1) };

      // Case table: pairs of edges to connect
      const table: Record<number, Array<[number, number]>> = {
        1: [[3, 0]],
        2: [[0, 1]],
        3: [[3, 1]],
        4: [[1, 2]],
        5: [[3, 0], [1, 2]], // ambiguous
        6: [[0, 2]],
        7: [[3, 2]],
        8: [[2, 3]],
        9: [[0, 2]],
        10: [[0, 1], [2, 3]], // ambiguous
        11: [[1, 2]],
        12: [[1, 3]],
        13: [[0, 1]],
        14: [[3, 0]]
      };

      const pairs = table[idx];
      if (!pairs) continue;
      for (const [e1, e2] of pairs) {
        segments.push({ a: p[e1], b: p[e2] });
      }
    }
  }

  return segments;
}

// Compute adaptive marching-squares resolution based on current view scale (px per world unit)
export function computeAdaptiveResolution(
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number },
  scale: number,
  options?: { base?: number; min?: number; max?: number; targetCellPx?: number; quality?: number }
): number {
  const { base = 96, min = 64, max = 2048, targetCellPx = 2, quality = 1.0 } = options ?? {};
  const safeScale = Math.max(0, Math.abs(scale));
  const worldWidth = Math.max(1e-9, bounds.xMax - bounds.xMin);
  const worldHeight = Math.max(1e-9, bounds.yMax - bounds.yMin);

  // Project bounds to pixels using current scale
  const pixelsX = worldWidth * safeScale;
  const pixelsY = worldHeight * safeScale;

  // Desired grid cells so that each cell is about targetCellPx pixels (or smaller)
  const resX = targetCellPx > 0 ? pixelsX / targetCellPx : base;
  const resY = targetCellPx > 0 ? pixelsY / targetCellPx : base;

  // Use the larger to ensure both axes have ~targetCellPx density
  let res = Math.round(Math.max(resX, resY) * quality);

  // Fallback to base if extremely small zoom
  if (!isFinite(res) || res <= 0) res = base;

  // Clamp to sane bounds
  if (res < min) res = min;
  if (res > max) res = max;
  return res;
}

// Env-aware marching squares
export function marchingSquaresSegmentsWithRegistry(
  expr: string,
  variables: [string, string],
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number },
  resolution: number,
  registry: Record<string, { arity: number; fn: (...args: number[]) => number; expr: string }>
): Array<{ a: { x: number; y: number }; b: { x: number; y: number } }> {
  const [xVar, yVar] = variables;
  const { xMin, xMax, yMin, yMax } = bounds;
  const cols = resolution;
  const rows = resolution;
  const dx = (xMax - xMin) / cols;
  const dy = (yMax - yMin) / rows;
  const values: number[][] = new Array(rows + 1);
  const symbols = Object.keys(registry);
  const fn = getCompiledFunction(expr, [xVar, yVar], symbols) as (...args: any[]) => number;
  // Precompile symbol functions and build F/DF once per grid
  const compiledPerSymbol: Record<string, Function> = {};
  for (const s of symbols) {
    const entry = registry[s];
    const args = entry.arity === 1 ? ['x'] : ['x', 'y'];
    compiledPerSymbol[s] = getCompiledFunction(entry.expr, args, symbols);
  }
  const F: Record<string, (...args: number[]) => number> = {};
  const DF = (name: string) => {
    const entry = registry[name];
    if (!entry || entry.arity !== 1) return (_x: number) => NaN;
    const cf = compiledPerSymbol[name];
    return (x: number) => {
      const h = Math.max(1e-6, Math.abs(x) * 1e-6);
      return (cf(F, DF, x + h) as number) - (cf(F, DF, x - h) as number);
    };
  };
  for (const s of symbols) {
    const cf = compiledPerSymbol[s];
    F[s] = (...args: number[]) => cf(F, DF, ...args) as number;
  }
  for (let j = 0; j <= rows; j++) {
    values[j] = new Array(cols + 1);
    const y = yMin + j * dy;
    for (let i = 0; i <= cols; i++) {
      const x = xMin + i * dx;
      let v: number;
      try {
        v = fn(F, DF, x, y);
      } catch {
        v = evaluateWithRegistry(expr, { [xVar]: x, [yVar]: y }, registry);
      }
      values[j][i] = v;
    }
  }
  // Reuse core marching logic by duplicating minimal part
  const segments: Array<{ a: { x: number; y: number }; b: { x: number; y: number } }> = [];
  const interp = (v0: number, v1: number, t0: number, t1: number) => {
    const t = v0 === v1 ? 0.5 : Math.abs(v0) / (Math.abs(v0) + Math.abs(v1));
    return t0 + t * (t1 - t0);
  };
  for (let j = 0; j < rows; j++) {
    const y0 = yMin + j * dy;
    const y1 = y0 + dy;
    for (let i = 0; i < cols; i++) {
      const x0 = xMin + i * dx;
      const x1 = x0 + dx;
      const v00 = values[j][i];
      const v10 = values[j][i + 1];
      const v11 = values[j + 1][i + 1];
      const v01 = values[j + 1][i];
      let idx = 0;
      if (v00 > 0) idx |= 1;
      if (v10 > 0) idx |= 2;
      if (v11 > 0) idx |= 4;
      if (v01 > 0) idx |= 8;
      if (idx === 0 || idx === 15) continue;
      const p: Array<{ x: number; y: number }> = new Array(4);
      p[0] = { x: interp(v00, v10, x0, x1), y: y0 };
      p[1] = { x: x1, y: interp(v10, v11, y0, y1) };
      p[2] = { x: interp(v01, v11, x0, x1), y: y1 };
      p[3] = { x: x0, y: interp(v00, v01, y0, y1) };
      const table: Record<number, Array<[number, number]>> = {
        1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 5: [[3, 0], [1, 2]], 6: [[0, 2]], 7: [[3, 2]],
        8: [[2, 3]], 9: [[0, 2]], 10: [[0, 1], [2, 3]], 11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[3, 0]]
      };
      const pairs = table[idx];
      if (!pairs) continue;
      for (const [e1, e2] of pairs) {
        segments.push({ a: p[e1], b: p[e2] });
      }
    }
  }
  return segments;
}

// Connect disjoint marching-squares segments into ordered polylines
export function connectSegmentsToPolylines(
  segments: Array<{ a: { x: number; y: number }; b: { x: number; y: number } }>,
  eps: number = 1e-6
): Vec2[][] {
  if (segments.length === 0) return [];
  const quant = (v: number) => v.toFixed(6);
  const key = (p: Vec2) => `${quant(p.x)}_${quant(p.y)}`;
  type Edge = { a: Vec2; b: Vec2; used: boolean };
  const edges: Edge[] = segments.map(s => ({ a: { x: s.a.x, y: s.a.y }, b: { x: s.b.x, y: s.b.y }, used: false }));
  const adj = new Map<string, number[]>();
  const pointOf = new Map<string, Vec2>();
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const ka = key(e.a);
    const kb = key(e.b);
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    adj.get(ka)!.push(i);
    adj.get(kb)!.push(i);
    if (!pointOf.has(ka)) pointOf.set(ka, e.a);
    if (!pointOf.has(kb)) pointOf.set(kb, e.b);
  }
  const polylines: Vec2[][] = [];
  const nextEdgeFrom = (pt: Vec2): number | null => {
    const k = key(pt);
    const list = adj.get(k) || [];
    for (const idx of list) {
      if (!edges[idx].used) return idx;
    }
    return null;
  };
  const otherEnd = (idx: number, from: Vec2): Vec2 => {
    const e = edges[idx];
    const da = Math.hypot(e.a.x - from.x, e.a.y - from.y);
    const db = Math.hypot(e.b.x - from.x, e.b.y - from.y);
    return da < db ? e.b : e.a;
  };
  for (let i = 0; i < edges.length; i++) {
    if (edges[i].used) continue;
    // Start a new polyline from this edge
    edges[i].used = true;
    const a = edges[i].a;
    const b = edges[i].b;
    const line: Vec2[] = [a, b];
    // Extend forward from b
    let cur = b;
    while (true) {
      const idx = nextEdgeFrom(cur);
      if (idx == null) break;
      edges[idx].used = true;
      const nxt = otherEnd(idx, cur);
      // Avoid degenerate duplicates
      if (Math.hypot(nxt.x - cur.x, nxt.y - cur.y) > eps) {
        line.push(nxt);
        cur = nxt;
      }
    }
    // Extend backward from a
    cur = a;
    while (true) {
      const idx = nextEdgeFrom(cur);
      if (idx == null) break;
      edges[idx].used = true;
      const nxt = otherEnd(idx, cur);
      if (Math.hypot(nxt.x - cur.x, nxt.y - cur.y) > eps) {
        line.unshift(nxt);
        cur = nxt;
      }
    }
    if (line.length >= 2) polylines.push(line);
  }
  return polylines;
}

// ------- Explicit function helpers: find vertical breaks (asymptotes) ---------
export function findExplicitVerticalBreaks(
  expr: string,
  domain: [number, number],
  registry: Record<string, { arity: number; fn: (...args: number[]) => number; expr?: string }>,
  yRange: number,
  steps: number = 128
): number[] {
  const [xMin, xMax] = domain;
  if (!(xMax > xMin)) return [];

  // Filter registry to only include 1-arity functions
  const filteredRegistry: Record<string, { arity: number; fn: (...args: number[]) => number; expr?: string }> = {};
  for (const [key, value] of Object.entries(registry)) {
    if (value.arity === 1) {
      filteredRegistry[key] = value;
    }
  }

  const symbols = Object.keys(filteredRegistry);
  const fn = getCompiledFunction(expr, ['x'], symbols) as (...args: any[]) => number;
  // Build F/DF once
  const compiledPerSymbol: Record<string, Function> = {};
  for (const s of symbols) {
    const entry = filteredRegistry[s];
    const args = entry.arity === 1 ? ['x'] : ['x', 'y'];
    compiledPerSymbol[s] = getCompiledFunction(entry.expr || '', args, symbols);
  }
  const F: Record<string, (...args: number[]) => number> = {};
  const DF = (_name: string) => (_x: number) => NaN; // not used here
  for (const s of symbols) {
    const cf = compiledPerSymbol[s];
    F[s] = (...args: number[]) => cf(F, DF, ...args) as number;
  }

  const jump = Math.max(1, 0.25 * Math.max(1e-6, yRange));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const x = xMin + ((xMax - xMin) * i) / steps;
    let y: number;
    try {
      y = fn(F, DF, x) as number;
    } catch {
      y = evaluateWithRegistry(expr, { x }, filteredRegistry);
    }
    xs.push(x);
    ys.push(y);
  }
  const breaks: number[] = [];
  for (let i = 1; i <= steps; i++) {
    const y0 = ys[i - 1];
    const y1 = ys[i];
    const x0 = xs[i - 1];
    const x1 = xs[i];
    const nonFinite = !isFinite(y0) || !isFinite(y1);
    const largeJump = isFinite(y0) && isFinite(y1) && Math.abs(y1 - y0) > jump;
    if (nonFinite || largeJump) {
      // Refine by bisection to localize break
      let a = x0, b = x1;
      for (let k = 0; k < 20 && b - a > (xMax - xMin) / 2048; k++) {
        const m = 0.5 * (a + b);
        let ya = ys[i - 1];
        let ym: number;
        try { ym = fn(F, DF, m) as number; } catch { ym = evaluateWithRegistry(expr, { x: m }, filteredRegistry); }
        const badHalf = !isFinite(ym) || (isFinite(ya) && Math.abs(ym - ya) > jump);
        if (badHalf) b = m; else a = m;
      }
      const xc = 0.5 * (a + b);
      if (xc > xMin && xc < xMax) breaks.push(xc);
    }
  }
  // Deduplicate and sort
  breaks.sort((a, b) => a - b);
  const uniq: number[] = [];
  for (const x of breaks) {
    if (uniq.length === 0 || Math.abs(x - uniq[uniq.length - 1]) > (xMax - xMin) / 4096) uniq.push(x);
  }
  return uniq;
}

// Compute extrema (local minima/maxima) for explicit functions
export function computeExtrema(
  expr: string,
  variable: string,
  domain: [number, number],
  registry: Record<string, { arity: number; fn: (...args: number[]) => number }>
): Vec2[] {
  const extrema: Vec2[] = [];
  const [xMin, xMax] = domain;
  const h = 1e-5; // small step for numerical derivative

  // Create function evaluator
  const evaluate = (x: number): number => {
    try {
      return evaluateWithRegistry(expr, { [variable]: x }, registry);
    } catch {
      return NaN;
    }
  };

  // Sample function and look for sign changes in derivative
  const samples = 200;
  const dx = (xMax - xMin) / samples;

  for (let i = 1; i < samples; i++) {
    const x0 = xMin + (i - 1) * dx;
    const x1 = xMin + i * dx;
    const x2 = xMin + (i + 1) * dx;

    if (x2 > xMax) break;

    const y0 = evaluate(x0);
    const y1 = evaluate(x1);
    const y2 = evaluate(x2);

    if (!Number.isFinite(y0) || !Number.isFinite(y1) || !Number.isFinite(y2)) continue;

    // Numerical derivative approximation
    const dy0 = (y1 - y0) / dx;
    const dy1 = (y2 - y1) / dx;

    // Sign change indicates extremum
    if (dy0 * dy1 < 0) {
      // Refine using bisection
      let a = x0, b = x2;
      for (let iter = 0; iter < 20; iter++) {
        const mid = (a + b) / 2;
        const yMid = evaluate(mid);
        const yMidPlus = evaluate(mid + h);
        const dyMid = (yMidPlus - yMid) / h;

        const yA = evaluate(a);
        const yAPlus = evaluate(a + h);
        const dyA = (yAPlus - yA) / h;

        if (dyA * dyMid < 0) {
          b = mid;
        } else {
          a = mid;
        }
      }

      const xExt = (a + b) / 2;
      const yExt = evaluate(xExt);

      if (Number.isFinite(yExt)) {
        extrema.push({ x: xExt, y: yExt });
      }
    }
  }

  return extrema;
}

// Compute inflection points for explicit functions
export function computeInflectionPoints(
  expr: string,
  variable: string,
  domain: [number, number],
  registry: Record<string, { arity: number; fn: (...args: number[]) => number }>
): Vec2[] {
  const inflections: Vec2[] = [];
  const [xMin, xMax] = domain;
  const h = 1e-4; // small step for numerical second derivative

  // Create function evaluator
  const evaluate = (x: number): number => {
    try {
      return evaluateWithRegistry(expr, { [variable]: x }, registry);
    } catch {
      return NaN;
    }
  };

  // Sample function and look for sign changes in second derivative
  const samples = 200;
  const dx = (xMax - xMin) / samples;

  for (let i = 2; i < samples - 2; i++) {
    const x0 = xMin + (i - 2) * dx;
    const x1 = xMin + (i - 1) * dx;
    const x2 = xMin + i * dx;
    const x3 = xMin + (i + 1) * dx;
    const x4 = xMin + (i + 2) * dx;

    const y0 = evaluate(x0);
    const y1 = evaluate(x1);
    const y2 = evaluate(x2);
    const y3 = evaluate(x3);
    const y4 = evaluate(x4);

    if (!Number.isFinite(y0) || !Number.isFinite(y1) || !Number.isFinite(y2) ||
      !Number.isFinite(y3) || !Number.isFinite(y4)) continue;

    // Numerical second derivative using central differences
    const d2y1 = (y0 - 2 * y1 + y2) / (dx * dx);
    const d2y2 = (y2 - 2 * y3 + y4) / (dx * dx);

    // Sign change indicates inflection point
    if (d2y1 * d2y2 < 0) {
      // Refine using bisection
      let a = x1, b = x3;
      for (let iter = 0; iter < 15; iter++) {
        const mid = (a + b) / 2;
        const yMinus = evaluate(mid - h);
        const yMid = evaluate(mid);
        const yPlus = evaluate(mid + h);
        const d2yMid = (yMinus - 2 * yMid + yPlus) / (h * h);

        const yAMinus = evaluate(a - h);
        const yA = evaluate(a);
        const yAPlus = evaluate(a + h);
        const d2yA = (yAMinus - 2 * yA + yAPlus) / (h * h);

        if (d2yA * d2yMid < 0) {
          b = mid;
        } else {
          a = mid;
        }
      }

      const xInf = (a + b) / 2;
      const yInf = evaluate(xInf);

      if (Number.isFinite(yInf)) {
        inflections.push({ x: xInf, y: yInf });
      }
    }
  }

  return inflections;
}

// Project point onto X and Y axes
export function projectPointsToAxes(points: Vec2[]): Vec2[] {
  const projections: Vec2[] = [];

  for (const pt of points) {
    // Project to X-axis (y = 0)
    projections.push({ x: pt.x, y: 0 });
    // Project to Y-axis (x = 0)
    projections.push({ x: 0, y: pt.y });
  }

  return projections;
}

// Heuristic: check if explicit function is linear in x over its domain
export function isExplicitLinear(
  expr: string,
  variable: string,
  domain: [number, number],
  registry: Record<string, { arity: number; fn: (...args: number[]) => number }>
): boolean {
  const [xMin, xMax] = domain;
  if (!(xMax > xMin)) return false;
  const evaluate = (x: number): number => {
    try {
      return evaluateWithRegistry(expr, { [variable]: x }, registry as any);
    } catch {
      return NaN;
    }
  };
  const N = 8; // small number of probes across domain
  let prevSlope: number | null = null;
  for (let i = 0; i < N - 2; i++) {
    const x0 = xMin + ((xMax - xMin) * i) / (N - 1);
    const x1 = xMin + ((xMax - xMin) * (i + 1)) / (N - 1);
    const x2 = xMin + ((xMax - xMin) * (i + 2)) / (N - 1);
    const y0 = evaluate(x0);
    const y1 = evaluate(x1);
    const y2 = evaluate(x2);
    if (!isFinite(y0) || !isFinite(y1) || !isFinite(y2)) continue;
    const dx1 = x1 - x0;
    const dx2 = x2 - x1;
    if (Math.abs(dx1) < 1e-9 || Math.abs(dx2) < 1e-9) continue;
    const s1 = (y1 - y0) / dx1;
    const s2 = (y2 - y1) / dx2;
    // Second difference near zero for linear
    const d2 = s2 - s1;
    if (Math.abs(d2) > 1e-6) return false;
    if (prevSlope == null) prevSlope = s1;
    else if (Math.abs(s1 - prevSlope) > 1e-5) return false;
  }
  return true;
}

