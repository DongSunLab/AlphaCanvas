import type { BezierSegmentNode, LineSegmentNode, Scene, SceneNode, AxisNode, ExplicitFunctionNode, ImplicitFunctionNode, Vec2, MathTextNode, SegmentNode, PointNode, AngleNode, FilledRegionNode } from '../shared/types';
import { buildFunctionRegistry, sampleExplicitWithRegistry, marchingSquaresSegmentsWithRegistry, computeAdaptiveResolution, findExplicitVerticalBreaks, connectSegmentsToPolylines } from '../geometry/mathEval';
import { clipPolylineToRect, extendPolylineToRect } from '../geometry/clip';
import { mathjax } from 'mathjax-full/mjs/mathjax.js';
import { TeX } from 'mathjax-full/mjs/input/tex.js';
import { SVG } from 'mathjax-full/mjs/output/svg.js';
import { liteAdaptor } from 'mathjax-full/mjs/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/mjs/handlers/html.js';
import * as opentype from 'opentype.js';
import { sanitizeLatexForMathJax } from '../shared/latexSanitize';

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Initialize MathJax once
let mjDocument: any = null;
function initMathJax() {
  if (mjDocument) return mjDocument;
  
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  
  const tex = new TeX({ 
    packages: ['base', 'ams', 'newcommand', 'noundefined', 'require', 'autoload', 'configmacros']
  });
  const svg = new SVG({ 
    // IMPORTANT (Illustrator/Inkscape compatibility):
    // `fontCache: 'local'` makes MathJax emit glyphs via <defs> + <use>.
    // Some editors will break/dedupe these references when re-saving the SVG,
    // which can make parts of formulas disappear (e.g., fraction bars, radicals, letters).
    // `none` inlines glyph paths so the SVG remains stable after "Save As".
    fontCache: 'none',
    font: 'mathjax-modern'  // Latin Modern 계열
  });
  
  mjDocument = mathjax.document('', { InputJax: tex, OutputJax: svg });
  return mjDocument;
}

// Export-time scale for MathJax formulas (not rm labels)
// Current physical height ≈ 1.1mm -> target 1.8mm
const MATH_EXPORT_SCALE = (1.6 / 1.1) / 60; // 화면과 동일
// rm 라벨 스케일: 1.54mm -> 2.28mm
const RM_EXPORT_SCALE = 2.28 / 1.54; // ≈ 1.480519...
// rm 라벨 장평(가로폭) 95% (KoPub에는 적용하지 않음)
const RM_CONDENSE_X = 0.95;

// 3.3.8과 동일한 간격 조정 (연산자 주변 간격 줄이기)
// 단, 지수(^{})와 첨자(_{}) 내부는 제외 (화면 렌더링과 동일)
function tightenOperators(tex: string): string {
  // 1) 지수/첨자 그룹을 임시 플레이스홀더로 교체 (보호)
  const protectedGroups: string[] = [];
  const protectGroup = (match: string) => {
    const idx = protectedGroups.length;
    protectedGroups.push(match);
    return `\x00PROTECTED${idx}\x00`;
  };

  // ^{...} 또는 _{...} 패턴 보호 (중첩 지원)
  let processed = tex;
  let prevLen = -1;
  while (processed.length !== prevLen) {
    prevLen = processed.length;
    processed = processed.replace(/([_^])\{([^{}]*)\}/g, (match) => protectGroup(match));
  }
  // 단일 문자 지수/첨자도 보호: ^x, _x (단, \가 아닌 경우)
  processed = processed.replace(/([_^])([A-Za-z0-9])/g, (match) => protectGroup(match));

  // 2) 연산자 간격 조정 (보호된 영역 제외)
  processed = processed
    .replace(/\+/g, '\\!+\\!')
    .replace(/\\times/g, '\\!\\times\\!')
    .replace(/\\cdot/g, '\\!\\cdot\\!');

  // - 기호 처리: 이항(binary)만 간격 조정, 단항(unary)은 원래 간격 유지
  // 이항: 숫자/문자 뒤에 오는 마이너스만 양쪽에 negative space
  processed = processed.replace(/([a-zA-Z0-9}])(-)/g, '$1\\!$2\\!');

  // relational: =, <, > → binary와 동일한 간격
  // LaTeX 명령어로 변환하여 XML 이스케이프 문제 방지
  processed = processed
    .replace(/=/g, '\\!=\\!')
    .replace(/</g, '\\!\\lt\\!')
    .replace(/>/g, '\\!\\gt\\!');

  // 3) 보호된 그룹 복원
  let result = processed;
  for (let i = protectedGroups.length - 1; i >= 0; i--) {
    result = result.replace(`\x00PROTECTED${i}\x00`, protectedGroups[i]);
  }
  return result;
}

// Load NotoSerifKR font for rm labels - convert to paths for SVG export
let notoSerifKrFont: opentype.Font | null = null;
let notoSerifKrFontLoadAttempted = false;

async function loadNotoSerifKrFont(): Promise<opentype.Font | null> {
  if (notoSerifKrFont) return notoSerifKrFont;
  if (notoSerifKrFontLoadAttempted) return null;
  
  notoSerifKrFontLoadAttempted = true;
  
  try {
    const response = await fetch('/NotoSerifKR.woff');
    if (!response.ok) {
      console.warn('NotoSerifKR.woff not found, rm labels will use text fallback');
      return null;
    }
    const buffer = await response.arrayBuffer();
    notoSerifKrFont = opentype.parse(buffer);
    console.log('✓ NotoSerifKR font loaded for SVG path conversion');
    return notoSerifKrFont;
  } catch (err) {
    console.warn('Failed to load NotoSerifKR.woff for SVG export, using text fallback:', err);
    return null;
  }
}

// Load KoPub font for Korean text - convert to paths for SVG export
let kopubFont: opentype.Font | null = null;
let kopubFontLoadAttempted = false;

async function loadKoPubFont(): Promise<opentype.Font | null> {
  if (kopubFont) return kopubFont;
  if (kopubFontLoadAttempted) return null;
  
  kopubFontLoadAttempted = true;
  
  try {
    const response = await fetch('/KoPubDotum-Medium.woff');
    if (!response.ok) {
      console.warn('KoPubDotum-Medium.woff not found, Korean labels will use text fallback');
      return null;
    }
    const buffer = await response.arrayBuffer();
    kopubFont = opentype.parse(buffer);
    console.log('✓ KoPub font loaded for Korean text SVG path conversion');
    return kopubFont;
  } catch (err) {
    console.warn('Failed to load KoPubDotum-Medium.woff for SVG export, using text fallback:', err);
    return null;
  }
}

// Convert text to SVG path using opentype.js
// 일반 수식과 완전히 동일한 nested SVG 방식 사용
function textToSvgPath(
  text: string,
  font: opentype.Font,
  fontSize: number,
  x: number,
  y: number,
  color: string,
  centerAlign: boolean = false,
  options?: { condenseX?: number; fallbackFontFamily?: string }
): string {
  const condenseX = options?.condenseX ?? 1;
  const fallbackFontFamily = options?.fallbackFontFamily ?? 'serif';
  try {
    // Build path at origin with unit size (1000 units per em is standard in fonts)
    const path = font.getPath(text, 0, 0, fontSize);
    const bbox = (path as any).getBoundingBox ? (path as any).getBoundingBox() : null;
    
    if (!bbox) {
      return `<g transform="translate(${x} ${y}) scale(${condenseX} 1)"><text x="0" y="0" font-size="${fontSize}" fill="${color}" font-family="${fallbackFontFamily}" style="font-style:normal;font-weight:400">${escapeXml(text)}</text></g>`;
    }
    
    // Font coordinates (already scaled by fontSize)
    const vbX = bbox.x1;
    const vbY = bbox.y1;
    const vbW = bbox.x2 - bbox.x1;
    const vbH = bbox.y2 - bbox.y1;
    
    // Generate path data with maximum precision for smooth curves (especially for Korean)
    // Use 8 decimal places for highest quality vector output (no visible artifacts)
    const pathData = path.toPathData(8);
    
    if (!pathData || pathData === 'M0 0Z' || pathData.length === 0) {
      return `<g transform="translate(${x} ${y}) scale(${condenseX} 1)"><text x="0" y="0" font-size="${fontSize}" fill="${color}" font-family="${fallbackFontFamily}" style="font-style:normal;font-weight:400">${escapeXml(text)}</text></g>`;
    }
    
    // World-space dimensions (fontSize is already in world units from caller)
    // Font bbox is in font units scaled by fontSize
    const widthWorld = vbW * condenseX;
    const heightWorld = vbH;
    
    // Calculate position with center alignment
    let tx = x;
    let ty = y;
    if (centerAlign) {
      // Center-align: translate by half width/height
      tx = x - (widthWorld / 2);
      ty = y - (heightWorld / 2);
    }
    
    // Return nested SVG with proper world-space dimensions
    return `<svg x="${tx}" y="${ty}" width="${widthWorld}" height="${heightWorld}" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" preserveAspectRatio="none" overflow="visible"><path d="${pathData}" fill="${color}" stroke="none" /></svg>`;
  } catch (err) {
    console.error('Failed to convert text to path:', err);
    return `<g transform="translate(${x} ${y}) scale(${condenseX} 1)"><text x="0" y="0" font-size="${fontSize}" fill="${color}" font-family="${fallbackFontFamily}" style="font-style:normal;font-weight:400">${escapeXml(text)}</text></g>`;
  }
}

type RmSplitPart = { type: 'rm' | 'math'; content: string };

function splitRmPattern(latex: string): RmSplitPart[] {
  const parts: RmSplitPart[] = [];
  let remaining = String(latex ?? '');

  // Match screen logic: find rm[letter] occurrences and split around them.
  while (remaining.length > 0) {
    const match = remaining.match(/^(.*?)(rm([A-Za-z]))(.*)/s);
    if (match) {
      const [, before, , rmChar, after] = match;
      if (before) parts.push({ type: 'math', content: before });
      parts.push({ type: 'rm', content: rmChar });
      remaining = after;
    } else {
      if (remaining) parts.push({ type: 'math', content: remaining });
      break;
    }
  }

  // Merge consecutive rm parts: rmArmB -> rm("AB")
  const merged: RmSplitPart[] = [];
  for (const p of parts) {
    const last = merged[merged.length - 1];
    if (last && last.type === 'rm' && p.type === 'rm') last.content += p.content;
    else merged.push({ ...p });
  }
  return merged;
}

function estimateRmDimsWorld(text: string, fontSizeWorld: number) {
  const len = Math.max(1, String(text ?? '').length);
  // Match existing heuristic used elsewhere in this file (0.7 width, ~1.3 height)
  return {
    width: fontSizeWorld * len * 0.7 * RM_CONDENSE_X,
    height: fontSizeWorld * 1.3,
  };
}

function measureRmDimsWorld(font: opentype.Font | null, text: string, fontSizeWorld: number) {
  if (!font) return estimateRmDimsWorld(text, fontSizeWorld);
  try {
    const path = font.getPath(text, 0, 0, fontSizeWorld);
    const bbox = (path as any).getBoundingBox ? (path as any).getBoundingBox() : null;
    if (!bbox) return estimateRmDimsWorld(text, fontSizeWorld);
    const vbW = bbox.x2 - bbox.x1;
    const vbH = bbox.y2 - bbox.y1;
    return {
      width: vbW * RM_CONDENSE_X,
      height: vbH,
    };
  } catch {
    return estimateRmDimsWorld(text, fontSizeWorld);
  }
}

