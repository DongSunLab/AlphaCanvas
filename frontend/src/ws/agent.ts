import { useSceneStore } from '../state/store';

export type AgentMessage =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'message', data: any };

export type AgentEvent = { type: string; payload: any };

export class AgentClient {
  private ws: WebSocket | null = null;
  private subs = new Set<(msg: AgentMessage) => void>();
  private sessionId: string | null = null;  // Thread/Session ID
  private responseId: string | null = null;  // Previous Response ID
  private history: any[] = [];  // 대화 이력
  private currentStreamRequestId: string | null = null;  // 현재 스트리밍 중인 요청 ID
  private openaiApiKey: string | null = null; // 메모리(미저장 모드용)
  private geminiApiKey: string | null = null; // 메모리(미저장 모드용)
  private claudeApiKey: string | null = null; // 메모리(미저장 모드용)

  private buildWsUrl(baseUrl: string): string {
    // 브라우저 WebSocket은 Authorization 헤더를 임의로 붙일 수 없어서,
    // 운영 인증은 query param token 방식이 가장 간단합니다.
    const token =
      (import.meta as any).env?.VITE_WS_AUTH_TOKEN ||
      (localStorage.getItem('alphacanvas_ws_token') || '').trim();
    if (!token) return baseUrl;
    try {
      const u = new URL(baseUrl);
      // 이미 token이 있으면 덮어쓰기
      u.searchParams.set('token', String(token));
      return u.toString();
    } catch {
      // URL 파싱 실패 시(상대경로 등) 원본 유지
      return baseUrl;
    }
  }

  setApiKeys(keys: { openai?: string | null; gemini?: string | null; claude?: string | null }) {
    if (typeof keys.openai !== 'undefined') this.openaiApiKey = (keys.openai || '').trim() || null;
    if (typeof keys.gemini !== 'undefined') this.geminiApiKey = (keys.gemini || '').trim() || null;
    if (typeof keys.claude !== 'undefined') this.claudeApiKey = (keys.claude || '').trim() || null;
  }

  connect(url?: string) {
    if (this.ws) return;

    // 현재 페이지가 HTTPS면 WSS 사용, HTTP면 WS 사용
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

    // 백엔드 포트 결정
    // - 프로덕션(빌드): 같은 포트 사용
    // - 개발(npm run dev): 8000 포트 사용
    const isProduction = import.meta.env.PROD;
    const port = isProduction
      ? (location.port || (location.protocol === 'https:' ? '443' : '80'))
      : '8000';

    // (선택) VITE_WS_URL로 완전한 ws/wss URL을 오버라이드 가능
    const envUrl = (import.meta as any).env?.VITE_WS_URL as string | undefined;
    const base = url || envUrl || `${protocol}//${location.hostname}:${port}/ws`;
    const wsUrl = this.buildWsUrl(base);

    console.log('[AgentClient] Connecting to:', wsUrl);
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    ws.addEventListener('open', () => {
      console.log('[AgentClient] WebSocket opened');

      // WebSocket 연결 시 세션 유지 (새로고침 시 자동으로 새 Agent가 생성되어 초기화됨)
      // clearHistory()를 호출하지 않음 → 같은 페이지 내에서 대화 유지

      this.emit({ type: 'open' });
    });
    ws.addEventListener('close', () => {
      console.log('[AgentClient] WebSocket closed');
      this.emit({ type: 'close' });
    });
    ws.addEventListener('error', (err) => {
      console.error('[AgentClient] WebSocket error:', err);
    });
    ws.addEventListener('message', (ev) => {
      try {
        const data = JSON.parse(ev.data);
        console.log('[AgentClient] Received:', data.type);

        // Session 관리
        if (data.type === 'Agent/Session.Init' || data.type === 'Agent/Session.Update') {
          const threadId = data.payload?.threadId;
          const responseId = data.payload?.responseId;

          if (threadId && threadId !== this.sessionId) {
            this.sessionId = threadId;
            console.log('[AgentClient] Session ID updated:', this.sessionId);
          }

          if (responseId && responseId !== this.responseId) {
            this.responseId = responseId;
            console.log('[AgentClient] Response ID updated:', this.responseId);
          }
        }

        // 스트림 시작 시 requestId 저장 (백엔드 응답용)
        if (data.type === 'Agent/Stream.Start') {
          const requestId = data.requestId;
          if (requestId && requestId !== this.currentStreamRequestId) {
            this.currentStreamRequestId = requestId;
            console.log('[AgentClient] Stream started, requestId saved:', this.currentStreamRequestId);
          }
        }

        // 스트림 종료 시 requestId 초기화
        if (data.type === 'Agent/Stream.End' || data.type === 'Agent/Stream.Aborted') {
          this.currentStreamRequestId = null;
          console.log('[AgentClient] Stream ended, requestId cleared');
        }

        this.emit({ type: 'message', data });
      } catch (e) {
        console.error('[AgentClient] Parse error:', e);
      }
    });
  }

