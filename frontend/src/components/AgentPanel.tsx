import { useEffect, useRef, useState, memo } from 'react';
import { useSceneStore } from '../state/store';
import { AgentClient, applyAgentEventToStore, type ApplyResult } from '../ws/agent.ts';
import katex from 'katex';
import { generateUUID } from '../shared/uuid';

type MessageRole = 'user' | 'assistant';

interface ImageAttachment {
  base64: string;
  mimeType: string;
  filename?: string;
}

interface Message {
  id: string;
  role: MessageRole;
  text: string;
  images?: ImageAttachment[];
  reasoning?: string;
  toolCalls?: ToolCall[];
  // 스트리밍 중 UI처럼 "텍스트/툴/추론"을 순서대로 렌더링하기 위한 타임라인
  elements?: Array<{ type: 'text' | 'tool' | 'view' | 'reasoning'; content: string; toolDetails?: ToolDetail[] }>;
  timestamp: number;
}

interface ToolCall {
  type: string;
  duration?: number;
}

type StreamingElementType = 'reasoning' | 'tool' | 'tool-pending' | 'view' | 'text' | 'gemini-oracle';
type ToolDetail = { name: string; description: string };
type StreamingElement = { id: string; type: StreamingElementType; content: string; toolDetails?: ToolDetail[] };

