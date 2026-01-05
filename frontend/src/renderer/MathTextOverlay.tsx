import { useEffect, useRef } from 'react';
import 'mathlive';
import type { MathfieldElement } from 'mathlive';
import { useSceneStore } from '../state/store';
import { generateStableId } from '../shared/types';

export function MathTextOverlay() {
  const mathTextFieldRef = useRef<MathfieldElement | null>(null);
  const upsertNode = useSceneStore(s => s.upsertNode);

  const handleAddMathText = () => {
    if (!mathTextFieldRef.current) return;
    const mf = mathTextFieldRef.current as any;
    let latex = (mf.value || '').trim();
    if (!latex) return;
    
    // 디버깅: latex 값과 각 문자의 코드 포인트 출력
    console.log('[MathTextOverlay] latex 원본:', latex);
    console.log('[MathTextOverlay] latex 길이:', latex.length);
    console.log('[MathTextOverlay] 각 문자 코드포인트:', 
      [...latex].map((c, i) => `[${i}] '${c}' = U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(', ')
    );
    
    // MathLive가 삽입하는 invisible operators 제거 (함수-괄호 간격 문제 해결)
    // U+2061: Function Application, U+2062: Invisible Times, U+2063: Invisible Separator, U+2064: Invisible Plus
    latex = latex.replace(/[\u2061\u2062\u2063\u2064]/g, '');
    // \left( 앞에 \! (negative space) 삽입하여 간격 줄임 (단, 첫 글자가 괄호인 경우 제외)
    latex = latex.replace(/(.)(\\left\()/g, '$1\\!$2');
    upsertNode({
      id: generateStableId('math-text'),
      kind: 'math-text' as const,
      latex,
      position: { x: 0, y: 0 },
      fontSize: 11,
      color: '#000000'
    });
    mf.value = '';
  };

  useEffect(() => {
    const mf = mathTextFieldRef.current as any;
    if (!mf) return;
    mf.setOptions({
      inlineShortcuts: {
        ...mf.getOptions?.('inlineShortcuts'),
        abs: '\\left|#@\\right|',
      },
      defaultMode: 'math',
      smartFence: true,
    });
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
      * { background-color: transparent !important; }
    `;
    mf.shadowRoot?.appendChild(style);
  }, []);

  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        zIndex: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 12px',
        borderRadius: 12,
        background: '#4a4a4a',
        backdropFilter: 'blur(20px)',
        boxShadow: '0 2px 12px rgba(0,0,0,0.1)',
        pointerEvents: 'auto',
        contain: 'layout style paint'
      }}
      onWheel={(e) => { e.stopPropagation(); e.preventDefault(); }}
      onMouseDown={(e) => { e.stopPropagation(); }}
      onMouseMove={(e) => { e.stopPropagation(); }}
      onTouchStart={(e) => { e.stopPropagation(); }}
      onTouchMove={(e) => { e.stopPropagation(); }}
    >
      {/* @ts-expect-error custom element */}
      <math-field
        ref={mathTextFieldRef}
        virtual-keyboard-mode="off"
        use-shared-virtual-keyboard={false}
        virtual-keyboard-container="none"
        style={{
          width: 260,
          maxWidth: 260,
          fontSize: '16px',
          border: 'none',
          background: 'transparent',
          color: '#fff',
          fontWeight: 400,
          overflow: 'hidden',
          flexShrink: 0
        }}
        onKeyDown={(e: any) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            handleAddMathText();
          }
        }}
        onInput={(e: any) => { e.stopPropagation(); }}
        onBeforeInput={(e: any) => { e.stopPropagation(); }}
      />
      <button
        onClick={handleAddMathText}
        style={{
          padding: '6px 12px',
          background: 'rgba(255,255,255,0.12)',
          border: 'none',
          borderRadius: 8,
          color: '#fff',
          cursor: 'pointer',
          fontSize: 13,
          fontWeight: 600,
          transition: 'all 0.2s',
          whiteSpace: 'nowrap'
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.2)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
      >
        입력
      </button>
    </div>
  );
}


