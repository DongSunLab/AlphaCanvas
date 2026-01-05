import { describe, it, expect } from 'vitest';
import { renderMathToHtml } from '../MathLabels';

describe('rm prefix roman labels', () => {
  it('renders rmO as condensed (95%) SVG', () => {
    const html = renderMathToHtml('rmO', 18);
    // rm 라벨은 NotoSerifKR(또는 fallback)로 렌더되며 가로만 압축
    expect(html).toContain('<svg');
    expect(html).toContain('preserveAspectRatio="none"');
    expect(html.includes('<path') || html.includes('Noto Serif KR')).toBe(true);
  });

  it('renders rmABC as condensed (95%) SVG', () => {
    const html = renderMathToHtml('rmABC', 20);
    expect(html).toContain('<svg');
    expect(html).toContain('preserveAspectRatio="none"');
    expect(html.includes('<path') || html.includes('Noto Serif KR')).toBe(true);
  });

  it('does not apply rm handling when no prefix', () => {
    const html = renderMathToHtml('x', 18);
    // MathJax SVG wrapper is expected, but rm-only attributes must not appear
    expect(html).toContain('<svg');
    expect(html).not.toContain('preserveAspectRatio="none"');
  });
});

describe('MathJax label rendering robustness (blanks/placeholders)', () => {
  it('does not throw on empty integral bounds', () => {
    // While editing, users often leave bounds empty temporarily.
    // This used to cause MathJax parse errors in some intermediate forms.
    expect(() => renderMathToHtml('\\int_{}^{} x\\,dx', 18)).not.toThrow();
    const html = renderMathToHtml('\\int_{}^{} x\\,dx', 18);
    expect(html).toContain('<svg');
  });

  it('does not throw on MathLive placeholder tokens', () => {
    // MathLive can emit placeholder tokens for blanks (integral bounds, etc).
    // We sanitize them to invisible tokens for MathJax.
    expect(() => renderMathToHtml('\\int_{\\placeholder{}}^{\\placeholder{}} x\\,dx', 18)).not.toThrow();
    const html = renderMathToHtml('\\int_{\\placeholder{}}^{\\placeholder{}} x\\,dx', 18);
    expect(html).toContain('<svg');
  });
});

