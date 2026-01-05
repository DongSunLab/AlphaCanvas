import { useSceneStore } from '../state/store';
// import { formatFunctionLabel } from '../shared/labels';
import { mathjax } from 'mathjax-full/mjs/mathjax.js';
import { TeX } from 'mathjax-full/mjs/input/tex.js';
import { SVG } from 'mathjax-full/mjs/output/svg.js';
import { liteAdaptor } from 'mathjax-full/mjs/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/mjs/handlers/html.js';
import { useEffect } from 'react';
import * as opentype from 'opentype.js';
import { sanitizeLatexForMathJax } from '../shared/latexSanitize';

let mjDoc: any | null = null;
function ensureMathJaxDoc() {
  if (mjDoc) return mjDoc;
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const tex = new TeX({
    packages: ['base', 'ams', 'newcommand', 'noundefined', 'require', 'autoload', 'configmacros']
  });
  const svg = new SVG({
    fontCache: 'local',
    font: 'mathjax-modern'  // Latin Modern 계열
  });
  mjDoc = mathjax.document('', { InputJax: tex, OutputJax: svg });
  return mjDoc;
}

// Screen scaling so that on-screen visual size matches SVG export
// Math formulas: 1.1mm -> 1.8mm, rm labels: 1.54mm -> 2.28mm
const MATH_SCREEN_SCALE = (1.6 / 1.1) / 60; // 75배 축소
const RM_SCREEN_SCALE = 2.28 / 1.54; // ≈ 1.480519...
// rm 라벨 장평(가로폭) 95% (KoPub에는 적용하지 않음)
const RM_CONDENSE_X = 0.95;

// Load NotoSerifKR font using opentype.js for screen rendering (SVG path conversion) - for rm labels
let notoSerifKrFont: opentype.Font | null = null;
let notoSerifKrFontLoadAttempted = false;

async function loadNotoSerifKrFont(): Promise<opentype.Font | null> {
  if (notoSerifKrFont) return notoSerifKrFont;
  if (notoSerifKrFontLoadAttempted) return null;

  notoSerifKrFontLoadAttempted = true;

  try {
    const response = await fetch('/NotoSerifKR.woff');
    if (!response.ok) {
      console.warn('NotoSerifKR.woff not found for screen rendering');
      return null;
    }
    const buffer = await response.arrayBuffer();
    notoSerifKrFont = opentype.parse(buffer);
    console.log('✓ NotoSerifKR font loaded for screen SVG path conversion');
    return notoSerifKrFont;
  } catch (err) {
    console.warn('Failed to load NotoSerifKR.woff for screen rendering:', err);
    return null;
  }
}

// Load KoPub font for Korean text
let kopubFont: opentype.Font | null = null;
let kopubFontLoadAttempted = false;

async function loadKoPubFont(): Promise<opentype.Font | null> {
  if (kopubFont) return kopubFont;
  if (kopubFontLoadAttempted) return null;

  kopubFontLoadAttempted = true;

  try {
    const response = await fetch('/KoPubDotum-Medium.woff');
    if (!response.ok) {
      console.warn('KoPubDotum-Medium.woff not found for screen rendering');
      return null;
    }
    const buffer = await response.arrayBuffer();
    kopubFont = opentype.parse(buffer);
    console.log('✓ KoPub font loaded for Korean text screen rendering');
    return kopubFont;
  } catch (err) {
    console.warn('Failed to load KoPubDotum-Medium.woff for screen rendering:', err);
    return null;
  }
}

// Start loading fonts immediately
loadNotoSerifKrFont();
loadKoPubFont();

