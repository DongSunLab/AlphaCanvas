export type ParsedInput =
  | { kind: 'explicit'; symbol?: string; variable: string; expr: string; label: string }
  | { kind: 'implicit'; symbol?: string; variables: [string, string]; expr: string; label: string };

// Result of translation pattern: function ± point or point ± function
export type ParsedTranslation =
  | { kind: 'explicit-translate'; expr: string; dx: number; dy: number; label: string }
  | { kind: 'implicit-translate'; expr: string; dx: number; dy: number; label: string };

// Map arbitrary arg names to canonical x,y
function mapArgsToXY(expr: string, arg1: string, arg2?: string): string {
  let out = expr;
  const a1 = arg1 || 'x';
  const a2 = arg2 || 'y';
  if (a2) {
    // replace whole-word occurrences
    out = out.replace(new RegExp(`\\b${a2}\\b`, 'g'), 'y');
  }
  if (a1) {
    out = out.replace(new RegExp(`\\b${a1}\\b`, 'g'), 'x');
  }
  return out;
}

// Normalize equation to lhs - rhs form for implicit zero-level definitions
function normalizeEquationToZero(expr: string): string {
  const eqIdx = expr.indexOf('=');
  if (eqIdx === -1) return expr;
  const lhs = expr.slice(0, eqIdx).trim();
  const rhs = expr.slice(eqIdx + 1).trim();
  return `(${lhs}) - (${rhs})`;
}

export function parseFunctionInput(latexNormalized: string): ParsedInput | null {
  const s = latexNormalized.trim();
  // Pattern: f(x) = ..., f(x): ..., f(x); ...
  const named1 = s.match(/^([a-zA-Z][a-zA-Z0-9_]*)\s*\(\s*([a-zA-Z])\s*\)\s*(?:[:;=])\s*(.+)$/);
  if (named1) {
    const [, sym, arg1, rhs] = named1;
    // If RHS is an equation y=..., prefer explicit by extracting RHS expr if it's y=...
    const rhsEq = rhs.includes('=') ? normalizeEquationToZero(rhs) : rhs;
    // Treat as explicit function of x if it doesn't contain y variable after mapping
    const mapped = mapArgsToXY(rhsEq, arg1);
    if (!/\by\b/.test(mapped)) {
      return { kind: 'explicit', symbol: sym, variable: 'x', expr: mapped, label: s };
    }
    // If y still present, treat as implicit zero-level set
    return { kind: 'implicit', symbol: sym, variables: ['x', 'y'], expr: mapped, label: s };
  }

  // Pattern: f(x,y) = ..., f(x,y): ..., f(x,y); ...
  const named2 = s.match(/^([a-zA-Z][a-zA-Z0-9_]*)\s*\(\s*([a-zA-Z])\s*,\s*([a-zA-Z])\s*\)\s*(?:[:;=])\s*(.+)$/);
  if (named2) {
    const [, sym, a1, a2, rhs] = named2;
    const rhsEq = rhs.includes('=') ? normalizeEquationToZero(rhs) : rhs;
    const mapped = mapArgsToXY(rhsEq, a1, a2);
    return { kind: 'implicit', symbol: sym, variables: ['x', 'y'], expr: mapped, label: s };
  }

  return null;
}

// NOTE: parsePointInput(간단 파서)은 과거에 Function 기반 평가를 사용해 보안상 제거되었습니다.
// 점 입력은 parsePointInputAdvanced + (latexConverter, evaluator)를 사용하세요.