export const AgentPanel = memo(function AgentPanel() {
  const [client, setClient] = useState<AgentClient | null>(null);
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [attachedImages, setAttachedImages] = useState<ImageAttachment[]>([]);
  // 사용자별 API 키 (localStorage에 저장)
  const [isApiKeyPanelOpen, setIsApiKeyPanelOpen] = useState(false);
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [claudeApiKey, setClaudeApiKey] = useState('');
  const [showKeys, setShowKeys] = useState(false);
  const [rememberKeys, setRememberKeys] = useState(true); // 끄면 localStorage에 저장하지 않고 메모리에서만 사용
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const streamingReasoningScrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sceneStore = useSceneStore;

  // 커스텀 스크롤바 상태
  const [scrollbarHeight, setScrollbarHeight] = useState(0);
  const [scrollbarTop, setScrollbarTop] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  // 현재 스트리밍 중인 메시지
  const [streamingText, setStreamingText] = useState('');
  const [streamingReasoning, setStreamingReasoning] = useState('');
  const [streamingElements, setStreamingElements] = useState<StreamingElement[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [currentTextElementId, setCurrentTextElementId] = useState<string | null>(null);

  // 최신 스트리밍 값을 추적하기 위한 ref
  const streamingTextRef = useRef('');
  const streamingReasoningRef = useRef('');
  const streamingElementsRef = useRef<StreamingElement[]>([]);
  const currentTextElementIdRef = useRef<string | null>(null);
  const currentReasoningElementIdRef = useRef<string | null>(null);  // 현재 스트리밍 중인 추론 element ID

  // React 18의 자동 배치로 인해 "텍스트 델타"와 "툴 시작"이 같은 틱에 들어오면
  // 마지막 토큰이 툴 박스 뒤에 늦게 붙어 보일 수 있다.
  // => ref를 먼저 동기적으로 갱신하고 그 값을 setState에 넣어 순서를 안정화한다.
  const commitStreamingElements = (updater: (prev: StreamingElement[]) => StreamingElement[]) => {
    const prev = streamingElementsRef.current;
    const next = updater(prev);
    streamingElementsRef.current = next;
    setStreamingElements(next);
  };

  // "고급스러운 멈춤" 연출: 텍스트 델타를 잠시 버퍼링(표시만 지연)
  const textPauseUntilRef = useRef<number>(0);
  const textPauseTimerRef = useRef<any>(null);
  const pausedTextBufferRef = useRef<string>('');

  // 추론(Reasoning) 델타도 스무딩: 과도한 setState로 인한 렉 방지
  const reasoningFlushTimerRef = useRef<any>(null);
  const pausedReasoningBufferRef = useRef<string>('');

  // ✨ Cursor 스타일 타이핑 애니메이션: 텍스트를 한 글자씩 부드럽게 표시
  const typingBufferRef = useRef<string>('');  // 표시 대기 중인 텍스트
  const typingRafRef = useRef<number | null>(null);  // requestAnimationFrame ID
  const lastTypingTimeRef = useRef<number>(0);  // 마지막 타이핑 시간
  const typingEmptyWaitRef = useRef<number>(0);  // 버퍼가 빈 채로 대기한 시간
  
  // 타이핑 루프: 버퍼에서 글자를 꺼내서 화면에 표시
  const runTypingLoop = () => {
    const now = performance.now();
    const elapsed = now - lastTypingTimeRef.current;
    
    // 버퍼가 비었을 때: 50ms까지 기다려서 다음 토큰이 올 수 있게 함
    if (typingBufferRef.current.length === 0) {
      typingEmptyWaitRef.current += 16;
      if (typingEmptyWaitRef.current >= 50) {
        // 50ms 기다렸는데도 안 오면 루프 종료
        typingRafRef.current = null;
        typingEmptyWaitRef.current = 0;
        return;
      }
      // 계속 대기
      typingRafRef.current = requestAnimationFrame(runTypingLoop);
      return;
    }
    
    // 버퍼에 뭔가 있으면 대기 시간 리셋
    typingEmptyWaitRef.current = 0;
    
    // ✨ 일정한 속도로 표시 (16ms마다 2글자씩 = 부드럽고 일관된 타이핑 효과)
    const CHARS_PER_FRAME = 2;
    const FRAME_INTERVAL = 16;
    
    if (elapsed >= FRAME_INTERVAL) {
      const chars = typingBufferRef.current.slice(0, CHARS_PER_FRAME);
      typingBufferRef.current = typingBufferRef.current.slice(CHARS_PER_FRAME);
      lastTypingTimeRef.current = now;
      
      // 화면에 글자 추가
      const tid = currentTextElementIdRef.current;
      if (tid && chars) {
        commitStreamingElements((prev) =>
          prev.map((el) => (el.id === tid ? { ...el, content: el.content + chars } : el))
        );
      }
    }
    
    // 다음 프레임 예약
    typingRafRef.current = requestAnimationFrame(runTypingLoop);
  };
  
  // 버퍼에 텍스트 추가하고 타이핑 루프 시작
  const addToTypingBuffer = (text: string) => {
    typingBufferRef.current += text;
    if (typingRafRef.current === null) {
      lastTypingTimeRef.current = performance.now();
      typingRafRef.current = requestAnimationFrame(runTypingLoop);
    }
  };
  
  // 버퍼 즉시 플러시 (스트림 종료 시)
  const flushTypingBuffer = () => {
    if (typingRafRef.current !== null) {
      cancelAnimationFrame(typingRafRef.current);
      typingRafRef.current = null;
    }
    const remaining = typingBufferRef.current;
    typingBufferRef.current = '';
    if (remaining) {
      const tid = currentTextElementIdRef.current;
      if (tid) {
        commitStreamingElements((prev) =>
          prev.map((el) => (el.id === tid ? { ...el, content: el.content + remaining } : el))
        );
      }
    }
  };

  // ✨ 추론(Reasoning)도 타이핑 애니메이션
  const reasoningTypingBufferRef = useRef<string>('');
  const reasoningTypingRafRef = useRef<number | null>(null);
  const lastReasoningTypingTimeRef = useRef<number>(0);
  const reasoningEmptyWaitRef = useRef<number>(0);  // 버퍼가 빈 채로 대기한 시간
  
  const runReasoningTypingLoop = () => {
    const now = performance.now();
    const elapsed = now - lastReasoningTypingTimeRef.current;
    
    // 버퍼가 비었을 때: 50ms까지 기다려서 다음 토큰이 올 수 있게 함
    if (reasoningTypingBufferRef.current.length === 0) {
      reasoningEmptyWaitRef.current += 16;
      if (reasoningEmptyWaitRef.current >= 50) {
        reasoningTypingRafRef.current = null;
        reasoningEmptyWaitRef.current = 0;
        return;
      }
      reasoningTypingRafRef.current = requestAnimationFrame(runReasoningTypingLoop);
      return;
    }
    
    // 버퍼에 뭔가 있으면 대기 시간 리셋
    reasoningEmptyWaitRef.current = 0;
    
    // ✨ 일정한 속도로 표시 (16ms마다 3글자씩 = 부드럽고 일관된 속도)
    const CHARS_PER_FRAME = 3;
    const FRAME_INTERVAL = 16;
    
    if (elapsed >= FRAME_INTERVAL) {
      const chars = reasoningTypingBufferRef.current.slice(0, CHARS_PER_FRAME);
      reasoningTypingBufferRef.current = reasoningTypingBufferRef.current.slice(CHARS_PER_FRAME);
      lastReasoningTypingTimeRef.current = now;
      
      if (chars) {
        // streamingReasoningRef는 계속 추적 (완료 시 사용)
        streamingReasoningRef.current += chars;
        
        // 현재 reasoning element 업데이트 (인터리빙 순서 유지)
        const rid = currentReasoningElementIdRef.current;
        if (rid) {
          commitStreamingElements((prev) =>
            prev.map((el) => (el.id === rid ? { ...el, content: el.content + chars } : el))
          );
        }
      }
    }
    
    reasoningTypingRafRef.current = requestAnimationFrame(runReasoningTypingLoop);
  };
  
  const addToReasoningTypingBuffer = (text: string) => {
    reasoningTypingBufferRef.current += text;
    if (reasoningTypingRafRef.current === null) {
      lastReasoningTypingTimeRef.current = performance.now();
      reasoningTypingRafRef.current = requestAnimationFrame(runReasoningTypingLoop);
    }
  };
  
  const flushReasoningTypingBuffer = () => {
    if (reasoningTypingRafRef.current !== null) {
      cancelAnimationFrame(reasoningTypingRafRef.current);
      reasoningTypingRafRef.current = null;
    }
    const remaining = reasoningTypingBufferRef.current;
    reasoningTypingBufferRef.current = '';
    if (remaining) {
      streamingReasoningRef.current += remaining;
      // 현재 reasoning element 업데이트 (인터리빙 순서 유지)
      const rid = currentReasoningElementIdRef.current;
      if (rid) {
        commitStreamingElements((prev) =>
          prev.map((el) => (el.id === rid ? { ...el, content: el.content + remaining } : el))
        );
      }
    }
  };
  
  // 도구 호출 합치기: 여러 도구 호출을 하나의 박스로 표시
  // total: 이번 “합쳐진 박스”에 포함된 전체 도구 호출 수(표시에 사용)
  // inFlight: 아직 결과(Result)가 도착하지 않은 실행 중 도구 호출 수(완료 전환 타이밍에 사용)
  const pendingToolTotalCountRef = useRef<number>(0);
  const pendingToolInFlightCountRef = useRef<number>(0);
  const pendingToolElementIdRef = useRef<string | null>(null);
  const toolCompleteTimerRef = useRef<any>(null);
  const pendingToolDetailsRef = useRef<ToolDetail[]>([]);
  // 멈춤 기능 비활성화 (빈 함수)
  // NOTE: 남겨두되(기능 토글/실험용), 현재는 사용하지 않음

  const ensureTextElement = () => {
    const tid = currentTextElementIdRef.current;
    if (tid) return tid;
    const newId = generateUUID();
    currentTextElementIdRef.current = newId;
    setCurrentTextElementId(newId);
    commitStreamingElements((prev) => [...prev, { id: newId, type: 'text', content: '' }]);
    return newId;
  };

  // flushPausedTextBuffer는 이제 타이핑 버퍼 플러시로 대체됨
  const flushPausedTextBuffer = () => {
    flushTypingBuffer();
  };

  // 추론 펼침/접기 상태
  const [expandedReasoning, setExpandedReasoning] = useState<Set<string>>(new Set());
  // 스트리밍 중 완료된 추론박스 펼침/접기 상태
  const [expandedStreamingReasoning, setExpandedStreamingReasoning] = useState<Set<string>>(new Set());

  // 모델 선택 상태 (기본값: Gemini Pro로 변경)
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    try {
      const saved = localStorage.getItem('alphacanvas_selected_model');
      // gemini-3-flash-preview가 저장되어 있으면 gemini-3-pro-preview로 변경
      if (saved === 'gemini-3-flash-preview') {
        return 'gemini-3-pro-preview';
      }
      return saved || 'gemini-3-pro-preview';
    } catch {
      return 'gemini-3-pro-preview';
    }
  });
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const availableModels = [
    { value: 'gpt-5.2', label: 'GPT-5.2', provider: 'OpenAI' },
    // { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (기본)', provider: 'Google' }, // 숨김
    { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro', provider: 'Google' },
    { value: 'claude-opus-4-5', label: 'Opus 4.5', provider: 'Anthropic' },
    { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', provider: 'Anthropic' },
  ];

  // 이미지를 base64로 변환
  const fileToBase64 = (file: File): Promise<ImageAttachment> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1]; // data:image/png;base64, 제거
        resolve({
          base64,
          mimeType: file.type,
          filename: file.name
        });
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  // 파일 선택 핸들러
  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const imageFiles = Array.from(files).filter(file => file.type.startsWith('image/'));
    const newImages: ImageAttachment[] = [];

    for (const file of imageFiles) {
      try {
        const img = await fileToBase64(file);
        newImages.push(img);
      } catch (error) {
        console.error('이미지 변환 오류:', error);
      }
    }

    setAttachedImages(prev => [...prev, ...newImages]);

    // input 초기화
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // 클립보드 붙여넣기 핸들러
  const handlePaste = async (event: React.ClipboardEvent) => {
    const items = event.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        event.preventDefault();
        const file = item.getAsFile();
        if (file) {
          try {
            const img = await fileToBase64(file);
            setAttachedImages(prev => [...prev, img]);
          } catch (error) {
            console.error('클립보드 이미지 변환 오류:', error);
          }
        }
      }
    }
  };

  // 이미지 삭제
  const removeImage = (index: number) => {
    setAttachedImages(prev => prev.filter((_, i) => i !== index));
  };

  useEffect(() => {
    const c = new AgentClient();
    setClient(c);
    const unsub = c.subscribe((msg: { type: 'open' | 'close' | 'message'; data?: any }) => {
      if (msg.type === 'open') {
        setConnected(true);
      } else if (msg.type === 'close') {
        setConnected(false);
      } else if (msg.type === 'message') {
        const data = msg.data as any;
        if (data && data.type && typeof data.type === 'string') {
          // Session 초기화/업데이트 (로깅만)
          if (data.type === 'Agent/Session.Init' || data.type === 'Agent/Session.Update') {
            console.log('[AgentPanel] Session updated:', data.payload?.threadId);
          }

          // 스트림 시작
          else if (data.type === 'Agent/Stream.Start') {
            setIsStreaming(true);
            setStreamingText('');
            setStreamingReasoning('');
            setStreamingElements([]);
            setExpandedStreamingReasoning(new Set());  // 스트리밍 중 추론 펼침 상태 초기화
            streamingTextRef.current = '';
            streamingReasoningRef.current = '';
            streamingElementsRef.current = [];
            currentReasoningElementIdRef.current = null;  // 추론 element ID 초기화
            pausedTextBufferRef.current = '';
            pausedReasoningBufferRef.current = '';
            typingBufferRef.current = '';  // 타이핑 버퍼 초기화
            typingEmptyWaitRef.current = 0;
            if (typingRafRef.current !== null) {
              cancelAnimationFrame(typingRafRef.current);
              typingRafRef.current = null;
            }
            textPauseUntilRef.current = 0;
            if (textPauseTimerRef.current) {
              clearTimeout(textPauseTimerRef.current);
              textPauseTimerRef.current = null;
            }
            if (reasoningFlushTimerRef.current) {
              clearTimeout(reasoningFlushTimerRef.current);
              reasoningFlushTimerRef.current = null;
            }
            // 추론 타이핑 버퍼 초기화
            reasoningTypingBufferRef.current = '';
            reasoningEmptyWaitRef.current = 0;
            if (reasoningTypingRafRef.current !== null) {
              cancelAnimationFrame(reasoningTypingRafRef.current);
              reasoningTypingRafRef.current = null;
            }
            // 도구 카운터/타이머 리셋
            pendingToolTotalCountRef.current = 0;
            pendingToolInFlightCountRef.current = 0;
            pendingToolElementIdRef.current = null;
            pendingToolDetailsRef.current = [];
            if (toolCompleteTimerRef.current) {
              clearTimeout(toolCompleteTimerRef.current);
              toolCompleteTimerRef.current = null;
            }
            // 타임라인의 첫 요소로 텍스트 블록을 만든다 (text → tool → text 순서 보장)
            const firstTextId = generateUUID();
            currentTextElementIdRef.current = firstTextId;
            setCurrentTextElementId(firstTextId);
            setStreamingElements([{ id: firstTextId, type: 'text', content: '' }]);
            streamingElementsRef.current = [{ id: firstTextId, type: 'text', content: '' }];
          }

          // 텍스트 델타 - Cursor 스타일 타이핑 애니메이션
          else if (data.type === 'Agent/Stream.Delta') {
            const delta = String(data.payload?.delta ?? '');
            const nextFull = streamingTextRef.current + delta;
            streamingTextRef.current = nextFull;
            
            // ✨ 텍스트가 시작되면 추론 박스를 닫음 (인터리빙: 추론 → 텍스트 순서)
            if (currentReasoningElementIdRef.current) {
              flushReasoningTypingBuffer();  // 남은 추론 버퍼 플러시
              currentReasoningElementIdRef.current = null;  // 다음 추론은 새 element로
              streamingReasoningRef.current = '';  // 추론 ref 초기화
            }
            
            // 텍스트는 타임라인의 'text' 요소로 표시한다.
            ensureTextElement();
            // ✨ 타이핑 버퍼에 추가 (한 글자씩 부드럽게 표시)
            addToTypingBuffer(delta);
          }

          // 추론 델타
          // 추론 델타 - Cursor 스타일 타이핑 애니메이션 (인터리빙: 추론이 텍스트보다 먼저 표시)
          else if (data.type === 'Agent/Reasoning.Delta') {
            const delta = String(data.payload?.delta ?? '');
            
            // 현재 reasoning element가 없으면 생성 (인터리빙 순서 유지)
            if (!currentReasoningElementIdRef.current) {
              // ✨ 추론 시작 시 현재 텍스트 element를 닫음 (추론 → 텍스트 순서 유지)
              if (currentTextElementIdRef.current) {
                flushTypingBuffer();  // 남은 텍스트 버퍼 플러시
                currentTextElementIdRef.current = null;
                setCurrentTextElementId(null);
              }
              
              const newReasoningId = generateUUID();
              currentReasoningElementIdRef.current = newReasoningId;
              commitStreamingElements((prev) => [
                ...prev,
                { id: newReasoningId, type: 'reasoning' as const, content: '' }
              ]);
            }
            
            // ✨ 추론도 타이핑 버퍼에 추가 (부드럽게 표시)
            addToReasoningTypingBuffer(delta);
          }

          // 액션 실행
          else if (data.type === 'Agent/Action.Start' && data.payload?.event) {
            // Start 시점에 "도구 실행 중" 박스를 바로 띄워서, 툴 호출이 시작되는 타이밍에 맞춘다.
            // (이전에는 Result에서만 처리해서 박스가 늦게 뜨는 문제가 있었음)
            flushTypingBuffer();  // 타이핑 버퍼 즉시 플러시
            flushReasoningTypingBuffer();  // 추론 타이핑 버퍼도 즉시 플러시 (추론2부터 안 보이는 버그 수정)

            // 추론이 있으면 닫음 (인터리빙: 추론 → 도구 순서)
            if (currentReasoningElementIdRef.current) {
              currentReasoningElementIdRef.current = null;
              streamingReasoningRef.current = '';
            }

            const normType = (t: any) => String(t ?? '').trim().toLowerCase();
            // View/RequestState는 별도 처리하므로 pending 박스는 띄우지 않음
            const eventType = data.payload?.event?.type;
            const eventTypeNorm = normType(eventType);
            if (eventTypeNorm === 'view/requeststate') {
              return;
            }

            // Tool/View는 시작 시점에 바로 view 요소 추가 (순서 유지를 위해)
            if (eventTypeNorm === 'tool/view' || eventTypeNorm === 'view') {
              flushPausedTextBuffer();
              commitStreamingElements((prev) => [
                ...prev,
                { id: generateUUID(), type: 'view' as const, content: '그래프 상태 확인됨' }
              ]);
              return;
            }

            // 🔮 Tool/GeminiOracle: Gemini 신탁 특별 처리
            if (eventType === 'Tool/GeminiOracle') {
              commitStreamingElements((prev) => {
                // 기존 gemini-oracle 박스가 있으면 업데이트 안 함
                const existingOracleIdx = prev.findIndex(el => el.type === 'gemini-oracle');
                if (existingOracleIdx >= 0) return prev;
                
                const oracleElementId = generateUUID();
                const nextTextId = generateUUID();
                currentTextElementIdRef.current = nextTextId;
                setCurrentTextElementId(nextTextId);
                return [
                  ...prev,
                  { id: oracleElementId, type: 'gemini-oracle' as const, content: 'Gemini에게 수학 계산 요청 중...' },
                  { id: nextTextId, type: 'text' as const, content: '' }
                ];
              });
              return;
            }

            // 새 도구가 시작되면: inFlight/total 증가 + (없으면) pending 박스 생성
            pendingToolInFlightCountRef.current += 1;
            pendingToolTotalCountRef.current += 1;
            const currentTotal = pendingToolTotalCountRef.current;

            // 진행 중에 새 도구가 시작되면, 완료 전환 타이머는 취소
            if (toolCompleteTimerRef.current) {
              clearTimeout(toolCompleteTimerRef.current);
              toolCompleteTimerRef.current = null;
            }

            commitStreamingElements((prev) => {
              const existingPendingIdx = prev.findIndex(el => el.type === 'tool-pending');
              if (existingPendingIdx >= 0) {
                const newElements = [...prev];
                newElements[existingPendingIdx] = {
                  ...newElements[existingPendingIdx],
                  content: `도구 실행 중 (${currentTotal}개)`,
                };
                return newElements;
              } else {
                const toolElementId = generateUUID();
                pendingToolElementIdRef.current = toolElementId;
                const nextTextId = generateUUID();
                currentTextElementIdRef.current = nextTextId;
                setCurrentTextElementId(nextTextId);
                const newElements = [
                  ...prev,
                  { id: toolElementId, type: 'tool-pending' as const, content: `도구 실행 중 (${currentTotal}개)` },
                  { id: nextTextId, type: 'text' as const, content: '' }
                ];
                return newElements;
              }
            });
          }
          else if (data.type === 'Agent/Action.Result' && data.payload?.event) {
            const normType = (t: any) => String(t ?? '').trim().toLowerCase();
            const eventType = data.payload.event.type;
            const eventTypeNorm = normType(eventType);

            // View/RequestState 처리 - 최신 상태를 즉시 백엔드로 전송
            if (eventTypeNorm === 'view/requeststate') {
              console.log('[AgentPanel] View/RequestState 수신 - 최신 상태 즉시 전송');
              setTimeout(() => {
                const currentScene = sceneStore.getState().scene;
                const graphState = {
                  nodes: currentScene.nodes,
                  view: currentScene.view,
                  zIndex: currentScene.zIndex
                };

                // 최신 상태를 백엔드로 전송
                if (c) {
                  const msg = {
                    type: 'Agent/GraphState.Response',
                    payload: { graphState },
                    requestId: data.requestId
                  };
                  console.log('[AgentPanel] 그래프 상태 전송:', Object.keys(graphState?.nodes || {}).length, '노드');
                  if (c['ws'] && c['ws'].readyState === WebSocket.OPEN) {
                    c['ws'].send(JSON.stringify(msg));
                  }
                }
              }, 100); // 100ms 대기 (세그먼트 생성 완료 대기)
            } else if (eventTypeNorm === 'tool/view' || eventTypeNorm === 'view') {
              // ✅ view Result: Start에서 이미 추가했으므로 중복 추가하지 않음
              //    단, pending에 잘못 들어간 경우만 정리
              if (pendingToolInFlightCountRef.current > 0) {
                pendingToolInFlightCountRef.current = Math.max(0, pendingToolInFlightCountRef.current - 1);
              }

              // pending 박스가 view 하나만으로 생성된 경우 → view로 교체
              const shouldReplacePending =
                pendingToolTotalCountRef.current <= 1 && (pendingToolDetailsRef.current?.length ?? 0) === 0;

              if (shouldReplacePending) {
                commitStreamingElements((prev) => {
                  const pendingIdx = prev.findIndex(el => el.type === 'tool-pending');
                  if (pendingIdx >= 0) {
                    const next = [...prev];
                    next[pendingIdx] = { ...next[pendingIdx], type: 'view' as const, content: '그래프 상태 확인됨' };
                    return next;
                  }
                  return prev;  // 이미 Start에서 view 추가됨 → 중복 추가 안 함
                });

                // 카운터 리셋
                if (pendingToolInFlightCountRef.current === 0) {
                  pendingToolTotalCountRef.current = 0;
                  pendingToolElementIdRef.current = null;
                  pendingToolDetailsRef.current = [];
                  if (toolCompleteTimerRef.current) {
                    clearTimeout(toolCompleteTimerRef.current);
                    toolCompleteTimerRef.current = null;
                  }
                }
              }

              return;
            } else if (eventType === 'Tool/GeminiOracle') {
              // 🔮 Gemini Oracle 완료 처리 - "답변이 도착한 시점"에 즉시 완료로 바꿈
              const answer = String(data.payload?.event?.payload?.answer ?? '').trim();
              const short = answer.length > 160 ? (answer.slice(0, 160) + '…') : answer;
              const nextContent = short ? `Gemini 수학 계산 완료: ${short}` : 'Gemini 수학 계산 완료';

              commitStreamingElements((prev) => {
                const hasOracle = prev.some(el => el.type === 'gemini-oracle');
                if (!hasOracle) {
                  // 혹시 Start 이벤트가 누락됐으면 여기서라도 박스를 만들어준다.
                  const oracleElementId = generateUUID();
                  return [...prev, { id: oracleElementId, type: 'gemini-oracle' as const, content: nextContent }];
                }
                return prev.map(el => (el.type === 'gemini-oracle' ? { ...el, content: nextContent } : el));
              });
            } else {
              // 일반 액션 처리 (Draw/Function, Draw/Segment 등)
              flushPausedTextBuffer();
              flushReasoningTypingBuffer();  // 추론 타이핑 버퍼도 즉시 플러시

              // 추론이 있으면 닫음 (인터리빙: 추론 → 도구 순서)
              if (currentReasoningElementIdRef.current) {
                currentReasoningElementIdRef.current = null;
                streamingReasoningRef.current = '';
              }

              // 1) 그래프/툴 적용은 즉시 실행
              let applyResult: ApplyResult = { success: true };
              try {
                applyResult = applyAgentEventToStore(data.payload.event, sceneStore);
                if (!applyResult.success) {
                  console.error('[AgentPanel] 도구 적용 실패:', applyResult.error);
                } else {
                  console.log('[AgentPanel] 도구 적용 성공:', applyResult.message);
                }
              } catch (e) {
                console.error('[AgentPanel] 도구 적용 오류:', e);
                applyResult = { success: false, error: String(e) };
              }

              // 2) 도구 적용 결과를 백엔드로 전송 (LLM에게 전달됨)
              if (c && c['ws'] && c['ws'].readyState === WebSocket.OPEN) {
                const eventType = data.payload.event?.type || 'Unknown';
                const resultMsg = {
                  type: 'Agent/Action.Applied',
                  payload: {
                    eventType,
                    eventId: data.payload.event?.payload?.id,
                    success: applyResult.success,
                    message: applyResult.success ? applyResult.message : undefined,
                    error: !applyResult.success ? applyResult.error : undefined,
                  },
                  requestId: data.requestId
                };
                c['ws'].send(JSON.stringify(resultMsg));
                console.log('[AgentPanel] 도구 적용 결과 전송:', applyResult.success ? '성공' : '실패', applyResult.success ? applyResult.message : applyResult.error);
              }

              // 3) 액션 적용 후 그래프 상태 전송
              const sendGraphState = () => {
                const currentScene = sceneStore.getState().scene;
                const graphState = {
                  nodes: currentScene.nodes,
                  view: currentScene.view,
                  zIndex: currentScene.zIndex
                };

                if (c && c['ws'] && c['ws'].readyState === WebSocket.OPEN) {
                  const msg = {
                    type: 'Agent/GraphState.Response',
                    payload: { graphState },
                    requestId: data.requestId
                  };
                  c['ws'].send(JSON.stringify(msg));
                  console.log('[AgentPanel] 액션 후 상태 전송:', Object.keys(graphState?.nodes || {}).length, '노드');
                }
              };
              sendGraphState();
              setTimeout(sendGraphState, 50);
              setTimeout(sendGraphState, 150);

              // 3) 툴 카운터 증가 (여러 도구 호출을 하나로 합침)
              // Start에서 이미 pending 박스를 생성/집계하므로, Result에서는 inFlight 감소만 수행
              pendingToolInFlightCountRef.current = Math.max(0, pendingToolInFlightCountRef.current - 1);
              const currentTotal = pendingToolTotalCountRef.current;

              // 도구 상세 정보 수집
              const eventType = data.payload.event?.type || 'Unknown';
              const eventPayload = data.payload.event?.payload || {};
              let toolName = eventType;
              let toolDesc = '';
              if (eventType.startsWith('Draw/')) {
                const drawType = eventType.replace('Draw/', '');
                toolName = `그리기: ${drawType}`;
                if (eventPayload.label) toolDesc = eventPayload.label;
                else if (eventPayload.latex) toolDesc = eventPayload.latex;
                else if (eventPayload.text) toolDesc = eventPayload.text;
              } else if (eventType === 'Edit/Label') {
                toolName = '라벨 수정';
                toolDesc = eventPayload.label || '';
              } else if (eventType === 'Edit/Style') {
                toolName = '스타일 수정';
              } else if (eventType === 'Edit/Move') {
                toolName = '이동';
              } else if (eventType === 'Remove/Nodes') {
                toolName = '삭제';
                toolDesc = `${(eventPayload.nodeIds || []).length}개 노드`;
              }
              pendingToolDetailsRef.current.push({ name: toolName, description: toolDesc });

              // 기존 pending 박스가 있으면 카운트 업데이트, 없으면 새로 생성
              commitStreamingElements((prev) => {
                const existingPendingIdx = prev.findIndex(el => el.type === 'tool-pending');
                if (existingPendingIdx >= 0) {
                  // 기존 박스의 카운트만 업데이트
                  const newElements = [...prev];
                  newElements[existingPendingIdx] = {
                    ...newElements[existingPendingIdx],
                    content: `도구 실행 중 (${currentTotal}개)`,
                  };
                  return newElements;
                } else {
                  // 첫 번째 도구 호출 - 새 pending 박스 생성 + 그 뒤에 새 텍스트 블록 추가
                  const toolElementId = generateUUID();
                  pendingToolElementIdRef.current = toolElementId;
                  const nextTextId = generateUUID();
                  currentTextElementIdRef.current = nextTextId;
                  setCurrentTextElementId(nextTextId);
                  const newElements = [
                    ...prev,
                    { id: toolElementId, type: 'tool-pending' as const, content: `도구 실행 중 (${currentTotal}개)` },
                    { id: nextTextId, type: 'text' as const, content: '' }
                  ];
                  return newElements;
                }
              });

              // 4) in-flight가 0이 되었을 때만 짧은 딜레이 후 완료 표시
              // (여러 도구 호출이 하나로 합쳐지면서도, 아직 실행 중인 툴이 있으면 완료로 바뀌지 않게)
              if (pendingToolInFlightCountRef.current === 0) {
                if (toolCompleteTimerRef.current) {
                  clearTimeout(toolCompleteTimerRef.current);
                }
                toolCompleteTimerRef.current = setTimeout(() => {
                  // 타이머 사이에 새 tool start가 들어오면(=inFlight>0) 완료로 바꾸지 않음
                  if (pendingToolInFlightCountRef.current > 0) return;

                  const finalCount = pendingToolTotalCountRef.current;
                  const finalDetails = [...pendingToolDetailsRef.current];
                  commitStreamingElements((prev) =>
                    prev.map(el =>
                      el.type === 'tool-pending'
                        ? { ...el, type: 'tool' as const, content: `도구 실행 완료 (${finalCount}개)`, toolDetails: finalDetails }
                        : el
                    )
                  );
                  // 카운터 리셋
                  pendingToolTotalCountRef.current = 0;
                  pendingToolInFlightCountRef.current = 0;
                  pendingToolElementIdRef.current = null;
                  pendingToolDetailsRef.current = [];
                  toolCompleteTimerRef.current = null;
                }, 300);
              }
            }
          }

          // 스트림 종료
          else if (data.type === 'Agent/Stream.End' || data.type === 'Agent/Stream.Aborted') {
            setIsStreaming(false);
            // 마지막 버퍼 강제 flush (타이핑 애니메이션 중인 텍스트/추론 즉시 표시)
            flushTypingBuffer();
            flushReasoningTypingBuffer();
            // 추론 element ID 초기화
            currentReasoningElementIdRef.current = null;
            // ref의 최신 값을 사용
            const finalText = streamingTextRef.current;
            const finalReasoning = streamingReasoningRef.current;
            // NOTE: 타이핑 버퍼에 남아있을 수 있는 텍스트도 마지막 텍스트 블록에 합침
            const rawFinalElements = streamingElementsRef.current;
            const pendingBuf = typingBufferRef.current;
            const pendingTextId = currentTextElementIdRef.current;
            const finalElements = (() => {
              if (!pendingBuf || !pendingTextId) return rawFinalElements;
              return rawFinalElements.map((el) =>
                el.id === pendingTextId && el.type === 'text'
                  ? { ...el, content: el.content + pendingBuf }
                  : el
              );
            })();
            // 버퍼/타이머 정리
            typingBufferRef.current = '';
            if (typingRafRef.current !== null) {
              cancelAnimationFrame(typingRafRef.current);
              typingRafRef.current = null;
            }
            // 도구 카운터/타이머 정리
            pendingToolTotalCountRef.current = 0;
            pendingToolInFlightCountRef.current = 0;
            pendingToolElementIdRef.current = null;
            pendingToolDetailsRef.current = [];
            if (toolCompleteTimerRef.current) {
              clearTimeout(toolCompleteTimerRef.current);
              toolCompleteTimerRef.current = null;
            }

            // 완성 메시지에서도 "추론 → 텍스트 → 도구" 순서를 유지하기 위해 타임라인을 생성
            // (추론도 포함하여 순서대로 표시: 추론1 - 멘트1 - 도구1 - 추론2 - 멘트2 - 도구2)
            const timelineWithReasoning = finalElements.map((el) => {
              if (el.type === 'text') return { type: 'text' as const, content: el.content };
              if (el.type === 'view') return { type: 'view' as const, content: el.content };
              if (el.type === 'reasoning') return { type: 'reasoning' as const, content: el.content };
              if (el.type === 'gemini-oracle') return { type: 'tool' as const, content: '🔮 Gemini 수학 계산' };
              // tool / tool-pending은 모두 tool로 저장 (완료로 텍스트 변경)
              const toolContent = el.content.replace('실행 중', '실행 완료');
              return { type: 'tool' as const, content: toolContent, toolDetails: el.toolDetails };
            });

            // 현재 진행 중이던 추론도 추가 (마지막에)
            if (finalReasoning && finalReasoning.trim()) {
              timelineWithReasoning.push({ type: 'reasoning' as const, content: finalReasoning.trim() });
            }

            // 비어있는 텍스트 블록은 제거 (툴이 위로 몰려 보이는 원인)
            const finalTimelineElements = timelineWithReasoning
              .filter((el) => el.type !== 'text' || (el.content ?? '').trim().length > 0);

            // 도구 호출 목록 추출 (view, tool-pending, gemini-oracle 포함)
            const finalToolCalls = finalElements
              .filter(el => el.type === 'tool' || el.type === 'tool-pending' || el.type === 'view' || el.type === 'gemini-oracle')
              .map(el => ({ type: el.content, duration: 0.3 }));

            // 모든 추론 합치기 (기존 호환성을 위해 reasoning 속성도 유지)
            const allReasonings = finalElements
              .filter(el => el.type === 'reasoning')
              .map(el => el.content.trim())
              .join('\n\n');
            const finalFullReasoning = (allReasonings + (finalReasoning ? '\n\n' + finalReasoning : '')).trim();

            if (finalText || finalFullReasoning || finalToolCalls.length > 0 || finalTimelineElements.length > 0) {
              const newMsg: Message = {
                id: generateUUID(),
                role: 'assistant',
                text: data.type === 'Agent/Stream.Aborted' ? finalText + ' [중단됨]' : finalText,
                reasoning: finalFullReasoning || undefined,  // 기존 호환성 유지
                toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
                elements: finalTimelineElements.length ? finalTimelineElements : undefined,
                timestamp: Date.now()
              };
              setMessages((prev) => [...prev, newMsg]);
            }
            setStreamingText('');
            setStreamingReasoning('');
            setStreamingElements([]);
            streamingTextRef.current = '';
            streamingReasoningRef.current = '';
            streamingElementsRef.current = [];
            pausedTextBufferRef.current = '';
            currentTextElementIdRef.current = null;
            setCurrentTextElementId(null);
          }

          // 에러
          else if (data.type.endsWith('.Error') || data.type === 'Agent/Action.Error') {
            const errorMsg: Message = {
              id: generateUUID(),
              role: 'assistant',
              text: '[오류] ' + (data.payload?.error || data.message || 'unknown error'),
              timestamp: Date.now()
            };
            setMessages((prev) => [...prev, errorMsg]);
          }
        }
      }
    });
    c.connect();
    return () => { unsub(); c.dispose(); };
  }, []);

  // 로컬 저장된 API 키 로드 (재배포/새로고침 후에도 유지)
  useEffect(() => {
    try {
      setOpenaiApiKey(localStorage.getItem('alphacanvas_openai_api_key') || '');
      setGeminiApiKey(localStorage.getItem('alphacanvas_gemini_api_key') || '');
      setClaudeApiKey(localStorage.getItem('alphacanvas_claude_api_key') || '');
    } catch { }
  }, []);

  // 선택 모델 저장 (새로고침 후 유지)
  useEffect(() => {
    try {
      localStorage.setItem('alphacanvas_selected_model', selectedModel);
    } catch { }
  }, [selectedModel]);

  // 스크롤바 업데이트
  const updateScrollbar = () => {
    if (!scrollRef.current) return;
    const { scrollHeight, clientHeight, scrollTop } = scrollRef.current;
    if (scrollHeight <= clientHeight) {
      setScrollbarHeight(0);
      return;
    }
    const offset = 24; // top + bottom margin
    const availableHeight = clientHeight - offset;
    const ratio = clientHeight / scrollHeight;
    const height = Math.max(availableHeight * ratio, 30);
    const maxScroll = scrollHeight - clientHeight;
    const top = (scrollTop / maxScroll) * (availableHeight - height);
    setScrollbarHeight(height);
    setScrollbarTop(top);
  };

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    updateScrollbar();
  }, [messages, streamingText, streamingElements]);

  // 스트리밍 중 "추론 박스" 내부 스크롤을 항상 맨 아래로 붙이기
  useEffect(() => {
    if (!isStreaming) return;
    const el = streamingReasoningScrollRef.current;
    if (!el) return;
    // requestAnimationFrame으로 레이아웃 반영 후 스크롤
    requestAnimationFrame(() => {
      try {
        el.scrollTop = el.scrollHeight;
      } catch { }
    });
  }, [isStreaming, streamingElements]);

  // 스크롤 이벤트 & 리사이즈 감지
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleScroll = () => updateScrollbar();

    el.addEventListener('scroll', handleScroll);

    // 초기 업데이트
    setTimeout(updateScrollbar, 100);

    // ResizeObserver로 크기 변화 감지
    const resizeObserver = new ResizeObserver(() => {
      updateScrollbar();
    });
    resizeObserver.observe(el);

    return () => {
      el.removeEventListener('scroll', handleScroll);
      resizeObserver.disconnect();
    };
  }, []);

  // 드래그 이벤트 핸들러
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!scrollRef.current) return;
      const { clientHeight, scrollHeight } = scrollRef.current;
      const maxScroll = scrollHeight - clientHeight;
      const containerRect = scrollRef.current.getBoundingClientRect();
      const offset = 12; // top margin
      const relativeY = e.clientY - containerRect.top - offset;
      const availableHeight = clientHeight - 24; // top + bottom margin
      const ratio = Math.max(0, Math.min(1, relativeY / availableHeight));
      scrollRef.current.scrollTop = ratio * maxScroll;
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  const onSend = () => {
    const text = input.trim();
    if (!text && attachedImages.length === 0) return;

    const userMsg: Message = {
      id: generateUUID(),
      role: 'user',
      text: text || '(이미지 첨부)',
      images: attachedImages.length > 0 ? [...attachedImages] : undefined,
      timestamp: Date.now()
    };
    setMessages((prev) => [...prev, userMsg]);

    client?.sendChat(text || '이미지를 분석해주세요.', {
      images: attachedImages.length > 0 ? attachedImages : undefined,
      model: selectedModel
    });
    setInput('');
    setAttachedImages([]); // 이미지 초기화

    // 스크롤을 맨 아래로 이동
    setTimeout(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }, 50);
  };

  const onAbortStream = () => {
    console.log('[AgentPanel] 중지 버튼 클릭됨');
    console.log('[AgentPanel] isStreaming:', isStreaming);
    console.log('[AgentPanel] client:', client);
    if (client) {
      console.log('[AgentPanel] abortStream 호출');
      client.abortStream();

      // 백엔드 응답이 오지 않을 수 있으므로 일정 시간 후 강제로 상태 초기화
      setTimeout(() => {
        console.log('[AgentPanel] 강제 상태 초기화 (타임아웃)');

        // 현재 스트리밍 중이면 메시지 저장 후 종료
        const finalText = streamingTextRef.current;
        const finalReasoning = streamingReasoningRef.current;
        const finalElements = streamingElementsRef.current;

        if (finalText || finalReasoning || finalElements.length > 0) {
          const finalToolCalls = finalElements
            .filter(el => el.type === 'tool' || el.type === 'view')
            .map(el => ({ type: el.content, duration: 0.3 }));

          const allReasonings = finalElements
            .filter(el => el.type === 'reasoning')
            .map(el => el.content.trim())
            .join('\n\n');
          const finalFullReasoning = (allReasonings + (finalReasoning ? '\n\n' + finalReasoning : '')).trim();

          const newMsg: Message = {
            id: generateUUID(),
            role: 'assistant',
            text: finalText + ' [중단됨]',
            reasoning: finalFullReasoning || undefined,
            toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
            timestamp: Date.now()
          };
          setMessages((prev) => [...prev, newMsg]);
        }

        // 상태 초기화
        setIsStreaming(false);
        setStreamingText('');
        setStreamingReasoning('');
        setStreamingElements([]);
        streamingTextRef.current = '';
        streamingReasoningRef.current = '';
        streamingElementsRef.current = [];
      }, 500); // 500ms 후 강제 초기화
    } else {
      console.error('[AgentPanel] client가 null입니다');
    }
  };

  const onClearHistory = () => {
    setMessages([]);
    client?.clearHistory();
  };

  const toggleReasoning = (msgId: string) => {
    setExpandedReasoning((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(msgId)) {
        newSet.delete(msgId);
      } else {
        newSet.add(msgId);
      }
      return newSet;
    });
  };

  return (
    <>
      <style>{`
        .agent-panel-container ::selection {
          background: rgba(100, 100, 100, 0.5);
          color: rgba(255, 255, 255, 0.95);
        }
        .agent-panel-container ::-moz-selection {
          background: rgba(100, 100, 100, 0.5);
          color: rgba(255, 255, 255, 0.95);
        }
      `}</style>
      <div className="agent-panel-container" style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 8
      }}>
        {/* Chat messages panel with custom scrollbar */}
        <div style={{
          flex: 1,
          position: 'relative',
          background: 'rgba(80, 85, 95, 0.8)',
          borderRadius: 12,
          overflow: 'hidden',
          display: 'flex'
        }}>
          <div ref={scrollRef} className="agent-chat-scrollarea-hidden" style={{
            flex: 1,
            overflowY: 'scroll',
            overflowX: 'hidden',
            padding: '12px 20px 12px 12px',
            color: 'rgba(255,255,255,0.85)',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            boxSizing: 'border-box'
          } as React.CSSProperties}>
            {/* API 키 섹션 (채팅창 상단으로 통째로 이동) */}
            <div style={{ position: 'sticky', top: 0, zIndex: 10 }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                alignSelf: 'flex-start',
                marginBottom: 6,
                padding: 6,
                borderRadius: 12,
                background: 'transparent',
                border: 'none',
                backdropFilter: 'none',
              }}>
                {/* API 키 상태(클릭 시 설정 열기/닫기) */}
                <button
                  onClick={() => setIsApiKeyPanelOpen((v) => !v)}
                  disabled={isStreaming}
                  style={{
                    padding: '5px 8px',
                    borderRadius: 999,
                    background: 'rgba(0,0,0,0.18)',
                    border: 'none',
                    fontSize: 11,
                    color: !isStreaming ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.35)',
                    whiteSpace: 'nowrap',
                    cursor: !isStreaming ? 'pointer' : 'not-allowed',
                    transition: 'background 0.2s, color 0.2s',
                    textAlign: 'left',
                  }}
                  onMouseEnter={(e) => {
                    if (!isStreaming) e.currentTarget.style.background = 'rgba(0,0,0,0.26)';
                  }}
                  onMouseLeave={(e) => {
                    if (!isStreaming) e.currentTarget.style.background = 'rgba(0,0,0,0.18)';
                  }}
                >
                  {(() => {
                    const hasOpenAI = !!openaiApiKey;
                    const hasGemini = !!geminiApiKey;
                    const hasClaude = !!claudeApiKey;
                    const providers = [
                      hasOpenAI ? 'OpenAI' : null,
                      hasGemini ? 'Gemini' : null,
                      hasClaude ? 'Claude' : null,
                    ].filter(Boolean).join(', ');
                    const hasAny = hasOpenAI || hasGemini || hasClaude;
                    return hasAny ? `API 키: 설정됨 (${providers})` : 'API 키: 없음';
                  })()}
                </button>

                {/* 모델 선택 (API 키 옆으로 이동) */}
                <div style={{ position: 'relative' }}>
                  <button
                    onClick={() => !isStreaming && connected && setIsModelMenuOpen(!isModelMenuOpen)}
                    disabled={!connected || isStreaming}
                    style={{
                      padding: '5px 8px',
                      background: isModelMenuOpen ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)',
                      color: (connected && !isStreaming) ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.35)',
                      border: 'none',
                      borderRadius: 10,
                      cursor: (connected && !isStreaming) ? 'pointer' : 'not-allowed',
                      fontSize: 11,
                      fontWeight: 700,
                      transition: 'all 0.2s',
                      whiteSpace: 'nowrap',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      maxWidth: 220
                    }}
                    onMouseEnter={(e) => {
                      if (connected && !isStreaming) e.currentTarget.style.background = 'rgba(255,255,255,0.14)';
                    }}
                    onMouseLeave={(e) => {
                      if (!isStreaming) e.currentTarget.style.background = isModelMenuOpen ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)';
                    }}
                  >
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {availableModels.find(m => m.value === selectedModel)?.label}
                    </span>
                    <span style={{
                      fontSize: 8,
                      opacity: 0.6,
                      transform: isModelMenuOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                      transition: 'transform 0.2s'
                    }}>▼</span>
                  </button>
                  {isModelMenuOpen && (
                    <>
                      <div
                        onClick={() => setIsModelMenuOpen(false)}
                        style={{ position: 'fixed', inset: 0, zIndex: 999 }}
                      />
                      <div style={{
                        position: 'absolute',
                        top: 'calc(100% + 8px)',
                        right: 0,
                        width: 200,
                        background: 'rgba(35, 38, 45, 0.98)',
                        backdropFilter: 'blur(20px)',
                        border: 'none',
                        borderRadius: 12,
                        padding: 6,
                        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
                        animation: 'slideUpFade 0.2s ease-out',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2,
                        zIndex: 1000
                      }}>
                        {availableModels.map((model) => (
                          <div
                            key={model.value}
                            onClick={() => {
                              // 모델을 바꾸면 백엔드 세션(thread/response)이 섞이면 안 되므로 대화/세션을 초기화한다.
                              setSelectedModel(model.value);
                              setIsModelMenuOpen(false);
                              setMessages([]);
                              client?.clearHistory();
                            }}
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              padding: '8px 12px',
                              borderRadius: 8,
                              cursor: 'pointer',
                              transition: 'all 0.2s',
                              background: selectedModel === model.value ? 'rgba(33, 150, 243, 0.15)' : 'transparent',
                            }}
                            onMouseEnter={(e) => {
                              if (selectedModel !== model.value) {
                                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
                              }
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = selectedModel === model.value ? 'rgba(33, 150, 243, 0.15)' : 'transparent';
                            }}
                          >
                            <span style={{ fontSize: 12, fontWeight: 600, color: selectedModel === model.value ? '#3da9ff' : '#eee' }}>{model.label}</span>
                            <span style={{ fontSize: 9, color: 'rgba(255, 255, 255, 0.4)', marginTop: 1 }}>{model.provider}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* API Key 패널 (로컬 저장) */}
              {isApiKeyPanelOpen && (
                <div style={{
                  marginBottom: 12,
                  padding: 12,
                  background: 'rgba(0, 0, 0, 0.25)',
                  borderRadius: 12,
                  border: 'none',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  boxSizing: 'border-box',
                  backdropFilter: 'blur(10px)'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', display: 'flex', alignItems: 'center', gap: 6 }}>
                      API 설정
                    </div>
                    <button
                      onClick={() => setShowKeys((v) => !v)}
                      style={{
                        padding: '4px 10px',
                        background: 'rgba(255,255,255,0.1)',
                        color: 'rgba(255,255,255,0.8)',
                        border: 'none',
                        borderRadius: 6,
                        cursor: 'pointer',
                        fontSize: 11,
                        fontWeight: 500,
                        transition: 'all 0.2s'
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.15)'; e.currentTarget.style.color = '#fff'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; e.currentTarget.style.color = 'rgba(255,255,255,0.8)'; }}
                    >
                      {showKeys ? '가리기' : '표시'}
                    </button>
                  </div>

                  <label style={{
                    display: 'flex',
                    gap: 10,
                    alignItems: 'center',
                    fontSize: 12,
                    color: 'rgba(255,255,255,0.75)',
                    fontWeight: 600,
                    userSelect: 'none'
                  }}>
                    <input
                      type="checkbox"
                      checked={rememberKeys}
                      onChange={(e) => setRememberKeys(e.target.checked)}
                    />
                    이 기기에 저장(기본). 끄면 이번 탭에서만 사용(미저장)
                  </label>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    {/* OpenAI Input */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', fontWeight: 600, paddingLeft: 2 }}>
                        OpenAI API Key <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', fontWeight: 400 }}>(GPT)</span>
                      </label>
                      <input
                        type={showKeys ? 'text' : 'password'}
                        value={openaiApiKey}
                        onChange={(e) => setOpenaiApiKey(e.target.value)}
                        placeholder="sk-..."
                        style={{
                          width: '100%',
                          padding: '10px 12px',
                          borderRadius: 8,
                          border: 'none',
                          background: 'rgba(0,0,0,0.2)',
                          color: '#fff',
                          outline: 'none',
                          fontSize: 13,
                          fontFamily: 'monospace',
                          boxSizing: 'border-box',
                          transition: 'border-color 0.2s, background 0.2s'
                        }}
                        onFocus={(e) => { e.currentTarget.style.borderColor = '#2196F3'; e.currentTarget.style.background = 'rgba(0,0,0,0.4)'; }}
                        onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; e.currentTarget.style.background = 'rgba(0,0,0,0.2)'; }}
                      />
                    </div>

                    {/* Gemini Input */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', fontWeight: 600, paddingLeft: 2 }}>
                        Gemini API Key <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', fontWeight: 400 }}>(Gemini)</span>
                      </label>
                      <input
                        type={showKeys ? 'text' : 'password'}
                        value={geminiApiKey}
                        onChange={(e) => setGeminiApiKey(e.target.value)}
                        placeholder="AIza..."
                        style={{
                          width: '100%',
                          padding: '10px 12px',
                          borderRadius: 8,
                          border: 'none',
                          background: 'rgba(0,0,0,0.2)',
                          color: '#fff',
                          outline: 'none',
                          fontSize: 13,
                          fontFamily: 'monospace',
                          boxSizing: 'border-box',
                          transition: 'border-color 0.2s, background 0.2s'
                        }}
                        onFocus={(e) => { e.currentTarget.style.borderColor = '#2196F3'; e.currentTarget.style.background = 'rgba(0,0,0,0.4)'; }}
                        onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; e.currentTarget.style.background = 'rgba(0,0,0,0.2)'; }}
                      />
                    </div>

                    {/* Claude Input */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', fontWeight: 600, paddingLeft: 2 }}>
                        Claude API Key <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', fontWeight: 400 }}>(Anthropic)</span>
                      </label>
                      <input
                        type={showKeys ? 'text' : 'password'}
                        value={claudeApiKey}
                        onChange={(e) => setClaudeApiKey(e.target.value)}
                        placeholder="sk-ant-..."
                        style={{
                          width: '100%',
                          padding: '10px 12px',
                          borderRadius: 8,
                          border: 'none',
                          background: 'rgba(0,0,0,0.2)',
                          color: '#fff',
                          outline: 'none',
                          fontSize: 13,
                          fontFamily: 'monospace',
                          boxSizing: 'border-box',
                          transition: 'border-color 0.2s, background 0.2s'
                        }}
                        onFocus={(e) => { e.currentTarget.style.borderColor = '#2196F3'; e.currentTarget.style.background = 'rgba(0,0,0,0.4)'; }}
                        onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; e.currentTarget.style.background = 'rgba(0,0,0,0.2)'; }}
                      />
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => {
                        try {
                          localStorage.removeItem('alphacanvas_openai_api_key');
                          localStorage.removeItem('alphacanvas_gemini_api_key');
                          localStorage.removeItem('alphacanvas_claude_api_key');
                        } catch { }
                        setOpenaiApiKey('');
                        setGeminiApiKey('');
                        setClaudeApiKey('');
                        client?.setApiKeys({ openai: null, gemini: null, claude: null });
                      }}
                      style={{
                        padding: '8px 12px',
                        background: 'rgba(255,255,255,0.06)',
                        color: 'rgba(255,255,255,0.8)',
                        border: 'none',
                        borderRadius: 10,
                        cursor: 'pointer',
                        fontSize: 12,
                        fontWeight: 700
                      }}
                    >
                      키 삭제
                    </button>
                    <button
                      onClick={() => {
                        // 우선 메모리에 반영 (미저장 모드에서도 즉시 적용)
                        client?.setApiKeys({
                          openai: openaiApiKey.trim() ? openaiApiKey.trim() : null,
                          gemini: geminiApiKey.trim() ? geminiApiKey.trim() : null,
                          claude: claudeApiKey.trim() ? claudeApiKey.trim() : null,
                        });
                        try {
                          if (rememberKeys) {
                            if (openaiApiKey.trim()) localStorage.setItem('alphacanvas_openai_api_key', openaiApiKey.trim());
                            else localStorage.removeItem('alphacanvas_openai_api_key');
                            if (geminiApiKey.trim()) localStorage.setItem('alphacanvas_gemini_api_key', geminiApiKey.trim());
                            else localStorage.removeItem('alphacanvas_gemini_api_key');
                            if (claudeApiKey.trim()) localStorage.setItem('alphacanvas_claude_api_key', claudeApiKey.trim());
                            else localStorage.removeItem('alphacanvas_claude_api_key');
                          } else {
                            // 미저장: 혹시 남아있는 키가 있다면 제거
                            localStorage.removeItem('alphacanvas_openai_api_key');
                            localStorage.removeItem('alphacanvas_gemini_api_key');
                            localStorage.removeItem('alphacanvas_claude_api_key');
                          }
                        } catch { }
                        // 패널은 유지
                      }}
                      style={{
                        padding: '8px 12px',
                        background: '#2196F3',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 10,
                        cursor: 'pointer',
                        fontSize: 12,
                        fontWeight: 800
                      }}
                    >
                      저장
                    </button>
                  </div>
                </div>
              )}
            </div>

            {messages.length === 0 && !isStreaming && (
              <div style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'rgba(255,255,255,0.5)'
              }}>
                AI Agent에게 요청하세요.
              </div>
            )}

            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                isExpanded={expandedReasoning.has(msg.id)}
                onToggleReasoning={() => toggleReasoning(msg.id)}
              />
            ))}

            {/* 스트리밍 중인 메시지 */}
            {isStreaming && (
              <div>
                <div style={{
                  fontSize: 13,
                  color: 'rgba(255,255,255,0.5)',
                  marginBottom: 4,
                  fontWeight: 500
                }}>
                  AI
                </div>

                <div className="message-content" style={{
                  background: 'rgba(255,255,255,0.1)',
                  borderRadius: 8,
                  padding: 12,
                }}>
                  {/* 텍스트, 추론, 도구를 순서대로 표시 (추론1 - 멘트1 - 도구1 - 추론2 - 멘트2 - 도구2) */}
                  {streamingElements.map((element) => (
                    element.type === 'text' ? (
                      <div
                        key={element.id}
                        style={{
                          fontSize: 14,
                          color: 'rgba(255,255,255,0.85)',
                          lineHeight: 1.5,
                          fontWeight: 600,
                          wordBreak: 'keep-all',
                          marginBottom: 8
                        }}
                        dangerouslySetInnerHTML={{
                          __html:
                            renderTextWithLatex(element.content) +
                            (isStreaming && element.id === currentTextElementId ? '<span style="animation: blink 1s infinite; margin-left: 2px;">▊</span>' : '')
                        }}
                      />
                    ) : element.type === 'reasoning' ? (
                      // 추론 표시 (인터리빙: 추론 → 텍스트/도구 순서)
                      (() => {
                        const isCurrentReasoning = currentReasoningElementIdRef.current === element.id;
                        const isExpanded = isCurrentReasoning || expandedStreamingReasoning.has(element.id);
                        return (
                          <div key={element.id} style={{ marginBottom: 10, overflow: 'hidden' }}>
                            <button
                              onClick={() => {
                                if (!isCurrentReasoning) {
                                  setExpandedStreamingReasoning(prev => {
                                    const next = new Set(prev);
                                    if (next.has(element.id)) next.delete(element.id);
                                    else next.add(element.id);
                                    return next;
                                  });
                                }
                              }}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                cursor: isCurrentReasoning ? 'default' : 'pointer',
                                background: 'rgba(255, 255, 255, 0.08)',
                                border: 'none',
                                borderRadius: isExpanded ? '6px 6px 0 0' : 6,
                                padding: '6px 10px',
                                width: '100%',
                                textAlign: 'left',
                                color: 'rgba(255, 255, 255, 0.7)',
                                fontSize: 12,
                                fontWeight: 600,
                                transition: 'all 0.2s',
                                outline: 'none',
                              }}
                              onMouseEnter={(e) => !isCurrentReasoning && (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.12)')}
                              onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)'}
                            >
                              <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                width: 16,
                                height: 16,
                                borderRadius: 4,
                                background: 'rgba(0,0,0,0.2)',
                                fontSize: 10,
                                transition: 'transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                                transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                                animation: isCurrentReasoning ? 'pulse 1.5s infinite' : 'none',
                              }}>▶</div>
                              <span>{isCurrentReasoning ? '추론 중...' : '추론 과정'}</span>
                              {!isCurrentReasoning && (
                                <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.5, fontWeight: 500 }}>
                                  {isExpanded ? '접기' : '펼치기'}
                                </span>
                              )}
                            </button>
                            <div style={{
                              maxHeight: isExpanded ? '500px' : '0px',
                              opacity: isExpanded ? 1 : 0,
                              overflow: 'hidden',
                              transition: 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)',
                              background: 'rgba(0, 0, 0, 0.15)',
                              borderRadius: '0 0 6px 6px',
                              borderTop: isExpanded ? '1px solid rgba(255,255,255,0.05)' : 'none',
                              marginTop: isExpanded ? 0 : -2,
                            }}>
                              <div 
                                ref={isCurrentReasoning ? streamingReasoningScrollRef : undefined}
                                className="agent-reasoning-scroll" 
                                style={{
                                  padding: '12px',
                                  fontSize: 12,
                                  lineHeight: 1.5,
                                  color: 'rgba(255, 255, 255, 0.75)',
                                  whiteSpace: 'pre-wrap',
                                  fontFamily: 'inherit',
                                  maxHeight: isCurrentReasoning ? 200 : undefined,
                                  overflowY: isCurrentReasoning ? 'auto' : undefined,
                                }} 
                                dangerouslySetInnerHTML={{ __html: renderTextWithLatex(element.content) }} 
                              />
                            </div>
                          </div>
                        );
                      })()
                    ) : element.type === 'view' ? (
                      <div key={element.id} style={{
                        marginBottom: 8,
                        padding: '6px 10px',
                        background: 'rgba(255, 255, 255, 0.08)',
                        borderRadius: 6,
                        fontSize: 11,
                        color: 'rgba(255,255,255,0.7)',
                        display: 'inline-block',
                        width: 'fit-content'
                      }}>
                        ✓ 그래프 상태 확인됨
                      </div>
                    ) : element.type === 'gemini-oracle' ? (
                      // 🔮 Gemini Oracle 박스 (기존 도구 디자인과 통일)
                      <div key={element.id} style={{
                        marginBottom: 8,
                        padding: '6px 10px',
                        background: 'rgba(255, 255, 255, 0.08)',
                        borderRadius: 6,
                        fontSize: 11,
                        color: 'rgba(255,255,255,0.7)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        width: 'fit-content'
                      }}>
                        {element.content.includes('완료') ? (
                          <>
                            <span style={{ fontSize: 12 }}>✓</span>
                            <span>{element.content}</span>
                          </>
                        ) : (
                          <>
                            <span style={{ 
                              display: 'inline-block',
                              animation: 'toolPendingSpin 1s linear infinite',
                              fontSize: 12
                            }}>🔮</span>
                            <span>{element.content}</span>
                          </>
                        )}
                      </div>
                    ) : (element.type === 'tool-pending' || element.type === 'tool') ? (
                      <div key={element.id} style={{ marginBottom: 8 }}>
                        {/* 도구 박스 헤더 */}
                        <div
                          onClick={() => {
                            if (element.type === 'tool' && element.toolDetails?.length) {
                              setExpandedTools(prev => {
                                const next = new Set(prev);
                                if (next.has(element.id)) next.delete(element.id);
                                else next.add(element.id);
                                return next;
                              });
                            }
                          }}
                          style={{
                            padding: '6px 10px',
                            background: element.type === 'tool-pending' ? 'rgba(80, 85, 95, 0.9)' : '#3da9ff',
                            borderRadius: expandedTools.has(element.id) ? '6px 6px 0 0' : 6,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            minWidth: 140,
                            height: 28,
                            boxSizing: 'border-box',
                            cursor: element.type === 'tool' && element.toolDetails?.length ? 'pointer' : 'default',
                          }}
                        >
                          {/* 아이콘 컨테이너 */}
                          <div style={{
                            width: 14,
                            height: 14,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                          }}>
                            {element.type === 'tool-pending' ? (
                              <div style={{
                                width: 12,
                                height: 12,
                                borderRadius: '50%',
                                border: '2px solid rgba(255, 255, 255, 0.3)',
                                borderTopColor: 'rgba(255, 255, 255, 0.9)',
                                animation: 'toolPendingSpin 0.8s linear infinite',
                                boxSizing: 'border-box',
                              }} />
                            ) : (
                              <span style={{ 
                                fontSize: 10, 
                                color: '#fff', 
                                transform: expandedTools.has(element.id) ? 'rotate(90deg)' : 'rotate(0deg)',
                                transition: 'transform 0.2s',
                              }}>
                                {element.toolDetails?.length ? '▶' : '✓'}
                              </span>
                            )}
                          </div>
                          <span style={{ fontSize: 11, color: '#fff', fontWeight: 600 }}>
                            {element.content}
                          </span>
                        </div>
                        {/* 펼쳐진 상세 내용 */}
                        {expandedTools.has(element.id) && element.toolDetails && element.toolDetails.length > 0 && (
                          <div style={{
                            background: 'rgba(61, 169, 255, 0.15)',
                            borderRadius: '0 0 6px 6px',
                            padding: '8px 10px',
                            fontSize: 11,
                            color: 'rgba(255,255,255,0.85)',
                          }}>
                            {element.toolDetails.map((detail, idx) => (
                              <div key={idx} style={{ 
                                padding: '4px 0',
                                borderBottom: idx < (element.toolDetails?.length || 0) - 1 ? '1px solid rgba(255,255,255,0.1)' : 'none'
                              }}>
                                <span style={{ fontWeight: 600 }}>{detail.name}</span>
                                {detail.description && (
                                  <span style={{ color: 'rgba(255,255,255,0.6)', marginLeft: 6 }}>{detail.description}</span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : null
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 커스텀 스크롤바 트랙 - 스크롤이 필요할 때만 표시 */}
          {scrollbarHeight > 0 && (
            <div
              style={{
                position: 'absolute',
                right: 6,
                top: 12,
                bottom: 12,
                width: 4,
                background: 'rgba(0, 0, 0, 0.15)',
                zIndex: 9
              }}
            />
          )}
          {/* 커스텀 스크롤바 */}
          {scrollbarHeight > 0 && (
            <div
              style={{
                position: 'absolute',
                right: 6,
                top: scrollbarTop + 12,
                width: 4,
                height: scrollbarHeight,
                background: isDragging ? 'rgba(255, 255, 255, 0.6)' : 'rgba(255, 255, 255, 0.4)',
                transition: isDragging ? 'none' : 'background 0.2s',
                cursor: 'pointer',
                zIndex: 10
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.6)';
              }}
              onMouseLeave={(e) => {
                if (!isDragging) {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.4)';
                }
              }}
            />
          )}
        </div>

        {/* Input panel - 분리된 입력창 */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          background: 'rgba(80, 85, 95, 0.7)',
          borderRadius: 12,
          padding: '20px',
          position: 'relative' // 모델 선택기 위치 기준
        }}>
          {/* 이미지 미리보기 영역 */}
          {attachedImages.length > 0 && (
            <div style={{
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              padding: '8px',
              background: 'rgba(0, 0, 0, 0.2)',
              borderRadius: 8,
            }}>
              {attachedImages.map((img, idx) => (
                <div key={idx} style={{
                  position: 'relative',
                  width: 80,
                  height: 80,
                  borderRadius: 6,
                  overflow: 'hidden',
                  border: 'none'
                }}>
                  <img
                    src={`data:${img.mimeType};base64,${img.base64}`}
                    alt={img.filename || '첨부 이미지'}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover'
                    }}
                  />
                  <button
                    onClick={() => removeImage(idx)}
                    style={{
                      position: 'absolute',
                      top: 2,
                      right: 2,
                      width: 20,
                      height: 20,
                      background: 'rgba(0, 0, 0, 0.7)',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '50%',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 12,
                      padding: 0
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8
          }}>
            {/* 입력창(왼쪽) + 컨트롤(오른쪽 세로) */}
            <div style={{
              display: 'flex',
              gap: 4,
              alignItems: 'stretch'
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onPaste={handlePaste}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !isStreaming) {
                      e.preventDefault();
                      onSend();
                    }
                  }}
                  placeholder={
                    isStreaming
                      ? 'AI가 응답 중입니다...'
                      : connected
                        ? 'AI Agent에게 요청하세요.'
                        : '연결 중... 잠시만 기다려주세요'
                  }
                  disabled={!connected || isStreaming}
                  rows={4}
                  style={{
                    width: '100%',
                    height: '100%',
                    minHeight: 118,
                    background: 'transparent',
                    border: 'none',
                    borderRadius: 10,
                    color: '#fff',
                    padding: '8px 10px',
                    outline: 'none',
                    fontSize: 14,
                    resize: 'none',
                    fontFamily: 'inherit',
                    opacity: isStreaming ? 0.5 : 1,
                    boxSizing: 'border-box'
                  }}
                />
              </div>

              {/* 컨트롤(오른쪽 세로 컬럼) */}
              <div style={{
                width: 100,
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                alignItems: 'stretch'
              }}>
                {/* 스트리밍 중이면 중지 버튼, 아니면 전송 버튼 */}
                {isStreaming ? (
                  <button
                    onClick={onAbortStream}
                    style={{
                      padding: '10px 12px',
                      width: '100%',
                      background: '#f44336',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 8,
                      cursor: 'pointer',
                      fontSize: 13,
                      fontWeight: 700,
                      transition: 'all 0.2s',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = '#d32f2f';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = '#f44336';
                    }}
                  >
                    <span style={{ fontSize: 14 }}>■</span>
                    <span>중지</span>
                  </button>
                ) : (
                  <button onClick={onSend} disabled={!connected || (!input.trim() && attachedImages.length === 0)} style={{
                    padding: '8px 10px',
                    width: '100%',
                    background: (connected && (input.trim() || attachedImages.length > 0)) ? '#2196F3' : 'rgba(255,255,255,0.2)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    cursor: (connected && (input.trim() || attachedImages.length > 0)) ? 'pointer' : 'not-allowed',
                    fontSize: 13,
                    fontWeight: 700,
                    transition: 'all 0.2s'
                  }}>전송</button>
                )}

                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!connected || isStreaming}
                  style={{
                    padding: '12px 8px',
                    width: '100%',
                    textAlign: 'center',
                    background: 'transparent',
                    color: (connected && !isStreaming) ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.35)',
                    border: 'none',
                    borderRadius: 8,
                    cursor: (connected && !isStreaming) ? 'pointer' : 'not-allowed',
                    fontSize: 12,
                    fontWeight: 600,
                    transition: 'background 0.2s, color 0.2s',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}
                  onMouseEnter={(e) => {
                    if (connected && !isStreaming) e.currentTarget.style.background = 'transparent';
                  }}
                  onMouseLeave={(e) => {
                    if (!isStreaming) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  사진 (Ctrl+V)
                </button>

                <button
                  onClick={onClearHistory}
                  disabled={!connected || isStreaming}
                  style={{
                    padding: '8px 10px',
                    width: '100%',
                    textAlign: 'center',
                    background: 'transparent',
                    color: (connected && !isStreaming) ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.35)',
                    border: 'none',
                    borderRadius: 8,
                    cursor: (connected && !isStreaming) ? 'pointer' : 'not-allowed',
                    fontSize: 12,
                    fontWeight: 600,
                    transition: 'background 0.2s, color 0.2s',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}
                  onMouseEnter={(e) => {
                    if (connected && !isStreaming) e.currentTarget.style.background = 'transparent';
                  }}
                  onMouseLeave={(e) => {
                    if (!isStreaming) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  대화 초기화
                </button>
              </div>
            </div>
          </div>

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleFileSelect}
            style={{ display: 'none' }}
          />
        </div>

        <style>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideUpFade {
          from { opacity: 0; transform: translateY(12px) scale(0.95); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes shimmer {
          0% { background-position: -200px 0; }
          100% { background-position: 200px 0; }
        }
        @keyframes toolPendingSpin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.7; }
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        /* 메시지 박스 마지막 요소 하단 여백 제거 */
        .message-content > *:last-child {
          margin-bottom: 0 !important;
        }
        textarea::placeholder {
          color: rgba(255, 255, 255, 0.8);
        }
        
        /* 애플 스타일 미니멀 I-beam 커서 */
        textarea {
          cursor: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDE4IDI0Ij48bGluZSB4MT0iOSIgeTE9IjMiIHgyPSI5IiB5Mj0iMjEiIHN0cm9rZT0id2hpdGUiIHN0cm9rZS13aWR0aD0iMS4yIiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48bGluZSB4MT0iNiIgeTE9IjMiIHgyPSIxMiIgeTI9IjMiIHN0cm9rZT0id2hpdGUiIHN0cm9rZS13aWR0aD0iMS4yIiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48bGluZSB4MT0iNiIgeTE9IjIxIiB4Mj0iMTIiIHkyPSIyMSIgc3Ryb2tlPSJ3aGl0ZSIgc3Ryb2tlLXdpZHRoPSIxLjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjwvc3ZnPg==') 9 12, text;
        }
        
        /* 기본 스크롤바 완전히 숨기기 */
        .agent-chat-scrollarea-hidden::-webkit-scrollbar {
          display: none;
          width: 0;
          height: 0;
        }
        
        .agent-chat-scrollarea-hidden {
          scrollbar-width: none;
          -ms-overflow-style: none;
        }
      `}</style>
      </div >
    </>
  );
});

// LaTeX 수식과 마크다운을 렌더링하는 함수
function renderTextWithLatex(text: string): string {
  const escapeHtml = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  // 입력 텍스트는 기본적으로 HTML 이스케이프하여 XSS를 차단하고,
  // LaTeX(\[...\], \(...\))만 KaTeX로 렌더된 안전한 HTML로 치환한다.
  let src = (text ?? '').trim();

  const mathChunks: string[] = [];
  const inlinePrefix = '__MATH_INLINE__';
  const blockPrefix = '__MATH_BLOCK__';
  const shouldRenderDollarMath = (latex: string) => {
    const s = (latex ?? '').trim();
    if (!s) return false;
    // Heuristic to avoid turning currency like "$100" into KaTeX.
    // Render if it likely contains math-ish content.
    return /[a-zA-Z\\^_={}\[\]()<>+\-*/]/.test(s);
  };

  // 1) 블록 수식 \[...\] 처리 (원문 latex 그대로 KaTeX에 전달)
  src = src.replace(/\\\[([\s\S]*?)\\\]/g, (match, latex) => {
    try {
      const html = katex.renderToString(latex, {
        throwOnError: false,
        displayMode: true,
        // 보안: trust=true는 위험한 HTML 기능을 허용할 수 있으므로 끔
        trust: false,
        strict: 'ignore'
      });
      const id = mathChunks.length;
      mathChunks.push(html);
      return `${blockPrefix}${id}__`;
    } catch (e) {
      console.error('KaTeX render error (block):', e, latex);
      return match;
    }
  });

  // 2) 인라인 수식 \(...\) 처리
  src = src.replace(/\\\(([\s\S]*?)\\\)/g, (match, latex) => {
    try {
      const html = katex.renderToString(latex, {
        throwOnError: false,
        displayMode: false,
        trust: false,
        strict: 'ignore'
      });
      const id = mathChunks.length;
      mathChunks.push(html);
      return `${inlinePrefix}${id}__`;
    } catch (e) {
      console.error('KaTeX render error (inline):', e, latex);
      return match;
    }
  });

  // 3) 블록 수식 $$...$$ 처리 (Gemini/Markdown 스타일)
  src = src.replace(/\$\$([\s\S]*?)\$\$/g, (match, latex) => {
    const raw = String(latex ?? '');
    if (!shouldRenderDollarMath(raw)) return match;
    try {
      const html = katex.renderToString(raw.trim(), {
        throwOnError: false,
        displayMode: true,
        trust: false,
        strict: 'ignore'
      });
      const id = mathChunks.length;
      mathChunks.push(html);
      return `${blockPrefix}${id}__`;
    } catch (e) {
      console.error('KaTeX render error ($$ block):', e, raw);
      return match;
    }
  });

  // 4) 인라인 수식 $...$ 처리 (단, $$는 위에서 이미 처리됨)
  //    - 한 줄 내에서만 처리 (줄바꿈 포함 X)
  //    - 통화 표기 등을 피하기 위해 간단 휴리스틱 사용
  src = src.replace(/\$([^\n$]*?)\$/g, (match, latex) => {
    const raw = String(latex ?? '');
    if (!shouldRenderDollarMath(raw)) return match;
    try {
      const html = katex.renderToString(raw.trim(), {
        throwOnError: false,
        displayMode: false,
        trust: false,
        strict: 'ignore'
      });
      const id = mathChunks.length;
      mathChunks.push(html);
      return `${inlinePrefix}${id}__`;
    } catch (e) {
      console.error('KaTeX render error ($ inline):', e, raw);
      return match;
    }
  });

  // 5) 나머지 일반 텍스트는 HTML 이스케이프
  src = escapeHtml(src);

  // 6) 마크다운 볼드 **텍스트** (이스케이프된 텍스트에만 적용)
  src = src.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // 7) 줄바꿈 처리
  src = src.replace(/\n/g, '<br>');

  // 8) KaTeX 결과(HTML)를 복원
  for (let i = 0; i < mathChunks.length; i++) {
    src = src
      .replaceAll(`${blockPrefix}${i}__`, mathChunks[i])
      .replaceAll(`${inlinePrefix}${i}__`, mathChunks[i]);
  }

  return src;
}

function MessageBubble({ message, isExpanded, onToggleReasoning }: {
  message: Message;
  isExpanded: boolean;
  onToggleReasoning: () => void;
}) {
  const isUser = message.role === 'user';
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  // 각 추론 요소별 펼침/접기 상태 (elements에 여러 reasoning이 있을 때)
  const [expandedReasoningElements, setExpandedReasoningElements] = useState<Set<string>>(new Set());

  // elements에 reasoning이 있는지 확인 (있으면 elements 순서대로 표시, 없으면 기존 message.reasoning 사용)
  const hasReasoningInElements = message.elements?.some(el => el.type === 'reasoning') ?? false;

  return (
    <div>
      <div style={{
        fontSize: 13,
        color: 'rgba(255,255,255,0.5)',
        marginBottom: 4,
        fontWeight: 500
      }}>
        {isUser ? '사용자' : 'AI'}
      </div>

      <div className="message-content" style={{
        background: isUser ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.1)',
        borderRadius: 8,
        padding: 12,
      }}>
        {/* 추론 과정 (assistant only) - elements에 reasoning이 없을 때만 기존 방식으로 표시 */}
        {!isUser && message.reasoning && !hasReasoningInElements && (
          <div style={{
            marginBottom: 10,
            overflow: 'hidden',
          }}>
            <button
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                cursor: 'pointer',
                background: 'rgba(255, 255, 255, 0.08)',
                border: 'none',
                borderRadius: 6,
                padding: '6px 10px',
                width: '100%',
                textAlign: 'left',
                color: 'rgba(255, 255, 255, 0.7)',
                fontSize: 12,
                fontWeight: 600,
                transition: 'all 0.2s',
                outline: 'none',
              }}
              onClick={onToggleReasoning}
              onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.12)'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)'}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 16,
                  height: 16,
                  borderRadius: 4,
                  background: 'rgba(0,0,0,0.2)',
                  fontSize: 10,
                  transition: 'transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                  transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)'
                }}
              >
                ▶
              </div>
              <span style={{}}>추론 과정</span>
              <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.5, fontWeight: 500 }}>
                {isExpanded ? '접기' : '펼치기'}
              </span>
            </button>

            <div style={{
              maxHeight: isExpanded ? '500px' : '0px',
              opacity: isExpanded ? 1 : 0,
              overflow: 'hidden',
              transition: 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)',
              background: 'rgba(0, 0, 0, 0.15)',
              borderRadius: '0 0 6px 6px',
              borderTop: isExpanded ? '1px solid rgba(255,255,255,0.05)' : 'none',
              marginTop: isExpanded ? 0 : -2 // hide border gap when closed
            }}>
              <div className="agent-reasoning-scroll" style={{
                padding: '12px',
                fontSize: 12,
                lineHeight: 1.5,
                color: 'rgba(255, 255, 255, 0.75)',
                whiteSpace: 'pre-wrap',
                fontFamily: 'inherit'
              }} dangerouslySetInnerHTML={{ __html: renderTextWithLatex(message.reasoning) }} />
            </div>
          </div>
        )}

        {/* 완성된 메시지도 스트리밍과 동일하게 "text → tool → text" 순서로 렌더링 */}
        {!isUser && message.elements && message.elements.map((el, idx) => (
          el.type === 'text' ? (
            <div
              key={`${message.id}-el-${idx}`}
              style={{
                fontSize: 14,
                lineHeight: 1.5,
                color: 'rgba(255,255,255,0.85)',
                fontWeight: 600,
                wordBreak: 'keep-all',
                marginBottom: 8
              }}
              dangerouslySetInnerHTML={{ __html: renderTextWithLatex(el.content) }}
            />
          ) : el.type === 'view' ? (
            <div key={`${message.id}-el-${idx}`} style={{
              marginBottom: 8,
              padding: '6px 10px',
              background: 'rgba(255, 255, 255, 0.08)',
              borderRadius: 6,
              fontSize: 11,
              color: 'rgba(255,255,255,0.7)',
              display: 'inline-block',
              width: 'fit-content'
            }}>
              ✓ 그래프 상태 확인됨
            </div>
          ) : el.type === 'reasoning' ? (
            // 추론 과정 (elements에 순서대로 표시)
            <div key={`${message.id}-el-${idx}`} style={{ marginBottom: 10, overflow: 'hidden' }}>
              <button
                onClick={() => {
                  const key = `${message.id}-el-${idx}`;
                  setExpandedReasoningElements(prev => {
                    const next = new Set(prev);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  });
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  cursor: 'pointer',
                  background: 'rgba(255, 255, 255, 0.08)',
                  border: 'none',
                  borderRadius: expandedReasoningElements.has(`${message.id}-el-${idx}`) ? '6px 6px 0 0' : 6,
                  padding: '6px 10px',
                  width: '100%',
                  textAlign: 'left',
                  color: 'rgba(255, 255, 255, 0.7)',
                  fontSize: 12,
                  fontWeight: 600,
                  transition: 'all 0.2s',
                  outline: 'none',
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.12)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)'}
              >
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 16,
                  height: 16,
                  borderRadius: 4,
                  background: 'rgba(0,0,0,0.2)',
                  fontSize: 10,
                  transition: 'transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                  transform: expandedReasoningElements.has(`${message.id}-el-${idx}`) ? 'rotate(90deg)' : 'rotate(0deg)',
                }}>▶</div>
                <span>추론 과정</span>
                <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.5, fontWeight: 500 }}>
                  {expandedReasoningElements.has(`${message.id}-el-${idx}`) ? '접기' : '펼치기'}
                </span>
              </button>
              <div style={{
                maxHeight: expandedReasoningElements.has(`${message.id}-el-${idx}`) ? '500px' : '0px',
                opacity: expandedReasoningElements.has(`${message.id}-el-${idx}`) ? 1 : 0,
                overflow: 'hidden',
                transition: 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)',
                background: 'rgba(0, 0, 0, 0.15)',
                borderRadius: '0 0 6px 6px',
                borderTop: expandedReasoningElements.has(`${message.id}-el-${idx}`) ? '1px solid rgba(255,255,255,0.05)' : 'none',
                marginTop: expandedReasoningElements.has(`${message.id}-el-${idx}`) ? 0 : -2,
              }}>
                <div className="agent-reasoning-scroll" style={{
                  padding: '12px',
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: 'rgba(255, 255, 255, 0.75)',
                  whiteSpace: 'pre-wrap',
                  fontFamily: 'inherit',
                }} dangerouslySetInnerHTML={{ __html: renderTextWithLatex(el.content) }} />
              </div>
            </div>
          ) : (
            <div key={`${message.id}-el-${idx}`} style={{ marginBottom: 8 }}>
              {/* 도구 박스 헤더 */}
              <div
                onClick={() => {
                  if (el.toolDetails?.length) {
                    const key = `${message.id}-el-${idx}`;
                    setExpandedTools(prev => {
                      const next = new Set(prev);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    });
                  }
                }}
                style={{
                  padding: '6px 10px',
                  background: '#3da9ff',
                  borderRadius: expandedTools.has(`${message.id}-el-${idx}`) ? '6px 6px 0 0' : 6,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  minWidth: 140,
                  height: 28,
                  boxSizing: 'border-box',
                  cursor: el.toolDetails?.length ? 'pointer' : 'default',
                }}
              >
                <div style={{
                  width: 14,
                  height: 14,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  <span style={{ 
                    fontSize: 10, 
                    color: '#fff',
                    transform: expandedTools.has(`${message.id}-el-${idx}`) ? 'rotate(90deg)' : 'rotate(0deg)',
                    transition: 'transform 0.2s',
                  }}>
                    {el.toolDetails?.length ? '▶' : '✓'}
                  </span>
                </div>
                <span style={{ fontSize: 11, color: '#fff', fontWeight: 600 }}>
                  {el.content}
                </span>
              </div>
              {/* 펼쳐진 상세 내용 */}
              {expandedTools.has(`${message.id}-el-${idx}`) && el.toolDetails && el.toolDetails.length > 0 && (
                <div style={{
                  background: 'rgba(61, 169, 255, 0.15)',
                  borderRadius: '0 0 6px 6px',
                  padding: '8px 10px',
                  fontSize: 11,
                  color: 'rgba(255,255,255,0.85)',
                }}>
                  {el.toolDetails.map((detail, dIdx) => (
                    <div key={dIdx} style={{ 
                      padding: '4px 0',
                      borderBottom: dIdx < (el.toolDetails?.length || 0) - 1 ? '1px solid rgba(255,255,255,0.1)' : 'none'
                    }}>
                      <span style={{ fontWeight: 600 }}>{detail.name}</span>
                      {detail.description && (
                        <span style={{ color: 'rgba(255,255,255,0.6)', marginLeft: 6 }}>{detail.description}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        ))}
        {/* 기존 메시지(타임라인 없는 경우)는 기존 렌더링 유지 */}
        {!isUser && !message.elements && message.toolCalls && message.toolCalls.map((tc, idx) => (
          tc.type === 'view' || tc.type === 'Tool/View' ? (
            <div key={idx} style={{
              marginBottom: 8,
              padding: 8,
              background: 'rgba(0, 0, 0, 0.3)',
              borderRadius: 6,
              fontSize: 11,
              color: 'rgba(255,255,255,0.7)',
              display: 'inline-block',
              width: 'fit-content'
            }}>
              그래프 상태 확인됨
            </div>
          ) : (
            <div key={idx} style={{
              marginTop: 0,
              marginBottom: 8,
              padding: '6px 10px',
              background: '#3da9ff',
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              minWidth: 140,
              height: 28,
              boxSizing: 'border-box',
            }}>
              <div style={{
                width: 14,
                height: 14,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}>
                <span style={{ fontSize: 12, color: '#fff', lineHeight: 1 }}>✓</span>
              </div>
              <span style={{
                fontSize: 11,
                color: '#fff',
                fontWeight: 600,
              }}>
                {tc.type}
              </span>
            </div>
          )
        ))}

        {/* 이미지 첨부 */}
        {message.images && message.images.length > 0 && (
          <div style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            marginBottom: 8
          }}>
            {message.images.map((img, idx) => (
              <div key={idx} style={{
                maxWidth: 200,
                borderRadius: 6,
                overflow: 'hidden',
                border: '1px solid rgba(255, 255, 255, 0.2)'
              }}>
                <img
                  src={`data:${img.mimeType};base64,${img.base64}`}
                  alt={img.filename || '첨부 이미지'}
                  style={{
                    width: '100%',
                    height: 'auto',
                    display: 'block'
                  }}
                />
              </div>
            ))}
          </div>
        )}

        {/* 텍스트: 타임라인이 있으면 위에서 렌더링하므로 중복 렌더링하지 않음 */}
        {!isUser && !message.elements && (
          <div
            style={{
              fontSize: 14,
              lineHeight: 1.5,
              color: 'rgba(255,255,255,0.85)',
              fontWeight: 600,
              wordBreak: 'keep-all'
            }}
            dangerouslySetInnerHTML={{ __html: renderTextWithLatex(message.text) }}
          />
        )}
        {isUser && (
          <div
            style={{
              fontSize: 14,
              lineHeight: 1.5,
              color: 'rgba(255,255,255,0.85)',
              fontWeight: 600,
              wordBreak: 'keep-all'
            }}
            dangerouslySetInnerHTML={{ __html: renderTextWithLatex(message.text) }}
          />
        )}
      </div>
    </div>
  );
}

// SkeletonShimmer removed (no longer used)