// 3.3.8과 동일한 간격 조정 (연산자 주변 간격 줄이기)
// 단, 지수(^{})와 첨자(_{}) 내부는 제외
function tightenOperators(tex: string): string {
  // 1. 지수/첨자 그룹을 임시 플레이스홀더로 교체 (보호)
  const protectedGroups: string[] = [];
  const protectGroup = (match: string) => {
    const idx = protectedGroups.length;
    protectedGroups.push(match);
    return `\x00PROTECTED${idx}\x00`;
  };

  // ^{...} 또는 _{...} 패턴 보호 (중첩 지원)
  let processed = tex;
  // 반복적으로 가장 안쪽 그룹부터 보호
  let prevLen = -1;
  while (processed.length !== prevLen) {
    prevLen = processed.length;
    processed = processed.replace(/([_^])\{([^{}]*)\}/g, (match) => protectGroup(match));
  }
  // 단일 문자 지수/첨자도 보호: ^x, _x (단, \가 아닌 경우)
  processed = processed.replace(/([_^])([A-Za-z0-9])/g, (match) => protectGroup(match));

  // 2. 연산자 간격 조정 (보호된 영역 제외)
  // binary: +, \times, \cdot → negative space 추가
  processed = processed
    .replace(/\+/g, '\\!+\\!')
    .replace(/\\times/g, '\\!\\times\\!')
    .replace(/\\cdot/g, '\\!\\cdot\\!');

  // - 기호 처리: 이항(binary)만 간격 조정, 단항(unary)은 원래 간격 유지
  // 이항: 숫자/문자 뒤에 오는 마이너스만 양쪽에 negative space
  processed = processed.replace(/([a-zA-Z0-9}])(-)/g, '$1\\!$2\\!');

  // relational: =, <, > → binary와 동일한 간격
  processed = processed
    .replace(/=/g, '\\!=\\!')
    .replace(/</g, '\\!<\\!')
    .replace(/>/g, '\\!>\\!');

  // 3. 보호된 그룹 복원
  let result = processed;
  for (let i = protectedGroups.length - 1; i >= 0; i--) {
    result = result.replace(`\x00PROTECTED${i}\x00`, protectedGroups[i]);
  }

  return result;
}

// Convert text to SVG path using opentype.js (for screen rendering)
function textToSvgPath(
  text: string,
  font: opentype.Font,
  fontSize: number,
  options?: { condenseX?: number; fallbackFontFamily?: string },
  fillColor: string = '#333'
): string {
  const condenseX = options?.condenseX ?? 1;
  const fallbackFontFamily = options?.fallbackFontFamily ?? 'serif';
  const escapeXmlText = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  try {
    const path = font.getPath(text, 0, 0, fontSize);
    const bbox = (path as any).getBoundingBox ? (path as any).getBoundingBox() : { x1: 0, y1: -fontSize, x2: fontSize * text.length, y2: 0 };
    const width = bbox.x2 - bbox.x1;
    const height = bbox.y2 - bbox.y1;
    const pathData = path.toPathData(2);

    if (!pathData || pathData === 'M0 0Z' || pathData.length === 0) {
      // Fallback: text element (apply condense via group scale)
      return `<svg style="display:inline-block;vertical-align:middle;" preserveAspectRatio="none"><g transform="scale(${condenseX} 1)"><text x="0" y="0" font-size="${fontSize}" fill="${fillColor}" font-family="${fallbackFontFamily}">${escapeXmlText(text)}</text></g></svg>`;
    }

    // Return inline SVG with path
    // 장평(condenseX)은 width만 줄이고 preserveAspectRatio="none"으로 가로만 압축한다.
    const width2 = width * condenseX;
    return `<svg width="${width2}px" height="${height}px" viewBox="${bbox.x1} ${bbox.y1} ${width} ${height}" preserveAspectRatio="none" style="display:inline-block;vertical-align:middle;overflow:visible;"><path d="${pathData}" fill="${fillColor}" stroke="none" /></svg>`;
  } catch (err) {
    console.error('Failed to convert text to path:', err);
    return `<svg style="display:inline-block;vertical-align:middle;" preserveAspectRatio="none"><g transform="scale(${condenseX} 1)"><text x="0" y="0" font-size="${fontSize}" fill="${fillColor}" font-family="${fallbackFontFamily}">${escapeXmlText(text)}</text></g></svg>`;
  }
}