// Advanced point parser that can handle function calls like (1, f(3))
export function parsePointInputAdvanced(
  latex: string,
  latexConverter: (latex: string) => string,
  evaluator: (expr: string) => number
): { x: number; y: number } | null {
  if (!latex) return null;
  let s = String(latex);
  s = s.replace(/\s+/g, '');
  s = s.replace(/\\left|\\right/g, '');
  // Normalize paren macros
  s = s.replace(/\\lparen/g, '(').replace(/\\rparen/g, ')');
  // Ensure outer parentheses optional; extract inner content
  if (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1);
  // Find top-level comma (not inside braces/parentheses)
  let depthPar = 0, depthBrace = 0, commaIdx = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depthPar++;
    else if (ch === ')') depthPar = Math.max(0, depthPar - 1);
    else if (ch === '{') depthBrace++;
    else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);
    else if (ch === ',' && depthPar === 0 && depthBrace === 0) { commaIdx = i; break; }
  }
  if (commaIdx === -1) return null;
  const sx = s.slice(0, commaIdx);
  const sy = s.slice(commaIdx + 1);
  
  try {
    // Use the provided converter and evaluator
    const ex = latexConverter(sx);
    const ey = latexConverter(sy);
    const x = evaluator(ex);
    const y = evaluator(ey);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  } catch {
    return null;
  }
}

// Extract identifiers from already-normalized JS-like math string
export function extractIdentifiers(expr: string): string[] {
  if (!expr) return [];
  const tokens = expr.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) || [];
  return Array.from(new Set(tokens));
}

// Find identifiers that are not built-ins (x,y) or known math functions or defined function symbols
export function findUnknownIdentifiers(expr: string, definedFunctionSymbols: Set<string> = new Set()): string[] {
  const idents = extractIdentifiers(expr);
  const allowed = new Set<string>([
    'x', 'y',
    'Math', 'PI', 'E', // core
    // common math names produced by latexToJS mapping
    'sin', 'cos', 'tan', 'log', 'ln', 'exp', 'abs'
  ]);
  const unknown: string[] = [];
  for (const id of idents) {
    if (allowed.has(id)) continue;
    if (definedFunctionSymbols.has(id)) continue;
    // Ignore scientific notation like e in 1e-3 by checking context is tricky; assume fine as tokens above
    unknown.push(id);
  }
  return unknown;
}


