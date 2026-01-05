/**
 * LaTeX-ish(MathLive) 수식 문자열을 JS 평가용 표현식으로 변환합니다.
 *
 * 주의:
 * - 이 함수는 "완전한 TeX 파서"가 아니라, 앱에서 자주 쓰는 입력 패턴을
 *   안전하게 평가하기 위한 휴리스틱 변환기입니다.
 * - 특히 그룹핑 중괄호 `{...}`는 의미가 있으므로, 삭제하지 않고 `(...)`로 보존합니다.
 *   (예: 2^{x+3} → 2**(x+3))
 */
export function latexToJS(latex: string, opts?: { debug?: boolean }): string {
  const debug = !!opts?.debug;
  let s = latex;

  const log = (...args: any[]) => {
    if (debug) console.log(...args);
  };

  log('🔵 입력 LaTeX:', latex);

  // Handle leading minus sign: -x^2 -> (0-x)**2
  if (s.startsWith('-')) {
    s = '(0' + s + ')';
  }

  // Step 1: Protect constants FIRST
  s = s.replace(/\\pi/g, '___PI___');
  s = s.replace(/\\e\b/g, '___E___');

  // Step 1.5: Handle implicit multiplication before \log (e.g., 2\log -> 2*\log)
  s = s.replace(/(\d)\\log/g, '$1*\\log');

  // Step 2: Remove \left and \right BEFORE processing log functions
  s = s.replace(/\\left/g, '');
  s = s.replace(/\\right/g, '');

  // Step 2.5: Normalize MathLive prime notation for derivatives
  // MathLive often emits: f^{\prime}\left(x\right) or f^{\prime\prime}(x)
  // We want: f'(x) or f''(x) so evaluateWithRegistry can map it to DF("f")(x)
  // NOTE: This must happen BEFORE we convert '^' to '**'.
  s = s
    // double prime first
    .replace(/\^\{\s*\\prime\s*\\prime\s*\}/g, "''")
    .replace(/\^\\prime\\prime\b/g, "''")
    // single prime
    .replace(/\^\{\s*\\prime\s*\}/g, "'")
    .replace(/\^\\prime\b/g, "'");

  // Step 3: Handle log with base: \log_3x -> (Math.log(x)/Math.log(3))
  // Now we can match simple parentheses since \left and \right are removed
  s = s.replace(/\\log_(\d+)\(([^)]+)\)/g, '(Math.log($2)/Math.log($1))');
  s = s.replace(/\\log_(\d+)([a-zA-Z])/g, '(Math.log($2)/Math.log($1))');
  // Also handle space: \log_3 x
  s = s.replace(/\\log_(\d+)\s+/g, '(Math.log(___LOGARG___)/Math.log($1))___LOGARG___');

  // Step 4: Handle fractions and sqrt
  // Handle \frac{...}{...} (with braces)
  s = s.replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '(($1)/($2))');
  // Handle \frac12 (without braces - single digit/char only)
  s = s.replace(/\\frac(\d)(\d)/g, '(($1)/($2))');
  s = s.replace(/\\frac([a-zA-Z])([a-zA-Z])/g, '(($1)/($2))');
  s = s.replace(/\\sqrt\{([^}]+)\}/g, 'Math.sqrt($1)');

  // Step 4.5: Handle implicit multiplication right after fractions (catches )x and )y early)
  // This ensures \frac{1}{2}x becomes ((1)/(2))*x correctly
  // Only process x,y to avoid breaking function calls like f(x)g where g is a function
  s = s.replace(/\)([xy])\b/g, ')*$1');
  s = s.replace(/\)\(/g, ')*(');

  // Step 5: Handle \ln (natural log) - ALL FORMS
  s = s.replace(/\\ln\{([^}]+)\}/g, 'Math.log($1)');
  s = s.replace(/\\ln\(([^)]+)\)/g, 'Math.log($1)');
  s = s.replace(/\\ln\s+([a-zA-Z])/g, 'Math.log($1)'); // \ln x
  s = s.replace(/\\ln([a-zA-Z])/g, 'Math.log($1)'); // \lnx

  // Step 5.5: Handle absolute value notation |...| from LaTeX
  // Convert \left| ... \right| to Math.abs(...)
  s = s.replace(/\\left\|([^|]+)\\right\|/g, 'Math.abs($1)');
  // Handle simple |...| (without \left \right)
  s = s.replace(/\|([^|]+)\|/g, 'Math.abs($1)');

  // Step 6: Handle trig/log/exp functions - ALL FORMS
  // \sin{...}
  s = s.replace(/\\(sin|cos|tan|log|exp|abs)\{([^}]+)\}/g, 'Math.$1($2)');
  // \sin(...)
  s = s.replace(/\\(sin|cos|tan|log|exp|abs)\(([^)]*)\)/g, 'Math.$1($2)');
  // \sin\pi x -> Math.sin(Math.PI*x) [NO space between \pi and x]
  s = s.replace(/\\(sin|cos|tan|log|exp|abs)(___PI___|___E___)([a-zA-Z])/g, 'Math.$1($2*$3)');
  // \sin\pi x -> Math.sin(Math.PI*x) [WITH space: \sin\pi x]
  s = s.replace(/\\(sin|cos|tan|log|exp|abs)(___PI___|___E___)\s+([a-zA-Z])/g, 'Math.$1($2*$3)');
  // \sin2x -> Math.sin(2*x)
  s = s.replace(/\\(sin|cos|tan|log|exp|abs)(\d+)([a-zA-Z])/g, 'Math.$1($2*$3)');
  // \sin 2x or \sin x (with space)
  s = s.replace(/\\(sin|cos|tan|log|exp|abs)\s+(\d+)([a-zA-Z])/g, 'Math.$1($2*$3)');
  s = s.replace(/\\(sin|cos|tan|log|exp|abs)\s+([a-zA-Z])/g, 'Math.$1($2)');
  // \sinx (no space, no number)
  s = s.replace(/\\(sin|cos|tan|log|exp|abs)([a-zA-Z])/g, 'Math.$1($2)');

  // Step 7: 남아있는 중괄호는 제거하지 말고 그룹핑을 보존하도록 괄호로 변환
  // (예: 2^{x+3} → 2^(x+3) → 2**(x+3))
  s = s.replace(/\{/g, '(').replace(/\}/g, ')');
  s = s.replace(/\\cdot/g, '*');

  // Step 8: Restore constants
  s = s.replace(/___PI___/g, 'Math.PI');
  s = s.replace(/___E___/g, 'Math.E');
  s = s.replace(/___LOGARG___/g, '');

  // Step 9: Handle plain 'pi' without backslash
  s = s.replace(/\bpi\b/g, 'Math.PI');

  // Step 10: Handle plain function names (no backslash): lnx, sinx, sin2x, sinpix
  // CRITICAL: Must handle multi-char patterns first
  s = s.replace(/\b(sin|cos|tan|ln|exp|abs)pi([a-zA-Z])/g, 'Math.$1(Math.PI*$2)'); // sinpix
  s = s.replace(/\b(sin|cos|tan|ln|exp|abs)(\d+)([a-zA-Z])/g, 'Math.$1($2*$3)'); // sin2x
  s = s.replace(/\b(sin|cos|tan|log|ln|exp|abs)([a-zA-Z])/g, 'Math.$1($2)'); // sinx, lnx

  // Step 11: Normalize derivative markers
  // Defensive: handle remaining patterns if any survived earlier normalization
  s = s.replace(/([a-zA-Z])\s*\^\{\s*\\prime\s*\}/g, "$1'");
  s = s.replace(/([a-zA-Z])\s*\^\\prime\b/g, "$1'");
  s = s.replace(/([a-zA-Z])′/g, "$1'");

  // Step 12: Convert exponentiation ^ to **
  s = s.replace(/\^/g, '**');

  log('🟡 지수 변환 후:', s);

  // Step 12.5: Fix unary minus before exponentiation
  // JavaScript doesn't allow: -x**2, must be: -(x**2) or (-x)**2
  // We need to wrap the entire exponentiation chain after a minus
  // Two cases:
  // 1. At start or after non-** characters: (^|[^*])-base**exp...
  // 2. After **: **-base**exp...  (most common in nested exponents like 2^(-x^2))
  const fixUnaryMinusExponent = (str: string): string => {
    log('🔧 fixUnaryMinusExponent 입력:', str);
    let result = str;

    // Case 1: Match -base**exp... where - comes after ** (e.g., 2**-x**2)
    // We want to capture the entire chain: -x**2 → -(x**2)
    result = result.replace(/\*\*-([a-zA-Z_][a-zA-Z0-9_]*(?:\*\*[a-zA-Z0-9_().]+)*)/g, (match, expChain) => {
      log('🔧 케이스1 매칭됨:', match, '→', '**-(' + expChain + ')');
      return '**-(' + expChain + ')';
    });

    // Case 2: Match at start or after non-* character
    result = result.replace(/(^|[^*])-([a-zA-Z_][a-zA-Z0-9_]*(?:\*\*[a-zA-Z0-9_().]+)+)/g, (match, prefix, expChain) => {
      log('🔧 케이스2 매칭됨:', match, '→', prefix + '-(' + expChain + ')');
      return prefix + '-(' + expChain + ')';
    });

    log('🔧 fixUnaryMinusExponent 출력:', result);
    return result;
  };

  s = fixUnaryMinusExponent(s);

  log('🟢 최종 단항 마이너스 수정 후:', s);

  // Step 13: Implicit multiplication (x, y만 적용, 나머지는 함수로 간주)
  // Math.PI x -> Math.PI*x (x, y만)
  s = s.replace(/Math\.PI\s+([xy])\b/g, 'Math.PI*$1');
  s = s.replace(/Math\.E\s+([xy])\b/g, 'Math.E*$1');
  // 2Math.PI -> 2*Math.PI
  s = s.replace(/(\d)\s*Math\./g, '$1*Math.');
  // 2x -> 2*x, 2y -> 2*y (숫자 뒤 x, y만)
  s = s.replace(/(\d)\s*([xy])\b/g, '$1*$2');
  // x2 -> x*2, y3 -> y*3 (x, y 뒤 숫자만)
  s = s.replace(/\b([xy])(\d)/g, '$1*$2');

  // xy -> x*y, yx -> y*x (x, y끼리만)
  s = s.replace(/\b([xy])\s*([xy])\b/g, '$1*$2');

  // x( -> x*(, y( -> y*( (x, y만 암묵적 곱셈, 나머지 알파벳은 함수 호출)
  s = s.replace(/\b([xy])\s*\(/g, '$1*(');

  // )x -> )*x, )y -> )*y (x, y만)
  s = s.replace(/\)\s*([xy])\b/g, ')*$1');

  // )( -> )*( (괄호 사이 암묵적 곱셈)
  s = s.replace(/\)\s*\(/g, ')*(');

  // 2( -> 2*(
  s = s.replace(/(\d)\s*\(/g, '$1*(');

  // Step 14: Clean up unclosed function calls
  s = s.replace(/Math\.(sin|cos|tan|log|ln|exp|abs)\s+([a-zA-Z0-9])/g, 'Math.$1($2)');

  log('🟢 변환된 JS:', s);

  return s;
}