function renderMathJaxFragmentToSvg(
  latex: string,
  fontSize: number,
  color: string,
  x: number,
  y: number,
  pixelsPerWorld?: number,
  addVphantom: boolean = false
): { svg: string; widthWorld: number; heightWorld: number } {
  const doc = initMathJax();
  const emSize = 16;
  const ppw = Math.max(1e-6, pixelsPerWorld ?? 1);
  const safeLatex = sanitizeLatexForMathJax(latex);
  const tightLatex = tightenOperators(safeLatex);
  const inputLatex = addVphantom ? `\\vphantom{X}${tightLatex}` : tightLatex;

  const node = doc.convert(inputLatex, {
    display: true,
    em: emSize,
    ex: emSize / 2,
    containerWidth: 80
  });

  const adaptor = liteAdaptor();
  const svgString = adaptor.outerHTML(node);

  // Extract viewBox and inner content
  const svgMatch = svgString.match(/<svg[^>]*viewBox="([^"]+)"[^>]*>([\s\S]*)<\/svg>/);
  if (!svgMatch) {
    const fallback = `<text x="${x}" y="${y}" font-size="${fontSize}" fill="${color}">${escapeXml(latex)}</text>`;
    return { svg: fallback, widthWorld: 0, heightWorld: 0 };
  }

  const vbParts = svgMatch[1].split(/\s+/).map(parseFloat);
  const innerSvg = svgMatch[2];
  if (vbParts.length !== 4 || !innerSvg) {
    const fallback = `<text x="${x}" y="${y}" font-size="${fontSize}" fill="${color}">${escapeXml(latex)}</text>`;
    return { svg: fallback, widthWorld: 0, heightWorld: 0 };
  }

  const [vbX, vbY, vbW, vbH] = vbParts;

  const scalePx = (fontSize * MATH_EXPORT_SCALE) / emSize;
  const widthPx = vbW * scalePx;
  const heightPx = vbH * scalePx;
  const widthWorld = widthPx / ppw;
  const heightWorld = heightPx / ppw;

  const svg = `<svg x="${x}" y="${y}" width="${widthWorld}" height="${heightWorld}" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" overflow="visible"><g fill="${color}" stroke="${color}">${innerSvg}</g></svg>`;
  return { svg, widthWorld, heightWorld };
}

async function latexToSvg(
  latex: string,
  fontSize: number,
  color: string,
  x: number = 0,
  y: number = 0,
  centerAlign: boolean = false,
  pixelsPerWorld?: number
): Promise<string> {
  // Check if latex contains Korean characters (한글)
  const hasKorean = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/.test(latex);
  const hasRmPattern = /rm[A-Za-z]/.test(latex);
  const isRmLabel = latex.startsWith('rm') && latex.length > 2;
  const ppw = Math.max(1e-6, pixelsPerWorld ?? 1);
  
  // Handle mixed rm patterns (e.g., rmP(1,0), rmA_1): match screen rendering by splitting
  // rm-letter chunks into NotoSerifKR and rendering the rest with MathJax, then concatenating.
  if (hasRmPattern) {
    const parts = splitRmPattern(latex);
    const font = await loadNotoSerifKrFont();
    const fontSizeWorld = (fontSize / ppw) * RM_EXPORT_SCALE;
    const fillRm = color; // Use passed color instead of hardcoded black

    // First pass: compute fragment sizes (world units)
    const measured: Array<
      | { type: 'rm'; content: string; width: number; height: number }
      | { type: 'math'; content: string; width: number; height: number; vb?: { svg: string } }
    > = [];

    for (const p of parts) {
      if (p.type === 'rm') {
        const dims = measureRmDimsWorld(font, p.content, fontSizeWorld);
        measured.push({ type: 'rm', content: p.content, width: dims.width, height: dims.height });
      } else {
        // Add vphantom to stabilize vertical metrics when mixing with rm glyphs (screen behavior).
        const frag = renderMathJaxFragmentToSvg(p.content, fontSize, color, 0, 0, pixelsPerWorld, true);
        measured.push({ type: 'math', content: p.content, width: frag.widthWorld, height: frag.heightWorld, vb: { svg: frag.svg } });
      }
    }

    const totalWidth = measured.reduce((acc, p) => acc + (Number.isFinite(p.width) ? p.width : 0), 0);
    const maxHeight = measured.reduce((acc, p) => Math.max(acc, Number.isFinite(p.height) ? p.height : 0), 0);

    const containerW = Math.max(1e-9, totalWidth);
    const containerH = Math.max(1e-9, maxHeight);
    const tx = centerAlign ? (x - containerW / 2) : x;
    const ty = centerAlign ? (y - containerH / 2) : y;

    let cursorX = 0;
    const fragments: string[] = [];
    for (const p of measured) {
      const fragY = (containerH - p.height) / 2;
      if (p.type === 'rm') {
        if (font) {
          fragments.push(
            textToSvgPath(p.content, font, fontSizeWorld, cursorX, fragY, fillRm, false, {
              condenseX: RM_CONDENSE_X,
              fallbackFontFamily: 'Noto Serif KR,serif'
            })
          );
        } else {
          // Fallback text (still place it; container still has explicit width/height)
          fragments.push(
            `<g transform="translate(${cursorX} ${fragY}) scale(${RM_CONDENSE_X} 1)"><text x="0" y="0" font-size="${fontSizeWorld}" fill="${color}" font-family="Noto Serif KR,serif" style="font-style:normal;font-weight:400">${escapeXml(p.content)}</text></g>`
          );
        }
      } else {
        // Re-render fragment with correct x/y (avoid fragile string edits)
        const frag = renderMathJaxFragmentToSvg(p.content, fontSize, color, cursorX, fragY, pixelsPerWorld, true);
        fragments.push(frag.svg);
      }
      cursorX += p.width;
    }

    return `<svg x="${tx}" y="${ty}" width="${containerW}" height="${containerH}" viewBox="0 0 ${containerW} ${containerH}" overflow="visible">${fragments.join('')}</svg>`;
  }
  
  // Handle rm labels with NotoSerifKR font
  if (isRmLabel) {
    const text = latex.substring(2);
    const font = await loadNotoSerifKrFont();
    if (font) {
      try {
        const fontSizeWorld = (fontSize / ppw) * RM_EXPORT_SCALE;
        return textToSvgPath(text, font, fontSizeWorld, x, y, color, centerAlign, { condenseX: RM_CONDENSE_X, fallbackFontFamily: 'Noto Serif KR,serif' });
      } catch (err) {
        console.warn('Failed to convert rm text to path:', err);
      }
    }
    // Fallback
    const fontSizeWorld = (fontSize / ppw) * RM_EXPORT_SCALE;
    return `<g transform="translate(${x} ${y}) scale(${RM_CONDENSE_X} 1)"><text x="0" y="0" font-size="${fontSizeWorld}" fill="${color}" font-family="Noto Serif KR,serif" style="font-style:normal;font-weight:400">${escapeXml(text)}</text></g>`;
  }
  
  // Handle Korean text with KoPub font
  if (hasKorean) {
    const font = await loadKoPubFont();
    if (font) {
      try {
        const fontSizeWorld = (fontSize / ppw) * RM_EXPORT_SCALE;
        return textToSvgPath(latex, font, fontSizeWorld, x, y, color, centerAlign, { fallbackFontFamily: 'KoPubDotum,sans-serif' });
      } catch (err) {
        console.warn('Failed to convert Korean text to path:', err);
      }
    }
    // Fallback
    const fontSizeWorld = (fontSize / ppw) * RM_EXPORT_SCALE;
    return `<text x="${x}" y="${y}" font-size="${fontSizeWorld}" fill="${color}" font-family="KoPubDotum,sans-serif" style="font-style:normal;font-weight:500">${escapeXml(latex)}</text>`;
  }
  
  try {
    const doc = initMathJax();
    // Match 3.3.8 and screen: display=true, em=16
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
    
    // Get the SVG output
    const adaptor = liteAdaptor();
    let svgString = adaptor.outerHTML(node);

    // MathJax may embed an error node instead of throwing.
    if (/merror/i.test(svgString) || /data-mml-node="merror"/i.test(svgString)) {
      console.warn('[SVG export] MathJax rendered merror', { latex, safeLatex, tightLatex });
    }
    
    // Extract viewBox and inner content
    const svgMatch = svgString.match(/<svg[^>]*viewBox="([^"]+)"[^>]*>([\s\S]*)<\/svg>/);
    if (!svgMatch) {
      return `<text x="${x}" y="${y}" font-size="${fontSize}" fill="${color}">${escapeXml(latex)}</text>`;
    }
    
    const vbParts = svgMatch[1].split(/\s+/).map(parseFloat);
    const innerSvg = svgMatch[2];
    
    if (vbParts.length !== 4 || !innerSvg) {
      return `<text x="${x}" y="${y}" font-size="${fontSize}" fill="${color}">${escapeXml(latex)}</text>`;
    }
    
    const [vbX, vbY, vbW, vbH] = vbParts;

    // 화면과 완전히 동일한 계산 방식
    // 화면: scalePx = (fontSizePx * MATH_SCREEN_SCALE) / emSize; widthPx = vbW * scalePx;
    // SVG: scalePx = (fontSize * MATH_EXPORT_SCALE) / emSize; widthPx = vbW * scalePx; widthWorld = widthPx / ppw;
    const ppw = Math.max(1e-6, pixelsPerWorld ?? 1); // pixels per world unit
    const scalePx = (fontSize * MATH_EXPORT_SCALE) / emSize; // pixels per em
    const widthPx = vbW * scalePx; // viewBox width in em → pixels
    const heightPx = vbH * scalePx; // viewBox height in em → pixels
    const widthWorld = widthPx / ppw; // pixels → world units
    const heightWorld = heightPx / ppw;

    let tx = x;
    let ty = y;
    if (centerAlign) {
      // 화면과 동일: 중앙 정렬 translate(-50%, -50%)
      tx = x - (widthWorld / 2);
      ty = y - (heightWorld / 2);
    }

    // Nested SVG with width/height in world units
    //
    // IMPORTANT:
    // MathJax SVG output frequently uses `fill="currentColor"` and may also set `fill`/`stroke`
    // per element. A parent `<g fill=...>` does not reliably override those attributes, so
    // exports could "stick" to black (or currentColor) for italic glyphs.
    //
    // We force color using CSS, but carefully avoid changing elements that intentionally have
    // `fill="none"` / `stroke="none"` (e.g., invisible helpers).
    const css = [
      '.mjx-color{color:var(--mjx-color)}',
      '.mjx-color [fill]:not([fill="none"]){fill:var(--mjx-color)!important}',
      '.mjx-color [stroke]:not([stroke="none"]){stroke:var(--mjx-color)!important}',
      // Some MathJax builds put color into inline style; override those too.
      '.mjx-color [style*="fill:"]{fill:var(--mjx-color)!important}',
      '.mjx-color [style*="stroke:"]{stroke:var(--mjx-color)!important}',
    ].join('');
    return `<svg x="${tx}" y="${ty}" width="${widthWorld}" height="${heightWorld}" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" overflow="visible" style="--mjx-color:${color};"><style>${css}</style><g class="mjx-color">${innerSvg}</g></svg>`;
    
  } catch (e) {
    console.error('MathJax error:', { latex, safeLatex: sanitizeLatexForMathJax(latex) }, e);
    return `<text x="${x}" y="${y}" font-size="${fontSize}" fill="${color}">${escapeXml(latex)}</text>`;
  }
}

type SvgExportOptions = {
  padding?: number;
  viewportPx?: { width: number; height: number };
  clipToView?: boolean; // default: true if viewportPx provided
  includeLabels?: boolean; // default true
  // When provided, map the entire canvas width to this many millimeters.
  // width_mm = (contentWorldWidth * scene.view.scale) * (physicalCanvasMm / viewportPx.width)
  physicalCanvasMm?: number; // e.g., 100
  // If true, size SVG to the drawn content bounds (ignoring viewport extent) and use padding accordingly
  fitToContent?: boolean; // default false (keeps previous WYSIWYG behavior)
};