// --- Translation pattern parser ---
// Supports: f(x) ± (a,b), (a,b) ± f(x)  -> explicit translate
//           g(x,y) ± (a,b), (a,b) ± g(x,y) or equation with x,y -> implicit translate
// Behavior:
//  - explicit y = f(x) moved by (+dx,+dy): y = f(x - dx) + dy
//  - implicit g(x,y)=0 moved by (+dx,+dy): g(x - dx, y - dy) = 0  (we store as zero-level expr)
// Robustness:
//  - Ignores whitespace and \left/\right, supports ± as + or -
//  - Validates point tuple, rejects empty parens or invalid numbers
//  - Returns null if not a translation pattern
export function parseFunctionPointTranslation(
  latex: string,
  latexToJS: (latex: string) => string,
  evaluator: (expr: string) => number
): ParsedTranslation | null {
  if (!latex) return null;
  let s = String(latex).trim();
  if (!s) return null;
  // Normalize spaces and remove \left/\right
  s = s.replace(/\s+/g, '');
  s = s.replace(/\\left|\\right/g, '');
  // Normalize paren macros
  s = s.replace(/\\lparen/g, '(').replace(/\\rparen/g, ')');

  // Quick reject for empty parens or unbalanced parens
  if (/\(\)/.test(s)) return null;
  const openCount = (s.match(/\(/g) || []).length;
  const closeCount = (s.match(/\)/g) || []).length;
  if (openCount !== closeCount) return null;
  // Quick reject: no comma means not a point tuple anywhere
  if (s.indexOf(',') === -1) return null;

  // Accept patterns with a single top-level + or - between function term and point term
  // We'll parse both orders: func ± (a,b)  OR  (a,b) ± func
  // First, define helpers
  const tryParsePoint = (pt: string): { dx: number; dy: number } | null => {
    if (!pt.startsWith('(') || !pt.endsWith(')')) return null;
    const inner = pt.slice(1, -1);
    // Find top-level comma
    let depthPar = 0, depthBrace = 0, commaIdx = -1;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === '(') depthPar++;
      else if (ch === ')') depthPar = Math.max(0, depthPar - 1);
      else if (ch === '{') depthBrace++;
      else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);
      else if (ch === ',' && depthPar === 0 && depthBrace === 0) { commaIdx = i; break; }
    }
    if (commaIdx === -1) return null;
    const sx = inner.slice(0, commaIdx);
    const sy = inner.slice(commaIdx + 1);
    if (!sx || !sy) return null;
    try {
      const ex = latexToJS(sx);
      const ey = latexToJS(sy);
      // Quick reject for incomplete expressions (unbalanced parens inside)
      if ((ex.match(/\(/g) || []).length !== (ex.match(/\)/g) || []).length) return null;
      if ((ey.match(/\(/g) || []).length !== (ey.match(/\)/g) || []).length) return null;
      const dx = evaluator(ex);
      const dy = evaluator(ey);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
      return { dx: Number(dx), dy: Number(dy) };
    } catch {
      return null;
    }
  };

  const normalizeFuncTerm = (term: string): { type: 'explicit' | 'implicit'; expr: string } | null => {
    // Convert LaTeX-ish to JS-like for detection
    const js = latexToJS(term);
    if (!js) return null;
    // Reject bare symbols without x, y, or function calls (e.g. 'f' alone is not a valid function expression)
    const hasX = /\bx\b/.test(js);
    const hasY = /\by\b/.test(js);
    const hasFunctionCall = /[a-zA-Z_][a-zA-Z0-9_]*\s*\(/.test(js);
    const hasEq = js.includes('=');
    if (!hasX && !hasY && !hasFunctionCall && !hasEq) {
      // Bare symbol or constant without variables/calls: not a valid function expression
      return null;
    }
    if (hasEq || (hasX && hasY)) {
      // normalize to zero-level set if equation present
      const expr = hasEq ? normalizeEquationToZero(js) : js;
      return { type: 'implicit', expr };
    }
    // explicit function of one variable (assume variable is x)
    return { type: 'explicit', expr: js };
  };

  // Find the top-level +/- between two terms
  const findTopLevelOp = (text: string): { left: string; right: string; op: '+' | '-' } | null => {
    let depthPar = 0, depthBrace = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '(') depthPar++;
      else if (ch === ')') depthPar = Math.max(0, depthPar - 1);
      else if (ch === '{') depthBrace++;
      else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);
      else if (depthPar === 0 && depthBrace === 0 && (ch === '+' || ch === '-')) {
        const left = text.slice(0, i);
        const right = text.slice(i + 1);
        if (!left || !right) return null;
        return { left, right, op: ch as '+' | '-' };
      }
    }
    return null;
  };

  const split = findTopLevelOp(s);
  if (!split) return null;
  const { left, right, op } = split;

  // Two orderings to support
  // Case A: functionTerm ± (a,b)
  const ptRight = tryParsePoint(right);
  if (ptRight) {
    const funcA = normalizeFuncTerm(left);
    if (!funcA) return null;
    const sign = op === '+' ? 1 : -1;
    const dx = sign * ptRight.dx;
    const dy = sign * ptRight.dy;
    if (funcA.type === 'explicit') {
      return { kind: 'explicit-translate', expr: funcA.expr, dx, dy, label: latex };
    } else {
      return { kind: 'implicit-translate', expr: funcA.expr, dx, dy, label: latex };
    }
  }

  // Case B: (a,b) ± functionTerm
  const ptLeft = tryParsePoint(left);
  if (ptLeft) {
    const funcB = normalizeFuncTerm(right);
    if (!funcB) return null;
    // (a,b) + f  == f + (a,b)
    // (a,b) - f  == -(f - (a,b)) but for translation we interpret as f shifted by (-a,-b)?
    // By user's request, treat (a,b) - f the same as f - (a,b): shift by (-a,-b)
    const sign = op === '+' ? 1 : -1;
    const dx = sign * ptLeft.dx;
    const dy = sign * ptLeft.dy;
    if (funcB.type === 'explicit') {
      return { kind: 'explicit-translate', expr: funcB.expr, dx, dy, label: latex };
    } else {
      return { kind: 'implicit-translate', expr: funcB.expr, dx, dy, label: latex };
    }
  }

  return null;
}