export function renderMathToHtml(latex: string, fontSizePx: number, color?: string): string {
  const escapeHtml = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const escapeXmlText = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');

  // Avoid inheriting unexpected text color (e.g., dark UI overlays that set color:#fff).
  // MathJax SVG often uses `currentColor`, so we must force a deterministic label color.
  const sanitizeCssColor = (raw?: string) => {
    const s = String(raw ?? '').trim();
    if (!s) return '#333';
    // Hex: #RGB, #RGBA, #RRGGBB, #RRGGBBAA
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s)) return s;
    // rgb()/rgba() with optional spaces
    if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/.test(s)) return s;
    // hsl()/hsla() (rare but valid)
    if (/^hsla?\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/.test(s)) return s;
    // Named colors: allow simple CSS identifiers only
    if (/^[a-zA-Z]+$/.test(s)) return s;
    return '#333';
  };
  const safeColor = sanitizeCssColor(color);
  const safeColorAttr = escapeXmlText(safeColor);

  // Check if latex contains Korean characters (한글)
  const hasKorean = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/.test(latex);
  // Handle rm labels: rm[글자] 패턴을 모두 찾아서 해당 글자만 NotoSerifKR로, 나머지는 MathJax로
  // 예: rmArmBrmC → A,B,C 각각 NotoSerifKR
  // 예: rmA_1 → A는 NotoSerifKR, _1은 MathJax
  const hasRmPattern = /rm[A-Za-z]/.test(latex);

  if (hasRmPattern) {
    const fs = fontSizePx * RM_SCREEN_SCALE;
    const parts: Array<{ type: 'rm' | 'math'; content: string }> = [];

    // rm[글자] 패턴을 찾아서 분리
    let remaining = latex;
    while (remaining.length > 0) {
      const match = remaining.match(/^(.*?)(rm([A-Za-z]))(.*)/s);
      if (match) {
        const [, before, , rmChar, after] = match;
        // rm 앞부분 (MathJax로)
        if (before) {
          parts.push({ type: 'math', content: before });
        }
        // rm 글자 (NotoSerifKR로)
        parts.push({ type: 'rm', content: rmChar });
        remaining = after;
      } else {
        // 더 이상 rm 패턴 없음 - 나머지는 MathJax
        if (remaining) {
          parts.push({ type: 'math', content: remaining });
        }
        break;
      }
    }

    // 연속된 rm 파트들 병합 (rmArmB → "AB"를 하나의 rm 파트로)
    const mergedParts: Array<{ type: 'rm' | 'math'; content: string }> = [];
    for (const part of parts) {
      const last = mergedParts[mergedParts.length - 1];
      if (last && last.type === 'rm' && part.type === 'rm') {
        last.content += part.content;
      } else {
        mergedParts.push({ ...part });
      }
    }

    // 각 파트 렌더링
    const renderedParts: string[] = [];
    for (const part of mergedParts) {
      if (part.type === 'rm') {
        // NotoSerifKR로 렌더링 (여러 글자도 한번에)
        if (notoSerifKrFont) {
          renderedParts.push(textToSvgPath(part.content, notoSerifKrFont, fs, { condenseX: RM_CONDENSE_X, fallbackFontFamily: 'Noto Serif KR,serif' }, safeColorAttr));
        } else {
          renderedParts.push(`<svg style="display:inline-block;vertical-align:middle;" preserveAspectRatio="none"><g transform="scale(${RM_CONDENSE_X} 1)"><text x="0" y="0" font-size="${fs}" fill="${safeColorAttr}" font-family="Noto Serif KR,serif" style="font-style:normal;font-weight:400">${escapeXmlText(part.content)}</text></g></svg>`);
        }
      } else {
        // MathJax로 렌더링
        try {
          const doc = ensureMathJaxDoc();
          const emSize = 16;
          // \vphantom{X}로 높이 맞춤
          const mathLatex = `\\vphantom{X}${part.content}`;
          const node = doc.convert(mathLatex, {
            display: true,
            em: emSize,
            ex: emSize / 2,
            containerWidth: 80
          });
          const adaptor = liteAdaptor();
          const svgString = adaptor.outerHTML(node);

          const svgMatch2 = svgString.match(/<svg[^>]*viewBox="([^"]+)"[^>]*>([\s\S]*)<\/svg>/);
          if (svgMatch2) {
            const vbParts2 = svgMatch2[1].split(/\s+/).map(parseFloat);
            const innerSvg = svgMatch2[2];

            if (vbParts2.length === 4 && innerSvg) {
              const [vbX, vbY, vbW, vbH] = vbParts2;
              const scalePx = (fontSizePx * MATH_SCREEN_SCALE) / emSize;
              const widthPx = vbW * scalePx;
              const heightPx = vbH * scalePx;
              renderedParts.push(`<svg width="${widthPx}px" height="${heightPx}px" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" style="display:inline-block;vertical-align:middle;color:${safeColorAttr};" color="${safeColorAttr}"><g fill="${safeColorAttr}" stroke="${safeColorAttr}" color="${safeColorAttr}">${innerSvg}</g></svg>`);
            }
          }
        } catch (e) {
          console.warn('[MathLabels] Failed to render math part with MathJax', e);
          renderedParts.push(escapeXmlText(part.content));
        }
      }
    }

    // 한 개짜리면 그대로 반환, 여러 개면 span으로 조합
    if (renderedParts.length === 1) {
      return renderedParts[0];
    }
    return `<span style="display:inline-flex;align-items:center;">${renderedParts.join('')}</span>`;
  }

  // Handle Korean text with KoPub font
  if (hasKorean) {
    const fs = fontSizePx * RM_SCREEN_SCALE;
    if (kopubFont) {
      return textToSvgPath(latex, kopubFont, fs, { fallbackFontFamily: 'KoPubDotum,sans-serif' }, safeColorAttr);
    } else {
      // Fallback to text element while font loads
      return `<svg style="display:inline-block;vertical-align:middle;"><text x="0" y="0" font-size="${fs}" fill="${safeColorAttr}" font-family="KoPubDotum,sans-serif" style="font-style:normal;font-weight:500">${escapeXmlText(latex)}</text></svg>`;
    }
  }

  try {
    const doc = ensureMathJaxDoc();
    // Match 3.3.8: display=true, em=16
    const emSize = 16;
    // 3.3.8처럼 연산자 간격 줄이기
    const safeLatex = sanitizeLatexForMathJax(latex);
    const tightLatex = tightenOperators(safeLatex);
    const node = doc.convert(tightLatex, {
      display: true,
      em: emSize,
      ex: emSize / 2,
      containerWidth: 80
    });
    const adaptor = liteAdaptor();
    let svgString = adaptor.outerHTML(node);

    // MathJax sometimes doesn't throw; it can embed an error node instead.
    // Detect this and log the sanitized input so we can debug MathLive->MathJax edge cases (e.g., dx).
    if (/merror/i.test(svgString) || /data-mml-node="merror"/i.test(svgString)) {
      console.warn('[MathLabels] MathJax rendered merror', { latex, safeLatex, tightLatex });
    }

    // Extract viewBox and inner SVG content
    const svgMatch = svgString.match(/<svg[^>]*viewBox="([^"]+)"[^>]*>([\s\S]*)<\/svg>/);
    if (!svgMatch) {
      return escapeHtml(latex);
    }

    const vbParts = svgMatch[1].split(/\s+/).map(parseFloat);
    const innerSvg = svgMatch[2];

    if (vbParts.length !== 4 || !innerSvg) {
      return escapeHtml(latex);
    }

    const [vbX, vbY, vbW, vbH] = vbParts;

    // Just use the basic calculation - actual size will be measured from DOM
    const scalePx = (fontSizePx * MATH_SCREEN_SCALE) / emSize;
    const widthPx = vbW * scalePx;
    const heightPx = vbH * scalePx;

    // Return SVG - the consuming code will measure actual DOM size for hit testing/bounds
    return `<svg width="${widthPx}px" height="${heightPx}px" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" style="display:inline-block;vertical-align:middle;color:${safeColorAttr};" color="${safeColorAttr}"><g fill="${safeColorAttr}" stroke="${safeColorAttr}" color="${safeColorAttr}">${innerSvg}</g></svg>`;
  } catch (e) {
    // Keep the app stable during editing; log enough info to debug transient MathLive tokens.
    console.warn('[MathLabels] MathJax convert failed', { latex, safeLatex: sanitizeLatexForMathJax(latex) }, e);
    return escapeHtml(latex);
  }
}