  dispose() {
    try { this.ws?.close(); } catch { }
    this.ws = null;
    this.subs.clear();
    this.sessionId = null;
    this.responseId = null;
    this.history = [];
  }

  subscribe(fn: (msg: AgentMessage) => void) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private emit(msg: AgentMessage) {
    for (const fn of this.subs) try { fn(msg); } catch { }
  }

  sendChat(text: string, opts?: { system?: string; history?: any[]; graphState?: any; images?: any[]; model?: string }) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('[AgentClient] Cannot send chat - WebSocket not open, state:', this.ws?.readyState);
      return;
    }

    const requestId = Math.random().toString(36).slice(2);
    this.currentStreamRequestId = requestId;  // 현재 스트림 요청 ID 저장

    // 그래프 상태 포함 (opts로 전달되거나 store에서 직접 가져오기)
    let graphState = opts?.graphState;
    if (!graphState) {
      const store = useSceneStore.getState();
      graphState = {
        nodes: store.scene.nodes,
        view: store.scene.view,
        zIndex: store.scene.zIndex
      };
    }

    const payload: any = {
      text,
      system: opts?.system,
      // history는 제거 - OpenAI Agents SDK가 thread_id로 자동 관리
      graphState  // 그래프 상태 추가
    };

    // 사용자별 API 키 (로컬 저장) - 백엔드에서 요청별로 사용
    // NOTE: 키를 서버로 전송하는 방식이므로, 운영 환경에서는 TLS(HTTPS/WSS) 필수 권장
    const openaiKey = (this.openaiApiKey ?? (localStorage.getItem('alphacanvas_openai_api_key') || '')).trim();
    const geminiKey = (this.geminiApiKey ?? (localStorage.getItem('alphacanvas_gemini_api_key') || '')).trim();
    const claudeKey = (this.claudeApiKey ?? (localStorage.getItem('alphacanvas_claude_api_key') || '')).trim();
    if (openaiKey.trim()) payload.apiKey = openaiKey.trim();
    if (geminiKey.trim()) payload.geminiApiKey = geminiKey.trim();
    if (claudeKey.trim()) payload.claudeApiKey = claudeKey.trim();

    // 모델 선택 포함
    if (opts?.model) {
      payload.model = opts.model;
      console.log('[AgentClient] Including model:', opts.model);
    }

    // 이미지 포함
    if (opts?.images && opts.images.length > 0) {
      payload.images = opts.images;
      console.log('[AgentClient] Including images:', opts.images.length);
    }

    // Session ID 포함 (OpenAI thread_id)
    if (this.sessionId) {
      payload.sessionId = this.sessionId;
      console.log('[AgentClient] Including sessionId (thread_id):', this.sessionId);
    }

    // Response ID 포함 (이전 응답 ID)
    if (this.responseId) {
      payload.responseId = this.responseId;
      console.log('[AgentClient] Including responseId:', this.responseId);
    }

    const msg = { type: 'Agent/Chat.Request', requestId, payload };
    console.log('[AgentClient] Sending chat:', {
      requestId,
      text: text.substring(0, 50),
      model: opts?.model,
      sessionId: this.sessionId,
      responseId: this.responseId,
      graphStateNodes: Object.keys(graphState?.nodes || {}).length,
      imagesCount: opts?.images?.length || 0
    });
    this.ws.send(JSON.stringify(msg));

    // 대화 이력 업데이트
    this.history.push({ role: 'user', content: text });
  }

  abortStream(): void {
    console.log('[AgentClient] abortStream 호출됨');
    console.log('[AgentClient] currentStreamRequestId:', this.currentStreamRequestId);
    console.log('[AgentClient] ws:', this.ws);
    console.log('[AgentClient] ws.readyState:', this.ws?.readyState);

    if (!this.currentStreamRequestId) {
      console.warn('[AgentClient] No active stream to abort - currentStreamRequestId is null');
      return;
    }

    console.log('[AgentClient] Aborting stream:', this.currentStreamRequestId);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const abortMsg = {
        type: 'Agent/Stream.Abort',
        requestId: this.currentStreamRequestId
      };
      console.log('[AgentClient] Sending abort message:', abortMsg);
      this.ws.send(JSON.stringify(abortMsg));
      console.log('[AgentClient] Abort message sent');
    } else {
      console.error('[AgentClient] WebSocket is not open, readyState:', this.ws?.readyState);
    }

    this.currentStreamRequestId = null;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getHistory(): any[] {
    return [...this.history];
  }

  clearHistory(): void {
    this.history = [];
    this.sessionId = null;
    this.responseId = null;
    console.log('[AgentClient] History cleared (session & response IDs reset)');

    // 백엔드에 세션 초기화 요청
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const requestId = Math.random().toString(36).slice(2);
      this.ws.send(JSON.stringify({
        type: 'Agent/Session.Clear',
        requestId
      }));
      console.log('[AgentClient] Sent session clear request to backend');
    }
  }
}