export async function sceneToSVGWithMetrics(scene: Scene, opts?: SvgExportOptions): Promise<{ svg: string; boundsWorld: { minX: number; minY: number; maxX: number; maxY: number } }> {
  const nodes = scene.nodes;
  // Filter out preview nodes to avoid rendering incomplete expressions
  const filtered = Object.values(nodes).filter((n: any) => !n.isPreview);
  const ordered: SceneNode[] = filtered.sort((a, b) => (scene.zIndex[a.id] ?? 0) - (scene.zIndex[b.id] ?? 0));
  
  // Separate point nodes to render them last (on top)
  const pointNodes = ordered.filter(n => n.kind === 'point');
  const nonPointNodes = ordered.filter(n => n.kind !== 'point');
  
  const paths: string[] = [];
  const AXIS_PT = 0.35;
  const CURVE_PT = 0.8;
  // Desired physical thicknesses
  const PT_TO_MM = 25.4 / 72;
  const AXIS_MM = AXIS_PT * PT_TO_MM;
  const CURVE_MM = CURVE_PT * PT_TO_MM;
  
  // Pre-render all math labels to get exact sizes for clipping regions
  const labelRenderCache: Map<string, { svg: string; worldX: number; worldY: number; width: number; height: number }> = new Map();
  
  // Calculate math label clip regions (for displayAboveCurves labels)
  const mathLabelClipRegions: Array<{ worldX: number; worldY: number; worldWidth: number; worldHeight: number }> = [];
  for (const node of Object.values(nodes)) {
    if (node.kind !== 'math-text') continue;
    const mathText = node as MathTextNode;
    if (!mathText.displayAboveCurves) continue;
    
    // Skip labels attached to hidden axes
    if (mathText.axisId) {
      const axis = nodes[mathText.axisId] as any;
      if (axis && axis.kind === 'axis' && axis.visible === false) {
        continue;
      }
    }
    
    // Calculate position
    let worldX = mathText.position.x;
    let worldY = mathText.position.y;
    
    // If this label is attached to a bezier curve, calculate position from bezierT parameter
    if (mathText.bezierParentId && typeof mathText.bezierT === 'number') {
      const bezier = nodes[mathText.bezierParentId] as any;
      if (bezier && bezier.kind === 'bezier') {
        const a = nodes[bezier.a] as any;
        const b = nodes[bezier.b] as any;
        const c1 = nodes[bezier.c1] as any;
        const c2 = nodes[bezier.c2] as any;
        
        if (a && b && c1 && c2 && a.kind === 'anchor' && b.kind === 'anchor' && c1.kind === 'anchor' && c2.kind === 'anchor') {
          const t = mathText.bezierT;
          const mt = 1 - t;
          // Cubic bezier formula
          worldX = mt*mt*mt*a.position.x + 3*mt*mt*t*c1.position.x + 3*mt*t*t*c2.position.x + t*t*t*b.position.x;
          worldY = mt*mt*mt*a.position.y + 3*mt*mt*t*c1.position.y + 3*mt*t*t*c2.position.y + t*t*t*b.position.y;
        }
      }
    } else if (mathText.axisId && mathText.offsetPx) {
      const axis = nodes[mathText.axisId] as any;
      if (axis && axis.kind === 'axis') {
        const endpoint = nodes[axis.endpointId] as any;
        if (endpoint && endpoint.kind === 'anchor') {
          const ys = scene.view.yScale ?? 1;
          worldX = endpoint.position.x + mathText.offsetPx.x / scene.view.scale;
          worldY = endpoint.position.y - mathText.offsetPx.y / (scene.view.scale * ys);
        }
      }
    } else if (mathText.offsetPx) {
      const ys = scene.view.yScale ?? 1;
      worldX = mathText.position.x + mathText.offsetPx.x / scene.view.scale;
      worldY = mathText.position.y - mathText.offsetPx.y / (scene.view.scale * ys);
    }
    
    // Render label to get exact size
    // fontSize is stored in points; legacy data may contain ~24-based "px" values.
    // If rawSize looks like legacy px (e.g., 24), convert back to pt so 24 -> 11pt.
    const rawSize = Number(mathText.fontSize ?? 11) || 11;
    const paramPt = rawSize > 15 ? (rawSize / 24) * 11 : rawSize;
    const fontSize = (paramPt / 11) * 24;
    const color = mathText.color ?? '#000000';
    
    // For clipping region calculation, we need to render the label
    // Note: flipY is defined later, so we temporarily use negative worldY
    const yFlipped = -(worldY * (scene.view.yScale ?? 1));
    const mathSvg = await latexToSvg(
      mathText.latex,
      fontSize,
      color,
      worldX,
      yFlipped,
      true,
      scene.view.scale
    );
    
    // Parse actual width/height from rendered SVG
    const widthMatch = mathSvg.match(/width="([0-9.eE+-]+)"/);
    const heightMatch = mathSvg.match(/height="([0-9.eE+-]+)"/);
    
    let labelWidth: number;
    let labelHeight: number;
    
    if (widthMatch && heightMatch) {
      labelWidth = parseFloat(widthMatch[1]);
      labelHeight = parseFloat(heightMatch[1]);
    } else {
      // Fallback estimation
      const hasKorean = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/.test(mathText.latex);
      const isRmLabel = mathText.latex.startsWith('rm') && mathText.latex.length > 2;
      if (hasKorean || isRmLabel) {
        const textLength = isRmLabel ? mathText.latex.length - 2 : mathText.latex.length;
        labelWidth = (fontSize * RM_EXPORT_SCALE * Math.max(textLength, 1) * 0.7) / scene.view.scale;
        labelHeight = (fontSize * RM_EXPORT_SCALE * 1.3) / scene.view.scale;
      } else {
        labelWidth = (fontSize * Math.max(mathText.latex.length, 2) * 0.6) / scene.view.scale;
        labelHeight = (fontSize * 1.5) / scene.view.scale;
      }
    }
    
    // Cache the rendered label
    labelRenderCache.set(mathText.id, {
      svg: mathSvg,
      worldX,
      worldY,  // Store unflipped worldY
      width: labelWidth,
      height: labelHeight
    });
    
    const pad = 8 / scene.view.scale;
    
    mathLabelClipRegions.push({
      worldX,
      worldY,
      worldWidth: labelWidth + pad,
      worldHeight: labelHeight + pad
    });
  }
  
  // Helper: check if a point is inside any math label clip region
  const isInClipRegion = (x: number, y: number) => {
    for (const region of mathLabelClipRegions) {
      const halfW = region.worldWidth / 2;
      const halfH = region.worldHeight / 2;
      if (
        x >= region.worldX - halfW &&
        x <= region.worldX + halfW &&
        y >= region.worldY - halfH &&
        y <= region.worldY + halfH
      ) {
        return true;
      }
    }
    return false;
  };
  
  // Helper: split polyline at math label clip regions
  const clipPolylineByLabels = (points: Vec2[]): Vec2[][] => {
    if (mathLabelClipRegions.length === 0 || points.length < 2) {
      return [points];
    }

    // Always subdivide segments to detect crossings with label regions
    // This handles both sparse (axes, lines) and dense (curves) polylines
    const subdivided: Vec2[] = [];
    const MAX_SEGMENT_LENGTH = 0.2; // world units
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i];
      const p1 = points[i + 1];
      subdivided.push(p0);
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const segLen = Math.hypot(dx, dy);
      const steps = Math.max(0, Math.min(200, Math.ceil(segLen / MAX_SEGMENT_LENGTH)));
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        subdivided.push({ x: p0.x + dx * t, y: p0.y + dy * t });
      }
    }
    subdivided.push(points[points.length - 1]);

    const result: Vec2[][] = [];
    let current: Vec2[] = [];
    for (let i = 0; i < subdivided.length; i++) {
      const p = subdivided[i];
      const inClip = isInClipRegion(p.x, p.y);
      if (!inClip) {
        current.push(p);
      } else {
        if (current.length >= 2) result.push(current);
        current = [];
      }
    }
    if (current.length >= 2) result.push(current);

    return result.length > 0 ? result : [];
  };

  // Helper: precisely clip a single segment by all label rectangles (subtract inside intervals)
  const clipSegmentByLabelRects = (p0: Vec2, p1: Vec2): Vec2[][] => {
    if (mathLabelClipRegions.length === 0) return [[p0, p1]];

    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    if (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12) return [];

    // Collect t-intervals that are inside any label rectangle
    const insideIntervals: Array<[number, number]> = [];

    for (const region of mathLabelClipRegions) {
      const halfW = region.worldWidth / 2;
      const halfH = region.worldHeight / 2;
      const xMin = region.worldX - halfW;
      const xMax = region.worldX + halfW;
      const yMin = region.worldY - halfH;
      const yMax = region.worldY + halfH;

      // Liang–Barsky to find portion INSIDE the rect in param t-space
      let t0 = 0;
      let t1 = 1;
      const p = [-dx, dx, -dy, dy];
      const q = [p0.x - xMin, xMax - p0.x, p0.y - yMin, yMax - p0.y];
      let visible = true;
      for (let i = 0; i < 4; i++) {
        const pi = p[i];
        const qi = q[i];
        if (pi === 0) {
          if (qi < 0) { visible = false; break; }
        } else {
          const t = qi / pi;
          if (pi < 0) { t0 = Math.max(t0, t); if (t0 > t1) { visible = false; break; } }
          else { t1 = Math.min(t1, t); if (t1 < t0) { visible = false; break; } }
        }
      }
      if (visible) insideIntervals.push([Math.max(0, t0), Math.min(1, t1)]);
    }

    if (insideIntervals.length === 0) return [[p0, p1]];

    // Union intervals
    insideIntervals.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const iv of insideIntervals) {
      if (merged.length === 0 || iv[0] > merged[merged.length - 1][1] + 1e-9) {
        merged.push([iv[0], iv[1]]);
      } else {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], iv[1]);
      }
    }

    // Subtract merged intervals from [0,1] to get outside pieces
    const pieces: Vec2[][] = [];
    let curr = 0;
    for (const [a, b] of merged) {
      if (a > curr + 1e-9) {
        const s0x = p0.x + dx * curr;
        const s0y = p0.y + dy * curr;
        const s1x = p0.x + dx * a;
        const s1y = p0.y + dy * a;
        pieces.push([{ x: s0x, y: s0y }, { x: s1x, y: s1y }]);
      }
      curr = Math.max(curr, b);
    }
    if (curr < 1 - 1e-9) {
      const s0x = p0.x + dx * curr;
      const s0y = p0.y + dy * curr;
      const s1x = p0.x + dx * 1;
      const s1y = p0.y + dy * 1;
      pieces.push([{ x: s0x, y: s0y }, { x: s1x, y: s1y }]);
    }

    return pieces;
  };

  // If physicalCanvasMm + viewportPx are provided, we can compute stroke width in user units
  // so that any viewer (Illustrator, Inkscape, etc.) renders the same physical thickness
  const mmPerUser = (opts?.physicalCanvasMm && opts?.viewportPx)
    ? (scene.view.scale * (opts!.physicalCanvasMm! / Math.max(1e-6, opts!.viewportPx!.width)))
    : null;
  const axisStrokeUser = mmPerUser ? (AXIS_MM / mmPerUser) : null;
  const curveStrokeUser = mmPerUser ? (CURVE_MM / mmPerUser) : null;
  
  // Get current view transformation
  const { scale, yScale = 1 } = scene.view;
  
  // Calculate dash scale for SVG export
  // Dash pattern is in pt units, but SVG stroke-dasharray uses the same units as stroke-width
  // We need to convert pt to SVG user units (same as stroke-width conversion)
  const dashScale = mmPerUser 
    ? PT_TO_MM / mmPerUser 
    : 1.0 / scale;
  
  // Helper to flip Y coordinate (SVG Y-axis points down, math Y-axis points up)
  // Also apply yScale transformation
  const flipY = (y: number) => -(y * yScale);
  
  // Track maximum stroke width used (in SVG user/world units) to ensure we keep
  // at least half of it as padding so strokes are not clipped at the edges
  let maxStrokeUser = 0;

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  const pushBounds = (x: number, y: number) => {
    const flippedY = flipY(y);
    minX = Math.min(minX, x);
    minY = Math.min(minY, flippedY);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, flippedY);
  };
  
  // Calculate clip bounds from axes (regardless of visible state)
  const calculateClipBounds = () => {
    // Include all axes regardless of visible state (matching PixiStage behavior)
    const axes = Object.values(nodes).filter((n: any) => n.kind === 'axis') as any[];
    if (axes.length === 0) return null;
    
    let xMin = -Infinity, xMax = Infinity, yMin = -Infinity, yMax = Infinity;
    
    for (const axis of axes) {
      const origin = nodes[axis.originId] as any;
      const endpoint = nodes[axis.endpointId] as any;
      if (!origin || !endpoint) continue;
      
      const dx = endpoint.position.x - origin.position.x;
      const dy = endpoint.position.y - origin.position.y;
      
      if (Math.abs(dx) > Math.abs(dy)) {
        xMin = Math.max(xMin, Math.min(origin.position.x, endpoint.position.x));
        xMax = Math.min(xMax, Math.max(origin.position.x, endpoint.position.x));
      } else {
        yMin = Math.max(yMin, Math.min(origin.position.y, endpoint.position.y));
        yMax = Math.min(yMax, Math.max(origin.position.y, endpoint.position.y));
      }
    }
    
    if (xMin === -Infinity) xMin = -1000;
    if (xMax === Infinity) xMax = 1000;
    if (yMin === -Infinity) yMin = -1000;
    if (yMax === Infinity) yMax = 1000;
    
    return { xMin, xMax, yMin, yMax };
  };
  
  const axesBounds = calculateClipBounds();

  // Viewport world bounds from scene.view and viewportPx
  const getViewWorldBounds = (view: { scale: number; translate: Vec2; rotation: number; yScale?: number }, canvasW: number, canvasH: number) => {
    const s = view.scale;
    const ys = view.yScale ?? 1;
    const tx = view.translate.x;
    const ty = view.translate.y;
    const xMin = (0 - tx) / s;
    const xMax = (canvasW - tx) / s;
    const yMax = (0 - ty) / (-s * ys); // flipped and scaled
    const yMin = (canvasH - ty) / (-s * ys);
    const padWorld = 0.5 * (1 / Math.max(1, s * ys));
    return { xMin: xMin - padWorld, xMax: xMax + padWorld, yMin: yMin - padWorld, yMax: yMax + padWorld };
  };

  const intersectBounds = (
    a: { xMin: number; xMax: number; yMin: number; yMax: number } | null,
    b: { xMin: number; xMax: number; yMin: number; yMax: number } | null
  ) => {
    if (!a) return b;
    if (!b) return a;
    return {
      xMin: Math.max(a.xMin, b.xMin),
      xMax: Math.min(a.xMax, b.xMax),
      yMin: Math.max(a.yMin, b.yMin),
      yMax: Math.min(a.yMax, b.yMax),
    };
  };

  const haveViewport = !!opts?.viewportPx && Number.isFinite(opts?.viewportPx?.width) && Number.isFinite(opts?.viewportPx?.height);
  const clipToView = opts?.clipToView ?? haveViewport;
  const viewBounds = haveViewport
    ? getViewWorldBounds(scene.view, opts!.viewportPx!.width, opts!.viewportPx!.height)
    : null;
  const clipBounds = clipToView ? intersectBounds(viewBounds, axesBounds) : axesBounds;

  const includeLabels = opts?.includeLabels ?? true;

  // Two-point segments (user drawn) are rendered from their anchor positions in Pixi (not their stored `samples`,
  // which can become stale while dragging). Keep SVG export consistent with on-screen rendering.
  const getActualSegmentSamples = (seg: SegmentNode): Vec2[] | null => {
    if (!seg.samples || seg.samples.length < 2) return null;
    const isTwoPointSegment = !seg.functionId;
    if (!isTwoPointSegment) return seg.samples;
    const a = (nodes as any)[seg.startAnchorId] as any;
    const b = (nodes as any)[seg.endAnchorId] as any;
    if (a && b && a.kind === 'anchor' && b.kind === 'anchor' && a.position && b.position) {
      return [{ x: a.position.x, y: a.position.y }, { x: b.position.x, y: b.position.y }];
    }
    // Fallback: still export the stored samples if anchors are missing
    return seg.samples;
  };

  // Build function registry excluding preview nodes
  const nonPreviewNodes: Record<string, SceneNode> = {};
  for (const [id, node] of Object.entries(nodes)) {
    if (!(node as any).isPreview) {
      nonPreviewNodes[id] = node;
    }
  }
  const registry = buildFunctionRegistry(nonPreviewNodes);

  // Render non-point nodes first
  for (const node of nonPointNodes) {
    if (node.kind === 'line') {
      const seg = node as LineSegmentNode;
      const a = nodes[seg.a] as any;
      const b = nodes[seg.b] as any;
      if (!a || !b) continue;
      const stroke = seg.style?.stroke ?? { color: '#333', width: 2 };
      // Optional clip to view bounds
      let aPos = { x: a.position.x, y: a.position.y };
      let bPos = { x: b.position.x, y: b.position.y };
      if (clipBounds) {
        // Lightweight inline clip (Liang–Barsky) to avoid importing clipLineToRect explicitly here
        const dx = bPos.x - aPos.x; const dy = bPos.y - aPos.y;
        let t0 = 0; let t1 = 1;
        const p = [-dx, dx, -dy, dy];
        const q = [aPos.x - clipBounds.xMin, clipBounds.xMax - aPos.x, aPos.y - clipBounds.yMin, clipBounds.yMax - aPos.y];
        let reject = false;
        for (let i = 0; i < 4; i++) {
          const pi = p[i]; const qi = q[i];
          if (pi === 0) { if (qi < 0) { reject = true; break; } }
          else {
            const t = qi / pi;
            if (pi < 0) { if (t > t1) { reject = true; break; } if (t > t0) t0 = t; }
            else { if (t < t0) { reject = true; break; } if (t < t1) t1 = t; }
          }
        }
        if (reject) continue;
        const nx0 = aPos.x + t0 * dx; const ny0 = aPos.y + t0 * dy;
        const nx1 = aPos.x + t1 * dx; const ny1 = aPos.y + t1 * dy;
        aPos = { x: nx0, y: ny0 }; bPos = { x: nx1, y: ny1 };
      }
      
      // Apply math label clipping
      const linePolyline = [aPos, bPos];
      const clippedPolylines = clipPolylineByLabels(linePolyline);
      
      for (const poly of clippedPolylines) {
        if (poly.length < 2) continue;
        const d = `M ${poly[0].x} ${flipY(poly[0].y)} L ${poly[1].x} ${flipY(poly[1].y)}`;
        const sw = (curveStrokeUser ?? (stroke.width / scale));
        paths.push(`<path d="${d}" fill="none" stroke="${stroke.color}" stroke-width="${sw}" stroke-opacity="${stroke.opacity ?? 1}" />`);
        if (Number.isFinite(sw)) maxStrokeUser = Math.max(maxStrokeUser, sw);
        poly.forEach(p => pushBounds(p.x, p.y));
      }
    } else if (node.kind === 'bezier') {
      const seg = node as BezierSegmentNode;
      const a = nodes[seg.a] as any;
      const b = nodes[seg.b] as any;
      const c1 = nodes[seg.c1] as any;
      const c2 = nodes[seg.c2] as any;
      if (!a || !b || !c1 || !c2) continue;
      const stroke = seg.style?.stroke ?? { color: '#0066ff', width: 2 };
      
      // Sample bezier curve to polyline for clipping
      const samples = 50;
      const bezierPolyline: Vec2[] = [];
      for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        const mt = 1 - t;
        const x = mt*mt*mt*a.position.x + 3*mt*mt*t*c1.position.x + 3*mt*t*t*c2.position.x + t*t*t*b.position.x;
        const y = mt*mt*mt*a.position.y + 3*mt*mt*t*c1.position.y + 3*mt*t*t*c2.position.y + t*t*t*b.position.y;
        bezierPolyline.push({ x, y });
      }
      
      // Convert dash pattern for bezier: convert pt to SVG user units (same as stroke-width)
      const dashPt = stroke.dash;
      let dashArrayAttr = '';
      if (dashPt && dashPt.length > 0) {
        // Convert pt to user units using dashScale (no unit suffix, uses SVG user units)
        const dashStr = dashPt.map((d: number) => `${(d * dashScale).toFixed(3)}`).join(',');
        dashArrayAttr = ` stroke-dasharray="${dashStr}"`;
      }
      
      // Apply math label clipping
      const clippedBezierPolylines = clipPolylineByLabels(bezierPolyline);
      
      for (const poly of clippedBezierPolylines) {
        if (poly.length < 2) continue;
        const d = poly.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${flipY(p.y)}`).join(' ');
        
        // Calculate stroke width from actual bezier width (not hardcoded 0.8pt)
        const strokeWidthPt = stroke.width ?? 0.8;
        const sw = mmPerUser 
          ? (strokeWidthPt * PT_TO_MM) / mmPerUser 
          : strokeWidthPt / scale;
        
        paths.push(`<path d="${d}" fill="none" stroke="${stroke.color}" stroke-width="${sw}" stroke-opacity="${stroke.opacity ?? 1}"${dashArrayAttr} />`);
        if (Number.isFinite(sw)) maxStrokeUser = Math.max(maxStrokeUser, sw);
        poly.forEach((n: any) => pushBounds(n.x, n.y));
      }
    } else if (node.kind === 'arrow') {
      const arrow = node as any;
      const a = nodes[arrow.a] as any;
      const b = nodes[arrow.b] as any;
      const c1 = nodes[arrow.c1] as any;
      const c2 = nodes[arrow.c2] as any;
      if (!a || !b || !c1 || !c2) continue;
      const stroke = arrow.style?.stroke ?? { color: '#000000', width: 0.35 };
      
      // Sample bezier curve to polyline for clipping
      const samples = 50;
      const arrowPolyline: Vec2[] = [];
      for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        const mt = 1 - t;
        const x = mt*mt*mt*a.position.x + 3*mt*mt*t*c1.position.x + 3*mt*t*t*c2.position.x + t*t*t*b.position.x;
        const y = mt*mt*mt*a.position.y + 3*mt*mt*t*c1.position.y + 3*mt*t*t*c2.position.y + t*t*t*b.position.y;
        arrowPolyline.push({ x, y });
      }
      
      // Convert dash pattern: convert pt to SVG user units
      const dashPt = stroke.dash;
      let dashArrayAttr = '';
      if (dashPt && dashPt.length > 0) {
        const dashStr = dashPt.map((d: number) => `${(d * dashScale).toFixed(3)}`).join(',');
        dashArrayAttr = ` stroke-dasharray="${dashStr}"`;
      }
      
      // Draw curve (no label clipping for arrows)
      if (arrowPolyline.length >= 2) {
        // Extend curve into arrows to avoid gap (same as axis)
        const arrowSizeMultiplier = arrow.arrowSize ?? 1.0;
        const svgScaleExtend = 5 / scale;
        const extension = 2 * svgScaleExtend * arrowSizeMultiplier; // Scale extension with arrow size
        
        let drawPolyline = [...arrowPolyline];
        
        // Extend end if end arrow is shown
        if (arrow.showEndArrow ?? true) {
          const p1 = arrowPolyline[arrowPolyline.length - 2];
          const p2 = arrowPolyline[arrowPolyline.length - 1];
          const angle = Math.atan2((p2.y - p1.y) * yScale, p2.x - p1.x);
          const extendedEndX = p2.x + extension * Math.cos(angle);
          const extendedEndY = p2.y + extension * Math.sin(angle);
          drawPolyline[drawPolyline.length - 1] = { x: extendedEndX, y: extendedEndY };
        }
        
        // Extend start if start arrow is shown
        if (arrow.showStartArrow ?? false) {
          const p1 = arrowPolyline[1];
          const p2 = arrowPolyline[0];
          const angle = Math.atan2((p2.y - p1.y) * yScale, p2.x - p1.x);
          const extendedStartX = p2.x + extension * Math.cos(angle);
          const extendedStartY = p2.y + extension * Math.sin(angle);
          drawPolyline[0] = { x: extendedStartX, y: extendedStartY };
        }
        
        const d = drawPolyline.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${flipY(p.y)}`).join(' ');
        
        const strokeWidthPt = stroke.width ?? 0.35;
        const sw = mmPerUser 
          ? (strokeWidthPt * PT_TO_MM) / mmPerUser 
          : strokeWidthPt / scale;
        
        paths.push(`<path d="${d}" fill="none" stroke="${stroke.color}" stroke-width="${sw}" stroke-opacity="${stroke.opacity ?? 1}"${dashArrayAttr} />`);
        if (Number.isFinite(sw)) maxStrokeUser = Math.max(maxStrokeUser, sw);
        drawPolyline.forEach((n: any) => pushBounds(n.x, n.y));
      }
      
      // Draw arrowheads
      const showStartArrow = arrow.showStartArrow ?? false;
      const showEndArrow = arrow.showEndArrow ?? true;
      const arrowSizeMultiplier = arrow.arrowSize ?? 1.0;
      
      // Helper to draw arrow using axis arrow style
      const drawSvgArrowhead = (fromX: number, fromY: number, toX: number, toY: number) => {
        const angle = Math.atan2((toY - fromY) * yScale, toX - fromX);
        const svgScale = (3 / scale) * arrowSizeMultiplier; // Apply size multiplier
        
        const tipX = 0.117;
        const centerY = 1.539;
        const arrowPoints = [
          { x: 0.991, y: 1.538 },
          { x: 0.117, y: 0.141 },
          { x: 2.51, y: 1.016 },
          { x: 4.964, y: 1.540 },
          { x: 2.51, y: 2.063 },
          { x: 0.168, y: 2.967 },
        ];
        
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const transformedPoints = arrowPoints.map(p => {
          const localX = p.x - tipX;
          const localY = p.y - centerY;
          const rotatedX = localX * cos - localY * sin;
          const rotatedY = localX * sin + localY * cos;
          const worldX = rotatedX * svgScale;
          const worldY = (rotatedY * svgScale) / Math.max(1e-6, yScale);
          return {
            x: toX + worldX,
            y: toY + worldY
          };
        });
        
        const arrowPath = transformedPoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${flipY(p.y)}`).join(' ') + ' Z';
        paths.push(`<path d="${arrowPath}" fill="${stroke.color}" />`);
        transformedPoints.forEach(p => pushBounds(p.x, p.y));
      };
      
      if (showEndArrow && arrowPolyline.length >= 2) {
        const p1 = arrowPolyline[arrowPolyline.length - 2];
        const p2 = arrowPolyline[arrowPolyline.length - 1];
        drawSvgArrowhead(p1.x, p1.y, p2.x, p2.y);
      }
      
      if (showStartArrow && arrowPolyline.length >= 2) {
        const p1 = arrowPolyline[1];
        const p2 = arrowPolyline[0];
        drawSvgArrowhead(p1.x, p1.y, p2.x, p2.y);
      }
    } else if (node.kind === 'axis') {
      const axis = node as AxisNode;
      // Skip hidden axes
      if (axis.visible === false) continue;
      
      const origin = nodes[axis.originId] as any;
      const endpoint = nodes[axis.endpointId] as any;
      if (!origin || !endpoint) continue;
      const stroke = axis.style ?? { color: '#000', width: 2 };
      // Clip axis to view if needed
      let o = { x: origin.position.x, y: origin.position.y };
      let e = { x: endpoint.position.x, y: endpoint.position.y };
      if (clipBounds) {
        const dx = e.x - o.x; const dy = e.y - o.y;
        let t0 = 0; let t1 = 1;
        const p = [-dx, dx, -dy, dy];
        const q = [o.x - clipBounds.xMin, clipBounds.xMax - o.x, o.y - clipBounds.yMin, clipBounds.yMax - o.y];
        let reject = false;
        for (let i = 0; i < 4; i++) {
          const pi = p[i]; const qi = q[i];
          if (pi === 0) { if (qi < 0) { reject = true; break; } }
          else {
            const t = qi / pi;
            if (pi < 0) { if (t > t1) { reject = true; break; } if (t > t0) t0 = t; }
            else { if (t < t0) { reject = true; break; } if (t < t1) t1 = t; }
          }
        }
        if (reject) continue;
        const nx0 = o.x + t0 * dx; const ny0 = o.y + t0 * dy;
        const nx1 = o.x + t1 * dx; const ny1 = o.y + t1 * dy;
        o = { x: nx0, y: ny0 }; e = { x: nx1, y: ny1 };
      }
      
      // Extend axis line into the arrow to avoid gap (same as PixiStage.tsx)
      // Calculate angle considering yScale (visual angle, not world-space angle)
      const dy = e.y - o.y;
      const dx = e.x - o.x;
      const angle = Math.atan2(dy * yScale, dx);
      const svgScaleExtend = 5 / scale;
      const extension = 2 * svgScaleExtend; // Extend into the arrow
      const extendedEndX = e.x + extension * Math.cos(angle);
      const extendedEndY = e.y + extension * Math.sin(angle);
      
      // Precisely subtract label rectangles from axis segment
      const clippedAxisSegments = clipSegmentByLabelRects(o, { x: extendedEndX, y: extendedEndY });
      for (const seg of clippedAxisSegments) {
        if (seg.length < 2) continue;
        const d = `M ${seg[0].x} ${flipY(seg[0].y)} L ${seg[1].x} ${flipY(seg[1].y)}`;
        const sw = (axisStrokeUser ?? (stroke.width / scale));
        paths.push(`<path d="${d}" fill="none" stroke="${stroke.color}" stroke-width="${sw}" />`);
        if (Number.isFinite(sw)) maxStrokeUser = Math.max(maxStrokeUser, sw);
        pushBounds(seg[0].x, seg[0].y);
        pushBounds(seg[1].x, seg[1].y);
      }
      
      // Add arrow at endpoint if enabled
      if (axis.showArrow !== false) {
        // Arrow should maintain consistent shape regardless of yScale
        // Only the direction follows the axis angle
        const svgScale = 3 / scale;
        
        // Arrow points from SVG (simplified triangle) - in pixel-space units
        const tipX = 0.117;
        const centerY = 1.539;
        const arrowPoints = [
          { x: 0.991, y: 1.538 },
          { x: 0.117, y: 0.141 },
          { x: 2.51, y: 1.016 },
          { x: 4.964, y: 1.540 },
          { x: 2.51, y: 2.063 },
          { x: 0.168, y: 2.967 },
        ];
        
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const transformedPoints = arrowPoints.map(p => {
          // Step 1: Center the arrow at origin (pixel space)
          const localX = p.x - tipX;
          const localY = p.y - centerY;
          
          // Step 2: Rotate in pixel space
          const rotatedX = localX * cos - localY * sin;
          const rotatedY = localX * sin + localY * cos;
          
          // Step 3: Scale to world coordinates; pre-divide Y by yScale so flipY(y*yScale) preserves shape
          const worldX = rotatedX * svgScale;
          const worldY = (rotatedY * svgScale) / Math.max(1e-6, yScale);
          
          // Step 4: Translate to endpoint position
          return {
            x: e.x + worldX,
            y: e.y + worldY  // Keep in world coords, flip when generating path
          };
        });
        
        const arrowPath = transformedPoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${flipY(p.y)}`).join(' ') + ' Z';
        paths.push(`<path d="${arrowPath}" fill="${stroke.color}" />`);
        transformedPoints.forEach(p => pushBounds(p.x, p.y));
      }
      
      // Axis labels removed - now handled as regular math-text nodes
    } else if (node.kind === 'function-explicit') {
      const fn = node as ExplicitFunctionNode;
      // If this function has segments or is flagged to use segments only, skip raw curve rendering
      const hasSegments = Object.values(nodes).some((n: any) => n && n.kind === 'segment' && n.functionId === fn.id && !n.hidden);
      if ((fn as any).segmentsOnly || hasSegments) {
        continue;
      }
      // Determine visible domain from view/axes bounds
      const domMin = (fn as any).clipToAxes && clipBounds ? clipBounds.xMin : fn.domain[0];
      const domMax = (fn as any).clipToAxes && clipBounds ? clipBounds.xMax : fn.domain[1];
      if (!(domMax > domMin)) continue;
      const visibleWidth = domMax - domMin;
      
      // SVG 내보내기: 최대 품질 샘플링 (줌과 완전히 독립)
      // domain 1단위당 250개 샘플 (영점/특이점 완벽 포착)
      const baseSamplesPerUnit = 250;
      const samples = Math.max(500, Math.min(16384, Math.round(visibleWidth * baseSamplesPerUnit)));

      // Split domain by vertical breaks (asymptotes)
      const yRange = clipBounds ? (clipBounds.yMax - clipBounds.yMin) : 16;
      const breaks = findExplicitVerticalBreaks(fn.expr, [domMin, domMax], registry as any, yRange, Math.min(1024, Math.max(512, Math.round(samples / 3))));  // SVG: 최대 정밀도 불연속점 검출
      const subDomains: Array<[number, number]> = [];
      let last = domMin;
      for (const b of breaks) { if (b > last) subDomains.push([last, b]); last = b; }
      if (last < domMax) subDomains.push([last, domMax]);

      let points: Vec2[] = [];
      try {
        for (const [a, b] of subDomains) {
          const w = b - a;
          const localSamples = Math.max(250, Math.min(8192, Math.round(w * baseSamplesPerUnit)));
          points.push(...sampleExplicitWithRegistry(fn.expr, fn.variable, [a, b], localSamples, registry as any));
        }
      } catch (err) {
        // Skip invalid function (wrong arity, undefined symbols, timeout)
        continue;
      }
      if (points.length < 2) continue;

      // Discontinuity-aware drawing within y-bounds
      const yMin = clipBounds ? clipBounds.yMin : -1e9;
      const yMax = clipBounds ? clipBounds.yMax : 1e9;
      const stroke = fn.style?.stroke ?? { color: '#0066ff', width: 2 };
      
      // Filter points to valid range first
      const validPoints = points.filter(p => 
        Number.isFinite(p.x) && Number.isFinite(p.y) && 
        p.y >= yMin && p.y <= yMax
      );
      
      // Apply math label clipping (same as bezier curves)
      const clippedPolylines = clipPolylineByLabels(validPoints);
      
      // Draw each clipped polyline segment
      for (const poly of clippedPolylines) {
        if (poly.length < 2) continue;
        const d = poly.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${flipY(p.y)}`).join(' ');
        const sw = (curveStrokeUser ?? ((stroke.width ?? 2) / scale));
        paths.push(`<path d="${d}" fill="none" stroke="${stroke.color}" stroke-width="${sw}" />`);
        if (Number.isFinite(sw)) maxStrokeUser = Math.max(maxStrokeUser, sw);
        poly.forEach((p: Vec2) => pushBounds(p.x, p.y));
      }
    } else if (node.kind === 'function-implicit') {
      const fn = node as ImplicitFunctionNode;
      // If this function has explicit segments drawn, skip raw implicit curve
      const hasSegmentsForImplicit = Object.values(nodes).some((n: any) => n && n.kind === 'segment' && n.functionId === fn.id && !n.hidden);
      if (hasSegmentsForImplicit) {
        continue;
      }
      const bounds = (fn as any).clipToAxes && clipBounds
        ? {
            xMin: Math.max(fn.bounds.xMin, clipBounds.xMin),
            xMax: Math.min(fn.bounds.xMax, clipBounds.xMax),
            yMin: Math.max(fn.bounds.yMin, clipBounds.yMin),
            yMax: Math.min(fn.bounds.yMax, clipBounds.yMax),
          }
        : fn.bounds;
      const res = computeAdaptiveResolution(bounds, scale, { base: 512, min: 256, max: 8192, targetCellPx: 0.5, quality: 2.0 });  // SVG 내보내기: 초고해상도
      let segments;
      try {
        segments = marchingSquaresSegmentsWithRegistry(fn.expr, fn.variables, bounds, res, registry as any);
      } catch (err) {
        // Skip invalid implicit function (wrong arity, undefined symbols, timeout)
        continue;
      }
      if (segments.length === 0) continue;
      
      // Connect segments into continuous polylines for smoother curves
      const polylines = connectSegmentsToPolylines(segments as any);
      
      const stroke = fn.style?.stroke ?? { color: '#ff6600', width: 2 };
      // Draw each polyline with math label clipping (same as other curves)
      for (const poly of polylines) {
        if (poly.length < 2) continue;
        
        // Clip polyline to bounds if needed (using proper polyline clipping, not filter)
        let polysToRender: Vec2[][] = [poly];
        if ((fn as any).clipToAxes && clipBounds) {
          polysToRender = clipPolylineToRect(poly, { 
            xMin: bounds.xMin, xMax: bounds.xMax, yMin: bounds.yMin, yMax: bounds.yMax 
          } as any);
        } else if (clipBounds) {
          polysToRender = clipPolylineToRect(poly, clipBounds as any);
        }
        
        // Apply math label clipping to each clipped polyline
        for (const clippedPoly of polysToRender) {
          if (clippedPoly.length < 2) continue;
          
          const labelClippedPolylines = clipPolylineByLabels(clippedPoly);
          
          for (const finalPoly of labelClippedPolylines) {
            if (finalPoly.length < 2) continue;
            const d = finalPoly.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${flipY(p.y)}`).join(' ');
            const sw = (curveStrokeUser ?? ((stroke.width ?? 2) / scale));
            paths.push(`<path d="${d}" fill="none" stroke="${stroke.color}" stroke-width="${sw}" />`);
            if (Number.isFinite(sw)) maxStrokeUser = Math.max(maxStrokeUser, sw);
            finalPoly.forEach((p: Vec2) => pushBounds(p.x, p.y));
          }
        }
      }
    } else if (node.kind === 'segment') {
      const seg = node as SegmentNode;
      if ((seg as any).hidden || !seg.samples || seg.samples.length < 2) continue;
      const stroke = seg.style?.stroke ?? { color: '#333', width: 2 };
      const dashPt = stroke.dash;
      
      // Convert dash pattern: convert pt to SVG user units (same as stroke-width)
      let dashArrayAttr = '';
      if (dashPt && dashPt.length > 0) {
        // Convert pt to user units using dashScale (no unit suffix, uses SVG user units)
        const dashStr = dashPt.map((d: number) => `${(d * dashScale).toFixed(3)}`).join(',');
        dashArrayAttr = ` stroke-dasharray="${dashStr}"`;
      }

      const actualSamples = getActualSegmentSamples(seg);
      if (!actualSamples || actualSamples.length < 2) continue;
      
      const extendStart = (seg as any).extendStart ?? false;
      const extendEnd = (seg as any).extendEnd ?? false;
      const samples = (extendStart || extendEnd) && clipBounds
        ? extendPolylineToRect(actualSamples, clipBounds as any, extendStart, extendEnd)
        : actualSamples;
      const polylines = clipBounds ? clipPolylineToRect(samples, clipBounds as any) : [samples];
      
      // Apply math label clipping to each polyline
      for (const poly of polylines) {
        if (poly.length < 2) continue;
        
        // Split polyline at label clip regions
        const clippedPolylines = clipPolylineByLabels(poly);
        
        for (const clippedPoly of clippedPolylines) {
          if (clippedPoly.length < 2) continue;
          
          const d = clippedPoly.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${flipY(p.y)}`).join(' ');
          
          // Calculate stroke width from actual segment width (not hardcoded 0.8pt)
          const strokeWidthPt = stroke.width ?? 0.8;
          const sw = mmPerUser 
            ? (strokeWidthPt * PT_TO_MM) / mmPerUser 
            : strokeWidthPt / scale;
          
          paths.push(`<path d="${d}" fill="none" stroke="${stroke.color}" stroke-width="${sw}"${dashArrayAttr} />`);
          if (Number.isFinite(sw)) maxStrokeUser = Math.max(maxStrokeUser, sw);
          clippedPoly.forEach((p) => pushBounds(p.x, p.y));
        }
      }

      // Draw center mark(s) at midpoint in SVG
      const centerMark = (seg as any).centerMark as ('single' | 'double' | undefined);
      if (centerMark && actualSamples.length >= 2) {
        const a = actualSamples[0];
        const b = actualSamples[actualSamples.length - 1];
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len > 1e-6) {
          // Unit perpendicular in world coords; yScale not applied in SVG export (world space)
          const nx = -dy / len;
          const ny = dx / len;
          const thicknessPt = 0.35;
          const lengthPt = 6.0; // match screen
          const thicknessUser = mmPerUser ? (thicknessPt * PT_TO_MM) / mmPerUser : (thicknessPt / scale);
          const halfLenUser = (mmPerUser ? (lengthPt * PT_TO_MM) / mmPerUser : (lengthPt / scale)) / 2;

          if (centerMark === 'single') {
            const x1 = mx - nx * halfLenUser;
            const y1 = my - ny * halfLenUser;
            const x2 = mx + nx * halfLenUser;
            const y2 = my + ny * halfLenUser;
            const w = thicknessUser;
            paths.push(`<line x1="${x1}" y1="${flipY(y1)}" x2="${x2}" y2="${flipY(y2)}" stroke="${stroke.color}" stroke-width="${w}" />`);
            pushBounds(x1, y1); pushBounds(x2, y2);
          } else if (centerMark === 'double') {
            // two parallel ticks: offset along tangent direction by half the gap
            const gapPt = 2.0;
            const gapUser = mmPerUser ? (gapPt * PT_TO_MM) / mmPerUser : (gapPt / scale);
            // tangent unit vector
            const tx = dx / len;
            const ty = dy / len;
            const offX = tx * (gapUser / 2);
            const offY = ty * (gapUser / 2);

            // left tick (minus tangent)
            let x1 = (mx - offX) - nx * halfLenUser;
            let y1 = (my - offY) - ny * halfLenUser;
            let x2 = (mx - offX) + nx * halfLenUser;
            let y2 = (my - offY) + ny * halfLenUser;
            paths.push(`<line x1="${x1}" y1="${flipY(y1)}" x2="${x2}" y2="${flipY(y2)}" stroke="${stroke.color}" stroke-width="${thicknessUser}" />`);
            pushBounds(x1, y1); pushBounds(x2, y2);

            // right tick (plus tangent)
            x1 = (mx + offX) - nx * halfLenUser;
            y1 = (my + offY) - ny * halfLenUser;
            x2 = (mx + offX) + nx * halfLenUser;
            y2 = (my + offY) + ny * halfLenUser;
            paths.push(`<line x1="${x1}" y1="${flipY(y1)}" x2="${x2}" y2="${flipY(y2)}" stroke="${stroke.color}" stroke-width="${thicknessUser}" />`);
            pushBounds(x1, y1); pushBounds(x2, y2);
          }
        }
      }
    } else if (node.kind === 'angle') {
      // Draw angle arc (same logic as PixiStage.tsx drawAngle)
      const angleNode = node as AngleNode;
      const item1 = nodes[angleNode.segment1Id] as any;
      const item2 = nodes[angleNode.segment2Id] as any;
      
      if (!item1 || !item2) {
        continue;
      }
      
      // Get samples for both items (segments have samples, axes need to be converted)
      let samples1: Vec2[] = [];
      let samples2: Vec2[] = [];
      
      if (item1.kind === 'segment') {
        const s = getActualSegmentSamples(item1 as SegmentNode);
        if (!s || s.length < 2) continue;
        samples1 = s;
      } else if (item1.kind === 'axis') {
        const origin = nodes[item1.originId] as any;
        const endpoint = nodes[item1.endpointId] as any;
        if (!origin || !endpoint) continue;
        samples1 = [origin.position, endpoint.position];
      } else {
        continue;
      }
      
      if (item2.kind === 'segment') {
        const s = getActualSegmentSamples(item2 as SegmentNode);
        if (!s || s.length < 2) continue;
        samples2 = s;
      } else if (item2.kind === 'axis') {
        const origin = nodes[item2.originId] as any;
        const endpoint = nodes[item2.endpointId] as any;
        if (!origin || !endpoint) continue;
        samples2 = [origin.position, endpoint.position];
      } else {
        continue;
      }
      
      // Find intersection point between polylines
      let intersection: Vec2 | null = null;
      
      // Helper: segment-segment intersection
      const segmentIntersection = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number): Vec2 | null => {
        const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
        if (Math.abs(denom) < 1e-10) return null;
        const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
        const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
          return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
        }
        return null;
      };
      
      // Check all segment-segment intersections
      for (let i = 0; i < samples1.length - 1 && !intersection; i++) {
        for (let j = 0; j < samples2.length - 1; j++) {
          const inter = segmentIntersection(
            samples1[i].x, samples1[i].y,
            samples1[i + 1].x, samples1[i + 1].y,
            samples2[j].x, samples2[j].y,
            samples2[j + 1].x, samples2[j + 1].y
          );
          if (inter) {
            intersection = inter;
            break;
          }
        }
      }
      
      // If no segment intersection, try infinite line intersection
      if (!intersection) {
        const lineIntersection = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number): Vec2 | null => {
          const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
          if (Math.abs(denom) < 1e-10) return null;
          const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
          return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
        };
        
        const p1Start = samples1[0];
        const p1End = samples1[samples1.length - 1];
        const p2Start = samples2[0];
        const p2End = samples2[samples2.length - 1];
        
        intersection = lineIntersection(
          p1Start.x, p1Start.y,
          p1End.x, p1End.y,
          p2Start.x, p2Start.y,
          p2End.x, p2End.y
        );
      }
      
      if (!intersection) continue;
      
      // Simple direction: just use segment start/end
      const getSimpleDirection = (samples: Vec2[]) => {
        if (samples.length < 2) return { dx: 1, dy: 0 };
        const start = samples[0];
        const end = samples[samples.length - 1];
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1e-6) return { dx: 1, dy: 0 };
        return { dx: dx / len, dy: dy / len };
      };
      
      let dir1 = getSimpleDirection(samples1);
      let dir2 = getSimpleDirection(samples2);
      
      // Flip directions based on click positions
      if (angleNode.segment1ClickPos) {
        const vx = angleNode.segment1ClickPos.x - intersection.x;
        const vy = angleNode.segment1ClickPos.y - intersection.y;
        if (vx * dir1.dx + vy * dir1.dy < 0) {
          dir1 = { dx: -dir1.dx, dy: -dir1.dy };
        }
      }
      if (angleNode.segment2ClickPos) {
        const vx = angleNode.segment2ClickPos.x - intersection.x;
        const vy = angleNode.segment2ClickPos.y - intersection.y;
        if (vx * dir2.dx + vy * dir2.dy < 0) {
          dir2 = { dx: -dir2.dx, dy: -dir2.dy };
        }
      }
      
      // Calculate angles (considering yScale for visual angle)
      const angle1 = Math.atan2(dir1.dy * yScale, dir1.dx);
      const angle2 = Math.atan2(dir2.dy * yScale, dir2.dx);
      
      let ccwAngle = angle2 - angle1;
      while (ccwAngle < 0) ccwAngle += 2 * Math.PI;
      while (ccwAngle >= 2 * Math.PI) ccwAngle -= 2 * Math.PI;
      
      let startAngle = angle1;
      let endAngle: number;
      const wantLargeAngle = angleNode.isLargeAngle || false;
      let preferCCW = ccwAngle < Math.PI;
      
      if (angleNode.segment1ClickPos || angleNode.segment2ClickPos) {
        let sumX = 0, sumY = 0, count = 0;
        if (angleNode.segment1ClickPos) {
          sumX += angleNode.segment1ClickPos.x - intersection.x;
          sumY += angleNode.segment1ClickPos.y - intersection.y;
          count++;
        }
        if (angleNode.segment2ClickPos) {
          sumX += angleNode.segment2ClickPos.x - intersection.x;
          sumY += angleNode.segment2ClickPos.y - intersection.y;
          count++;
        }
        if (count > 0) {
          const avgClickAngle = Math.atan2(sumY / count, sumX / count);
          let relAngle = avgClickAngle - angle1;
          while (relAngle < 0) relAngle += 2 * Math.PI;
          while (relAngle >= 2 * Math.PI) relAngle -= 2 * Math.PI;
          preferCCW = relAngle < ccwAngle;
        }
      }
      
      // Choose angle (inverted logic from PixiStage)
      if (wantLargeAngle) {
        if (!preferCCW) {
          endAngle = (ccwAngle > Math.PI) ? angle2 : (angle2 - 2 * Math.PI);
        } else {
          endAngle = (ccwAngle < Math.PI) ? (angle2 - 2 * Math.PI) : angle2;
        }
      } else {
        if (!preferCCW) {
          endAngle = (ccwAngle < Math.PI) ? angle2 : (angle2 - 2 * Math.PI);
        } else {
          endAngle = (ccwAngle > Math.PI) ? (angle2 - 2 * Math.PI) : angle2;
        }
      }
      
      // Convert radius from pt to world units (same as PixiStage.tsx)
      const radiusPt = angleNode.arcRadiusPt || 20;
      const radiusPx = (radiusPt / 72) * 96; // pt to px at 96 DPI
      const radiusWorld = radiusPx / scale;
      
      // Draw style (same calculation as PixiStage.tsx line 1728-1730)
      // Note: angleNode.style has nested structure { stroke: { color, width } }
      const stroke = (angleNode.style as any)?.stroke ?? { color: '#000000', width: 0.35 };
      const strokeWidthPt = stroke.width || 0.35;
      
      // Calculate stroke width: convert pt to world units with proper scaling
      let sw: number;
      if (mmPerUser) {
        // Use physical size conversion when available (pt -> mm -> user units)
        const strokeWidthMm = strokeWidthPt * PT_TO_MM;
        sw = strokeWidthMm / mmPerUser;
      } else {
        // Fallback: same as PixiStage calculation
        sw = (strokeWidthPt * (96 / 72) * 1.8) / scale;
      }
      
      // Check if right angle style (square)
      if (angleNode.isRightAngle) {
        // Draw square for right angle
        const size = radiusWorld;
        
        // Calculate three corners of the square (starting from intersection)
        // Apply yScale compensation so shape is preserved after flipY
        const c1X = intersection.x + size * Math.cos(startAngle);
        const c1Y = intersection.y + (size * Math.sin(startAngle)) / yScale;
        const c2X = c1X + size * Math.cos(angle2);
        const c2Y = c1Y + (size * Math.sin(angle2)) / yScale;
        const c3X = intersection.x + size * Math.cos(angle2);
        const c3Y = intersection.y + (size * Math.sin(angle2)) / yScale;
        
        // Draw square path
        const squarePath = `M ${c1X} ${flipY(c1Y)} L ${c2X} ${flipY(c2Y)} L ${c3X} ${flipY(c3Y)}`;
        paths.push(`<path d="${squarePath}" fill="none" stroke="${stroke.color}" stroke-width="${sw}" />`);
        if (Number.isFinite(sw)) maxStrokeUser = Math.max(maxStrokeUser, sw);
        
        // Update bounds
        pushBounds(c1X, c1Y);
        pushBounds(c2X, c2Y);
        pushBounds(c3X, c3Y);
      } else {
        // Draw arc (original behavior)
        const totalAngle = endAngle - startAngle;
        const segments = Math.max(8, Math.ceil((Math.abs(totalAngle) * 180 / Math.PI) / 5));
        const arcPoints: string[] = [];
        
        for (let i = 0; i <= segments; i++) {
          const t = i / segments;
          const angle = startAngle + totalAngle * t;
          const x = intersection.x + radiusWorld * Math.cos(angle);
          // Apply yScale compensation to preserve arc shape
          const y = intersection.y + (radiusWorld * Math.sin(angle)) / yScale;
          arcPoints.push(`${i === 0 ? 'M' : 'L'} ${x} ${flipY(y)}`);
          pushBounds(x, y);
        }
        
        paths.push(`<path d="${arcPoints.join(' ')}" fill="none" stroke="${stroke.color}" stroke-width="${sw}" />`);
        if (Number.isFinite(sw)) maxStrokeUser = Math.max(maxStrokeUser, sw);
      }
    } else if (node.kind === 'math-text') {
      const mathText = node as MathTextNode;
      if (includeLabels) {
        // Skip labels attached to hidden axes
        if (mathText.axisId) {
          const axis = nodes[mathText.axisId] as any;
          if (axis && axis.kind === 'axis' && axis.visible === false) {
            continue;
          }
        }
        
        // Use cached label if available (for displayAboveCurves labels)
        let mathSvg: string;
        let worldX: number;
        let worldY: number;
        let estimatedLabelWidth: number;
        let estimatedLabelHeight: number;
        
        const cached = labelRenderCache.get(mathText.id);
        if (cached) {
          // Use cached rendering
          mathSvg = cached.svg;
          worldX = cached.worldX;
          worldY = cached.worldY;
          estimatedLabelWidth = cached.width;
          estimatedLabelHeight = cached.height;
        } else {
          // Render label (for non-displayAboveCurves labels)
          const rawSize = mathText.fontSize ?? 11;
          const fontSize = (rawSize / 11) * 24;
          const color = mathText.color ?? '#000000';
          
          // Calculate actual position considering bezierParentId, offsetPx and axisId
          worldX = mathText.position.x;
          worldY = mathText.position.y;
          
          // If this label is attached to a bezier curve, calculate position from bezierT parameter
          if (mathText.bezierParentId && typeof mathText.bezierT === 'number') {
            const bezier = nodes[mathText.bezierParentId] as any;
            if (bezier && bezier.kind === 'bezier') {
              const a = nodes[bezier.a] as any;
              const b = nodes[bezier.b] as any;
              const c1 = nodes[bezier.c1] as any;
              const c2 = nodes[bezier.c2] as any;
              
              if (a && b && c1 && c2 && a.kind === 'anchor' && b.kind === 'anchor' && c1.kind === 'anchor' && c2.kind === 'anchor') {
                const t = mathText.bezierT;
                const mt = 1 - t;
                // Cubic bezier formula
                worldX = mt*mt*mt*a.position.x + 3*mt*mt*t*c1.position.x + 3*mt*t*t*c2.position.x + t*t*t*b.position.x;
                worldY = mt*mt*mt*a.position.y + 3*mt*mt*t*c1.position.y + 3*mt*t*t*c2.position.y + t*t*t*b.position.y;
              }
            }
          }
          // If this label is attached to an axis with pixel offset, calculate world position from axis endpoint
          else if (mathText.axisId && mathText.offsetPx) {
            const axis = nodes[mathText.axisId] as any;
            if (axis && axis.kind === 'axis') {
              const endpoint = nodes[axis.endpointId] as any;
              if (endpoint && endpoint.kind === 'anchor') {
                // Offset is in pixels, convert to world units (considering yScale for Y)
                worldX = endpoint.position.x + mathText.offsetPx.x / scale;
                worldY = endpoint.position.y - mathText.offsetPx.y / (scale * yScale); // Y is flipped and scaled
              }
            }
          } else if (mathText.offsetPx) {
            // Has offsetPx but no axisId: position is base, add offset in world units
            worldX = mathText.position.x + mathText.offsetPx.x / scale;
            worldY = mathText.position.y - mathText.offsetPx.y / (scale * yScale); // Y is flipped and scaled
          }
          
          // Center-align math text like screen rendering (translate(-50%, -50%))
          mathSvg = await latexToSvg(
            mathText.latex,
            fontSize,
            color,
            worldX,
            flipY(worldY),
            true,
            scale
          );
          
          // Parse width/height for bounds calculation
          const widthMatch = mathSvg.match(/width="([0-9.eE+-]+)"/);
          const heightMatch = mathSvg.match(/height="([0-9.eE+-]+)"/);
          
          if (widthMatch && heightMatch) {
            estimatedLabelWidth = parseFloat(widthMatch[1]);
            estimatedLabelHeight = parseFloat(heightMatch[1]);
          } else {
            // Fallback
            const hasKorean = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/.test(mathText.latex);
            const isRmLabel = mathText.latex.startsWith('rm') && mathText.latex.length > 2;
            if (hasKorean || isRmLabel) {
              const textLength = isRmLabel ? mathText.latex.length - 2 : mathText.latex.length;
              estimatedLabelWidth = (fontSize * RM_EXPORT_SCALE * Math.max(textLength, 1) * 1.0) / scale;
              estimatedLabelHeight = (fontSize * RM_EXPORT_SCALE * 1.5) / scale;
            } else {
              estimatedLabelWidth = (fontSize * Math.max(mathText.latex.length, 2) * 1.0) / scale;
              estimatedLabelHeight = (fontSize * 2.0) / scale;
            }
          }
        }
        
        paths.push(mathSvg);
        
        // Add some margin for safety
        const margin = 0.15; // 15% margin
        const finalWidth = estimatedLabelWidth * (1 + margin);
        const finalHeight = estimatedLabelHeight * (1 + margin);
        
        // pushBounds with worldY (not flipped)
        pushBounds(worldX - finalWidth / 2, worldY - finalHeight / 2);
        pushBounds(worldX + finalWidth / 2, worldY + finalHeight / 2);
      }
    } else if (node.kind === 'filled-region') {
      // Draw filled region using ray casting from center point
      const region = node as FilledRegionNode;
      if (!clipBounds) continue;
      
      const centerX = region.centerPoint.x;
      const centerY = region.centerPoint.y;
      
      // Parse color from RGB string
      const colorMatch = region.fillColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
      if (!colorMatch) continue;
      
      const r = parseInt(colorMatch[1]);
      const g = parseInt(colorMatch[2]);
      const b = parseInt(colorMatch[3]);
      const hexColor = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
      
      // Collect all boundary segments (axes and segments)
      const boundaries: Array<{ start: Vec2; end: Vec2 }> = [];
      
      // Add axis boundaries
      const axesForRegion = Object.values(nodes).filter((n: any) => n.kind === 'axis') as any[];
      for (const axis of axesForRegion) {
        const origin = nodes[axis.originId] as any;
        const endpoint = nodes[axis.endpointId] as any;
        if (origin && endpoint) {
          boundaries.push({
            start: { x: origin.position.x, y: origin.position.y },
            end: { x: endpoint.position.x, y: endpoint.position.y }
          });
        }
      }
      
      // Add segment boundaries
      const segmentsForRegion = Object.values(nodes).filter((n: any) => n.kind === 'segment' && !n.hidden) as any[];
      for (const seg of segmentsForRegion) {
        if (seg.samples && seg.samples.length >= 2) {
          for (let i = 0; i < seg.samples.length - 1; i++) {
            boundaries.push({
              start: { x: seg.samples[i].x, y: seg.samples[i].y },
              end: { x: seg.samples[i + 1].x, y: seg.samples[i + 1].y }
            });
          }
        }
      }
      
      // Ray casting: cast rays from center point to find boundaries
      const numRays = 360;
      const maxDistance = Math.max(
        Math.abs(clipBounds.xMax - clipBounds.xMin),
        Math.abs(clipBounds.yMax - clipBounds.yMin)
      ) * 2;
      
      const boundaryPoints: Vec2[] = [];
      
      // Helper: ray-segment intersection
      const raySegmentIntersection = (
        rayX: number, rayY: number, rayDirX: number, rayDirY: number,
        segX1: number, segY1: number, segX2: number, segY2: number
      ): { distance: number } | null => {
        const segDx = segX2 - segX1;
        const segDy = segY2 - segY1;
        
        const cross = rayDirX * segDy - rayDirY * segDx;
        if (Math.abs(cross) < 1e-10) return null; // Parallel
        
        const t = ((segX1 - rayX) * segDy - (segY1 - rayY) * segDx) / cross;
        const u = ((segX1 - rayX) * rayDirY - (segY1 - rayY) * rayDirX) / cross;
        
        if (t >= 0 && u >= 0 && u <= 1) {
          return { distance: t };
        }
        
        return null;
      };
      
      // Helper: ray-rectangle intersection
      const rayRectIntersection = (
        rayX: number, rayY: number, rayDirX: number, rayDirY: number,
        rect: { xMin: number; xMax: number; yMin: number; yMax: number }
      ): number | null => {
        const edges = [
          { x1: rect.xMin, y1: rect.yMin, x2: rect.xMax, y2: rect.yMin },
          { x1: rect.xMax, y1: rect.yMin, x2: rect.xMax, y2: rect.yMax },
          { x1: rect.xMax, y1: rect.yMax, x2: rect.xMin, y2: rect.yMax },
          { x1: rect.xMin, y1: rect.yMax, x2: rect.xMin, y2: rect.yMin },
        ];
        
        let minDist: number | null = null;
        
        for (const edge of edges) {
          const result = raySegmentIntersection(
            rayX, rayY, rayDirX, rayDirY,
            edge.x1, edge.y1, edge.x2, edge.y2
          );
          
          if (result && (minDist === null || result.distance < minDist)) {
            minDist = result.distance;
          }
        }
        
        return minDist;
      };
      
      for (let i = 0; i < numRays; i++) {
        const angle = (i / numRays) * 2 * Math.PI;
        const dirX = Math.cos(angle);
        const dirY = Math.sin(angle);
        
        let closestDist = maxDistance;
        let foundIntersection = false;
        
        // Cast ray and find nearest boundary intersection
        for (const boundary of boundaries) {
          const intersection = raySegmentIntersection(
            centerX, centerY, dirX, dirY,
            boundary.start.x, boundary.start.y,
            boundary.end.x, boundary.end.y
          );
          
          if (intersection && intersection.distance < closestDist) {
            closestDist = intersection.distance;
            foundIntersection = true;
          }
        }
        
        // Also check clip bounds
        const clipIntersection = rayRectIntersection(
          centerX, centerY, dirX, dirY, clipBounds
        );
        if (clipIntersection && clipIntersection < closestDist) {
          closestDist = clipIntersection;
          foundIntersection = true;
        }
        
        if (foundIntersection) {
          boundaryPoints.push({
            x: centerX + dirX * closestDist,
            y: centerY + dirY * closestDist
          });
        }
      }
      
      // Draw the filled polygon
      if (boundaryPoints.length >= 3) {
        const pathData = boundaryPoints.map((p, i) => 
          `${i === 0 ? 'M' : 'L'} ${p.x} ${flipY(p.y)}`
        ).join(' ') + ' Z';
        
        paths.push(`<path d="${pathData}" fill="${hexColor}" fill-opacity="1.0" />`);
        
        // Update bounds
        boundaryPoints.forEach(p => pushBounds(p.x, p.y));
      }
    }
  }
  
  // Render point nodes last (on top of everything)
  for (const node of pointNodes) {
    const pointNode = node as PointNode;
    // SVG export: always use 1.35mm regardless of screen diameterMm (which is 2.3mm)
    const diameterMm = 1.2;
    const color = pointNode.color ?? '#000000';
    
    // Convert diameter from mm to world units to match screen rendering
    // Screen uses: mmToWorld(mm, scale, dpr) = (mm / 25.4) * 96 * dpr / scale
    // For SVG export (vector, no dpr), we use dpr=1 equivalent
    let radiusWorld: number;
    if (mmPerUser) {
      // Use physical size conversion when available
      radiusWorld = (diameterMm / 2) / mmPerUser;
    } else {
      // Fallback: convert mm to world units (same as screen with dpr=1)
      // mm -> px (at 96 DPI) -> world units
      const diameterPx = (diameterMm / 25.4) * 96;
      const diameterWorld = diameterPx / scale;
      radiusWorld = diameterWorld / 2;
    }
    
    // Draw main circle
    const cx = pointNode.position.x;
    const cy = flipY(pointNode.position.y);
    paths.push(`<circle cx="${cx}" cy="${cy}" r="${radiusWorld}" fill="${color}" />`);
    
    // Draw stroke if specified
    if (pointNode.strokeColor && pointNode.strokeWidth) {
      const strokeWidthPt = pointNode.strokeWidth;
      const strokeWidthWorld = mmPerUser 
        ? (strokeWidthPt * PT_TO_MM) / mmPerUser 
        : (strokeWidthPt * (96 / 72)) / scale;
      paths.push(`<circle cx="${cx}" cy="${cy}" r="${radiusWorld}" fill="none" stroke="${pointNode.strokeColor}" stroke-width="${strokeWidthWorld}" />`);
      if (Number.isFinite(strokeWidthWorld)) maxStrokeUser = Math.max(maxStrokeUser, strokeWidthWorld);
    }
    
    // Update bounds
    pushBounds(cx, pointNode.position.y - radiusWorld);
    pushBounds(cx, pointNode.position.y + radiusWorld);
    pushBounds(cx - radiusWorld, pointNode.position.y);
    pushBounds(cx + radiusWorld, pointNode.position.y);
  }
  
  // Origin label removed - now handled as regular math-text node

  // Determine content bounds (drawn elements only)
  let contentMinX = minX, contentMinY = minY, contentMaxX = maxX, contentMaxY = maxY;
  if (!isFinite(contentMinX)) {
    contentMinX = -100; contentMinY = -100; contentMaxX = 100; contentMaxY = 100;
  }
  const contentWidth = contentMaxX - contentMinX;
  const contentHeight = contentMaxY - contentMinY;

  // Decide viewBox and output size
  let vb: string;
  let outWStr: string;
  let outHStr: string;
  const fitToContent = opts?.fitToContent ?? false;
  const usePad = fitToContent ? (opts?.padding ?? 0) : (opts?.padding ?? 8);
  // Ensure at least half of the thickest stroke is padded so edges are not clipped
  const strokePad = Math.max(0, maxStrokeUser * 0.5);
  const finalPad = Math.max(usePad, strokePad);

  if (fitToContent) {
    // Tight to content bounds
    const vbX = contentMinX - finalPad;
    const vbY = contentMinY - finalPad;
    const vbW = contentWidth + finalPad * 2;
    const vbH = contentHeight + finalPad * 2;
    vb = `${vbX} ${vbY} ${vbW} ${vbH}`;

    // Output physical size in mm if mapping provided and viewport known
    if (opts?.physicalCanvasMm && opts?.viewportPx) {
      const mmPerPxX = opts.physicalCanvasMm / Math.max(1e-6, opts.viewportPx.width);
      const mmPerPxY = opts.physicalCanvasMm / Math.max(1e-6, opts.viewportPx.height);
      const outWmm = vbW * scale * mmPerPxX;
      const outHmm = vbH * scale * mmPerPxY;
      outWStr = `${outWmm}mm`;
      outHStr = `${outHmm}mm`;
    } else {
      // Fallback to previous px scaling
      const outputScale = 30;
      outWStr = String((vbW) * outputScale);
      outHStr = String((vbH) * outputScale);
    }
  } else if (haveViewport && clipToView && viewBounds) {
    const xMin = viewBounds.xMin;
    const xMax = viewBounds.xMax;
    const yMinW = viewBounds.yMin; // world
    const yMaxW = viewBounds.yMax;
    const minXSvg = xMin - finalPad;
    const minYSvg = flipY(yMaxW) - finalPad; // flip world yMax to svg minY
    const widthSvg = (xMax - xMin) + finalPad * 2;
    const heightSvg = (yMaxW - yMinW) + finalPad * 2;
    vb = `${minXSvg} ${minYSvg} ${widthSvg} ${heightSvg}`;
    // Keep WYSIWYG: output in px matching viewport
    outWStr = String(opts!.viewportPx!.width);
    outHStr = String(opts!.viewportPx!.height);
  } else {
    const vbX = contentMinX - finalPad;
    const vbY = contentMinY - finalPad;
    const vbW = contentWidth + finalPad * 2;
    const vbH = contentHeight + finalPad * 2;
    vb = `${vbX} ${vbY} ${vbW} ${vbH}`;
    const outputScale = 30;
    outWStr = String((vbW) * outputScale);
    outHStr = String((vbH) * outputScale);
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${vb}" width="${outWStr}" height="${outHStr}">
${paths.join('\n')}
</svg>`;
  return { svg, boundsWorld: { minX: contentMinX, minY: contentMinY, maxX: contentMaxX, maxY: contentMaxY } };
}

export async function sceneToSVG(scene: Scene, opts?: SvgExportOptions) {
  const { svg } = await sceneToSVGWithMetrics(scene, opts);
  return svg;
}

export async function measureDrawnBoundsMm(
  scene: Scene,
  viewportPx: { width: number; height: number },
  options?: { includeLabels?: boolean; physicalCanvasMm?: number }
): Promise<{ widthMm: number; heightMm: number }> {
  const includeLabels = options?.includeLabels ?? false;
  const { boundsWorld } = await sceneToSVGWithMetrics(scene, {
    viewportPx,
    clipToView: true,
    includeLabels,
    fitToContent: true,
    padding: 0
  });
  const scale = scene.view.scale;
  const mmPerPxX = (options?.physicalCanvasMm ?? 100) / Math.max(1e-6, viewportPx.width);
  const mmPerPxY = (options?.physicalCanvasMm ?? 100) / Math.max(1e-6, viewportPx.height);
  const wWorld = Math.max(0, boundsWorld.maxX - boundsWorld.minX);
  const hWorld = Math.max(0, boundsWorld.maxY - boundsWorld.minY);
  const widthMm = wWorld * scale * mmPerPxX;
  const heightMm = hWorld * scale * mmPerPxY;
  return { widthMm, heightMm };
}