export function MathLabels() {
  const scene = useSceneStore((s) => s.scene);

  // Ensure fonts are loaded (for SVG path conversion)
  useEffect(() => {
    loadNotoSerifKrFont();
    loadKoPubFont();
  }, []);

  const mathTexts = Object.values(scene.nodes).filter(
    (n: any) => n.kind === 'math-text'
  );

  // Update clip regions for PixiStage
  useEffect(() => {
    const clipRegions: Array<{ screenX: number; screenY: number; width: number; height: number }> = [];

    for (const mathText of mathTexts as any[]) {
      // Only calculate clip regions for labels with displayAboveCurves enabled
      if (!mathText.displayAboveCurves) {
        continue;
      }

      // 축과 연결된 라벨인 경우, 축의 visible 상태를 확인하여 제외
      if (mathText.axisId) {
        const axis = scene.nodes[mathText.axisId] as any;
        if (axis && axis.kind === 'axis' && axis.visible === false) {
          continue;
        }
      }

      const yScale = scene.view.yScale ?? 1;
      let screenX: number;
      let screenY: number;

      // Same position calculation as render
      if (mathText.bezierParentId && typeof mathText.bezierT === 'number') {
        const bezier = scene.nodes[mathText.bezierParentId] as any;
        if (bezier && bezier.kind === 'bezier') {
          const a = scene.nodes[bezier.a] as any;
          const b = scene.nodes[bezier.b] as any;
          const c1 = scene.nodes[bezier.c1] as any;
          const c2 = scene.nodes[bezier.c2] as any;

          if (a && b && c1 && c2 && a.kind === 'anchor' && b.kind === 'anchor' && c1.kind === 'anchor' && c2.kind === 'anchor') {
            const t = mathText.bezierT;
            const mt = 1 - t;
            // Cubic bezier formula
            const wx = mt * mt * mt * a.position.x + 3 * mt * mt * t * c1.position.x + 3 * mt * t * t * c2.position.x + t * t * t * b.position.x;
            const wy = mt * mt * mt * a.position.y + 3 * mt * mt * t * c1.position.y + 3 * mt * t * t * c2.position.y + t * t * t * b.position.y;

            screenX = wx * scene.view.scale + scene.view.translate.x;
            screenY = -wy * yScale * scene.view.scale + scene.view.translate.y;
          } else {
            // Fallback
            screenX = mathText.position.x * scene.view.scale + scene.view.translate.x;
            screenY = -mathText.position.y * yScale * scene.view.scale + scene.view.translate.y;
          }
        } else {
          // Fallback
          screenX = mathText.position.x * scene.view.scale + scene.view.translate.x;
          screenY = -mathText.position.y * yScale * scene.view.scale + scene.view.translate.y;
        }
      } else if (mathText.axisId && mathText.offsetPx) {
        const axis = scene.nodes[mathText.axisId] as any;
        if (axis && axis.kind === 'axis') {
          const endpoint = scene.nodes[axis.endpointId] as any;
          if (endpoint && endpoint.kind === 'anchor') {
            const magnification = scene.view.magnification ?? 1;
            const endpointScreenX = endpoint.position.x * scene.view.scale + scene.view.translate.x;
            const endpointScreenY = -endpoint.position.y * yScale * scene.view.scale + scene.view.translate.y;
            screenX = endpointScreenX + mathText.offsetPx.x * magnification;
            screenY = endpointScreenY + mathText.offsetPx.y * magnification;
          } else {
            screenX = mathText.position.x * scene.view.scale + scene.view.translate.x;
            screenY = -mathText.position.y * yScale * scene.view.scale + scene.view.translate.y;
          }
        } else {
          screenX = mathText.position.x * scene.view.scale + scene.view.translate.x;
          screenY = -mathText.position.y * yScale * scene.view.scale + scene.view.translate.y;
        }
      } else if (mathText.offsetPx) {
        const magnification = scene.view.magnification ?? 1;
        const baseScreenX = mathText.position.x * scene.view.scale + scene.view.translate.x;
        const baseScreenY = -mathText.position.y * yScale * scene.view.scale + scene.view.translate.y;
        screenX = baseScreenX + mathText.offsetPx.x * magnification;
        screenY = baseScreenY + mathText.offsetPx.y * magnification;
      } else {
        screenX = mathText.position.x * scene.view.scale + scene.view.translate.x;
        screenY = -mathText.position.y * yScale * scene.view.scale + scene.view.translate.y;
      }

      // Measure actual DOM size - convert getBBox to pixels directly
      let w = 140, h = 70;
      try {
        const el = document.querySelector(`[data-math-label-id="${mathText.id}"]`) as HTMLElement | null;
        if (el) {
          const svgEl = el.querySelector('svg');
          if (svgEl) {
            try {
              const bbox = svgEl.getBBox();
              if (bbox && bbox.width > 0 && bbox.height > 0) {
                // Get the scale factor: declared width / viewBox width
                const declaredWidth = parseFloat(svgEl.getAttribute('width') || '0');
                const viewBox = svgEl.getAttribute('viewBox');
                if (declaredWidth > 0 && viewBox) {
                  const vbParts = viewBox.split(/\s+/).map(parseFloat);
                  if (vbParts.length === 4) {
                    const [, , vbW] = vbParts;
                    // Scale factor: px per SVG unit
                    const scale = declaredWidth / vbW;
                    // Convert actual content size to pixels
                    w = bbox.width * scale;
                    h = bbox.height * scale;
                  }
                }
              }
            } catch {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0) {
                w = rect.width;
                h = rect.height;
              }
            }
          } else {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0) {
              w = rect.width;
              h = rect.height;
            }
          }
        }
      } catch { }

      const magnification = scene.view.magnification ?? 1;
      const pad = 8 * magnification;
      clipRegions.push({
        screenX,
        screenY,
        width: w + pad,
        height: h + pad
      });
    }

    useSceneStore.setState({ mathLabelClipRegions: clipRegions });
  }, [scene, mathTexts]);

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5, overflow: 'hidden' }}>
      {mathTexts.map((mathText: any) => {
        // 축과 연결된 라벨인 경우, 축의 visible 상태를 확인하여 숨김 처리
        if (mathText.axisId) {
          const axis = scene.nodes[mathText.axisId] as any;
          if (axis && axis.kind === 'axis' && axis.visible === false) {
            // 축이 꺼져있으면 라벨도 표시하지 않음
            return null;
          }
        }

        const yScale = scene.view.yScale ?? 1;
        let screenX: number;
        let screenY: number;

        // Bezier-attached label: compute position from bezierT parameter
        if (mathText.bezierParentId && typeof mathText.bezierT === 'number') {
          const bezier = scene.nodes[mathText.bezierParentId] as any;
          if (bezier && bezier.kind === 'bezier') {
            const a = scene.nodes[bezier.a] as any;
            const b = scene.nodes[bezier.b] as any;
            const c1 = scene.nodes[bezier.c1] as any;
            const c2 = scene.nodes[bezier.c2] as any;

            if (a && b && c1 && c2 && a.kind === 'anchor' && b.kind === 'anchor' && c1.kind === 'anchor' && c2.kind === 'anchor') {
              const t = mathText.bezierT;
              const mt = 1 - t;
              // Cubic bezier formula
              const wx = mt * mt * mt * a.position.x + 3 * mt * mt * t * c1.position.x + 3 * mt * t * t * c2.position.x + t * t * t * b.position.x;
              const wy = mt * mt * mt * a.position.y + 3 * mt * mt * t * c1.position.y + 3 * mt * t * t * c2.position.y + t * t * t * b.position.y;

              screenX = wx * scene.view.scale + scene.view.translate.x;
              screenY = -wy * yScale * scene.view.scale + scene.view.translate.y;
            } else {
              // Fallback
              screenX = mathText.position.x * scene.view.scale + scene.view.translate.x;
              screenY = -mathText.position.y * yScale * scene.view.scale + scene.view.translate.y;
            }
          } else {
            // Fallback
            screenX = mathText.position.x * scene.view.scale + scene.view.translate.x;
            screenY = -mathText.position.y * yScale * scene.view.scale + scene.view.translate.y;
          }
        } else if (mathText.axisId && mathText.offsetPx) {
          const axis = scene.nodes[mathText.axisId] as any;
          if (axis && axis.kind === 'axis') {
            const endpoint = scene.nodes[axis.endpointId] as any;
            if (endpoint && endpoint.kind === 'anchor') {
              const magnification = scene.view.magnification ?? 1;
              const endpointScreenX = endpoint.position.x * scene.view.scale + scene.view.translate.x;
              const endpointScreenY = -endpoint.position.y * yScale * scene.view.scale + scene.view.translate.y;
              screenX = endpointScreenX + mathText.offsetPx.x * magnification;
              screenY = endpointScreenY + mathText.offsetPx.y * magnification;
            } else {
              screenX = mathText.position.x * scene.view.scale + scene.view.translate.x;
              screenY = -mathText.position.y * yScale * scene.view.scale + scene.view.translate.y;
            }
          } else {
            screenX = mathText.position.x * scene.view.scale + scene.view.translate.x;
            screenY = -mathText.position.y * yScale * scene.view.scale + scene.view.translate.y;
          }
        } else if (mathText.offsetPx) {
          const magnification = scene.view.magnification ?? 1;
          const baseScreenX = mathText.position.x * scene.view.scale + scene.view.translate.x;
          const baseScreenY = -mathText.position.y * yScale * scene.view.scale + scene.view.translate.y;
          screenX = baseScreenX + mathText.offsetPx.x * magnification;
          screenY = baseScreenY + mathText.offsetPx.y * magnification;
        } else {
          screenX = mathText.position.x * scene.view.scale + scene.view.translate.x;
          screenY = -mathText.position.y * yScale * scene.view.scale + scene.view.translate.y;
        }

        // fontSize is stored in points; legacy data may contain ~24-based "px" values.
        // If rawSize looks like legacy px (e.g., 24), convert back to pt so 24 -> 11pt.
        const rawSize = Number((mathText as any).fontSize ?? 11) || 11;
        const magnification = scene.view.magnification ?? 1;
        const paramPt = rawSize > 15 ? (rawSize / 24) * 11 : rawSize;
        const visualPx = (paramPt / 11) * 24 * magnification;
        const html = renderMathToHtml(mathText.latex, visualPx, (mathText as any).color ?? '#000000');

        let w = 140, h = 70;
        try {
          const m = html.match(/width="([0-9.]+)px"[\s\S]*?height="([0-9.]+)px"/);
          if (m) {
            w = parseFloat(m[1]);
            h = parseFloat(m[2]);
          }
        } catch { }

        // Silence unused variable warning (w and h are used in useEffect above)
        void w;
        void h;

        if (mathText.displayAboveCurves) {
          // No background needed - PixiStage handles the clipping by not drawing curves in this area
          return (
            <div
              key={mathText.id}
              data-math-label-id={mathText.id}
              style={{
                position: 'absolute',
                left: screenX,
                top: screenY,
                transform: 'translate(-50%, -50%)'
              }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          );
        }

        return (
          <div
            key={mathText.id}
            data-math-label-id={mathText.id}
            style={{
              position: 'absolute',
              left: screenX,
              top: screenY,
              transform: 'translate(-50%, -50%)'
            }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      })}
    </div>
  );
}