// 수식 변환 헬퍼 함수 (Draw/Function과 동일한 로직)
function convertMathExpression(rawExpr: string, isImplicit: boolean = false): string {
  const mathFunctions = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
    'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
    'sqrt', 'cbrt', 'log', 'log2', 'log10', 'ln', 'exp', 'abs',
    'floor', 'ceil', 'round', 'sign', 'min', 'max', 'pow'];

  let expr = rawExpr
    .replace(/\\left/g, '')
    .replace(/\\right/g, '')
    .replace(/\\cdot/g, '*')
    .replace(/\\times/g, '*')
    .replace(/·/g, '*')
    .replace(/\^/g, '**')
    .replace(/(\d)([a-zA-Z])/g, '$1*$2')
    .replace(/(\))([a-zA-Z])/g, '$1*$2')
    .replace(/\)\s*\(/g, ')*(')
    .replace(/(\d)\s*\(/g, '$1*(')
    .replace(/\)\s*(\d)/g, ')*$1');

  expr = expr.replace(/([+\-*/=(,\s]|^)-(\w+)\*\*(\w+)/g, (_m: string, prefix: string, base: string, exp: string) => {
    const p = prefix === '-' ? '' : prefix;
    return `${p}-(${base}**${exp})`;
  });

  expr = expr.replace(/([a-zA-Z])(\()/g, (match: string, letter: string, paren: string, offset: number) => {
    const beforeMatch = expr.slice(0, offset + 1);
    for (const fn of mathFunctions) {
      if (beforeMatch.endsWith(fn)) {
        return match;
      }
    }
    return `${letter}*${paren}`;
  });

  if (isImplicit) {
    expr = expr.replace(/([xy])([xy])/g, '$1*$2');
  }

  return expr;
}

export type ApplyResult = { success: true; message?: string } | { success: false; error: string };

export function applyAgentEventToStore(event: AgentEvent, store: typeof useSceneStore): ApplyResult {
  const s = store.getState();
  const allocateFunctionSymbol = s.allocateFunctionSymbol;
  if (event.type === 'Draw/Segment') {
    const id = event.payload.id;
    const aId = s.createAnchor({ x: event.payload.p1[0], y: event.payload.p1[1] });
    const bId = s.createAnchor({ x: event.payload.p2[0], y: event.payload.p2[1] });
    s.upsertNode({
      id,
      kind: 'segment',
      functionId: '',
      startAnchorId: aId,
      endAnchorId: bId,
      samples: [{ x: event.payload.p1[0], y: event.payload.p1[1] }, { x: event.payload.p2[0], y: event.payload.p2[1] }],
      style: event.payload.style,
      extendStart: !!event.payload.extendStart,
      extendEnd: !!event.payload.extendEnd,
    } as any);
    return { success: true, message: `세그먼트 ${id} 생성됨` };
  }
  if (event.type === 'Draw/Line') {
    const id = event.payload.id;
    const aId = s.createAnchor({ x: event.payload.p1[0], y: event.payload.p1[1] });
    const bId = s.createAnchor({ x: event.payload.p2[0], y: event.payload.p2[1] });
    s.upsertNode({ id, kind: 'line', a: aId, b: bId, style: event.payload.style } as any);
    return { success: true, message: `직선 ${id} 생성됨` };
  }
  if (event.type === 'Draw/Bezier') {
    const id = event.payload.id;
    const a = s.createAnchor({ x: event.payload.a[0], y: event.payload.a[1] });
    const b = s.createAnchor({ x: event.payload.b[0], y: event.payload.b[1] });
    const c1 = s.createAnchor({ x: event.payload.c1[0], y: event.payload.c1[1] });
    const c2 = s.createAnchor({ x: event.payload.c2[0], y: event.payload.c2[1] });
    s.upsertNode({ id, kind: 'bezier', a, b, c1, c2, style: event.payload.style } as any);
    return { success: true, message: `베지어 ${id} 생성됨` };
  }
  if (event.type === 'Draw/Arrow') {
    const id = event.payload.id;
    const a = s.createAnchor({ x: event.payload.a[0], y: event.payload.a[1] });
    const b = s.createAnchor({ x: event.payload.b[0], y: event.payload.b[1] });
    const c1 = s.createAnchor({ x: event.payload.c1[0], y: event.payload.c1[1] });
    const c2 = s.createAnchor({ x: event.payload.c2[0], y: event.payload.c2[1] });
    s.upsertNode({
      id,
      kind: 'arrow',
      a,
      b,
      c1,
      c2,
      style: event.payload.style,
      showStartArrow: event.payload.showStartArrow ?? false,
      showEndArrow: event.payload.showEndArrow ?? true,
      arrowSize: event.payload.arrowSize ?? 3.0,
    } as any);
    return { success: true, message: `화살표 ${id} 생성됨` };
  }
  if (event.type === 'Draw/LengthBezier') {
    const id = event.payload.id;
    const a = s.createAnchor({ x: event.payload.a[0], y: event.payload.a[1] });
    const b = s.createAnchor({ x: event.payload.b[0], y: event.payload.b[1] });
    const c1 = s.createAnchor({ x: event.payload.c1[0], y: event.payload.c1[1] });
    const c2 = s.createAnchor({ x: event.payload.c2[0], y: event.payload.c2[1] });
    const labelIds = event.payload.labelIds || [];

    // 베지어 곡선 생성
    s.upsertNode({ id, kind: 'bezier', a, b, c1, c2, style: event.payload.style, labelIds } as any);

    // 라벨이 제공된 경우 자동으로 math-text 생성
    if (event.payload.labelText && event.payload.labelId && event.payload.labelPosition) {
      s.upsertNode({
        id: event.payload.labelId,
        kind: 'math-text',
        latex: event.payload.labelText,
        position: { x: event.payload.labelPosition[0], y: event.payload.labelPosition[1] },
        fontSize: 11,
        color: '#000000',
        bezierParentId: id,
        bezierT: 0.5,
        displayAboveCurves: true  // 곡선 위에 클리핑되어 표시
      } as any);
      console.log(`[Agent] Length-bezier label created: ${event.payload.labelText} at (${event.payload.labelPosition[0]}, ${event.payload.labelPosition[1]})`);
    }

    return { success: true, message: `길이 베지어 ${id} 생성됨` };
  }
  if (event.type === 'Draw/Point') {
    s.addPoint({ x: event.payload.position[0], y: event.payload.position[1] }, event.payload.diameterMm, event.payload.color);
    return { success: true, message: `점 생성됨 at (${event.payload.position[0]}, ${event.payload.position[1]})` };
  }
  if (event.type === 'Draw/FilledRegion') {
    s.upsertNode({ id: event.payload.id, kind: 'filled-region', centerPoint: { x: event.payload.centerPoint[0], y: event.payload.centerPoint[1] }, fillColor: event.payload.fillColor } as any);
    s.setZIndex(event.payload.id, -100);
    return { success: true, message: `채워진 영역 ${event.payload.id} 생성됨` };
  }
  if (event.type === 'Draw/Function') {
    const id = event.payload.id;
    const rawExpr = event.payload.expression;

    // Known math functions that should NOT have * inserted before (
    const mathFunctions = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
      'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
      'sqrt', 'cbrt', 'log', 'log2', 'log10', 'ln', 'exp', 'abs',
      'floor', 'ceil', 'round', 'sign', 'min', 'max', 'pow'];

    // Convert math notation to JS (x^2 → x**2, 2x → 2*x)
    // NOTE: Keep this in sync with `shared/latexToJS.ts` implicit multiplication rules.
    // AI often emits implicit multiplication like (x-1)(x-3) which MUST become (x-1)*(x-3).
    let expr = rawExpr
      // tolerate LaTeX-ish wrappers frequently produced by LLMs
      .replace(/\\left/g, '')
      .replace(/\\right/g, '')
      .replace(/\\cdot/g, '*')
      .replace(/\\times/g, '*')
      .replace(/·/g, '*')
      .replace(/\^/g, '**')
      .replace(/(\d)([a-zA-Z])/g, '$1*$2')
      .replace(/(\))([a-zA-Z])/g, '$1*$2')
      // )(... -> )*(...  (critical for (x-1)(x-3))
      .replace(/\)\s*\(/g, ')*(')
      // 2(... -> 2*(...
      .replace(/(\d)\s*\(/g, '$1*(')
      // )2 -> )*2  (rare but valid implicit multiplication)
      .replace(/\)\s*(\d)/g, ')*$1');

    // Fix: JavaScript doesn't allow unary minus directly before ** (e.g., -x**2 is a syntax error)
    // We need to wrap in parentheses: -x**2 → -(x**2)
    expr = expr.replace(/([+\-*/=(,\s]|^)-(\w+)\*\*(\w+)/g, (_m: string, prefix: string, base: string, exp: string) => {
      const p = prefix === '-' ? '' : prefix; // avoid double negative
      return `${p}-(${base}**${exp})`;
    });

    // Only insert * before ( if NOT preceded by a known function name
    // This handles cases like x( → x*( but NOT sqrt( → sqrt*(
    expr = expr.replace(/([a-zA-Z])(\()/g, (match: string, letter: string, paren: string, offset: number) => {
      // Check if this letter is part of a known function name
      const beforeMatch = expr.slice(0, offset + 1); // includes the letter
      for (const fn of mathFunctions) {
        if (beforeMatch.endsWith(fn)) {
          return match; // Keep as is (function call)
        }
      }
      return `${letter}*${paren}`; // Insert multiplication
    });

    console.log(`[Agent] Draw/Function: ${rawExpr} → ${expr}`);

    // Allocate unique function symbol (f, g, h, ...)
    const symbol = allocateFunctionSymbol();

    // Use consistent style with manual drawing (black, 0.8 width)
    const defaultStyle = { stroke: { color: '#000000', width: 0.8 } };
    const style = event.payload.style
      ? {
          ...event.payload.style,
          stroke: {
            ...event.payload.style.stroke,
            color: event.payload.style.stroke?.color ?? '#000000',
            width: event.payload.style.stroke?.width || 0.8,
          },
        }
      : defaultStyle;

    // 정의역 처리: payload에 domain이 있으면 사용, 없으면 기본값 [-10, 10]
    const domain = event.payload.domain
      ? [event.payload.domain[0], event.payload.domain[1]] as [number, number]
      : [-10, 10] as [number, number];

    // clipToAxes: domain이 명시적으로 제공된 경우 false, 아니면 true
    const clipToAxes = !event.payload.domain;

    console.log(`[Agent] Function domain: [${domain[0]}, ${domain[1]}], clipToAxes: ${clipToAxes}`);

    s.upsertNode({
      id,
      kind: 'function-explicit',
      expr,
      variable: 'x',
      domain,
      style,
      label: rawExpr,  // label은 원본 표기법 사용
      symbol,  // 고유 함수 심볼 (f, g, h, ...)
      clipToAxes
    } as any);
    return { success: true, message: `함수 ${symbol}(x) = ${rawExpr} 생성됨` };
  }
  if (event.type === 'Draw/FunctionImplicit') {
    const id = event.payload.id;
    const rawExpr = event.payload.expression;

    // Known math functions that should NOT have * inserted before (
    const mathFunctions = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
      'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
      'sqrt', 'cbrt', 'log', 'log2', 'log10', 'ln', 'exp', 'abs',
      'floor', 'ceil', 'round', 'sign', 'min', 'max', 'pow'];

    // Convert math notation to JS (x^2 → x**2, 2x → 2*x, xy → x*y)
    // NOTE: Keep this in sync with `shared/latexToJS.ts` implicit multiplication rules.
    let expr = rawExpr
      // tolerate LaTeX-ish wrappers frequently produced by LLMs
      .replace(/\\left/g, '')
      .replace(/\\right/g, '')
      .replace(/\\cdot/g, '*')
      .replace(/\\times/g, '*')
      .replace(/·/g, '*')
      .replace(/\^/g, '**')
      .replace(/(\d)([a-zA-Z])/g, '$1*$2')
      .replace(/(\))([a-zA-Z])/g, '$1*$2')
      // )(... -> )*(...
      .replace(/\)\s*\(/g, ')*(')
      // 2(... -> 2*(...
      .replace(/(\d)\s*\(/g, '$1*(')
      // )2 -> )*2
      .replace(/\)\s*(\d)/g, ')*$1');

    // Fix: JavaScript doesn't allow unary minus directly before ** (e.g., -x**2 is a syntax error)
    // We need to wrap in parentheses: -x**2 → -(x**2)
    expr = expr.replace(/([+\-*/=(,\s]|^)-(\w+)\*\*(\w+)/g, (_m: string, prefix: string, base: string, exp: string) => {
      const p = prefix === '-' ? '' : prefix;
      return `${p}-(${base}**${exp})`;
    });

    // Only insert * before ( if NOT preceded by a known function name
    expr = expr.replace(/([a-zA-Z])(\()/g, (match: string, letter: string, paren: string, offset: number) => {
      const beforeMatch = expr.slice(0, offset + 1);
      for (const fn of mathFunctions) {
        if (beforeMatch.endsWith(fn)) {
          return match;
        }
      }
      return `${letter}*${paren}`;
    });

    // xy → x*y
    expr = expr.replace(/([xy])([xy])/g, '$1*$2');

    console.log(`[Agent] Draw/FunctionImplicit: ${rawExpr} → ${expr}`);

    // Allocate unique function symbol (f, g, h, ...)
    const symbol = allocateFunctionSymbol();

    // Use consistent style with manual drawing (black, 0.8 width)
    const defaultStyle = { stroke: { color: '#000000', width: 0.8 } };
    const style = event.payload.style
      ? {
          ...event.payload.style,
          stroke: {
            ...event.payload.style.stroke,
            color: event.payload.style.stroke?.color ?? '#000000',
            width: event.payload.style.stroke?.width || 0.8,
          },
        }
      : defaultStyle;

    s.upsertNode({
      id,
      kind: 'function-implicit',
      expr,
      variables: ['x', 'y'] as [string, string],
      bounds: { xMin: -10, xMax: 10, yMin: -10, yMax: 10 },
      style,
      label: rawExpr,  // label은 원본 표기법 사용
      symbol,  // 고유 함수 심볼 (f, g, h, ...)
      clipToAxes: true
    } as any);
    return { success: true, message: `음함수 ${symbol}: ${rawExpr} = 0 생성됨` };
  }
  if (event.type === 'Draw/MathText') {
    const id = event.payload.id;
    const latex = event.payload.latex;
    const position = { x: event.payload.position[0], y: event.payload.position[1] };
    // fontSize is stored in points; default to 11pt to match manual labels
    const fontSize = Number(event.payload.fontSize ?? 11) || 11;
    const color = event.payload.color || '#000000';

    console.log(`[Agent] Draw/MathText: ${latex} at (${position.x}, ${position.y})`);

    s.upsertNode({
      id,
      kind: 'math-text',
      latex,
      position,
      fontSize,
      color
    } as any);
    return { success: true, message: `수식 텍스트 "${latex}" 생성됨` };
  }
  if (event.type === 'Remove/ById') {
    const ids = event.payload.ids || [];
    const removed: string[] = [];
    const failed: string[] = [];
    for (const id of ids) {
      // 안전장치: axis와 anchor 노드는 삭제하지 않음
      const node = s.scene.nodes[id];
      if (!node) {
        console.warn(`[applyAgentEventToStore] Remove/ById: 노드 ${id}를 찾을 수 없음`);
        failed.push(id);
        continue;
      }
      if ((node as any).kind === 'axis' || (node as any).kind === 'anchor') {
        console.warn(`[applyAgentEventToStore] Remove/ById: ${(node as any).kind} 노드(${id})는 삭제할 수 없습니다.`);
        failed.push(id);
        continue;
      }
      s.removeNode(id);
      removed.push(id);
    }
    if (failed.length > 0) {
      return { success: false, error: `일부 노드 삭제 실패: ${failed.join(', ')}. 삭제됨: ${removed.join(', ') || '없음'}` };
    }
    return { success: true, message: `${removed.length}개 노드 삭제됨: ${removed.join(', ')}` };
  }
  if (event.type === 'Remove/ByQuery') {
    const { kind, functionId } = event.payload || {};

    // 안전장치(중요):
    // - by-query는 대량 삭제로 이어질 수 있어, 백엔드와 동일하게 functionId가 있을 때만 허용합니다.
    // - kind만으로 전체 segment/point 등을 지우는 오작동을 차단합니다.
    if (!functionId) {
      console.warn('[applyAgentEventToStore] Remove/ByQuery: functionId 없이 삭제를 차단합니다.', event.payload);
      return { success: false, error: 'Remove/ByQuery: functionId가 필요합니다(광범위 삭제 방지). ID로 삭제(remove/by-id)를 사용하세요.' };
    }

    const nodes = { ...(s.scene.nodes as any) };
    const removed: string[] = [];
    for (const [id, n] of Object.entries(nodes)) {
      // 안전장치: axis와 anchor 노드는 삭제하지 않음
      const nodeKind = (n as any).kind;
      if (nodeKind === 'axis' || nodeKind === 'anchor') {
        continue;
      }

      if (kind && nodeKind !== kind) continue;
      if (functionId && (n as any).functionId !== functionId) continue;
      s.removeNode(id);
      removed.push(id);
    }
    if (removed.length === 0) {
      return { success: false, error: `쿼리에 해당하는 노드가 없습니다 (kind: ${kind}, functionId: ${functionId})` };
    }
    return { success: true, message: `${removed.length}개 노드 삭제됨` };
  }

  if (event.type === 'Edit/Object') {
    const { id, updates } = event.payload || {};
    if (!id || !updates) {
      console.error('[Agent] Edit/Object: id 또는 updates 없음', event.payload);
      return { success: false, error: 'Edit/Object: id 또는 updates가 없습니다' };
    }

    console.log(`[Agent] Edit/Object: ${id}`, updates);

    // 기존 노드 가져오기
    const existingNode = s.scene.nodes[id];
    if (!existingNode) {
      console.error(`[Agent] Edit/Object: 노드 ${id}를 찾을 수 없음`);
      return { success: false, error: `노드 ${id}를 찾을 수 없습니다. 그래프 상태에서 정확한 ID를 확인하세요.` };
    }

    const nodeKind = (existingNode as any).kind;

    // updates를 기존 노드에 병합
    const updatedNode = { ...existingNode, ...updates };

    // 특수 처리: 함수 expression 업데이트 (수식 변환 필요)
    const isFunction = nodeKind === 'function-explicit' || nodeKind === 'function-implicit';
    const needsSegmentRebuild = isFunction && (updates.expression || updates.domain);
    
    if (updates.expression) {
      const rawExpr = updates.expression;
      const isImplicit = nodeKind === 'function-implicit';
      const convertedExpr = convertMathExpression(rawExpr, isImplicit);
      console.log(`[Agent] Edit/Object function expression: ${rawExpr} → ${convertedExpr}`);
      updatedNode.expr = convertedExpr;
      updatedNode.label = rawExpr; // label은 원본 유지
    }

    // 특수 처리: 함수 domain 업데이트
    if (updates.domain && nodeKind === 'function-explicit') {
      if (Array.isArray(updates.domain) && updates.domain.length === 2) {
        updatedNode.domain = [updates.domain[0], updates.domain[1]];
        updatedNode.clipToAxes = false; // 명시적 domain이면 clipToAxes 비활성화
        console.log(`[Agent] Edit/Object function domain: [${updates.domain[0]}, ${updates.domain[1]}]`);
      }
    }
    
    // 함수 수식/정의역이 변경되면 기존 세그먼트를 삭제하고 세그먼트 재생성 필요
    if (needsSegmentRebuild) {
      console.log(`[Agent] Edit/Object: 함수 ${id} 수정 - 세그먼트 재빌드 예약`);
      // segmentsOnly를 false로 설정하여 convertFunctionsToSegments가 다시 실행되도록 함
      updatedNode.segmentsOnly = false;
      
      // 기존 세그먼트 삭제
      const nodes = s.scene.nodes;
      const segmentsToRemove: string[] = [];
      for (const [nodeId, node] of Object.entries(nodes)) {
        const n = node as any;
        if (n.kind === 'segment' && n.functionId === id) {
          segmentsToRemove.push(nodeId);
        }
      }
      for (const segId of segmentsToRemove) {
        s.removeNode(segId);
      }
      console.log(`[Agent] Edit/Object: 함수 ${id}의 기존 세그먼트 ${segmentsToRemove.length}개 삭제`);
    }

    // 특수 처리: 위치 업데이트 (point, math-text 등)
    if (updates.position) {
      // position이 배열 [x, y] 형식으로 오면 객체 {x, y}로 변환
      if (Array.isArray(updates.position)) {
        updatedNode.position = { x: updates.position[0], y: updates.position[1] };
      } else {
        updatedNode.position = updates.position;
      }
    }

    // 특수 처리: 세그먼트/선/베지어 위치 업데이트
    if (updates.p1 || updates.p2) {
      if (updates.p1) {
        const aId = s.createAnchor({ x: updates.p1[0], y: updates.p1[1] });
        updatedNode.a = aId;
        updatedNode.startAnchorId = aId;
      }
      if (updates.p2) {
        const bId = s.createAnchor({ x: updates.p2[0], y: updates.p2[1] });
        updatedNode.b = bId;
        updatedNode.endAnchorId = bId;
      }
    }

    // 특수 처리: 베지어 제어점 업데이트
    if (updates.a || updates.b) {
      if (updates.a) updatedNode.a = s.createAnchor({ x: updates.a[0], y: updates.a[1] });
      if (updates.b) updatedNode.b = s.createAnchor({ x: updates.b[0], y: updates.b[1] });
    }
    if (updates.c1) updatedNode.c1 = s.createAnchor({ x: updates.c1[0], y: updates.c1[1] });
    if (updates.c2) updatedNode.c2 = s.createAnchor({ x: updates.c2[0], y: updates.c2[1] });

    // 특수 처리: centerPoint 업데이트 (filled-region)
    if (updates.centerPoint) {
      if (Array.isArray(updates.centerPoint)) {
        updatedNode.centerPoint = { x: updates.centerPoint[0], y: updates.centerPoint[1] };
      } else {
        updatedNode.centerPoint = updates.centerPoint;
      }
    }

    // 노드 업데이트
    s.upsertNode(updatedNode as any);
    
    // 함수 수식/정의역 변경 시 세그먼트 재생성 트리거
    if (needsSegmentRebuild) {
      // requestAnimationFrame을 사용하여 상태 업데이트 후 세그먼트 재생성
      requestAnimationFrame(() => {
        setTimeout(() => {
          console.log(`[Agent] Edit/Object: 함수 ${id} 세그먼트 재생성 시작`);
          s.convertFunctionsToSegments();
        }, 10);
      });
    }
    
    return { success: true, message: `노드 ${id} (${nodeKind}) 수정됨` };
  }

  // Set/CustomAxisRange: 커스텀 축 범위 및 가시성 설정
  if (event.type === 'Set/CustomAxisRange') {
    const { xMin, xMax, yMin, yMax, xVisible, yVisible } = event.payload || {};
    const nodes = s.scene.nodes;
    
    // X축과 Y축 노드 찾기
    let xAxis: any = null;
    let yAxis: any = null;
    for (const node of Object.values(nodes)) {
      const n = node as any;
      if (n.kind === 'axis') {
        if (n.name === 'X' || n.name === 'x') xAxis = n;
        else if (n.name === 'Y' || n.name === 'y') yAxis = n;
      }
    }
    
    if (!xAxis || !yAxis) {
      console.error('[Agent] Set/CustomAxisRange: 축을 찾을 수 없음');
      return { success: false, error: '축을 찾을 수 없습니다' };
    }
    
    const changes: string[] = [];
    
    // X축 범위 설정
    if (typeof xMin === 'number' || typeof xMax === 'number') {
      const xOrigin = nodes[xAxis.originId] as any;
      const xEndpoint = nodes[xAxis.endpointId] as any;
      if (xOrigin && xEndpoint) {
        const newXMin = typeof xMin === 'number' ? xMin : xOrigin.position.x;
        const newXMax = typeof xMax === 'number' ? xMax : xEndpoint.position.x;
        
        // originId는 항상 작은 값, endpointId는 큰 값
        const actualMin = Math.min(newXMin, newXMax);
        const actualMax = Math.max(newXMin, newXMax);
        
        s.upsertNode({ ...xOrigin, position: { x: actualMin, y: 0 } });
        s.upsertNode({ ...xEndpoint, position: { x: actualMax, y: 0 } });
        changes.push(`X축: [${actualMin}, ${actualMax}]`);
      }
    }
    
    // Y축 범위 설정
    if (typeof yMin === 'number' || typeof yMax === 'number') {
      const yOrigin = nodes[yAxis.originId] as any;
      const yEndpoint = nodes[yAxis.endpointId] as any;
      if (yOrigin && yEndpoint) {
        const newYMin = typeof yMin === 'number' ? yMin : yOrigin.position.y;
        const newYMax = typeof yMax === 'number' ? yMax : yEndpoint.position.y;
        
        // originId는 항상 작은 값, endpointId는 큰 값
        const actualMin = Math.min(newYMin, newYMax);
        const actualMax = Math.max(newYMin, newYMax);
        
        s.upsertNode({ ...yOrigin, position: { x: 0, y: actualMin } });
        s.upsertNode({ ...yEndpoint, position: { x: 0, y: actualMax } });
        changes.push(`Y축: [${actualMin}, ${actualMax}]`);
      }
    }
    
    // 가시성 설정
    if (typeof xVisible === 'boolean') {
      s.upsertNode({ ...xAxis, visible: xVisible });
      changes.push(`X축 ${xVisible ? '표시' : '숨김'}`);
    }
    if (typeof yVisible === 'boolean') {
      s.upsertNode({ ...yAxis, visible: yVisible });
      changes.push(`Y축 ${yVisible ? '표시' : '숨김'}`);
    }
    
    // 세그먼트 재생성 (축 범위 변경 시 함수 그래프 다시 그리기)
    requestAnimationFrame(() => {
      setTimeout(() => {
        s.convertFunctionsToSegments();
      }, 50);
    });
    
    console.log(`[Agent] Set/CustomAxisRange: ${changes.join(', ')}`);
    return { success: true, message: `축 범위 설정 완료: ${changes.join(', ')}` };
  }

  // Set/FitToScreen: 화면 맞춤 (축에 맞게 배율 조절)
  if (event.type === 'Set/FitToScreen') {
    try {
      // App.tsx의 setDefaultView와 동일한 로직을 트리거
      window.dispatchEvent(new Event('alphacanvas-fit-to-screen'));
      console.log('[Agent] Set/FitToScreen: 화면 맞춤 이벤트 발송');
      return { success: true, message: '화면 맞춤 완료' };
    } catch (err) {
      console.error('[Agent] Set/FitToScreen 오류:', err);
      return { success: false, error: String(err) };
    }
  }

  // 알 수 없는 타입
  console.warn('[applyAgentEventToStore] 알 수 없는 이벤트 타입:', event.type, event);
  return { success: false, error: `알 수 없는 이벤트 타입: ${event.type}` };
}


