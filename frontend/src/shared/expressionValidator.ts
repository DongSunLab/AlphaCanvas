/**
 * Expression completeness gate - single source of truth for whether an expression is ready to evaluate
 */

export interface ValidationResult {
  isComplete: boolean;
  reason?: string;
}

/**
 * Check if a LaTeX expression is complete and safe to evaluate/render
 * Returns true only if expression is fully formed with balanced syntax
 */
export function isExpressionComplete(latex: string): ValidationResult {
  if (!latex || !latex.trim()) {
    return { isComplete: false, reason: 'empty' };
  }

  const trimmed = latex.trim();
  const compact = trimmed.replace(/\s+/g, '');
  
  // DEBUG: Log what we're checking
  console.log('🔍 Validation check:', { latex, trimmed, compact });

  // 1. Check balanced parentheses and braces
  const openPar = (compact.match(/\(|\\left\(/g) || []).length;
  const closePar = (compact.match(/\)|\\right\)/g) || []).length;
  const openBrace = (compact.match(/\{/g) || []).length;
  const closeBrace = (compact.match(/\}/g) || []).length;
  const openBracket = (compact.match(/\[|\\left\[/g) || []).length;
  const closeBracket = (compact.match(/\]|\\right\]/g) || []).length;

  if (openPar !== closePar) {
    return { isComplete: false, reason: 'unbalanced_parens' };
  }
  if (openBrace !== closeBrace) {
    return { isComplete: false, reason: 'unbalanced_braces' };
  }
  if (openBracket !== closeBracket) {
    return { isComplete: false, reason: 'unbalanced_brackets' };
  }

  // 2. Check for trailing operators (CRITICAL - blocks y^2=, x+, etc)
  if (/[+\-*/^=]$/.test(compact)) {
    console.log('🚫 Blocked by trailing operator:', compact[compact.length - 1]);
    return { isComplete: false, reason: 'trailing_operator' };
  }
  
  // 2.5. Comprehensive equation checks
  if (compact.includes('=')) {
    // Must have exactly one = sign
    if ((compact.match(/=/g) || []).length !== 1) {
      return { isComplete: false, reason: 'multiple_equals' };
    }
    const parts = compact.split('=');
    // Both sides must be non-empty after trimming
    if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
      return { isComplete: false, reason: 'incomplete_equation' };
    }
    // Neither side can be just whitespace/operators
    if (!/[a-zA-Z0-9)]/.test(parts[0]) || !/[a-zA-Z0-9)]/.test(parts[1])) {
      return { isComplete: false, reason: 'invalid_equation_sides' };
    }
  }

  // 3. Check for leading operators (except minus for negation)
  if (/^[+*/^=]/.test(compact)) {
    return { isComplete: false, reason: 'leading_operator' };
  }

  // 4. Check for incomplete LaTeX commands (\sin without argument, \frac without braces, etc)
  if (/\\[a-z]+$/.test(trimmed) && !/\\(pi|e)$/.test(trimmed)) {
    return { isComplete: false, reason: 'incomplete_latex_command' };
  }

  // 5. Check for incomplete fractions
  if (/\\frac\{[^}]*$/.test(latex) || /\\frac[^{]*$/.test(latex)) {
    return { isComplete: false, reason: 'incomplete_fraction' };
  }
  if (/\\frac\{[^}]+\}[^{]*$/.test(latex) && !/\\frac\{[^}]+\}\{[^}]+\}/.test(latex)) {
    return { isComplete: false, reason: 'incomplete_fraction_denominator' };
  }

  // 6. Check for empty parentheses/braces (incomplete input)
  if (/\(\s*\)|\{\s*\}|\[\s*\]/.test(compact)) {
    return { isComplete: false, reason: 'empty_delimiters' };
  }

  // 7. Check for incomplete function calls (ending with open paren)
  if (/[a-zA-Z_][a-zA-Z0-9_]*\($/.test(compact)) {
    return { isComplete: false, reason: 'incomplete_function_call' };
  }

  // 8. Check last token is valid (number, variable, closing delimiter)
  const lastChar = compact[compact.length - 1];
  if (!/[0-9a-zA-Z)\]}]/.test(lastChar) && lastChar !== '\\') {
    return { isComplete: false, reason: 'invalid_last_token' };
  }

  // 9. Single character variables/operators are incomplete
  if (/^[a-zA-Z+\-*/^=]$/.test(compact)) {
    return { isComplete: false, reason: 'single_char' };
  }

  // Expression passed all checks
  return { isComplete: true };
}

