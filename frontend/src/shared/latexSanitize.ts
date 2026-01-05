/**
 * MathLive -> MathJax compatibility helpers for labels (math-text).
 *
 * Problem:
 * - While editing, MathLive can emit placeholder tokens or empty groups for blanks
 *   (e.g., integral bounds). MathJax may throw on some of these intermediate forms.
 *
 * Strategy:
 * - Normalize common MathLive-only constructs into MathJax-safe TeX.
 * - Replace truly-empty sub/superscript/placeholder content with an *invisible* token
 *   so the user can leave blanks empty without MathJax throwing.
 */
export function sanitizeLatexForMathJax(raw: string): string {
  let s = String(raw ?? '');

  // Normalize whitespace (keep it mostly as-is; MathJax ignores multiple spaces in math mode)
  // but trim outer whitespace for consistency.
  s = s.trim();

  if (!s) return s;

  // 0) Strip invisible/control characters that MathLive may emit while editing.
  // These can cause MathJax parse errors even though they are not visible to the user.
  // - NBSP: \u00A0
  // - Zero-width: \u200B..\u200D, BOM: \uFEFF
  // - Invisible operators: \u2061..\u2064
  //   * U+2061: Function Application (함수와 괄호 사이 간격의 주요 원인)
  //   * U+2062: Invisible Times
  //   * U+2063: Invisible Separator
  //   * U+2064: Invisible Plus
  s = s
    .replace(/\u00A0/g, ' ')
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
    .replace(/[\u2061\u2062\u2063\u2064]/g, '')
    // MathLive may also emit these as named entities or in other encodings
    .replace(/&#x206[1-4];/gi, '')
    .replace(/&#824[1-4];/g, '');

  // A zero-width, invisible token that is safe inside groups (including subscripts/superscripts).
  // Using a command rather than an empty group avoids some MathJax parse errors on intermediate input.
  const INVISIBLE = '\\kern0pt';

  // 0.5) Remove known MathLive-only cursor token if present.
  // (MathJax does not understand it; it can appear transiently during editing.)
  s = s.replace(/\\cursor\b/g, '');

  // 0.6) MathLive differential symbol macro -> MathJax-safe TeX
  // MathLive may output "\differentialD x" for dx; MathJax (base/ams) doesn't define it.
  // Render as italic d (default math italics).
  s = s.replace(/\\differentialD\b/g, 'd');

  // 0.7) Normalize deprecated \rm font switch into a *scoped* \mathrm{...}
  // so it doesn't "leak" into following tokens (e.g., exponents/digits).
  // Examples:
  // - "\rm x^2"        -> "\mathrm{x}^2"
  // - "{\rm ABC}^2"    -> "{\mathrm{ABC}}^2"
  // - "\rm\,x"         -> "\,\mathrm{x}"
  s = normalizeRmSwitchToMathrm(s);

  // 1) Remove MathLive placeholder commands if present.
  // MathLive commonly uses \placeholder{...} (or empty).
  // Convert empty placeholder to an invisible token so it still "exists" syntactically.
  s = s.replace(/\\placeholder\s*\{([\s\S]*?)\}/g, (_m, inner) => {
    const content = String(inner ?? '').trim();
    return content ? content : INVISIBLE;
  });
  // If some variants appear without braces (rare), drop them to an invisible token.
  s = s.replace(/\\placeholder\b/g, INVISIBLE);

  // 2) MathLive sometimes uses \class{...}{...} for UI-ish markup.
  // If the class indicates placeholder-like content, keep inner content; otherwise keep as-is.
  // We only strip the wrapper for known placeholder-ish classes to be safe.
  s = s.replace(/\\class\s*\{\s*([^}]+)\s*\}\s*\{([\s\S]*?)\}/g, (_m, cls, inner) => {
    const klass = String(cls ?? '');
    const content = String(inner ?? '');
    if (/placeholder/i.test(klass) || /ML__/.test(klass)) return content || INVISIBLE;
    return `\\class{${klass}}{${content}}`;
  });

  // 3) Replace empty subscript/superscript groups.
  // TeX allows some empties but MathJax can be picky depending on the token stream.
  // Keep them visually empty by inserting an invisible token.
  // Handle: _{}  ^{}  _{   }  ^{   }
  s = s.replace(/_\{\s*\}/g, `_{${INVISIBLE}}`);
  s = s.replace(/\^\{\s*\}/g, `^{${INVISIBLE}}`);

  // Also handle shorthand: _\{\} or ^\{\} after other sanitizers (defensive).
  s = s.replace(/_\\\{\s*\\\}/g, `_{${INVISIBLE}}`);
  s = s.replace(/\^\\\{\s*\\\}/g, `^{${INVISIBLE}}`);

  // Normalize runs of whitespace to a single space (keeps output stable, doesn't affect math layout much).
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}


function normalizeRmSwitchToMathrm(input: string): string {
  const isLetter = (ch: string) => /[A-Za-z]/.test(ch);
  const isWhitespace = (ch: string) => /\s/.test(ch);

  const readCommand = (s: string, start: number): { token: string; next: number } => {
    // start points at "\"
    let i = start + 1;
    if (i >= s.length) return { token: '\\', next: start + 1 };

    if (isLetter(s[i])) {
      while (i < s.length && isLetter(s[i])) i++;
      return { token: s.slice(start, i), next: i };
    }

    // Control symbol: backslash + single char (e.g., \, \; \! \{)
    return { token: s.slice(start, Math.min(start + 2, s.length)), next: Math.min(start + 2, s.length) };
  };

  const readBalancedGroup = (s: string, start: number): { group: string | null; next: number } => {
    if (s[start] !== '{') return { group: null, next: start };
    let depth = 0;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      const prev = i > 0 ? s[i - 1] : '';
      const escaped = prev === '\\';
      if (!escaped && ch === '{') depth++;
      if (!escaped && ch === '}') depth--;
      if (depth === 0) return { group: s.slice(start, i + 1), next: i + 1 };
    }
    // Unbalanced; don't touch.
    return { group: null, next: start };
  };

  const isSpacingCommand = (cmd: string) =>
    cmd === '\\,' ||
    cmd === '\\;' ||
    cmd === '\\:' ||
    cmd === '\\!' ||
    cmd === '\\quad' ||
    cmd === '\\qquad' ||
    cmd === '\\ ' ||
    cmd === '\\\n';

  let out = '';
  for (let i = 0; i < input.length; ) {
    if (input[i] === '\\' && input.startsWith('\\rm', i) && !isLetter(input[i + 3] ?? '')) {
      // Consume "\rm"
      let j = i + 3;

      // Keep any immediate whitespace/spacing tokens after \rm, but do NOT include them in \mathrm{...}
      while (j < input.length) {
        while (j < input.length && isWhitespace(input[j])) j++;
        if (j < input.length && input[j] === '\\') {
          const { token, next } = readCommand(input, j);
          if (isSpacingCommand(token)) {
            out += token;
            j = next;
            continue;
          }
        }
        break;
      }

      if (j >= input.length) {
        i = j;
        continue;
      }

      // Case 1: Next token is a braced group: \rm{...} or \rm {...}
      if (input[j] === '{') {
        const { group, next } = readBalancedGroup(input, j);
        if (group) {
          out += `\\mathrm${group}`;
          i = next;
          continue;
        }
      }

      // Case 2: Next token is a command: \rm \alpha  -> \mathrm{\alpha}
      if (input[j] === '\\') {
        const { token, next } = readCommand(input, j);
        out += `\\mathrm{${token}}`;
        i = next;
        continue;
      }

      // Case 3: Next token is a run of ASCII letters: \rm ABC -> \mathrm{ABC}
      if (isLetter(input[j])) {
        let k = j + 1;
        while (k < input.length && isLetter(input[k])) k++;
        const token = input.slice(j, k);
        out += `\\mathrm{${token}}`;
        i = k;
        continue;
      }

      // Otherwise: drop \rm (avoid leaking), keep parsing from j.
      i = j;
      continue;
    }

    out += input[i];
    i++;
  }

  return out;
}

