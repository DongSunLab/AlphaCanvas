from __future__ import annotations

import asyncio
import os
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import AsyncIterator, Dict, Any, Iterable, List, Optional, Tuple
import re

# Load .env file (조용히)
try:
    from dotenv import load_dotenv, find_dotenv
    env_path = find_dotenv(usecwd=False)
    if not env_path:
        env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), '.env')
    load_dotenv(env_path)
except Exception:
    pass

# OpenAI Agents SDK - 지연 로딩 (필요할 때만 로드)
AGENTS_SDK_AVAILABLE = None  # None = 아직 확인 안 함
Agent = None
Runner = None
ModelSettings = None
function_tool = None
Reasoning = None

def _ensure_agents_sdk():
    """OpenAI Agents SDK를 필요할 때만 로드"""
    global AGENTS_SDK_AVAILABLE, Agent, Runner, ModelSettings, function_tool, Reasoning
    if AGENTS_SDK_AVAILABLE is not None:
        return AGENTS_SDK_AVAILABLE
    try:
        from agents import Agent as _Agent, Runner as _Runner, function_tool as _ft, ModelSettings as _MS
        from openai.types.shared import Reasoning as _Reasoning
        Agent, Runner, function_tool, ModelSettings, Reasoning = _Agent, _Runner, _ft, _MS, _Reasoning
        AGENTS_SDK_AVAILABLE = True
        print("[LlmClient] ✅ OpenAI Agents SDK 로드됨")
    except Exception:
        AGENTS_SDK_AVAILABLE = False
    return AGENTS_SDK_AVAILABLE

# Gemini SDK - 지연 로딩
GEMINI_AVAILABLE = None  # None = 아직 확인 안 함
genai_client = None
genai_types = None

# Claude SDK - 지연 로딩
CLAUDE_AVAILABLE = None  # None = 아직 확인 안 함
anthropic_client = None
anthropic = None

def _ensure_claude_sdk():
    """Claude SDK를 필요할 때만 로드"""
    global CLAUDE_AVAILABLE, anthropic_client, anthropic
    if CLAUDE_AVAILABLE is not None:
        return CLAUDE_AVAILABLE
    try:
        import anthropic as anthropic_module
        anthropic = anthropic_module
        
        CLAUDE_API_KEY = os.getenv('CLAUDE_API_KEY') or os.getenv('ANTHROPIC_API_KEY')
        if CLAUDE_API_KEY:
            try:
                anthropic_client = anthropic_module.Anthropic(api_key=CLAUDE_API_KEY)
            except Exception:
                anthropic_client = None
        CLAUDE_AVAILABLE = True
        print("[LlmClient] ✅ Claude SDK 로드됨")
    except Exception:
        CLAUDE_AVAILABLE = False
    return CLAUDE_AVAILABLE

def _ensure_gemini_sdk():
    """Gemini SDK를 필요할 때만 로드"""
    global GEMINI_AVAILABLE, genai_client, genai_types
    if GEMINI_AVAILABLE is not None:
        return GEMINI_AVAILABLE
    try:
        from google import genai
        from google.genai import types as genai_types_module
        genai_types = genai_types_module
        
        # ✅ 중요:
        # - 프론트에서 geminiApiKey를 "요청별"로 보내는 구조에서는 서버 ENV에 GEMINI_API_KEY가 없어도
        #   SDK import만 가능하면 Gemini 호출이 가능해야 한다.
        # - 따라서 SDK 로드 성공 여부는 "import 성공"으로 판단하고,
        #   env 키가 있으면 공용 client(genai_client)만 미리 만들어둔다.
        GEMINI_API_KEY = os.getenv('GEMINI_API_KEY')
        if GEMINI_API_KEY:
            try:
                genai_client = genai.Client(api_key=GEMINI_API_KEY)
            except Exception:
                genai_client = None
        GEMINI_AVAILABLE = True
        print("[LlmClient] ✅ Gemini SDK 로드됨")
    except Exception:
        GEMINI_AVAILABLE = False
    return GEMINI_AVAILABLE

# 지원하는 Gemini 모델 목록
GEMINI_MODELS = [
    "gemini-3-pro-preview",
    "gemini-3-flash-preview",
]

# 지원하는 Claude 모델 목록
CLAUDE_MODELS = [
    "claude-opus-4-5",
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-5",
]


class StreamChunk:
    def __init__(self, type: str, text: str = "", tool_call: Dict[str, Any] | None = None, metadata: Dict[str, Any] | None = None):
        # type:
        # - 'text': assistant text delta
        # - 'reasoning': reasoning delta
        # - 'tool_start': tool execution is about to start (front-end can show pending UI immediately)
        # - 'tool': tool execution finished (has result or error)
        # - 'thread_id' / 'response_id': session bookkeeping
        self.type = type
        self.text = text
        self.tool_call = tool_call or {}
        self.metadata = metadata or {}


class LlmClient:
    """
    3.3.8 스타일 OpenAI Agents SDK + Responses API 클라이언트
    
    - Agents SDK 사용 (Agent + Runner)
    - Thread/Session 관리 (conversation_id, previous_response_id)
    - 대화 연속성 보장
    """

    def __init__(
        self,
        model: str | None = None,
        thread_id: str | None = None,
        response_id: str | None = None,
        api_key: str | None = None,
    ):
        self.model = model or os.getenv('OPENAI_MODEL', 'gemini-3-flash-preview')
        # 요청별 API 키 지원: api_key가 주어지면 전역 env에 의존하지 않고 이 키로만 호출
        self._openai_key = api_key or os.getenv('OPENAI_API_KEY')
        self._api_key_override = api_key
        self.thread_id = thread_id
        self.response_id = response_id
        
        # Agents SDK 객체들 (지연 초기화)
        self._agent: Optional[Any] = None
        self._runner: Optional[Any] = None
    
    async def _wait_for_frontend_results(self, tools_impl: Any, expected_count: int, timeout: float = 2.0) -> List[Dict[str, Any]]:
        """
        프론트엔드에서 도구 적용 결과를 대기합니다.
        
        Args:
            tools_impl: Tools 인스턴스
            expected_count: 예상 결과 개수
            timeout: 대기 시간 (초)
            
        Returns:
            프론트엔드 적용 결과 리스트
        """
        results = []
        queue = getattr(tools_impl, '_action_result_queue', None)
        
        if not queue:
            print("[LlmClient] _wait_for_frontend_results: 큐가 설정되지 않음")
            return results
        
        try:
            for i in range(expected_count):
                try:
                    result = await asyncio.wait_for(queue.get(), timeout=timeout)
                    results.append(result)
                    print(f"[LlmClient] 프론트엔드 결과 수신 ({i+1}/{expected_count}): {result.get('success', '?')} - {result.get('eventType', '?')}")
                except asyncio.TimeoutError:
                    print(f"[LlmClient] 프론트엔드 결과 대기 타임아웃 ({i+1}/{expected_count})")
                    break
        except Exception as e:
            print(f"[LlmClient] 프론트엔드 결과 대기 오류: {e}")
        
        return results
        
    def _ensure_agent_and_runner(self, tools_impl: Any) -> bool:
        """Agents SDK Agent와 Runner를 지연 초기화 (3.3.8 스타일)"""
        if not _ensure_agents_sdk():
            return False
        
        if self._agent is not None and self._runner is not None:
            print("[LlmClient] 기존 Agent/Runner 재사용")
            return True
        
        try:
            print("[LlmClient] Agent/Runner 생성 중...")
            
            # 도구 정의를 Agents SDK 형식으로 변환
            tools_spec = self._build_tools_for_agent(tools_impl)
            
            # prompt.py의 build_system_prompt 사용
            from .prompt import build_system_prompt
            # ✅ 그래프 상태는 매 턴 업데이트될 수 있으므로, 가능한 경우 현재 Tools에 저장된 최신 상태를 포함한다.
            # - Agents SDK Agent.instructions는 "생성 시점"에 고정되므로, 최소한 최초 생성 시점에는 상태를 넣어준다.
            graph_state_for_prompt = None
            try:
                graph_state_for_prompt = getattr(tools_impl, "graph_state", None)
            except Exception:
                graph_state_for_prompt = None
            instructions = build_system_prompt(graph_state=graph_state_for_prompt, model=self.model)
            
            # Agent 생성 (parallel tool calls 활성화)
            agent_kwargs = {
                "name": "AlphaStudio Agent",
                "instructions": instructions,
                "model": self.model,
                "tools": tools_spec,
            }
            
            # ModelSettings 추가 (parallel_tool_calls 활성화)
            if ModelSettings and Reasoning:
                try:
                    # 운영 기본값: medium (필요 시 env로 조정)
                    effort = (os.getenv("REASONING_EFFORT", "medium") or "medium").strip().lower()
                    if effort not in ("none", "low", "medium", "high"):
                        effort = "medium"
                    agent_kwargs["model_settings"] = ModelSettings(
                        reasoning=Reasoning(
                            effort=effort,
                            summary="detailed"
                        ),
                        verbosity="low",
                        response_include=[
                            "reasoning.encrypted_content",
                            "web_search_call.results",
                        ],
                        parallel_tool_calls=True,  # 🔥 병렬 툴 호출 활성화
                    )
                    print("[LlmClient] ✅ Parallel tool calls 활성화")
                except Exception as e:
                    print(f"[LlmClient] ModelSettings 설정 실패 (무시): {e}")
            
            self._agent = Agent(**agent_kwargs)
            
            # Runner 생성
            self._runner = Runner()
            
            print(f"[LlmClient] ✅ Agent/Runner 생성 완료")
            return True
            
        except Exception as e:
            print(f"[LlmClient] Agent/Runner 생성 실패: {e}")
            import traceback
            traceback.print_exc()
            return False

    async def stream_chat(self, messages: List[Dict[str, Any]], tools_impl: Any | None = None) -> AsyncIterator[StreamChunk]:
        """3.3.8 스타일 Agents SDK 스트리밍"""
        print(f"[LlmClient] stream_chat 시작: model={self.model}, thread={self.thread_id}")
        
        if not self._openai_key:
            # API 키 없으면 echo fallback
            print("[LlmClient] API 키 없음 - echo fallback")
            content = messages[-1].get('content', '') if messages else ''
            yield StreamChunk('text', text=f"[Echo] {content[:200]}")
            return

        # 사용자별 api_key가 들어온 경우: Agents SDK는 env 의존/전역 상태 경합 위험이 있어
        # OpenAI Responses API를 직접 사용 (요청별 api_key 주입 가능)
        if self._api_key_override:
            async for c in self._stream_chat_via_responses_api(messages, tools_impl=tools_impl):
                yield c
            return
        
        # Agents SDK 사용 시도
        if _ensure_agents_sdk() and self._ensure_agent_and_runner(tools_impl):
            try:
                import json
                
                print(f"[LlmClient] Agents SDK 스트리밍 시작...")
                
                # 메시지 추출 (마지막 user 메시지)
                user_content = None
                for msg in reversed(messages):
                    if msg.get('role') == 'user':
                        user_content = msg.get('content', '')
                        break
                
                if not user_content:
                    yield StreamChunk('text', text="메시지가 없습니다.")
                    return
                
                # content가 배열(멀티모달)인지 문자열인지 확인
                is_multimodal = isinstance(user_content, list)
                print(f"[LlmClient] 멀티모달 메시지: {is_multimodal}")
                
                # Runner로 스트리밍 실행 (동기적으로)
                run_kwargs = {}
                
                # Thread ID 전달 (시도)
                if self.thread_id:
                    run_kwargs['thread_id'] = self.thread_id
                    print(f"[LlmClient] thread_id 전달 시도: {self.thread_id}")
                
                # Previous response ID 전달 (시도)
                if self.response_id:
                    run_kwargs['previous_response_id'] = self.response_id
                    print(f"[LlmClient] previous_response_id 전달 시도: {self.response_id}")
                
                # 스트리밍 실행 (agent_loop.py 방식: messages로 전달)
                try:
                    print(f"[LlmClient] run_streamed 호출 중... (messages 길이: {len(messages)})")
                    # input/messages 명칭 호환 시도
                    try:
                        result = self._runner.run_streamed(
                            self._agent,
                            input=messages,
                            max_turns=100,
                            **run_kwargs
                        )
                    except TypeError:
                        result = self._runner.run_streamed(
                            self._agent,
                            messages=messages,
                            max_turns=100,
                            **run_kwargs
                        )
                except Exception as e:
                    # SDK 버전에 따라 파라미터 다를 수 있음
                    print(f"[LlmClient] 파라미터 오류: {e}, fallback 실행")
                    try:
                        result = self._runner.run_streamed(self._agent, input=messages, max_turns=100)
                    except:
                        result = self._runner.run_streamed(self._agent, messages=messages, max_turns=100)
                
                # 이벤트 스트리밍 (3.3.8 방식: 실시간 처리)
                print("[LlmClient] 실시간 스트리밍 시작...")
                
                event_count = 0
                # stream_events()를 실시간으로 처리 (3.3.8 line 3327)
                async for event in result.stream_events():
                    event_count += 1
                    
                    try:
                        event_type = getattr(event, 'type', None)
                        
                        # run_item_stream_event 처리 - ToolCallItem에서 함수 호출 정보 추출
                        if event_type == "run_item_stream_event":
                            if hasattr(event, 'item'):
                                item = getattr(event, 'item', None)
                                if item:
                                    item_type_name = type(item).__name__
                                    print(f"[LlmClient] >>> run_item_stream_event: item_type={item_type_name}")
                                    
                                    # ToolCallItem 처리
                                    if item_type_name == 'ToolCallItem':
                                        # ToolCallItem 구조 디버깅
                                        print(f"[LlmClient]   - dir(item)[:30]: {[x for x in dir(item) if not x.startswith('_')][:30]}")
                                        
                                        # raw_item에서 실제 데이터 추출
                                        raw_item = getattr(item, 'raw_item', None)
                                        if raw_item:
                                            print(f"[LlmClient]   - raw_item type={type(raw_item)}, dir[:30]={[x for x in dir(raw_item) if not x.startswith('_')][:30]}")
                                            # raw_item이 딕셔너리처럼 작동하는지 확인
                                            if hasattr(raw_item, 'name'):
                                                print(f"[LlmClient]   - raw_item.name={getattr(raw_item, 'name', None)}")
                                            if hasattr(raw_item, 'arguments'):
                                                print(f"[LlmClient]   - raw_item.arguments type={type(getattr(raw_item, 'arguments', None))}")
                                            # 모델 덤프 시도
                                            if hasattr(raw_item, 'model_dump'):
                                                try:
                                                    dumped = raw_item.model_dump()
                                                    print(f"[LlmClient]   - raw_item.model_dump()={dumped}")
                                                except Exception as dump_err:
                                                    print(f"[LlmClient]   - model_dump 실패: {dump_err}")
                                        
                                        # 함수 이름과 인자 추출 시도 (다양한 경로)
                                        tool_name = None
                                        args_data = None
                                        
                                        # 1. item 직접 속성
                                        tool_name = getattr(item, 'name', None) or getattr(item, 'tool_name', None) or getattr(item, 'function_name', None)
                                        args_data = getattr(item, 'arguments', None) or getattr(item, 'input', None)
                                        
                                        # 2. raw_item에서 추출
                                        if raw_item and not tool_name:
                                            # 먼저 model_dump 시도
                                            if hasattr(raw_item, 'model_dump'):
                                                try:
                                                    raw_dict = raw_item.model_dump()
                                                    tool_name = raw_dict.get('name') or raw_dict.get('tool_name') or raw_dict.get('function_name')
                                                    args_data = raw_dict.get('arguments') or raw_dict.get('input') or raw_dict.get('args')
                                                except Exception:
                                                    pass
                                            
                                            # 속성으로 직접 접근
                                            if not tool_name:
                                                tool_name = getattr(raw_item, 'name', None) or getattr(raw_item, 'tool_name', None) or getattr(raw_item, 'function_name', None)
                                                args_data = getattr(raw_item, 'arguments', None) or getattr(raw_item, 'input', None) or getattr(raw_item, 'args', None)
                                        
                                        print(f"[LlmClient]   - tool_name={tool_name}, args_data type={type(args_data)}")
                                        
                                        if tool_name and args_data:
                                            # 인자 파싱
                                            if isinstance(args_data, str):
                                                try:
                                                    args = json.loads(args_data)
                                                except Exception:
                                                    args = {}
                                            elif isinstance(args_data, dict):
                                                args = args_data
                                            else:
                                                args = {}
                                            
                                            print(f"[LlmClient] ToolCallItem 함수 호출: name={tool_name}, args_keys={list(args.keys()) if isinstance(args, dict) else '...'}")
                                            
                                            # view 도구 감지 - 특별한 이벤트 전송
                                            if tool_name == 'view':
                                                yield StreamChunk('tool', tool_call={
                                                    'name': 'view',
                                                    'args': {},
                                                    'result': {
                                                        'type': 'Tool/View',
                                                        'payload': {'message': 'AI가 현재 그래프 상태를 확인했습니다.'}
                                                    }
                                                })
                                            
                                            # 도구 실행 (draw, remove, edit)
                                            if tools_impl and tool_name in ('draw', 'remove', 'edit'):
                                                try:
                                                    # spec_json 파라미터 추출
                                                    spec_json = args.get('spec_json', '{}')
                                                    spec = json.loads(spec_json) if isinstance(spec_json, str) else spec_json

                                                    
                                                    # spec이 리스트인 경우 각 항목에 대해 실행
                                                    if isinstance(spec, list):
                                                        results = []
                                                        for item in spec:
                                                            if tool_name == 'draw':
                                                                result = tools_impl.draw(item)
                                                            elif tool_name == 'remove':
                                                                result = tools_impl.remove(item)
                                                            else:  # edit
                                                                result = tools_impl.edit(item)
                                                            results.append(result)
                                                        
                                                        # 여러 결과를 하나의 이벤트로 통합
                                                        tool_result = {
                                                            'type': 'batch',
                                                            'results': results,
                                                            'count': len(results)
                                                        }
                                                        print(f"[LlmClient] ✅ 도구 배치 실행 전송: {tool_name} -> {len(results)}개")
                                                        yield StreamChunk('tool', tool_call={'name': tool_name, 'args': spec, 'result': tool_result})
                                                        
                                                        # 프론트엔드 적용 결과 대기 (양방향 통신)
                                                        frontend_results = await self._wait_for_frontend_results(tools_impl, len(results))
                                                        if frontend_results:
                                                            failed = [r for r in frontend_results if not r.get('success', True)]
                                                            if failed:
                                                                error_msgs = [r.get('error', '알 수 없는 오류') for r in failed]
                                                                print(f"[LlmClient] ❌ 프론트엔드 적용 실패: {error_msgs}")
                                                                yield StreamChunk('tool', tool_call={'name': tool_name, 'args': spec, 'frontend_error': error_msgs})
                                                            else:
                                                                print(f"[LlmClient] ✅ 프론트엔드 적용 성공: {len(frontend_results)}개")
                                                    else:
                                                        # 단일 spec 실행
                                                        if tool_name == 'draw':
                                                            tool_result = tools_impl.draw(spec)
                                                        elif tool_name == 'remove':
                                                            tool_result = tools_impl.remove(spec)
                                                        else:  # edit
                                                            tool_result = tools_impl.edit(spec)
                                                        
                                                        print(f"[LlmClient] ✅ 도구 실행 전송: {tool_name} -> {tool_result.get('type', 'unknown') if isinstance(tool_result, dict) else 'string'}")
                                                        yield StreamChunk('tool', tool_call={'name': tool_name, 'args': spec, 'result': tool_result})
                                                        
                                                        # 프론트엔드 적용 결과 대기 (양방향 통신)
                                                        frontend_results = await self._wait_for_frontend_results(tools_impl, 1)
                                                        if frontend_results and len(frontend_results) > 0:
                                                            fr = frontend_results[0]
                                                            if not fr.get('success', True):
                                                                error_msg = fr.get('error', '알 수 없는 오류')
                                                                print(f"[LlmClient] ❌ 프론트엔드 적용 실패: {error_msg}")
                                                                yield StreamChunk('tool', tool_call={'name': tool_name, 'args': spec, 'frontend_error': error_msg})
                                                            else:
                                                                print(f"[LlmClient] ✅ 프론트엔드 적용 성공: {fr.get('message', '')}")
                                                except Exception as tool_err:
                                                    print(f"[LlmClient] ❌ 도구 실행 오류: {tool_err}")
                                                    import traceback
                                                    traceback.print_exc()
                                                    yield StreamChunk('tool', tool_call={'name': tool_name, 'args': args, 'error': str(tool_err)})
                        
                        # Thread/Response ID 추출 시도
                        try:
                            if hasattr(event, 'thread_id') and event.thread_id:
                                tid = str(event.thread_id)
                                if tid != self.thread_id:
                                    yield StreamChunk('thread_id', text=tid)
                            
                            if hasattr(event, 'response_id') and event.response_id:
                                yield StreamChunk('response_id', text=str(event.response_id))
                        except Exception:
                            pass
                        
                        # raw_response_event 또는 raw_model_stream_event 처리 (3.3.8 line 3396)
                        if event_type in ("raw_response_event", "raw_model_stream_event"):
                            e = getattr(event, 'data', None) or getattr(event, 'event', None)
                            if e:
                                inner_type = getattr(e, "type", "")
                                
                                # response.output_text.delta - 최종 답변 텍스트 (3.3.8 line 3471)
                                if inner_type == "response.output_text.delta":
                                    delta = getattr(e, "delta", "")
                                    if delta:
                                        yield StreamChunk('text', text=delta)
                                
                                # response.reasoning.* - 추론 과정 (SDK/모델 버전에 따라 타입이 다를 수 있음)
                                elif inner_type in ("response.reasoning.delta", "response.reasoning_text.delta"):
                                    delta = getattr(e, "delta", "")
                                    if delta:
                                        print(f"[LlmClient] 추론: {delta[:50]}")
                                        yield StreamChunk('reasoning', text=delta)
                                
                                # response.reasoning_summary* - 추론 요약 (SDK/모델 버전에 따라 타입이 다를 수 있음)
                                elif inner_type in ("response.reasoning_summary_text.delta", "response.reasoning_summary.delta"):
                                    delta = getattr(e, "delta", "")
                                    if delta:
                                        print(f"[LlmClient] 추론 요약: {delta}")
                                        yield StreamChunk('reasoning', text=delta)  # 🔥 프론트엔드로 전송!
                                
                                # response.function_call_arguments.done - 함수 호출 (3.3.8 line 3449)
                                elif inner_type == "response.function_call_arguments.done":
                                    # 이벤트 구조에서 이름 추출 (model_dump 사용)
                                    try:
                                        event_data = e.model_dump() if hasattr(e, 'model_dump') else (e.dict() if hasattr(e, 'dict') else {})
                                        print(f"[LlmClient] function_call_arguments.done event_data: {event_data}")
                                        name = event_data.get('name') or getattr(e, 'name', None)
                                        args_str = event_data.get('arguments') or getattr(e, 'arguments', '{}')
                                        call_id = event_data.get('call_id') or getattr(e, 'call_id', None)
                                    except Exception as ex:
                                        print(f"[LlmClient] function_call_arguments.done 파싱 오류: {ex}")
                                        name = getattr(e, 'name', None)
                                        args_str = getattr(e, 'arguments', '{}')
                                        call_id = getattr(e, 'call_id', None)
                                    
                                    if isinstance(args_str, str):
                                        try:
                                            args = json.loads(args_str)
                                        except Exception:
                                            args = {}
                                    else:
                                        args = args_str or {}
                                    
                                    print(f"[LlmClient] function_call_arguments.done: name={name}, call_id={call_id}, args_keys={list(args.keys()) if isinstance(args, dict) else '...'}")
                                    # 도구 실행 (단순화: draw, remove만)
                                    if tools_impl and name in ('draw', 'remove'):
                                        try:
                                            # spec_json 파라미터 추출
                                            spec_json = args.get('spec_json', '{}')
                                            spec = json.loads(spec_json) if isinstance(spec_json, str) else spec_json
                                            
                                            # spec이 리스트인 경우 각 항목에 대해 실행
                                            if isinstance(spec, list):
                                                results = []
                                                for item in spec:
                                                    if name == 'draw':
                                                        result = tools_impl.draw(item)
                                                    else:
                                                        result = tools_impl.remove(item)
                                                    results.append(result)
                                                
                                                tool_result = {
                                                    'type': 'batch',
                                                    'results': results,
                                                    'count': len(results)
                                                }
                                                print(f"[LlmClient] ✅ 도구 배치 실행 성공: {name} -> {len(results)}개")
                                                yield StreamChunk('tool', tool_call={'name': name, 'args': spec, 'result': tool_result})
                                            else:
                                                # 단일 spec 실행
                                                if name == 'draw':
                                                    tool_result = tools_impl.draw(spec)
                                                else:
                                                    tool_result = tools_impl.remove(spec)
                                                
                                                print(f"[LlmClient] ✅ 도구 실행 성공: {name} -> {tool_result.get('type', 'unknown')}")
                                                yield StreamChunk('tool', tool_call={'name': name, 'args': spec, 'result': tool_result})
                                        except Exception as tool_err:
                                            print(f"[LlmClient] ❌ 도구 실행 오류: {tool_err}")
                                            import traceback
                                            traceback.print_exc()
                                            yield StreamChunk('tool', tool_call={'name': name, 'args': args, 'error': str(tool_err)})
                    
                    except Exception as e:
                        print(f"[LlmClient] 이벤트 {event_count} 처리 오류: {e}")
                        continue
                
                print(f"[LlmClient] Agents SDK 스트리밍 완료: 총 {event_count}개 이벤트")
                
                # 스트림 완료 후 thread_id와 response_id 추출
                try:
                    # result 객체에서 직접 thread_id 추출
                    print(f"[LlmClient] result 객체 타입: {type(result)}")
                    print(f"[LlmClient] result 속성: {[x for x in dir(result) if not x.startswith('_')][:20]}")
                    
                    # Response ID 추출 (last_response_id 속성 사용)
                    rid = None
                    if hasattr(result, 'last_response_id') and result.last_response_id:
                        rid = str(result.last_response_id)
                        print(f"[LlmClient] ✅ Response ID 추출 (last_response_id): {rid}")
                    elif hasattr(result, 'response_id') and result.response_id:
                        rid = str(result.response_id)
                        print(f"[LlmClient] ✅ Response ID 추출 (response_id): {rid}")
                    elif hasattr(result, 'id') and result.id:
                        rid = str(result.id)
                        print(f"[LlmClient] ✅ Response ID 추출 (id): {rid}")
                    
                    if rid and rid != self.response_id:
                        yield StreamChunk('response_id', text=rid)
                        self.response_id = rid
                    
                    # Thread ID 추출 (trace에서 시도)
                    tid = None
                    if hasattr(result, 'trace') and result.trace:
                        trace = result.trace
                        print(f"[LlmClient] trace 타입: {type(trace)}, 속성: {[x for x in dir(trace) if not x.startswith('_')][:15]}")
                        if hasattr(trace, 'thread_id') and trace.thread_id:
                            tid = str(trace.thread_id)
                            print(f"[LlmClient] ✅ Thread ID 추출 (trace.thread_id): {tid}")
                        elif hasattr(trace, 'conversation_id') and trace.conversation_id:
                            tid = str(trace.conversation_id)
                            print(f"[LlmClient] ✅ Thread ID 추출 (trace.conversation_id): {tid}")
                    
                    # trace에서 못 찾으면 다른 속성 시도
                    if not tid:
                        if hasattr(result, 'thread_id') and result.thread_id:
                            tid = str(result.thread_id)
                            print(f"[LlmClient] ✅ Thread ID 추출 (thread_id): {tid}")
                        elif hasattr(result, 'conversation_id') and result.conversation_id:
                            tid = str(result.conversation_id)
                            print(f"[LlmClient] ✅ Thread ID 추출 (conversation_id): {tid}")
                    
                    if tid and tid != self.thread_id:
                        yield StreamChunk('thread_id', text=tid)
                        self.thread_id = tid
                    
                    print(f"[LlmClient] 최종 thread_id={self.thread_id}, response_id={self.response_id}")
                
                except Exception as e:
                    print(f"[LlmClient] Thread/Response ID 추출 실패: {e}")
                    import traceback
                    traceback.print_exc()
                
                return
                
            except Exception as e:
                print(f"[LlmClient] Agents SDK 오류: {_scrub_secrets(e)}")
                import traceback
                traceback.print_exc()
                # fallback으로
        
        # Fallback: Echo
        print(f"[LlmClient] Echo fallback")
        content = messages[-1].get('content', '') if messages else ''
        yield StreamChunk('text', text=f"[Echo] {content[:200]}")
        print(f"[LlmClient] Echo 완료")

    async def _stream_chat_via_responses_api(
        self,
        messages: List[Dict[str, Any]],
        tools_impl: Any | None = None,
    ) -> AsyncIterator[StreamChunk]:
        """
        OpenAI Responses API로 스트리밍 + 툴콜 루프.
        - 요청별 api_key 주입 가능(전역 env 불필요) → 멀티유저 동시 사용 안전
        """
        import json

        try:
            from openai import OpenAI  # type: ignore
        except Exception as e:
            yield StreamChunk('text', text=f"[오류] openai 라이브러리를 불러올 수 없습니다: {_scrub_secrets(e)}")
            return

        client = OpenAI(api_key=self._openai_key)

        # 시스템 프롬프트를 첫 메시지로 포함 (Agents SDK와 유사한 동작)
        try:
            from .prompt import build_system_prompt
            graph_state_for_prompt = None
            try:
                graph_state_for_prompt = getattr(tools_impl, "graph_state", None) if tools_impl else None
            except Exception:
                graph_state_for_prompt = None
            system_instructions = build_system_prompt(graph_state=graph_state_for_prompt, model=self.model)
        except Exception:
            system_instructions = ""

        input_items: List[Dict[str, Any]] = []
        if system_instructions:
            # Responses API 표준 포맷에 맞춰 content를 파트 배열로 전달
            input_items.append({"role": "system", "content": [{"type": "input_text", "text": system_instructions}]})
        input_items.extend(messages)

        # thread_id/response_id 초기값을 프론트와 동기화
        if self.thread_id:
            yield StreamChunk('thread_id', text=str(self.thread_id))
        if self.response_id:
            yield StreamChunk('response_id', text=str(self.response_id))

        tools_spec = self._build_tools_spec_all()

        max_turns = 15
        turn = 0
        while turn < max_turns:
            turn += 1
            tool_calls: List[Tuple[str, Dict[str, Any], str | None]] = []  # (name, args, call_id)
            seen_tool_call_keys: set[str] = set()

            def _tool_call_key(name: str | None, args: Any, call_id: Any) -> str:
                try:
                    if call_id:
                        return f"id:{call_id}"
                    return f"na:{name}:{json.dumps(args, sort_keys=True, ensure_ascii=False) if isinstance(args, (dict, list)) else str(args)}"
                except Exception:
                    return f"na:{name}:{str(call_id)}"

            def _maybe_add_tool_call(name: Any, args: Any, call_id: Any) -> None:
                if not name:
                    return
                n = str(name)
                a: Dict[str, Any]
                if isinstance(args, dict):
                    a = args
                else:
                    a = {}
                cid = str(call_id) if call_id else None
                k = _tool_call_key(n, a, cid)
                if k in seen_tool_call_keys:
                    return
                seen_tool_call_keys.add(k)
                tool_calls.append((n, a, cid))

            def _extract_tool_calls_from_final(final_obj: Any) -> None:
                """
                SDK/버전별로 스트림 이벤트에서 tool call 완료 이벤트가 안 오는 경우가 있어
                get_final_response()에서 function_call 항목을 한 번 더 추출한다.
                """
                try:
                    d = final_obj.model_dump() if hasattr(final_obj, "model_dump") else (final_obj.dict() if hasattr(final_obj, "dict") else {})
                except Exception:
                    d = {}
                if not isinstance(d, dict):
                    return
                output = d.get("output") or d.get("outputs") or d.get("output_items") or []
                if not isinstance(output, list):
                    return
                for item in output:
                    if not isinstance(item, dict):
                        continue
                    itype = item.get("type") or item.get("kind")
                    # Responses API에서 function/tool call 아이템
                    if itype not in ("function_call", "tool_call") and not (item.get("name") and ("arguments" in item or "args" in item)):
                        continue
                    name = item.get("name") or item.get("tool_name") or item.get("function_name")
                    call_id = item.get("call_id") or item.get("tool_call_id") or item.get("id")
                    args_str = item.get("arguments") or item.get("args") or item.get("input") or "{}"
                    if isinstance(args_str, str):
                        try:
                            args = json.loads(args_str) if args_str else {}
                        except Exception:
                            args = {}
                    elif isinstance(args_str, dict):
                        args = args_str
                    else:
                        args = {}
                    _maybe_add_tool_call(name, args, call_id)

            # 스트리밍 실행
            try:
                # responses.stream은 동기 iterator일 수 있어 이벤트 루프에 제어권을 넘김
                stream_kwargs: Dict[str, Any] = {
                    "model": self.model,
                    "input": input_items,
                    "tools": tools_spec,
                    "previous_response_id": self.response_id,
                }
                # Reasoning effort/summary 기본값.
                # - effort: none|low|medium|high
                # - summary: none|auto|detailed (일부 모델은 summary를 요청해야 reasoning 텍스트 델타가 옴)
                effort = (os.getenv("REASONING_EFFORT", "medium") or "medium").strip().lower()
                if effort not in ("none", "low", "medium", "high"):
                    effort = "medium"
                summary = (os.getenv("REASONING_SUMMARY", "detailed") or "detailed").strip().lower()
                if summary not in ("none", "auto", "detailed"):
                    summary = "detailed"
                reasoning_cfg: Dict[str, Any] = {"effort": effort}
                if summary != "none":
                    reasoning_cfg["summary"] = summary
                stream_kwargs["reasoning"] = reasoning_cfg
                # include는 모델/버전별로 지원 값이 매우 엄격하지만,
                # 사용자 요청에 따라 기본값은 ON으로 둡니다.
                # - 끄고 싶으면 ENABLE_REASONING_INCLUDE=false 로 설정
                enable_include = (os.getenv("ENABLE_REASONING_INCLUDE", "true") or "true").strip().lower()
                if enable_include not in ("0", "false", "no", "n", "off"):
                    stream_kwargs["include"] = ["reasoning.encrypted_content"]
                # OpenAI Python SDK 최신 버전: conversation_id 대신 conversation 사용
                if self.thread_id:
                    stream_kwargs["conversation"] = self.thread_id
                def _open_stream(kwargs: Dict[str, Any]):
                    try:
                        return client.responses.stream(**kwargs)
                    except TypeError:
                        # SDK/모델이 reasoning/include를 아예 안 받는 경우
                        kwargs = dict(kwargs)
                        kwargs.pop("reasoning", None)
                        kwargs.pop("include", None)
                        return client.responses.stream(**kwargs)
                    except Exception as e:
                        # API가 include/reasoning 값을 거부(400)하는 경우: 문제되는 키를 제거하고 1회 재시도
                        try:
                            msg = str(e)
                        except Exception:
                            msg = ""
                        if "Invalid value" in msg and "include" in msg:
                            kwargs2 = dict(kwargs)
                            kwargs2.pop("include", None)
                            return client.responses.stream(**kwargs2)
                        if "reasoning" in msg and ("Invalid" in msg or "unsupported" in msg.lower() or "unknown" in msg.lower()):
                            kwargs2 = dict(kwargs)
                            kwargs2.pop("reasoning", None)
                            kwargs2.pop("include", None)
                            return client.responses.stream(**kwargs2)
                        raise

                with _open_stream(stream_kwargs) as stream:
                    for event in stream:
                        await asyncio.sleep(0)

                        etype = getattr(event, "type", "") or ""

                        # 텍스트 델타
                        if etype == "response.output_text.delta":
                            delta = getattr(event, "delta", "") or ""
                            if delta:
                                yield StreamChunk('text', text=str(delta))

                        # 추론(있을 경우) - SDK/모델 버전에 따라 이벤트 타입이 다를 수 있어 넓게 처리
                        elif etype in (
                            "response.reasoning.delta",
                            "response.reasoning_text.delta",
                            "response.reasoning_summary_text.delta",
                            "response.reasoning_summary.delta",
                        ):
                            delta = getattr(event, "delta", "") or ""
                            if delta:
                                yield StreamChunk('reasoning', text=str(delta))

                        # 함수 호출 완료
                        elif etype == "response.function_call_arguments.done":
                            try:
                                d = event.model_dump() if hasattr(event, "model_dump") else {}
                            except Exception:
                                d = {}
                            name = d.get("name") or getattr(event, "name", None)
                            # SDK/버전마다 call_id 키가 다를 수 있음
                            call_id = (
                                d.get("call_id")
                                or d.get("tool_call_id")
                                or d.get("id")
                                or getattr(event, "call_id", None)
                                or getattr(event, "tool_call_id", None)
                                or getattr(event, "id", None)
                            )
                            args_str = d.get("arguments") or getattr(event, "arguments", "{}")
                            if isinstance(args_str, str):
                                try:
                                    args = json.loads(args_str)
                                except Exception:
                                    args = {}
                            elif isinstance(args_str, dict):
                                args = args_str
                            else:
                                args = {}
                            _maybe_add_tool_call(name, args, call_id)

                    # 최종 응답에서 id/대화 id 추출
                    try:
                        final = stream.get_final_response()
                        if hasattr(final, "id") and final.id:
                            self.response_id = str(final.id)
                            yield StreamChunk('response_id', text=self.response_id)
                        # conversation/thread id 추출 (SDK 버전별 필드명 차이 대응)
                        cid = (
                            getattr(final, "conversation_id", None)
                            or getattr(final, "thread_id", None)
                        )
                        if not cid:
                            conv = getattr(final, "conversation", None)
                            # conversation이 문자열 id일 수도 있고, 객체/딕셔너리일 수도 있음
                            if isinstance(conv, str) and conv:
                                cid = conv
                            elif conv is not None:
                                cid = getattr(conv, "id", None)
                                if not cid and isinstance(conv, dict):
                                    cid = conv.get("id")
                        if cid:
                            self.thread_id = str(cid)
                            yield StreamChunk('thread_id', text=self.thread_id)

                        # 스트림 이벤트에서 tool call을 못 잡은 경우 대비: final에서 한 번 더 추출
                        _extract_tool_calls_from_final(final)
                    except Exception:
                        pass

            except Exception as e:
                yield StreamChunk('text', text=f"[오류] OpenAI Responses 스트리밍 실패: {_scrub_secrets(e)}")
                return

            # 툴콜이 없으면 완료
            if not tool_calls:
                return

            # 툴 실행 및 결과를 다음 input으로 준비
            tool_outputs: List[Dict[str, Any]] = []
            for (name, args, call_id) in tool_calls:
                # view는 args가 비어있음
                try:
                    if name == "view":
                        # 최신 그래프 상태가 비동기로 업데이트될 수 있으므로(view 레이스 방지),
                        # 프론트에 상태 요청(View/RequestState)을 보내고 짧게 기다린 뒤 응답을 사용합니다.
                        res = None
                        if tools_impl and hasattr(tools_impl, "set_view_state_future"):
                            try:
                                fut = asyncio.get_running_loop().create_future()
                                tools_impl.set_view_state_future(fut)
                                # 프론트가 View/RequestState를 받으면 Agent/GraphState.Response를 보냄
                                yield StreamChunk('tool', tool_call={
                                    'name': 'view',
                                    'args': {},
                                    'result': {'type': 'View/RequestState', 'payload': {'message': 'request latest graph state'}}
                                })
                                res = await asyncio.wait_for(fut, timeout=0.6)
                            except Exception:
                                res = None
                            finally:
                                try:
                                    tools_impl.set_view_state_future(None)
                                except Exception:
                                    pass
                        if res is None:
                            res = tools_impl.view() if tools_impl else "그래프 상태를 가져올 수 없습니다."
                        tool_result = {"type": "Tool/View", "payload": {"text": res}}
                        # 프론트는 view를 별도 UI로 보여줌
                        yield StreamChunk('tool', tool_call={'name': 'view', 'args': {}, 'result': {"type": "Tool/View", "payload": {"message": "AI가 현재 그래프 상태를 확인했습니다."}}})
                        # OpenAI쪽에 tool output이 빈 문자열로 찍히면 디버깅이 어려우니 최소한의 텍스트 보장
                        if isinstance(res, str):
                            out_str = res if res.strip() else "[view] empty"
                        else:
                            out_str = json.dumps(res, ensure_ascii=False)
                    elif tools_impl and name in ("draw", "remove", "edit"):
                        spec_json = args.get("spec_json", "{}")
                        spec = json.loads(spec_json) if isinstance(spec_json, str) else spec_json

                        if isinstance(spec, list):
                            results = []
                            for item in spec:
                                # 🔥 tool start signal (per-item) so UI can show pending immediately
                                yield StreamChunk('tool_start', tool_call={'name': name, 'args': item})
                                if name == "draw":
                                    results.append(tools_impl.draw(item))
                                elif name == "remove":
                                    results.append(tools_impl.remove(item))
                                else:
                                    results.append(tools_impl.edit(item))
                            tool_result = {'type': 'batch', 'results': results, 'count': len(results)}
                            yield StreamChunk('tool', tool_call={'name': name, 'args': spec, 'result': tool_result})
                            out_str = json.dumps(tool_result, ensure_ascii=False)
                        else:
                            # 🔥 tool start signal
                            yield StreamChunk('tool_start', tool_call={'name': name, 'args': spec})
                            if name == "draw":
                                tool_result = tools_impl.draw(spec)
                            elif name == "remove":
                                tool_result = tools_impl.remove(spec)
                            else:
                                tool_result = tools_impl.edit(spec)
                            yield StreamChunk('tool', tool_call={'name': name, 'args': spec, 'result': tool_result})
                            out_str = json.dumps(tool_result, ensure_ascii=False) if isinstance(tool_result, dict) else str(tool_result)
                    else:
                        out_str = json.dumps({"error": f"Unknown tool: {name}"}, ensure_ascii=False)
                except Exception as tool_err:
                    yield StreamChunk('tool', tool_call={'name': name, 'args': args, 'error': str(tool_err)})
                    out_str = json.dumps({"error": str(tool_err)}, ensure_ascii=False)

                if call_id:
                    tool_outputs.append({"type": "function_call_output", "call_id": call_id, "output": out_str})
                else:
                    # call_id 없이 tool output을 보낼 수 없으면, 서버/대시보드에서 "No output"이 떠버림.
                    # 최대한 진행할 수 있도록 안내를 남기고 종료.
                    yield StreamChunk('text', text="\n\n[도구 호출(call_id)을 식별할 수 없어 tool output을 전달하지 못했습니다. openai SDK 이벤트 포맷을 확인해 주세요.]")
                    return

            # 다음 턴 입력: tool outputs만 전달(Responses API 방식)
            if not tool_outputs:
                yield StreamChunk('text', text="\n\n[도구 호출 결과를 이어서 처리할 수 없습니다: call_id 누락]")
                return
            input_items = tool_outputs

        # max turns
        yield StreamChunk('text', text="\n\n[최대 처리 단계에 도달했습니다]")


    def _build_tools_for_agent(self, tools_impl: Any) -> List[Any]:
        """Agents SDK용 도구 생성 (단순화: draw, remove 2개만)"""
        if not _ensure_agents_sdk() or not function_tool:
            return []
        
        try:
            import json
            
            @function_tool
            def draw(spec_json: str) -> str:
                """Draw geometry on canvas. 
                
                spec_json format examples:
                - Single: {"kind": "function", "expression": "x^2"}
                - Multiple: [{"kind": "function", "expression": "x^2"}, {"kind": "function", "expression": "x+3"}]
                - Segment: {"kind": "segment", "p1": [x1, y1], "p2": [x2, y2], "extendStart": false, "extendEnd": false}
                - Line: {"kind": "line", "p1": [x1, y1], "p2": [x2, y2]}
                - Function (explicit): {"kind": "function", "expression": "x^2"}
                - Function (implicit): {"kind": "function-implicit", "expression": "x^2 + y^2 - 25"}
                - Point: {"kind": "point", "position": [x, y], "diameterMm": 2.3, "color": "#000000", "strokeColor": "#000000" (optional), "strokeWidth": 0.35 (optional)}
                - Bezier: {"kind": "bezier", "a": [x1, y1], "b": [x2, y2], "c1": [cx1, cy1], "c2": [cx2, cy2]}
                - FilledRegion: {"kind": "filled-region", "centerPoint": [x, y], "fillColor": "rgb(230, 230, 230)"}
                """
                try:
                    spec = json.loads(spec_json)
                    
                    # spec이 리스트인 경우 각 항목을 실행
                    if isinstance(spec, list):
                        results = []
                        for item in spec:
                            result = tools_impl.draw(item)
                            results.append(result)
                        return json.dumps({'type': 'batch', 'results': results, 'count': len(results)}, ensure_ascii=False)
                    else:
                        result = tools_impl.draw(spec)
                        return json.dumps(result, ensure_ascii=False)
                except json.JSONDecodeError as e:
                    return json.dumps({'error': f'Invalid JSON: {e}'}, ensure_ascii=False)
                except Exception as e:
                    return json.dumps({'error': str(e)}, ensure_ascii=False)
            
            @function_tool
            def remove(spec_json: str) -> str:
                """Remove elements from canvas.
                
                spec_json format examples:
                - Single: {"mode": "by-id", "ids": ["id1", "id2"]}
                - Multiple: [{"mode": "by-id", "ids": ["id1"]}, {"mode": "by-id", "ids": ["id2"]}]
                - By IDs: {"mode": "by-id", "ids": ["id1", "id2"]}
                - By query (restricted): {"mode": "by-query", "functionId": "function-abc123", "kind": "segment"}
                
                Safety:
                - Broad deletes (by-query without functionId / clear-all) are disabled. Prefer by-id.
                """
                try:
                    spec = json.loads(spec_json)
                    
                    # spec이 리스트인 경우 각 항목을 실행
                    if isinstance(spec, list):
                        results = []
                        for item in spec:
                            result = tools_impl.remove(item)
                            results.append(result)
                        return json.dumps({'type': 'batch', 'results': results, 'count': len(results)}, ensure_ascii=False)
                    else:
                        result = tools_impl.remove(spec)
                        return json.dumps(result, ensure_ascii=False)
                except json.JSONDecodeError as e:
                    return json.dumps({'error': f'Invalid JSON: {e}'}, ensure_ascii=False)
                except Exception as e:
                    return json.dumps({'error': str(e)}, ensure_ascii=False)
            
            @function_tool
            def edit(spec_json: str) -> str:
                """Edit existing objects on canvas.
                
                spec_json format examples:
                - Change style: {"id": "segment-abc123", "style": {"stroke": {"color": "#000000", "width": 3}}}
                - Move point: {"id": "point-abc123", "position": [3, 4]}
                - Update function: {"id": "function-abc123", "expression": "x^3"}
                - Multiple edits: [{"id": "point-abc123", "color": "#000000"}, {"id": "segment-xyz", "style": {"stroke": {"color": "#000000"}}}]
                """
                try:
                    spec = json.loads(spec_json)
                    
                    # spec이 리스트인 경우 각 항목을 실행
                    if isinstance(spec, list):
                        results = []
                        for item in spec:
                            result = tools_impl.edit(item)
                            results.append(result)
                        return json.dumps({'type': 'batch', 'results': results, 'count': len(results)}, ensure_ascii=False)
                    else:
                        result = tools_impl.edit(spec)
                        return json.dumps(result, ensure_ascii=False)
                except json.JSONDecodeError as e:
                    return json.dumps({'error': f'Invalid JSON: {e}'}, ensure_ascii=False)
                except Exception as e:
                    return json.dumps({'error': str(e)}, ensure_ascii=False)
            
            @function_tool
            def view() -> str:
                """View current graph state. Shows all objects with their IDs, positions, and styles.
                
                Use this to check what is currently drawn on the canvas, including all segments.
                No parameters needed.
                
                The frontend automatically sends updated state after every action, so this returns 
                the latest state stored in memory.
                """
                try:
                    result = tools_impl.view()
                    # view는 포맷팅된 문자열 반환
                    return result
                except Exception as e:
                    return json.dumps({'error': str(e)}, ensure_ascii=False)
            
            @function_tool
            def set_custom_axis_range(spec_json: str) -> str:
                """Set custom axis range and visibility.
                
                IMPORTANT: Functions and segments outside the axis range are automatically clipped.
                Set the axis range appropriately so that the graph is fully visible.
                
                spec_json format:
                {
                    "xMin": -5,        // X axis start value (optional)
                    "xMax": 10,        // X axis end value (optional)
                    "yMin": -3,        // Y axis start value (optional)
                    "yMax": 8,         // Y axis end value (optional)
                    "xVisible": true,  // X axis visibility (optional, default: true)
                    "yVisible": true   // Y axis visibility (optional, default: true)
                }
                
                Examples:
                - Set x-axis from -5 to 10: {"xMin": -5, "xMax": 10}
                - Set both axes: {"xMin": -5, "xMax": 5, "yMin": -3, "yMax": 3}
                - Hide x-axis: {"xVisible": false}
                - Set range and hide y-axis: {"xMin": 0, "xMax": 10, "yVisible": false}
                """
                try:
                    spec = json.loads(spec_json)
                    result = tools_impl.set_custom_axis_range(spec)
                    return json.dumps(result, ensure_ascii=False)
                except json.JSONDecodeError as e:
                    return json.dumps({'error': f'Invalid JSON: {e}'}, ensure_ascii=False)
                except Exception as e:
                    return json.dumps({'error': str(e)}, ensure_ascii=False)
            
            @function_tool
            def fit_to_screen() -> str:
                """Fit the view to show all content on screen.
                
                Adjusts the zoom level so that all drawn objects fit within the visible area.
                Call this after completing all drawing operations to ensure everything is visible.
                
                No parameters needed.
                """
                try:
                    result = tools_impl.fit_to_screen()
                    return json.dumps(result, ensure_ascii=False)
                except Exception as e:
                    return json.dumps({'error': str(e)}, ensure_ascii=False)
            
            print("[LlmClient] ✅ 도구 생성 완료: draw, remove, edit, view, set_custom_axis_range, fit_to_screen")
            return [draw, remove, edit, view, set_custom_axis_range, fit_to_screen]
            
        except Exception as e:
            print(f"[LlmClient] 도구 생성 실패: {e}")
            import traceback
            traceback.print_exc()
            return []

    def _build_tools_spec_all(self) -> List[Dict[str, Any]]:
        """OpenAI Responses API용 도구 스펙 (draw/remove/edit/view)"""
        return [
            {
                "type": "function",
                "name": "draw",
                "description": "Draw geometry on canvas. Pass a JSON string in spec_json. Supports single object or list.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "spec_json": {"type": "string", "description": "JSON string describing what to draw"}
                    },
                    "required": ["spec_json"],
                },
            },
            {
                "type": "function",
                "name": "remove",
                "description": "Remove elements from canvas. Pass a JSON string in spec_json.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "spec_json": {"type": "string", "description": "JSON string describing what to remove"}
                    },
                    "required": ["spec_json"],
                },
            },
            {
                "type": "function",
                "name": "edit",
                "description": "Edit existing objects on canvas. Pass a JSON string in spec_json.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "spec_json": {"type": "string", "description": "JSON string describing what to edit"}
                    },
                    "required": ["spec_json"],
                },
            },
            {
                "type": "function",
                "name": "view",
                "description": "View current graph state. No parameters.",
                "parameters": {"type": "object", "properties": {}},
            },
            {
                "type": "function",
                "name": "set_custom_axis_range",
                "description": "Set custom axis range and visibility. Functions/segments outside axis range are clipped. Use xMin/xMax for X axis, yMin/yMax for Y axis, xVisible/yVisible for visibility.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "spec_json": {"type": "string", "description": "JSON string with xMin, xMax, yMin, yMax (numbers), xVisible, yVisible (booleans)"}
                    },
                    "required": ["spec_json"],
                },
            },
            {
                "type": "function",
                "name": "fit_to_screen",
                "description": "Fit the view to show all content on screen. Adjusts zoom so all drawn objects are visible. Call after completing all drawing operations.",
                "parameters": {"type": "object", "properties": {}},
            },
        ]


class GeminiLlmClient:
    """
    Gemini API 스트리밍 클라이언트
    
    - Google Generative AI SDK 사용
    - Function Calling 지원
    - 스트리밍 응답 지원
    - 대화 이력 관리 (스레드)
    - Thinking 모드 지원 (thinkingBudget: high)
    """
    
    def __init__(self, model: str = "gemini-3-pro-preview", thread_id: str | None = None, api_key: str | None = None):
        self.model = model
        self._gemini_key = api_key or os.getenv('GEMINI_API_KEY')
        self._client_override = None
        self._conversation_history: List[Dict[str, Any]] = []
        # 동일 thread_id에 대한 동시 요청이 들어오면 이력이 섞이거나
        # tool-call ReAct 루프가 서로 엉키는 문제가 생길 수 있어 직렬화한다.
        self._lock = asyncio.Lock()
        self.thread_id = thread_id or f"gemini-{os.urandom(8).hex()}"
        
        # 🔍 디버그: 인스턴스 생성 로그
        print(f"[GeminiLlmClient.__init__] 🆕 NEW instance: id={id(self)}, thread={self.thread_id}, history_len={len(self._conversation_history)}")
        print(f"[GeminiLlmClient] 초기화: model={self.model}, thread_id={self.thread_id}, api_key={'present' if self._gemini_key else 'MISSING'}")
    
    async def _wait_for_frontend_results(self, tools_impl: Any, expected_count: int, timeout: float = 2.0) -> List[Dict[str, Any]]:
        """프론트엔드에서 도구 적용 결과를 대기합니다."""
        results = []
        queue = getattr(tools_impl, '_action_result_queue', None)
        
        if not queue:
            print("[GeminiLlmClient] _wait_for_frontend_results: 큐가 설정되지 않음")
            return results
        
        try:
            for i in range(expected_count):
                try:
                    result = await asyncio.wait_for(queue.get(), timeout=timeout)
                    results.append(result)
                    print(f"[GeminiLlmClient] 프론트엔드 결과 수신 ({i+1}/{expected_count}): {result.get('success', '?')} - {result.get('eventType', '?')}")
                except asyncio.TimeoutError:
                    print(f"[GeminiLlmClient] 프론트엔드 결과 대기 타임아웃 ({i+1}/{expected_count})")
                    break
        except Exception as e:
            print(f"[GeminiLlmClient] 프론트엔드 결과 대기 오류: {e}")
        
        return results
    
    def _build_tools_spec(self) -> List[Dict[str, Any]]:
        """Gemini Function Calling용 도구 스펙 - 모든 도구 포함"""
        return [
            {
                "name": "draw",
                "description": """Draw geometry on canvas. Supports various geometric objects.

spec_json format examples:
- Segment: {"kind": "segment", "p1": [x1, y1], "p2": [x2, y2], "extendStart": false, "extendEnd": false, "style": {"stroke": {"color": "#000000", "width": 0.8}}}
- Line (infinite): {"kind": "line", "p1": [x1, y1], "p2": [x2, y2]}
- Function (explicit y=f(x)): {"kind": "function", "expression": "x^2", "domain": [-5, 5]}
- Function (implicit F(x,y)=0): {"kind": "function-implicit", "expression": "x^2 + y^2 - 25"}
- Point: {"kind": "point", "position": [x, y], "diameterMm": 2.3, "color": "#000000", "strokeColor": "#000000", "strokeWidth": 0.35}
- Bezier curve: {"kind": "bezier", "a": [x1, y1], "b": [x2, y2], "c1": [cx1, cy1], "c2": [cx2, cy2]}
- Length-bezier (길이 표시 베지어): {"kind": "length-bezier", "a": [x1, y1], "b": [x2, y2], "c1": [cx1, cy1], "c2": [cx2, cy2], "label": "3"}
- Filled region: {"kind": "filled-region", "centerPoint": [x, y], "fillColor": "rgb(230, 230, 230)"}
- Math text (LaTeX): {"kind": "math-text", "latex": "x^2 + y^2 = 1", "position": [x, y], "fontSize": 11, "color": "#000000"}
- Multiple objects: [{...}, {...}, ...]

IMPORTANT:
- Coordinates are in mathematical units (not pixels)
- Use ^ for exponents (x^2), the system will convert to JavaScript
- For length-bezier, the label appears on the bezier curve""",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "spec_json": {
                            "type": "string",
                            "description": "JSON string describing what to draw"
                        }
                    },
                    "required": ["spec_json"]
                }
            },
            {
                "name": "remove",
                "description": """Remove elements from canvas.

spec_json format examples:
- By IDs: {"mode": "by-id", "ids": ["segment-abc123", "point-xyz789"]}
- By kind (all of type): {"mode": "by-query", "kind": "segment"}
- By functionId: {"mode": "by-query", "functionId": "func-123"}
- Clear all: {"mode": "by-query"}
- Multiple removals: [{"mode": "by-id", "ids": ["id1"]}, {"mode": "by-query", "kind": "point"}]""",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "spec_json": {
                            "type": "string",
                            "description": "JSON string describing what to remove"
                        }
                    },
                    "required": ["spec_json"]
                }
            },
            {
                "name": "edit",
                "description": """Edit existing objects on canvas. Only the specified properties are updated.

spec_json format examples:
- Change style: {"id": "segment-abc123", "style": {"stroke": {"color": "#000000", "width": 3}}}
- Move point: {"id": "point-abc123", "position": [3, 4]}
- Move segment endpoints: {"id": "segment-abc123", "p1": [0, 0], "p2": [5, 5]}
- Update function: {"id": "function-abc123", "expression": "x^3", "domain": [-10, 10]}
- Change color: {"id": "point-abc123", "color": "#000000"}
- Change fill: {"id": "filled-region-abc123", "fillColor": "rgb(200, 200, 255)"}
- Update LaTeX: {"id": "math-text-abc123", "latex": "y = x^2", "fontSize": 11}
- Multiple edits: [{"id": "id1", "color": "#000000"}, {"id": "id2", "position": [1, 2]}]""",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "spec_json": {
                            "type": "string",
                            "description": "JSON string describing what to edit"
                        }
                    },
                    "required": ["spec_json"]
                }
            },
            {
                "name": "view",
                "description": """View current graph state. Returns all objects currently on the canvas with their IDs, positions, styles, and properties.

Use this tool to:
- Check what is currently drawn
- Get IDs of objects for editing or removal
- Verify the result of previous draw/edit operations

No parameters needed. The frontend automatically sends updated state after every action.""",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            },
            {
                "name": "set_custom_axis_range",
                "description": """Set custom axis range and visibility.

IMPORTANT: Functions and segments outside the axis range are automatically clipped. Set the axis range appropriately so that the graph is fully visible.

spec_json format:
{
    "xMin": -5,        // X axis start value (optional)
    "xMax": 10,        // X axis end value (optional)
    "yMin": -3,        // Y axis start value (optional)
    "yMax": 8,         // Y axis end value (optional)
    "xVisible": true,  // X axis visibility (optional, default: true)
    "yVisible": true   // Y axis visibility (optional, default: true)
}

Examples:
- Set x-axis from -5 to 10: {"xMin": -5, "xMax": 10}
- Set both axes: {"xMin": -5, "xMax": 5, "yMin": -3, "yMax": 3}
- Hide x-axis: {"xVisible": false}
- Set range and hide y-axis: {"xMin": 0, "xMax": 10, "yVisible": false}""",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "spec_json": {
                            "type": "string",
                            "description": "JSON string with xMin, xMax, yMin, yMax (numbers), xVisible, yVisible (booleans)"
                        }
                    },
                    "required": ["spec_json"]
                }
            },
            {
                "name": "fit_to_screen",
                "description": """Fit the view to show all content on screen.

Adjusts the zoom level so that all drawn objects fit within the visible area.
Call this after completing all drawing operations to ensure everything is visible.

No parameters needed.""",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            }
        ]

    async def stream_chat(self, messages: List[Dict[str, Any]], tools_impl: Any | None = None) -> AsyncIterator[StreamChunk]:
        """Gemini 스트리밍 채팅 with ReAct 루프 (멀티턴 Function Calling)"""
        import json

        # 🔍 디버그: stream_chat 호출 시점 로그
        print(f"[GeminiLlmClient.stream_chat] ▶ START: id={id(self)}, thread={self.thread_id}, history_len={len(self._conversation_history)}")
        
        print(f"[GeminiLlmClient] stream_chat 시작: model={self.model}, thread={self.thread_id}")
        
        if not _ensure_gemini_sdk():
            print("[GeminiLlmClient] Gemini 사용 불가 - fallback")
            content = messages[-1].get('content', '') if messages else ''
            yield StreamChunk('text', text=f"[Gemini 사용 불가] {content[:200]}")
            return

        # 요청별 api key가 있으면 전용 클라이언트 사용
        local_client = genai_client
        if self._gemini_key:
            try:
                from google import genai
                local_client = genai.Client(api_key=self._gemini_key)
            except Exception:
                local_client = genai_client
        if not local_client:
            print("[GeminiLlmClient] Gemini client 없음 - fallback")
            content = messages[-1].get('content', '') if messages else ''
            yield StreamChunk('text', text=f"[Gemini 사용 불가] {content[:200]}")
            return
        
        # NOTE: stream_chat는 generator이므로 락 범위를 함수 전체로 잡아 이력/contents 변형을 보호한다.
        async with self._lock:
            from .prompt import build_system_prompt
            
            # 대화 내용 구성 (기존 이력 + 새 메시지)
            contents = []
            
            # 기존 대화 이력 추가
            for hist_msg in self._conversation_history:
                role = hist_msg.get('role', 'user')
                parts_data = hist_msg.get('parts', [])
                parts = []
                for p in parts_data:
                    if 'text' in p:
                        # 빈 텍스트는 Gemini 컨텍스트를 오염시키고(=빈 model 메시지),
                        # functionCall/Response 페어링을 흐리게 만들 수 있어 제외한다.
                        t = p.get('text')
                        if isinstance(t, str) and t.strip():
                            parts.append(genai_types.Part.from_text(text=t))
                    elif 'raw_part' in p:
                        # ✅ 모델이 실제로 반환한 "원본 Part"를 그대로 저장/복원 (thought_signature 포함 가능)
                        # - 특히 function_call 파트는 thought_signature가 필요하므로 재생성하면 안 됨
                        try:
                            rp = p.get('raw_part')
                            if rp is not None:
                                parts.append(rp)
                        except Exception:
                            pass
                    elif 'function_call' in p:
                        # ⚠️ Gemini 3 tool calling은 functionCall 파트에 thought_signature가 필요합니다.
                        # 서버에서 임의로 functionCall을 재구성(Part.from_function_call)하면 thought_signature가 없어
                        # 400 INVALID_ARGUMENT가 발생할 수 있습니다.
                        # 따라서 history에 저장된 function_call(시그니처 없음)은 contents에 재주입하지 않습니다.
                        continue
                    elif 'function_response' in p:
                        # Function response 파트 복원
                        fr = p['function_response']
                        parts.append(genai_types.Part.from_function_response(
                            name=fr['name'],
                            response=fr.get('response', {})
                        ))
                if parts:
                    contents.append(genai_types.Content(role=role, parts=parts))
            
            # 새 메시지 추가
            for msg in messages:
                role = msg.get('role', 'user')
                content = msg.get('content', '')
                
                # Gemini는 role이 'user' 또는 'model'만 지원
                gemini_role = 'model' if role == 'assistant' else 'user'
                
                parts = []
                
                # content가 배열(멀티모달)인 경우 처리
                if isinstance(content, list):
                    for item in content:
                        if item.get('type') == 'input_text':
                            t = item.get('text', '')
                            if isinstance(t, str) and t.strip():
                                parts.append(genai_types.Part.from_text(text=t))
                        elif item.get('type') == 'input_image':
                            # 이미지 처리 (base64)
                            image_url = item.get('image_url', '')
                            if image_url.startswith('data:'):
                                try:
                                    header, b64_data = image_url.split(',', 1)
                                    mime_type = header.split(':')[1].split(';')[0]
                                    import base64
                                    image_bytes = base64.b64decode(b64_data)
                                    parts.append(genai_types.Part.from_bytes(data=image_bytes, mime_type=mime_type))
                                except Exception as e:
                                    print(f"[GeminiLlmClient] 이미지 처리 오류: {e}")
                    
                    if parts:
                        contents.append(genai_types.Content(role=gemini_role, parts=parts))
                        # 이력에 추가 (텍스트만)
                        text_parts = [{"text": item.get('text', '')} for item in content if item.get('type') == 'input_text' and isinstance(item.get('text'), str) and item.get('text').strip()]
                        if text_parts:
                            self._conversation_history.append({"role": gemini_role, "parts": text_parts})
                else:
                    if isinstance(content, str) and content.strip():
                        parts.append(genai_types.Part.from_text(text=content))
                        contents.append(genai_types.Content(role=gemini_role, parts=parts))
                        # 이력에 추가
                        self._conversation_history.append({"role": gemini_role, "parts": [{"text": content}]})
            
            print(f"[GeminiLlmClient] 메시지 수: {len(contents)} (이력: {len(self._conversation_history)})")
            
            # Thread ID 전송
            yield StreamChunk('thread_id', text=self.thread_id)
            
            # Function Calling 도구 설정
            tools_spec = self._build_tools_spec()
            function_declarations = [
                genai_types.FunctionDeclaration(
                    name=tool['name'],
                    description=tool['description'],
                    parameters=tool['parameters']
                )
                for tool in tools_spec
            ]
            
            # GenerateContentConfig 설정
            # 다만 모델/버전/프로젝트 설정에 따라 거부될 수 있어, GPT 경로처럼 "자동 폴백 재시도"를 같이 둔다.
            try:
                max_out = int(os.getenv("GEMINI_MAX_OUTPUT_TOKENS", "60036"))
            except Exception:
                max_out = 60000
            if max_out <= 0:
                max_out = 60000
            try:
                thinking_budget = int(os.getenv("GEMINI_THINKING_BUDGET", "60000"))
            except Exception:
                thinking_budget = 60000
            # 일부 모델은 thinking_config 자체를 싫어할 수 있어 0이면 비활성
            if thinking_budget < 0:
                thinking_budget = 0
            
            def _make_thinking_config(*, budget: int) -> Any | None:
                """
                Gemini 3 Flash/Pro:
                - include_thoughts=True 로 thought summary(추론 요약) 파트를 스트리밍 받을 수 있음
                - thinking_level은 모델별 지원 값이 달라 env로 조정 가능
                - thinking_budget은 지원되는 SDK/모델에서만 적용
                IMPORTANT: Gemini API는 thinking_budget과 thinking_level을 동시에 설정하면 400을 반환함.
                """
                try:
                    include_env = (os.getenv("GEMINI_INCLUDE_THOUGHTS", "true") or "true").strip().lower()
                    include_thoughts = include_env not in ("0", "false", "no", "n", "off")
                except Exception:
                    include_thoughts = True

                thinking_level = (os.getenv("GEMINI_THINKING_LEVEL", "high") or "high").strip().lower()
                # level | budget | auto (default: level)
                mode = (os.getenv("GEMINI_THINKING_MODE", "level") or "level").strip().lower()

                def _include_only() -> Any | None:
                    try:
                        return genai_types.ThinkingConfig(include_thoughts=include_thoughts)
                    except Exception:
                        return None

                # ✅ 기본/권장: thinking_level만 사용 (budget과 동시 설정 금지)
                if mode in ("level", "thinking_level"):
                    try:
                        return genai_types.ThinkingConfig(
                            include_thoughts=include_thoughts,
                            thinking_level=thinking_level,
                        )
                    except Exception:
                        return _include_only()

                if mode in ("budget", "thinking_budget"):
                    if budget > 0:
                        try:
                            return genai_types.ThinkingConfig(
                                include_thoughts=include_thoughts,
                                thinking_budget=budget,
                            )
                        except Exception:
                            return _include_only()
                    return _include_only()

                # auto: level 먼저, 실패하면 budget
                try:
                    return genai_types.ThinkingConfig(
                        include_thoughts=include_thoughts,
                        thinking_level=thinking_level,
                    )
                except Exception:
                    pass
                if budget > 0:
                    try:
                        return genai_types.ThinkingConfig(
                            include_thoughts=include_thoughts,
                            thinking_budget=budget,
                        )
                    except Exception:
                        pass
                return _include_only()

            def _make_config(*, max_out_tokens: int, thinking: int) -> Any:
                # NOTE: thinking_config=None을 싫어하는 경우가 있어 조건부로만 넣는다.
                cfg: Dict[str, Any] = {
                    "temperature": 1.0,
                    "max_output_tokens": max_out_tokens,
                    "tools": [genai_types.Tool(function_declarations=function_declarations)],
                }
                # ✅ 정석: system_instruction
                if system_prompt:
                    cfg["system_instruction"] = system_prompt
                thinking_cfg = _make_thinking_config(budget=thinking)
                if thinking_cfg is not None:
                    cfg["thinking_config"] = thinking_cfg
                return genai_types.GenerateContentConfig(**cfg)
            
            # ========== ReAct 루프 시작 ==========
            MAX_TURNS = 15  # 최대 턴 수 제한
            turn = 0
            accumulated_text = ""
            accumulated_thinking = ""
            
            while turn < MAX_TURNS:
                turn += 1
                print(f"[GeminiLlmClient] === ReAct Turn {turn}/{MAX_TURNS} ===")

                # ✅ (A) systemInstruction의 그래프 상태가 턴 중간에 stale 되는 문제 완화:
                # - 매 턴, Tools에 저장된 최신 graph_state로 system prompt를 다시 생성한다.
                # - tool 실행 직후 graph_state가 업데이트되어도 다음 턴에는 반영된다.
                graph_state_for_prompt = None
                try:
                    graph_state_for_prompt = getattr(tools_impl, "graph_state", None) if tools_impl else None
                except Exception:
                    graph_state_for_prompt = None
                system_prompt = build_system_prompt(graph_state=graph_state_for_prompt, model=self.model)

                # 1차: 요청된(기본) 값으로 생성
                config = _make_config(max_out_tokens=max_out, thinking=thinking_budget)
                # 폴백 후보 (GPT처럼 실패 시 자동 재시도)
                fallback_config_no_thinking = _make_config(max_out_tokens=max_out, thinking=0)
                fallback_config_safe = _make_config(max_out_tokens=min(max_out, 8192), thinking=min(thinking_budget, 4096))
                
                # 스트리밍 응답 생성
                try:
                    response = local_client.models.generate_content_stream(
                        model=self.model,
                        contents=contents,
                        config=config
                    )
                except Exception as gen_err:
                    # GPT(Responses)처럼 "옵션을 줄여서" 1~2회 자동 재시도
                    msg = ""
                    try:
                        msg = str(gen_err)
                    except Exception:
                        msg = ""
                    print(f"[GeminiLlmClient] generate_content_stream 실패(1차): {_scrub_secrets(gen_err)}")
                    retried = False
                    # thinking 관련 에러면 thinking 비활성화로 재시도
                    if ("thinking" in msg.lower()) or ("thinkingConfig" in msg) or ("ThinkingConfig" in msg):
                        try:
                            response = local_client.models.generate_content_stream(
                                model=self.model,
                                contents=contents,
                                config=fallback_config_no_thinking
                            )
                            retried = True
                            print("[GeminiLlmClient] ✅ 재시도 성공: thinking_config 비활성화")
                        except Exception as gen_err2:
                            print(f"[GeminiLlmClient] 재시도 실패(thinking off): {_scrub_secrets(gen_err2)}")
                    # maxOutputTokens 관련이면 안전한 토큰/생각 예산으로 재시도
                    if (not retried) and (("maxOutputTokens" in msg) or ("max_output_tokens" in msg) or ("max output" in msg.lower())):
                        try:
                            response = local_client.models.generate_content_stream(
                                model=self.model,
                                contents=contents,
                                config=fallback_config_safe
                            )
                            retried = True
                            print("[GeminiLlmClient] ✅ 재시도 성공: 안전한 max_output_tokens/thinking_budget")
                        except Exception as gen_err3:
                            print(f"[GeminiLlmClient] 재시도 실패(safe cfg): {_scrub_secrets(gen_err3)}")
                    if not retried:
                        raise
                
                turn_text = ""
                turn_thinking = ""
                function_calls_in_turn = []  # 이번 턴에서 발생한 function calls
                function_calls_processed = set()
                model_response_content = None  # 모델 응답의 전체 content 저장 (thought_signature 보존)
                # NOTE:
                # - Gemini 3 tool calling은 functionCall 파트에 thought_signature가 필요합니다.
                # - 스트리밍 중에 관측되는 part 객체는 "부분 스냅샷"일 수 있어 thought_signature가 비어 있을 수 있습니다.
                # - 따라서 다음 턴에 재주입할 functionCall 파트는 반드시 "턴 종료 후"
                #   model_response_content.parts(최종 content)에서 다시 추출합니다.
                function_call_parts_for_next_turn: List[Any] = []
                finish_reason = None  # Gemini의 완료 사유
                
                for chunk in response:
                    # 🔥 동기 iterator이므로 이벤트 루프에 제어권을 넘겨 WebSocket 메시지 처리
                    await asyncio.sleep(0)
                    
                    try:
                        candidates = getattr(chunk, "candidates", None)
                        if candidates:
                            for candidate in candidates:
                                # finish_reason 추출
                                fr = getattr(candidate, "finish_reason", None)
                                if fr:
                                    finish_reason = str(fr)
                                
                                content_obj = getattr(candidate, "content", None)
                                if not content_obj:
                                    continue
                                parts_iter = getattr(content_obj, "parts", None)
                                if not parts_iter:
                                    continue
                                
                                # 모델 응답 content 저장 (마지막 것이 최종)
                                model_response_content = content_obj
                                    
                                for part in parts_iter:
                                    # 1. Thinking 응답 처리
                                    thought_flag = getattr(part, "thought", None)
                                    if bool(thought_flag):
                                        thought_text = ""
                                        try:
                                            # ✅ Gemini: include_thoughts=True면 thought summary 파트가 part.thought=True로 옴
                                            # 일부 환경에서 thought가 문자열로 올 수도 있어 방어
                                            if isinstance(thought_flag, str) and thought_flag.strip():
                                                thought_text = thought_flag
                                            else:
                                                t = getattr(part, "text", None)
                                                if t:
                                                    thought_text = str(t)
                                        except Exception:
                                            pass
                                            
                                        if thought_text:
                                            turn_thinking += thought_text
                                            accumulated_thinking += thought_text
                                            yield StreamChunk('reasoning', text=thought_text)
                                        continue
                                    
                                    # 2. 일반 텍스트 처리
                                    part_text = getattr(part, "text", None)
                                    part_fc = getattr(part, "function_call", None)
                                    if part_text and not part_fc:
                                        text = str(part_text)
                                        if text:
                                            turn_text += text
                                            accumulated_text += text
                                            yield StreamChunk('text', text=text)
                                    
                                    # 3. Function Call 처리
                                    if part_fc:
                                        fc = part_fc
                                        func_name = getattr(fc, "name", None)
                                        if not func_name:
                                            # SDK 구조가 바뀐 경우 대비: model_dump 시도
                                            try:
                                                fc_dump = fc.model_dump() if hasattr(fc, "model_dump") else {}
                                            except Exception:
                                                fc_dump = {}
                                            func_name = fc_dump.get("name")
                                        if not func_name:
                                            continue
                                        raw_args = getattr(fc, "args", None)
                                        func_args: Dict[str, Any] = {}
                                        if raw_args:
                                            try:
                                                # dict-like(Mapping)인 경우
                                                func_args = dict(raw_args)  # type: ignore[arg-type]
                                            except Exception:
                                                # model_dump가 가능하면 거기서 추출
                                                try:
                                                    if hasattr(fc, "model_dump"):
                                                        fc_dump = fc.model_dump()
                                                        a = fc_dump.get("args") or fc_dump.get("arguments") or {}
                                                        if isinstance(a, dict):
                                                            func_args = a
                                                except Exception:
                                                    func_args = {}
                                        
                                        # 중복 호출 방지
                                        try:
                                            call_key = f"{func_name}_{json.dumps(func_args, sort_keys=True, ensure_ascii=False)}"
                                        except Exception:
                                            call_key = f"{func_name}_{str(func_args)}"
                                        if call_key in function_calls_processed:
                                            continue
                                        function_calls_processed.add(call_key)

                                        # ✅ 주의:
                                        # functionCall 파트는 thought_signature가 필요하므로 "여기서" 저장하지 않는다.
                                        # (스트리밍 part가 signature 없는 스냅샷일 수 있음)
                                        
                                        print(f"[GeminiLlmClient] Function Call (turn {turn}): {func_name}, args: {func_args}")
                                        
                                        # 도구 실행 및 결과 수집
                                        tool_result_for_gemini = None
                                        
                                        # view 도구 처리
                                        if func_name == 'view':
                                            # view 레이스 방지: 프론트에 최신 상태 요청 후 짧게 대기
                                            view_result = None
                                            if tools_impl and hasattr(tools_impl, "set_view_state_future"):
                                                try:
                                                    fut = asyncio.get_running_loop().create_future()
                                                    tools_impl.set_view_state_future(fut)
                                                    yield StreamChunk('tool', tool_call={
                                                        'name': 'view',
                                                        'args': {},
                                                        'result': {'type': 'View/RequestState', 'payload': {'message': 'request latest graph state'}}
                                                    })
                                                    view_result = await asyncio.wait_for(fut, timeout=0.6)
                                                except Exception:
                                                    view_result = None
                                                finally:
                                                    try:
                                                        tools_impl.set_view_state_future(None)
                                                    except Exception:
                                                        pass
                                            if view_result is None:
                                                view_result = tools_impl.view() if tools_impl else "그래프 상태를 가져올 수 없습니다."
                                            # Gemini에 전달되는 Observation(=function_response)은 가능한 한
                                            # 텍스트(output) 형태로도 함께 제공하면 모델이 안정적으로 사용한다.
                                            tool_result_for_gemini = {
                                                "status": "success",
                                                "output": str(view_result),
                                                "data": view_result,
                                            }
                                            yield StreamChunk('tool', tool_call={
                                                'name': 'view',
                                                'args': {},
                                                'result': {
                                                    'type': 'Tool/View',
                                                    'payload': {'message': 'AI가 현재 그래프 상태를 확인했습니다.'}
                                                }
                                            })
                                        
                                        # draw, remove, edit 도구 처리
                                        elif tools_impl and func_name in ('draw', 'remove', 'edit'):
                                            try:
                                                spec_json = func_args.get('spec_json', '{}')
                                                spec = json.loads(spec_json) if isinstance(spec_json, str) else spec_json
                                                
                                                if isinstance(spec, list):
                                                    results = []
                                                    for item in spec:
                                                        if func_name == 'draw':
                                                            result = tools_impl.draw(item)
                                                        elif func_name == 'remove':
                                                            result = tools_impl.remove(item)
                                                        else:
                                                            result = tools_impl.edit(item)
                                                        results.append(result)
                                                    
                                                    tool_result = {
                                                        'type': 'batch',
                                                        'results': results,
                                                        'count': len(results)
                                                    }
                                                    print(f"[GeminiLlmClient] ✅ 배치 전송: {func_name} -> {len(results)}개")
                                                    yield StreamChunk('tool', tool_call={'name': func_name, 'args': spec, 'result': tool_result})
                                                    
                                                    # 프론트엔드 적용 결과 대기 (양방향 통신)
                                                    frontend_results = await self._wait_for_frontend_results(tools_impl, len(results))
                                                    failed = [r for r in frontend_results if not r.get('success', True)]
                                                    if failed:
                                                        error_msgs = [r.get('error', '알 수 없는 오류') for r in failed]
                                                        print(f"[GeminiLlmClient] ❌ 프론트엔드 적용 실패: {error_msgs}")
                                                        tool_result_for_gemini = {
                                                            "status": "error",
                                                            "output": f"프론트엔드 적용 실패: {error_msgs}",
                                                            "error": str(error_msgs),
                                                        }
                                                        yield StreamChunk('tool', tool_call={'name': func_name, 'args': spec, 'frontend_error': error_msgs})
                                                    else:
                                                        try:
                                                            out_str = json.dumps(tool_result, ensure_ascii=False)
                                                        except Exception:
                                                            out_str = str(tool_result)
                                                        success_msgs = [r.get('message', '') for r in frontend_results if r.get('message')]
                                                        tool_result_for_gemini = {
                                                            "status": "success",
                                                            "output": out_str,
                                                            "count": len(results),
                                                            "results": results,
                                                            "frontend_messages": success_msgs,
                                                        }
                                                        print(f"[GeminiLlmClient] ✅ 프론트엔드 적용 성공: {len(frontend_results)}개")
                                                else:
                                                    if func_name == 'draw':
                                                        tool_result = tools_impl.draw(spec)
                                                    elif func_name == 'remove':
                                                        tool_result = tools_impl.remove(spec)
                                                    else:
                                                        tool_result = tools_impl.edit(spec)
                                                    print(f"[GeminiLlmClient] ✅ 전송: {func_name} -> {tool_result.get('type', 'unknown') if isinstance(tool_result, dict) else 'string'}")
                                                    yield StreamChunk('tool', tool_call={'name': func_name, 'args': spec, 'result': tool_result})
                                                    
                                                    # 프론트엔드 적용 결과 대기 (양방향 통신)
                                                    frontend_results = await self._wait_for_frontend_results(tools_impl, 1)
                                                    if frontend_results and len(frontend_results) > 0:
                                                        fr = frontend_results[0]
                                                        if not fr.get('success', True):
                                                            error_msg = fr.get('error', '알 수 없는 오류')
                                                            print(f"[GeminiLlmClient] ❌ 프론트엔드 적용 실패: {error_msg}")
                                                            tool_result_for_gemini = {
                                                                "status": "error",
                                                                "output": f"프론트엔드 적용 실패: {error_msg}",
                                                                "error": error_msg,
                                                            }
                                                            yield StreamChunk('tool', tool_call={'name': func_name, 'args': spec, 'frontend_error': error_msg})
                                                        else:
                                                            try:
                                                                out_str = json.dumps(tool_result, ensure_ascii=False) if isinstance(tool_result, dict) else str(tool_result)
                                                            except Exception:
                                                                out_str = str(tool_result)
                                                            tool_result_for_gemini = {
                                                                "status": "success",
                                                                "output": out_str,
                                                                "result": tool_result,
                                                                "frontend_message": fr.get('message', ''),
                                                            }
                                                            print(f"[GeminiLlmClient] ✅ 프론트엔드 적용 성공: {fr.get('message', '')}")
                                                    else:
                                                        # 타임아웃 - 결과 없음 (일단 성공으로 처리)
                                                        try:
                                                            out_str = json.dumps(tool_result, ensure_ascii=False) if isinstance(tool_result, dict) else str(tool_result)
                                                        except Exception:
                                                            out_str = str(tool_result)
                                                        tool_result_for_gemini = {
                                                            "status": "success",
                                                            "output": out_str,
                                                            "result": tool_result,
                                                            "note": "프론트엔드 확인 대기 타임아웃",
                                                        }
                                            except Exception as tool_err:
                                                print(f"[GeminiLlmClient] ❌ 도구 실행 오류: {tool_err}")
                                                import traceback
                                                traceback.print_exc()
                                                tool_result_for_gemini = {"status": "error", "output": str(tool_err), "error": str(tool_err)}
                                                yield StreamChunk('tool', tool_call={'name': func_name, 'args': func_args, 'error': str(tool_err)})
                                        
                                        # set_custom_axis_range 도구 처리
                                        elif tools_impl and func_name == 'set_custom_axis_range':
                                            try:
                                                spec_json = func_args.get('spec_json', '{}')
                                                spec = json.loads(spec_json) if isinstance(spec_json, str) else spec_json
                                                
                                                tool_result = tools_impl.set_custom_axis_range(spec)
                                                print(f"[GeminiLlmClient] ✅ 전송: set_custom_axis_range -> {tool_result.get('type', 'unknown') if isinstance(tool_result, dict) else 'string'}")
                                                yield StreamChunk('tool', tool_call={'name': func_name, 'args': spec, 'result': tool_result})
                                                
                                                # 프론트엔드 적용 결과 대기
                                                frontend_results = await self._wait_for_frontend_results(tools_impl, 1)
                                                if frontend_results and len(frontend_results) > 0:
                                                    fr = frontend_results[0]
                                                    if not fr.get('success', True):
                                                        error_msg = fr.get('error', '알 수 없는 오류')
                                                        print(f"[GeminiLlmClient] ❌ 프론트엔드 적용 실패: {error_msg}")
                                                        tool_result_for_gemini = {
                                                            "status": "error",
                                                            "output": f"프론트엔드 적용 실패: {error_msg}",
                                                            "error": error_msg,
                                                        }
                                                    else:
                                                        try:
                                                            out_str = json.dumps(tool_result, ensure_ascii=False) if isinstance(tool_result, dict) else str(tool_result)
                                                        except Exception:
                                                            out_str = str(tool_result)
                                                        tool_result_for_gemini = {
                                                            "status": "success",
                                                            "output": out_str,
                                                            "result": tool_result,
                                                            "frontend_message": fr.get('message', ''),
                                                        }
                                                        print(f"[GeminiLlmClient] ✅ 프론트엔드 적용 성공: {fr.get('message', '')}")
                                                else:
                                                    try:
                                                        out_str = json.dumps(tool_result, ensure_ascii=False) if isinstance(tool_result, dict) else str(tool_result)
                                                    except Exception:
                                                        out_str = str(tool_result)
                                                    tool_result_for_gemini = {
                                                        "status": "success",
                                                        "output": out_str,
                                                        "result": tool_result,
                                                    }
                                            except Exception as tool_err:
                                                print(f"[GeminiLlmClient] ❌ set_custom_axis_range 오류: {tool_err}")
                                                import traceback
                                                traceback.print_exc()
                                                tool_result_for_gemini = {"status": "error", "output": str(tool_err), "error": str(tool_err)}
                                                yield StreamChunk('tool', tool_call={'name': func_name, 'args': func_args, 'error': str(tool_err)})
                                        
                                        # fit_to_screen 도구 처리
                                        elif tools_impl and func_name == 'fit_to_screen':
                                            try:
                                                tool_result = tools_impl.fit_to_screen()
                                                print(f"[GeminiLlmClient] ✅ 전송: fit_to_screen")
                                                yield StreamChunk('tool', tool_call={'name': func_name, 'args': {}, 'result': tool_result})
                                                
                                                tool_result_for_gemini = {
                                                    "status": "success",
                                                    "output": "화면 맞춤 완료",
                                                    "result": tool_result,
                                                }
                                            except Exception as tool_err:
                                                print(f"[GeminiLlmClient] ❌ fit_to_screen 오류: {tool_err}")
                                                tool_result_for_gemini = {"status": "error", "output": str(tool_err), "error": str(tool_err)}
                                                yield StreamChunk('tool', tool_call={'name': func_name, 'args': {}, 'error': str(tool_err)})
                                        
                                        else:
                                            tool_result_for_gemini = {"status": "error", "output": f"Unknown tool: {func_name}", "error": f"Unknown tool: {func_name}"}
                                        
                                        # Function call 정보 저장 (ReAct 루프용)
                                        function_calls_in_turn.append({
                                            'name': func_name,
                                            'args': func_args,
                                            'result': tool_result_for_gemini
                                        })
                                        
                    except Exception as chunk_err:
                        print(f"[GeminiLlmClient] 청크 처리 오류 (무시): {chunk_err}")
                        continue
                
                # finish_reason 확인
                print(f"[GeminiLlmClient] Turn {turn}: finish_reason={finish_reason}, function_calls={len(function_calls_in_turn)}")
                
                # 이번 턴에 function call이 없고, Gemini가 명시적으로 STOP했으면 루프 종료
                if not function_calls_in_turn:
                    # 응답 텍스트를 대화 이력에 추가
                    if turn_text:
                        self._conversation_history.append({
                            "role": "model",
                            "parts": [{"text": turn_text}]
                        })
                    
                    # STOP이면 Gemini가 자연스럽게 완료한 것 → 종료
                    if finish_reason and 'STOP' in finish_reason.upper():
                        print(f"[GeminiLlmClient] Turn {turn}: Gemini STOP (finish_reason={finish_reason}) - ReAct 루프 종료")
                        break
                    # STOP이 아니면 (예: MAX_TOKENS, SAFETY 등) 일단 종료
                    else:
                        print(f"[GeminiLlmClient] Turn {turn}: Function call 없고 finish_reason={finish_reason} - ReAct 루프 종료")
                        break
                
                # Function call이 있으면 결과를 contents에 추가하고 다음 턴 진행
                print(f"[GeminiLlmClient] Turn {turn}: {len(function_calls_in_turn)}개 function call 처리됨 - 다음 턴 진행")
                
                # 🔥 프론트엔드에서 그래프 상태를 받을 시간을 주기 위해 대기
                await asyncio.sleep(0.25)  # 250ms 대기 - WebSocket 메시지 처리 시간 확보
                # IMPORTANT: GPT 경로와 동일하게 "상태"는 view 도구로만 전달/조회한다.
                # draw/remove/edit 결과에 거대한 current_graph_state를 억지로 붙이면
                # 컨텍스트 폭발(토큰/비용/지연) + 모델 혼란(불필요한 중복 상태)이 생긴다.
                
                # Model의 function call 응답을 contents에 추가
                # IMPORTANT:
                # - Gemini 3 tool calling은 functionCall 파트에 thought_signature가 필요합니다.
                # - 서버가 functionCall을 재생성하면 thought_signature가 빠져 400 INVALID_ARGUMENT가 날 수 있으므로,
                #   "모델이 실제로 반환한 원본 functionCall Part"를 보존해서 다음 턴 contents에 전달합니다.
                model_parts_for_next: List[Any] = []
                try:
                    if isinstance(turn_text, str) and turn_text.strip():
                        model_parts_for_next.append(genai_types.Part.from_text(text=turn_text))
                except Exception:
                    pass
                # ✅ 항상 최종 model_response_content에서 function_call 파트를 다시 추출 (thought_signature 보존)
                if model_response_content is not None:
                    try:
                        raw_parts = getattr(model_response_content, "parts", None) or []
                        function_call_parts_for_next_turn = [rp for rp in raw_parts if getattr(rp, "function_call", None)]
                    except Exception:
                        function_call_parts_for_next_turn = []

                # 다음 턴 컨텍스트 구성:
                # - 가능하면 (text + functionCall parts)로 명시적으로 Content를 구성
                # - 그래도 안 되면 최후 fallback으로 model_response_content를 통째로 넣어 signature를 보존
                # ⚠️ 빈 텍스트 파트만 있는 경우엔 Content를 만들지 않음(Gemini 400 방지)
                if function_call_parts_for_next_turn:
                    model_parts_for_next.extend(function_call_parts_for_next_turn)
                    # model_parts_for_next가 "빈 텍스트 Part 하나"만 있는 경우를 필터링
                    has_meaningful_parts = any(
                        getattr(p, "function_call", None) is not None or 
                        (getattr(p, "text", None) and getattr(p, "text", "").strip())
                        for p in model_parts_for_next
                    )
                    if model_parts_for_next and has_meaningful_parts:
                        contents.append(genai_types.Content(role="model", parts=model_parts_for_next))
                elif model_response_content is not None:
                    try:
                        # 원본 content를 추가하되, 빈 텍스트 Part는 제거 (400 방지)
                        raw_parts_check = getattr(model_response_content, "parts", None) or []
                        filtered_parts = [
                            p for p in raw_parts_check
                            if getattr(p, "function_call", None) is not None or
                               (getattr(p, "text", None) and getattr(p, "text", "").strip())
                        ]
                        if filtered_parts:
                            contents.append(genai_types.Content(role="model", parts=filtered_parts))
                            print(f"[GeminiLlmClient] 원본 model content 추가(fallback) (parts: {len(model_response_content.parts)})")
                    except Exception:
                        # 그래도 실패하면 text만이라도 유지
                        if model_parts_for_next:
                            contents.append(genai_types.Content(role="model", parts=model_parts_for_next))
                else:
                    if model_parts_for_next:
                        contents.append(genai_types.Content(role="model", parts=model_parts_for_next))

                # ✅ 대화 이력에도 "원본 functionCall Part"를 그대로 저장해 다음 요청(stream_chat)에서 save-state(=thought_signature)를 유지한다.
                # - dict 형태의 function_call을 저장/재구성하는 건 400을 유발할 수 있으니 절대 하지 않는다.
                model_history_parts: List[Dict[str, Any]] = []
                if isinstance(turn_text, str) and turn_text.strip():
                    model_history_parts.append({"text": turn_text})
                if function_call_parts_for_next_turn:
                    for rp in function_call_parts_for_next_turn:
                        model_history_parts.append({"raw_part": rp})
                if model_history_parts:
                    self._conversation_history.append({"role": "model", "parts": model_history_parts})
                
                # Function response를 user 역할로 추가
                response_parts = []
                for fc_info in function_calls_in_turn:
                    tool_result = fc_info['result']
                    # ✅ 성공 힌트 추가: AI가 "이미 완료됨"을 명확히 인식하도록
                    if isinstance(tool_result, dict) and tool_result.get('status') == 'success':
                        tool_name = fc_info.get('name', '')
                        if tool_name in ('draw', 'remove', 'edit'):
                            # 원래 결과에 추가 힌트 붙이기
                            enhanced_result = {
                                **tool_result,
                                'note': '✅ 작업 완료. 사용자 요청이 충족되었는지 확인하고, 충족되었으면 즉시 종료하세요. 같은 작업을 반복하지 마세요.'
                            }
                            tool_result = enhanced_result
                    
                    response_parts.append(genai_types.Part.from_function_response(
                        name=fc_info['name'],
                        response=tool_result
                    ))
                contents.append(genai_types.Content(role="user", parts=response_parts))
                
                # 대화 이력에도 추가
                history_response_parts = []
                for fc_info in function_calls_in_turn:
                    history_response_parts.append({
                        "function_response": {
                            "name": fc_info['name'],
                            "response": fc_info['result']
                        }
                    })
                self._conversation_history.append({"role": "user", "parts": history_response_parts})
            
            # ========== ReAct 루프 종료 ==========
            
            if turn >= MAX_TURNS:
                print(f"[GeminiLlmClient] ⚠️ 최대 턴 수({MAX_TURNS}) 도달 - 강제 종료")
                yield StreamChunk('text', text="\n\n[최대 처리 단계에 도달했습니다]")
            
            # 이력이 너무 길어지면 오래된 것 제거 (최근 40개 유지)
            if len(self._conversation_history) > 40:
                self._conversation_history = self._conversation_history[-40:]
            
            print(f"[GeminiLlmClient] ReAct 완료 (총 {turn}턴, 이력: {len(self._conversation_history)}, thinking: {len(accumulated_thinking)} chars)")


class ClaudeLlmClient:
    """
    Claude API 스트리밍 클라이언트 (GPT와 동일한 스펙)
    
    - Anthropic SDK 사용
    - Function Calling (Tool Use) 지원
    - 스트리밍 응답 지원
    - Extended Thinking 지원
    - 대화 이력 관리
    """
    
    def __init__(self, model: str = "claude-haiku-4-5-20251001", thread_id: str | None = None, api_key: str | None = None, gemini_key: str | None = None):
        self.model = model
        # 모델 이름 정규화
        if model == "claude-haiku-4-5":
            self.model = "claude-haiku-4-5-20251001"
        elif model == "claude-sonnet-4-5":
            self.model = "claude-sonnet-4-5"
        elif model == "claude-opus-4-5":
            self.model = "claude-opus-4-5"
        self._claude_key = api_key or os.getenv('CLAUDE_API_KEY') or os.getenv('ANTHROPIC_API_KEY')
        self._gemini_key = gemini_key or os.getenv('GEMINI_API_KEY')  # Gemini Oracle용
        self._conversation_history: List[Dict[str, Any]] = []
        self._lock = asyncio.Lock()
        self.thread_id = thread_id or f"claude-{os.urandom(8).hex()}"
        
        print(f"[ClaudeLlmClient] 초기화: model={self.model}, thread_id={self.thread_id}, claude_key={'present' if self._claude_key else 'MISSING'}, gemini_key={'present' if self._gemini_key else 'MISSING'}")
    
    async def _wait_for_frontend_results(self, tools_impl: Any, expected_count: int, timeout: float = 2.0) -> List[Dict[str, Any]]:
        """프론트엔드에서 도구 적용 결과를 대기합니다."""
        results = []
        queue = getattr(tools_impl, '_action_result_queue', None)
        
        if not queue:
            print("[ClaudeLlmClient] _wait_for_frontend_results: 큐가 설정되지 않음")
            return results
        
        try:
            for i in range(expected_count):
                try:
                    result = await asyncio.wait_for(queue.get(), timeout=timeout)
                    results.append(result)
                    print(f"[ClaudeLlmClient] 프론트엔드 결과 수신 ({i+1}/{expected_count}): {result.get('success', '?')} - {result.get('eventType', '?')}")
                except asyncio.TimeoutError:
                    print(f"[ClaudeLlmClient] 프론트엔드 결과 대기 타임아웃 ({i+1}/{expected_count})")
                    break
        except Exception as e:
            print(f"[ClaudeLlmClient] 프론트엔드 결과 대기 오류: {e}")
        
        return results
    
    def _build_tools_spec(self) -> List[Dict[str, Any]]:
        """Claude Tool Use용 도구 스펙"""
        return [
            {
                "name": "draw",
                "description": """Draw geometry on canvas. Supports various geometric objects.

spec_json format examples:
- Segment: {"kind": "segment", "p1": [x1, y1], "p2": [x2, y2], "extendStart": false, "extendEnd": false, "style": {"stroke": {"color": "#000000", "width": 0.8}}}
- Line (infinite): {"kind": "line", "p1": [x1, y1], "p2": [x2, y2]}
- Function (explicit y=f(x)): {"kind": "function", "expression": "x^2", "domain": [-5, 5]}
- Function (implicit F(x,y)=0): {"kind": "function-implicit", "expression": "x^2 + y^2 - 25"}
- Point: {"kind": "point", "position": [x, y], "diameterMm": 2.3, "color": "#000000"}
- Bezier curve: {"kind": "bezier", "a": [x1, y1], "b": [x2, y2], "c1": [cx1, cy1], "c2": [cx2, cy2]}
- Length-bezier (길이 표시 베지어): {"kind": "length-bezier", "a": [x1, y1], "b": [x2, y2], "c1": [cx1, cy1], "c2": [cx2, cy2], "label": "3"}
- Filled region: {"kind": "filled-region", "centerPoint": [x, y], "fillColor": "rgb(230, 230, 230)"}
- Math text (LaTeX): {"kind": "math-text", "latex": "x^2 + y^2 = 1", "position": [x, y], "fontSize": 11, "color": "#000000"}
- Multiple objects: [{...}, {...}, ...]""",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "spec_json": {
                            "type": "string",
                            "description": "JSON string describing what to draw"
                        }
                    },
                    "required": ["spec_json"]
                }
            },
            {
                "name": "remove",
                "description": """Remove elements from canvas.

spec_json format examples:
- By IDs: {"mode": "by-id", "ids": ["segment-abc123", "point-xyz789"]}
- By kind (all of type): {"mode": "by-query", "kind": "segment"}
- By functionId: {"mode": "by-query", "functionId": "func-123"}
- Clear all: {"mode": "by-query"}
- Multiple removals: [{"mode": "by-id", "ids": ["id1"]}, {"mode": "by-query", "kind": "point"}]""",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "spec_json": {
                            "type": "string",
                            "description": "JSON string describing what to remove"
                        }
                    },
                    "required": ["spec_json"]
                }
            },
            {
                "name": "edit",
                "description": """Edit existing objects on canvas. Only the specified properties are updated.

spec_json format examples:
- Change style: {"id": "segment-abc123", "style": {"stroke": {"color": "#000000", "width": 3}}}
- Move point: {"id": "point-abc123", "position": [3, 4]}
- Update function: {"id": "function-abc123", "expression": "x^3", "domain": [-10, 10]}
- Multiple edits: [{"id": "id1", "color": "#000000"}, {"id": "id2", "position": [1, 2]}]""",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "spec_json": {
                            "type": "string",
                            "description": "JSON string describing what to edit"
                        }
                    },
                    "required": ["spec_json"]
                }
            },
            {
                "name": "view",
                "description": """View current graph state. Returns all objects currently on the canvas with their IDs, positions, styles, and properties.

Use this tool to:
- Check what is currently drawn
- Get IDs of objects for editing or removal
- Verify the result of previous draw/edit operations

No parameters needed.""",
                "input_schema": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            },
            {
                "name": "set_custom_axis_range",
                "description": """Set custom axis range and visibility.

IMPORTANT: Functions and segments outside the axis range are automatically clipped. Set the axis range appropriately so that the graph is fully visible.

spec_json format:
{
    "xMin": -5,        // X axis start value (optional)
    "xMax": 10,        // X axis end value (optional)
    "yMin": -3,        // Y axis start value (optional)
    "yMax": 8,         // Y axis end value (optional)
    "xVisible": true,  // X axis visibility (optional, default: true)
    "yVisible": true   // Y axis visibility (optional, default: true)
}

Examples:
- Set x-axis from -5 to 10: {"xMin": -5, "xMax": 10}
- Set both axes: {"xMin": -5, "xMax": 5, "yMin": -3, "yMax": 3}
- Hide x-axis: {"xVisible": false}
- Set range and hide y-axis: {"xMin": 0, "xMax": 10, "yVisible": false}""",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "spec_json": {
                            "type": "string",
                            "description": "JSON string with xMin, xMax, yMin, yMax (numbers), xVisible, yVisible (booleans)"
                        }
                    },
                    "required": ["spec_json"]
                }
            },
            {
                "name": "fit_to_screen",
                "description": """Fit the view to show all content on screen.

Adjusts the zoom level so that all drawn objects fit within the visible area.
Call this after completing all drawing operations to ensure everything is visible.

No parameters needed.""",
                "input_schema": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            },
            {
                "name": "ask_to_gemini",
                "description": """🔮 ORACLE TOOL: Ask Gemini for mathematical calculations and precise answers.

⚠️ CRITICAL: You MUST use this tool when:
- User asks for ANY mathematical calculation (limits, derivatives, integrals, etc.)
- User needs precise numerical values or coordinates
- User asks "what is", "calculate", "find", "solve" for math problems
- Drawing requires exact coordinates from mathematical formulas

🚫 DO NOT ask Gemini for INTERSECTION POINTS!
- Intersections are automatically calculated when you draw functions
- After drawing, use view() tool to see the graph state with auto-calculated intersections

DO NOT attempt to calculate yourself. Gemini is your mathematical oracle.

How to use:
1. Describe EXACTLY what you need to know (be specific!)
2. Include the full context of what user wants
3. Wait for Gemini's answer before drawing

Example queries:
- "Calculate the limit of (sin x)/x as x approaches 0"
- "Find the derivative of x^3 + 2x^2 at x=1"
- "Calculate the integral of e^x from 0 to 1"
- "Find the coordinates for plotting y=sin(x) from -2π to 2π with 20 points"

The response will contain Gemini's precise mathematical answer.""",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "question": {
                            "type": "string",
                            "description": "Your mathematical question for Gemini. Be specific and include all context."
                        }
                    },
                    "required": ["question"]
                }
            }
        ]

    async def _ask_gemini_oracle(self, question: str) -> str:
        """🔮 Gemini에게 수학 계산을 요청하는 신탁 메서드"""
        if not _ensure_gemini_sdk():
            return "Gemini SDK를 사용할 수 없습니다."
        
        # Gemini 클라이언트 준비
        local_gemini = genai_client
        if self._gemini_key:
            try:
                from google import genai
                local_gemini = genai.Client(api_key=self._gemini_key)
            except Exception:
                pass
        
        if not local_gemini:
            return "Gemini API 키가 없습니다."
        
        # 수학 전문가 프롬프트
        system_prompt = """You are a mathematical oracle. Your ONLY job is to provide precise, accurate mathematical answers.

Rules:
1. Give EXACT numerical values, not approximations (unless asked)
2. Show step-by-step calculation when helpful
3. For coordinates, provide them in a clear format: (x, y) or [x, y]
4. For multiple values, list them clearly
5. Be concise but complete
6. If the question involves graphing, provide the exact coordinates/values needed

DO NOT:
- Give vague answers
- Skip calculations
- Provide unnecessary explanations
- Suggest using other tools

Just answer the mathematical question precisely."""

        try:
            # Gemini Pro 사용 (수학에 강함)
            response = await asyncio.to_thread(
                local_gemini.models.generate_content,
                model="gemini-3-pro-preview",
                contents=[{"role": "user", "parts": [{"text": question}]}],
                config=genai_types.GenerateContentConfig(
                    system_instruction=system_prompt,
                    temperature=0.1,  # 낮은 temperature로 정확한 답변
                    max_output_tokens=10000
                )
            )
            
            # 응답 텍스트 추출
            if response and hasattr(response, 'text'):
                return response.text
            elif response and hasattr(response, 'candidates') and response.candidates:
                parts = response.candidates[0].content.parts
                return ''.join(getattr(p, 'text', '') for p in parts)
            else:
                return "Gemini 응답을 파싱할 수 없습니다."
        except Exception as e:
            print(f"[ClaudeLlmClient] Gemini Oracle 오류: {e}")
            import traceback
            traceback.print_exc()
            return f"Gemini 호출 오류: {str(e)}"

    async def stream_chat(self, messages: List[Dict[str, Any]], tools_impl: Any | None = None) -> AsyncIterator[StreamChunk]:
        """Claude 스트리밍 채팅 with Tool Use 루프"""
        import json

        print(f"[ClaudeLlmClient] stream_chat 시작: model={self.model}, thread={self.thread_id}")
        
        if not _ensure_claude_sdk():
            print("[ClaudeLlmClient] Claude SDK 사용 불가 - fallback")
            content = messages[-1].get('content', '') if messages else ''
            yield StreamChunk('text', text=f"[Claude SDK 사용 불가] {content[:200]}")
            return

        # 요청별 api key가 있으면 전용 클라이언트 사용
        local_client = anthropic_client
        if self._claude_key:
            try:
                local_client = anthropic.Anthropic(api_key=self._claude_key)
            except Exception:
                local_client = anthropic_client
        if not local_client:
            print("[ClaudeLlmClient] Claude client 없음 - fallback")
            content = messages[-1].get('content', '') if messages else ''
            yield StreamChunk('text', text=f"[Claude 사용 불가] {content[:200]}")
            return
        
        async with self._lock:
            from .prompt import build_system_prompt
            
            # 시스템 프롬프트 생성
            graph_state_for_prompt = None
            try:
                graph_state_for_prompt = getattr(tools_impl, "graph_state", None) if tools_impl else None
            except Exception:
                graph_state_for_prompt = None
            system_prompt = build_system_prompt(graph_state=graph_state_for_prompt, model=self.model)
            
            # 메시지 구성 (Claude 형식)
            claude_messages = []
            
            # 기존 대화 이력 추가
            for hist_msg in self._conversation_history:
                claude_messages.append(hist_msg)
            
            # 새 메시지 추가
            for msg in messages:
                role = msg.get('role', 'user')
                content = msg.get('content', '')
                
                # Claude는 role이 'user' 또는 'assistant'만 지원
                claude_role = 'assistant' if role == 'assistant' else 'user'
                
                # content가 배열(멀티모달)인 경우 처리
                if isinstance(content, list):
                    claude_content = []
                    for item in content:
                        if item.get('type') == 'input_text':
                            t = item.get('text', '')
                            if isinstance(t, str) and t.strip():
                                claude_content.append({"type": "text", "text": t})
                        elif item.get('type') == 'input_image':
                            # 이미지 처리 (base64)
                            image_url = item.get('image_url', '')
                            if image_url.startswith('data:'):
                                try:
                                    header, b64_data = image_url.split(',', 1)
                                    mime_type = header.split(':')[1].split(';')[0]
                                    claude_content.append({
                                        "type": "image",
                                        "source": {
                                            "type": "base64",
                                            "media_type": mime_type,
                                            "data": b64_data
                                        }
                                    })
                                except Exception as e:
                                    print(f"[ClaudeLlmClient] 이미지 처리 오류: {e}")
                    
                    if claude_content:
                        claude_messages.append({"role": claude_role, "content": claude_content})
                        # 이력에 추가 (텍스트만)
                        text_parts = [{"type": "text", "text": item.get('text', '')} 
                                     for item in content if item.get('type') == 'input_text' and isinstance(item.get('text'), str) and item.get('text').strip()]
                        if text_parts:
                            self._conversation_history.append({"role": claude_role, "content": text_parts})
                else:
                    if isinstance(content, str) and content.strip():
                        claude_messages.append({"role": claude_role, "content": content})
                        self._conversation_history.append({"role": claude_role, "content": content})
            
            print(f"[ClaudeLlmClient] 메시지 수: {len(claude_messages)} (이력: {len(self._conversation_history)})")
            
            # Thread ID 전송
            yield StreamChunk('thread_id', text=self.thread_id)
            
            # Tool Use 도구 설정
            tools_spec = self._build_tools_spec()
            
            # ========== Tool Use 루프 시작 ==========
            MAX_TURNS = 15
            turn = 0
            accumulated_text = ""
            
            while turn < MAX_TURNS:
                turn += 1
                print(f"[ClaudeLlmClient] === Tool Use Turn {turn}/{MAX_TURNS} ===")
                
                # 매 턴마다 시스템 프롬프트 업데이트 (그래프 상태 반영)
                try:
                    graph_state_for_prompt = getattr(tools_impl, "graph_state", None) if tools_impl else None
                except Exception:
                    graph_state_for_prompt = None
                system_prompt = build_system_prompt(graph_state=graph_state_for_prompt, model=self.model)
                
                turn_text = ""
                thinking_text = ""
                thinking_block = None  # API에서 받은 thinking 블록 원본 (signature 포함)
                tool_uses = []
                stop_reason = None
                
                try:
                    # Extended Thinking 설정
                    # max_tokens는 thinking budget보다 커야 함
                    try:
                        thinking_budget = int(os.getenv("CLAUDE_THINKING_BUDGET", "10000"))
                    except Exception:
                        thinking_budget = 10000
                    
                    # max_tokens = thinking_budget + 실제 응답용 토큰
                    max_tokens = thinking_budget + 16000 if thinking_budget > 0 else 16000
                    
                    # 스트리밍 요청
                    # 인터리빙 사고: 도구 호출 사이에 추론 가능 (베타 헤더로 전달)
                    interleaved_thinking_header = {"anthropic-beta": "interleaved-thinking-2025-05-14"}
                    stream_kwargs = {
                        "model": self.model,
                        "max_tokens": max_tokens,
                        "system": system_prompt,
                        "messages": claude_messages,
                        "tools": tools_spec,
                        "extra_headers": interleaved_thinking_header,
                    }
                    
                    # Extended Thinking 활성화 (지원되는 모델만)
                    if thinking_budget > 0:
                        stream_kwargs["thinking"] = {
                            "type": "enabled",
                            "budget_tokens": thinking_budget
                        }
                        print(f"[ClaudeLlmClient] Turn {turn}: thinking ENABLED (budget={thinking_budget})")
                    else:
                        print(f"[ClaudeLlmClient] Turn {turn}: thinking DISABLED (budget=0)")
                    
                    # 동기 스트리밍을 비동기로 감싸기
                    def _stream_sync():
                        try:
                            return local_client.messages.stream(**stream_kwargs)
                        except Exception as e:
                            msg = str(e).lower()
                            print(f"[ClaudeLlmClient] Turn {turn} stream error (thinking on): {e}")
                            
                            # ✅ 'thinking'이 진짜로 미지원/미인식일 때만 fallback
                            thinking_not_supported = (
                                ("unknown parameter" in msg and "thinking" in msg) or
                                ("unrecognized" in msg and "thinking" in msg) or
                                ("invalid request" in msg and "thinking" in msg and "parameter" in msg)
                            )
                            
                            if thinking_not_supported and stream_kwargs.get("thinking"):
                                print(f"[ClaudeLlmClient] Turn {turn} disabling thinking and retrying (not supported)")
                                stream_kwargs.pop("thinking", None)
                                return local_client.messages.stream(**stream_kwargs)
                            
                            # ✅ 나머지는 숨기지 말고 터뜨려서 원인 잡기
                            raise
                    
                    # ✅ Claude 스트림은 동기 iterator라 이벤트 루프를 블로킹할 수 있음.
                    #    -> 별도 스레드에서 읽고, asyncio.Queue로 이벤트를 전달해 WS 응답을 부드럽게 만든다.
                    loop = asyncio.get_running_loop()
                    q: "asyncio.Queue[tuple[str, Any]]" = asyncio.Queue()

                    def _worker():
                        try:
                            with _stream_sync() as stream:
                                # ✅ 이벤트를 즉시 전달 (프론트에서 스무딩하므로 배치 불필요)
                                for ev in stream:
                                    loop.call_soon_threadsafe(q.put_nowait, ("event", ev))
                                fm = stream.get_final_message()
                                loop.call_soon_threadsafe(q.put_nowait, ("final", fm))
                        except Exception as e:
                            loop.call_soon_threadsafe(q.put_nowait, ("error", e))
                        finally:
                            loop.call_soon_threadsafe(q.put_nowait, ("done", None))

                    worker_task = asyncio.create_task(asyncio.to_thread(_worker))
                    final_message = None
                    # 일부 SDK/모델 조합에서는 thinking 블록의 delta가 thinking_delta가 아니라 text_delta로 올 수 있다.
                    # -> 현재 content block의 타입을 추적해서 text_delta라도 thinking이면 reasoning으로 흘려보낸다.
                    active_block_type: str | None = None
                    try:
                        while True:
                            kind, payload = await q.get()
                            if kind == "event":
                                event = payload
                                if True:  # 단일 이벤트 처리
                                    event_type = getattr(event, 'type', '')

                                    # 델타/툴 입력을 한 군데에서 처리
                                    if event_type == 'content_block_delta':
                                        delta = getattr(event, 'delta', None)
                                        if delta:
                                            delta_type = getattr(delta, 'type', '')
                                            if delta_type == 'text_delta':
                                                text = getattr(delta, 'text', '')
                                                if text:
                                                    # ✅ thinking 블록인데 text_delta로 오는 케이스(변종) 처리
                                                    if active_block_type == 'thinking':
                                                        thinking_text += text
                                                        yield StreamChunk('reasoning', text=text)
                                                    else:
                                                        turn_text += text
                                                        accumulated_text += text
                                                        yield StreamChunk('text', text=text)
                                            elif delta_type == 'thinking_delta':
                                                thinking = getattr(delta, 'thinking', '')
                                                if thinking:
                                                    thinking_text += thinking
                                                    yield StreamChunk('reasoning', text=thinking)
                                            elif delta_type == 'input_json_delta':
                                                partial_json = getattr(delta, 'partial_json', '')
                                                if tool_uses and partial_json:
                                                    if 'partial_input' not in tool_uses[-1]:
                                                        tool_uses[-1]['partial_input'] = ''
                                                    tool_uses[-1]['partial_input'] += partial_json
                                    
                                    elif event_type == 'content_block_start':
                                        content_block = getattr(event, 'content_block', None)
                                        if content_block:
                                            active_block_type = getattr(content_block, 'type', '') or None
                                            # 디버깅: 어떤 블록이 열리는지(특히 thinking이 2턴부터 사라지는 케이스 추적)
                                            try:
                                                print(f"[ClaudeLlmClient] Turn {turn}: content_block_start={active_block_type}")
                                            except Exception:
                                                pass

                                            if active_block_type == 'tool_use':
                                                tool_id = getattr(content_block, 'id', '')
                                                tool_name = getattr(content_block, 'name', '')
                                                tu = {'id': tool_id, 'name': tool_name, 'input': {}, 'start_emitted': True}
                                                tool_uses.append(tu)
                                                
                                                # ✅ Claude는 tool_start를 "실행" 단계에서만 보내면 프론트에서 늦게 보일 수 있음.
                                                #    -> tool_use 감지 즉시 시작 이벤트를 먼저 쏜다.
                                                start_event_type = f"Tool/{tool_name}"
                                                start_payload: dict[str, Any] = {}
                                                if tool_name == "ask_to_gemini":
                                                    start_event_type = "Tool/GeminiOracle"
                                                    start_payload = {"stage": "request"}
                                                yield StreamChunk('tool_start', tool_call={
                                                    'name': tool_name,
                                                    'args': {'type': start_event_type, 'payload': start_payload}
                                                })
                                    
                                    elif event_type == 'message_delta':
                                        delta = getattr(event, 'delta', None)
                                        if delta:
                                            stop_reason = getattr(delta, 'stop_reason', None)

                            elif kind == "final":
                                final_message = payload
                            elif kind == "error":
                                raise payload
                            elif kind == "done":
                                break
                    finally:
                        try:
                            await worker_task
                        except Exception:
                            # 에러는 queue의 ("error", e)로 이미 전달됨
                            pass

                    # 스트림 종료 후 최종 메시지에서 thinking(signature)/tool_use를 추출
                    if final_message:
                        stop_reason = getattr(final_message, 'stop_reason', stop_reason)
                        content_blocks = getattr(final_message, 'content', [])
                        # 디버깅: 최종 메시지의 블록 타입들(생각 블록이 실제로 포함되는지 확인)
                        try:
                            _types = []
                            for b in content_blocks or []:
                                _types.append(getattr(b, "type", "") or "")
                            print(f"[ClaudeLlmClient] Turn {turn}: final_message block_types={_types}")
                        except Exception:
                            pass
                        for block in content_blocks:
                            block_type = getattr(block, 'type', '')
                            if block_type == 'thinking':
                                thinking_block = block
                            elif block_type == 'tool_use':
                                tool_id = getattr(block, 'id', '')
                                tool_name = getattr(block, 'name', '')
                                tool_input = getattr(block, 'input', {})
                                found = False
                                for tu in tool_uses:
                                    if tu['id'] == tool_id:
                                        tu['input'] = tool_input
                                        found = True
                                        break
                                if not found:
                                    tool_uses.append({'id': tool_id, 'name': tool_name, 'input': tool_input})
                
                except Exception as e:
                    print(f"[ClaudeLlmClient] 스트리밍 오류: {_scrub_secrets(e)}")
                    import traceback
                    traceback.print_exc()
                    yield StreamChunk('text', text=f"\n\n[오류] {_scrub_secrets(e)}")
                    return
                
                print(f"[ClaudeLlmClient] Turn {turn}: stop_reason={stop_reason}, tool_uses={len(tool_uses)}")
                
                # Tool Use가 없으면 종료
                if not tool_uses or stop_reason != 'tool_use':
                    # 대화 이력에 추가 (thinking 블록 원본 포함 - signature 필요)
                    if turn_text or thinking_block:
                        final_content = []
                        if thinking_block:
                            # thinking 블록 원본을 그대로 사용 (signature 포함)
                            try:
                                tb_dict = thinking_block.model_dump() if hasattr(thinking_block, 'model_dump') else {
                                    "type": "thinking",
                                    "thinking": getattr(thinking_block, 'thinking', thinking_text),
                                    "signature": getattr(thinking_block, 'signature', None)
                                }
                                final_content.append(tb_dict)
                            except Exception:
                                pass
                        if turn_text:
                            final_content.append({"type": "text", "text": turn_text})
                        self._conversation_history.append({
                            "role": "assistant",
                            "content": final_content if final_content else turn_text
                        })
                    break
                
                # Tool Use 실행
                tool_results = []
                for tu in tool_uses:
                    tool_name = tu['name']
                    tool_input = tu.get('input', {})
                    tool_id = tu['id']
                    
                    print(f"[ClaudeLlmClient] Tool Use: {tool_name}, input: {tool_input}")
                    
                    tool_result_content = ""
                    
                    if tool_name == 'view':
                        # view 도구 처리
                        view_result = None
                        if tools_impl and hasattr(tools_impl, "set_view_state_future"):
                            try:
                                fut = asyncio.get_running_loop().create_future()
                                tools_impl.set_view_state_future(fut)
                                yield StreamChunk('tool', tool_call={
                                    'name': 'view',
                                    'args': {},
                                    'result': {'type': 'View/RequestState', 'payload': {'message': 'request latest graph state'}}
                                })
                                view_result = await asyncio.wait_for(fut, timeout=0.6)
                            except Exception:
                                view_result = None
                            finally:
                                try:
                                    tools_impl.set_view_state_future(None)
                                except Exception:
                                    pass
                        if view_result is None:
                            view_result = tools_impl.view() if tools_impl else "그래프 상태를 가져올 수 없습니다."
                        tool_result_content = str(view_result)
                        yield StreamChunk('tool', tool_call={
                            'name': 'view',
                            'args': {},
                            'result': {'type': 'Tool/View', 'payload': {'message': 'AI가 현재 그래프 상태를 확인했습니다.'}}
                        })
                    
                    elif tool_name == 'ask_to_gemini':
                        # 🔮 Gemini 신탁 도구: 수학 계산을 Gemini에게 위임
                        question = tool_input.get('question', '')
                        print(f"[ClaudeLlmClient] 🔮 ASK_TO_GEMINI: {question[:100]}...")
                        
                        try:
                            # Gemini API 호출
                            gemini_answer = await self._ask_gemini_oracle(question)
                            tool_result_content = gemini_answer
                            print(f"[ClaudeLlmClient] 🔮 Gemini 응답: {gemini_answer[:200]}...")
                            yield StreamChunk('tool', tool_call={
                                'name': 'ask_to_gemini',
                                'args': {'question': question},
                                'result': {'type': 'Tool/GeminiOracle', 'payload': {'answer': gemini_answer[:100] + '...'}}
                            })
                        except Exception as gemini_err:
                            print(f"[ClaudeLlmClient] ❌ Gemini 오류: {gemini_err}")
                            tool_result_content = f"Gemini 호출 실패: {str(gemini_err)}"
                            yield StreamChunk('tool', tool_call={
                                'name': 'ask_to_gemini',
                                'args': {'question': question},
                                'error': str(gemini_err)
                            })
                    
                    elif tools_impl and tool_name in ('draw', 'remove', 'edit'):
                        try:
                            spec_json = tool_input.get('spec_json', '{}')
                            spec = json.loads(spec_json) if isinstance(spec_json, str) else spec_json
                            
                            if isinstance(spec, list):
                                # start_emitted가 이미 1개 올라갔으면 나머지 개수만큼만 start 이벤트를 추가로 보낸다.
                                already_started = 1 if tu.get('start_emitted') else 0
                                for item in spec[already_started:]:
                                    yield StreamChunk('tool_start', tool_call={'name': tool_name, 'args': item})
                                results = []
                                for item in spec:
                                    if tool_name == 'draw':
                                        results.append(tools_impl.draw(item))
                                    elif tool_name == 'remove':
                                        results.append(tools_impl.remove(item))
                                    else:
                                        results.append(tools_impl.edit(item))
                                
                                tool_result = {'type': 'batch', 'results': results, 'count': len(results)}
                                print(f"[ClaudeLlmClient] ✅ 배치 전송: {tool_name} -> {len(results)}개")
                                yield StreamChunk('tool', tool_call={'name': tool_name, 'args': spec, 'result': tool_result})
                                
                                # 프론트엔드 적용 결과 대기 (양방향 통신)
                                frontend_results = await self._wait_for_frontend_results(tools_impl, len(results))
                                failed = [r for r in frontend_results if not r.get('success', True)]
                                if failed:
                                    error_msgs = [r.get('error', '알 수 없는 오류') for r in failed]
                                    print(f"[ClaudeLlmClient] ❌ 프론트엔드 적용 실패: {error_msgs}")
                                    tool_result_content = json.dumps({"status": "error", "error": str(error_msgs)}, ensure_ascii=False)
                                    yield StreamChunk('tool', tool_call={'name': tool_name, 'args': spec, 'frontend_error': error_msgs})
                                else:
                                    success_msgs = [r.get('message', '') for r in frontend_results if r.get('message')]
                                    tool_result_content = json.dumps({**tool_result, "status": "success", "frontend_messages": success_msgs}, ensure_ascii=False)
                                    print(f"[ClaudeLlmClient] ✅ 프론트엔드 적용 성공: {len(frontend_results)}개")
                            else:
                                # tool_start 이벤트 (아직 안 보냈을 때만)
                                if not tu.get('start_emitted'):
                                    yield StreamChunk('tool_start', tool_call={'name': tool_name, 'args': spec})
                                if tool_name == 'draw':
                                    tool_result = tools_impl.draw(spec)
                                elif tool_name == 'remove':
                                    tool_result = tools_impl.remove(spec)
                                else:
                                    tool_result = tools_impl.edit(spec)
                                print(f"[ClaudeLlmClient] ✅ 전송: {tool_name} -> {tool_result.get('type', 'unknown') if isinstance(tool_result, dict) else 'string'}")
                                yield StreamChunk('tool', tool_call={'name': tool_name, 'args': spec, 'result': tool_result})
                                
                                # 프론트엔드 적용 결과 대기 (양방향 통신)
                                frontend_results = await self._wait_for_frontend_results(tools_impl, 1)
                                if frontend_results and len(frontend_results) > 0:
                                    fr = frontend_results[0]
                                    if not fr.get('success', True):
                                        error_msg = fr.get('error', '알 수 없는 오류')
                                        print(f"[ClaudeLlmClient] ❌ 프론트엔드 적용 실패: {error_msg}")
                                        tool_result_content = json.dumps({"status": "error", "error": error_msg}, ensure_ascii=False)
                                        yield StreamChunk('tool', tool_call={'name': tool_name, 'args': spec, 'frontend_error': error_msg})
                                    else:
                                        tool_result_content = json.dumps({**(tool_result if isinstance(tool_result, dict) else {"result": tool_result}), "status": "success", "frontend_message": fr.get('message', '')}, ensure_ascii=False)
                                        print(f"[ClaudeLlmClient] ✅ 프론트엔드 적용 성공: {fr.get('message', '')}")
                                else:
                                    # 타임아웃 - 결과 없음
                                    tool_result_content = json.dumps(tool_result, ensure_ascii=False) if isinstance(tool_result, dict) else str(tool_result)
                        except Exception as tool_err:
                            print(f"[ClaudeLlmClient] ❌ 도구 실행 오류: {tool_err}")
                            import traceback
                            traceback.print_exc()
                            tool_result_content = json.dumps({"error": str(tool_err)}, ensure_ascii=False)
                            yield StreamChunk('tool', tool_call={'name': tool_name, 'args': tool_input, 'error': str(tool_err)})
                    
                    elif tools_impl and tool_name == 'set_custom_axis_range':
                        try:
                            spec_json = tool_input.get('spec_json', '{}')
                            spec = json.loads(spec_json) if isinstance(spec_json, str) else spec_json
                            
                            tool_result = tools_impl.set_custom_axis_range(spec)
                            print(f"[ClaudeLlmClient] ✅ 전송: set_custom_axis_range -> {tool_result.get('type', 'unknown') if isinstance(tool_result, dict) else 'string'}")
                            yield StreamChunk('tool', tool_call={'name': tool_name, 'args': spec, 'result': tool_result})
                            
                            # 프론트엔드 적용 결과 대기
                            frontend_results = await self._wait_for_frontend_results(tools_impl, 1)
                            if frontend_results and len(frontend_results) > 0:
                                fr = frontend_results[0]
                                if not fr.get('success', True):
                                    error_msg = fr.get('error', '알 수 없는 오류')
                                    print(f"[ClaudeLlmClient] ❌ 프론트엔드 적용 실패: {error_msg}")
                                    tool_result_content = json.dumps({"status": "error", "error": error_msg}, ensure_ascii=False)
                                else:
                                    tool_result_content = json.dumps({**(tool_result if isinstance(tool_result, dict) else {"result": tool_result}), "status": "success"}, ensure_ascii=False)
                                    print(f"[ClaudeLlmClient] ✅ 프론트엔드 적용 성공: {fr.get('message', '')}")
                            else:
                                tool_result_content = json.dumps(tool_result, ensure_ascii=False) if isinstance(tool_result, dict) else str(tool_result)
                        except Exception as tool_err:
                            print(f"[ClaudeLlmClient] ❌ set_custom_axis_range 오류: {tool_err}")
                            import traceback
                            traceback.print_exc()
                            tool_result_content = json.dumps({"error": str(tool_err)}, ensure_ascii=False)
                            yield StreamChunk('tool', tool_call={'name': tool_name, 'args': tool_input, 'error': str(tool_err)})
                    
                    # fit_to_screen 도구 처리
                    elif tools_impl and tool_name == 'fit_to_screen':
                        try:
                            tool_result = tools_impl.fit_to_screen()
                            print(f"[ClaudeLlmClient] ✅ 전송: fit_to_screen")
                            yield StreamChunk('tool', tool_call={'name': tool_name, 'args': {}, 'result': tool_result})
                            
                            tool_result_content = json.dumps({"status": "success", "message": "화면 맞춤 완료"}, ensure_ascii=False)
                        except Exception as tool_err:
                            print(f"[ClaudeLlmClient] ❌ fit_to_screen 오류: {tool_err}")
                            tool_result_content = json.dumps({"error": str(tool_err)}, ensure_ascii=False)
                            yield StreamChunk('tool', tool_call={'name': tool_name, 'args': {}, 'error': str(tool_err)})
                    
                    else:
                        tool_result_content = json.dumps({"error": f"Unknown tool: {tool_name}"}, ensure_ascii=False)
                    
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tool_id,
                        "content": tool_result_content
                    })
                
                # 대화 이력에 assistant 응답 추가 (thinking 블록 원본 포함 - signature 필요!)
                assistant_content = []
                # Extended Thinking: thinking 블록이 먼저 와야 함 (signature 포함)
                if thinking_block:
                    try:
                        tb_dict = thinking_block.model_dump() if hasattr(thinking_block, 'model_dump') else {
                            "type": "thinking",
                            "thinking": getattr(thinking_block, 'thinking', thinking_text),
                            "signature": getattr(thinking_block, 'signature', None)
                        }
                        assistant_content.append(tb_dict)
                    except Exception:
                        pass
                if turn_text:
                    assistant_content.append({"type": "text", "text": turn_text})
                for tu in tool_uses:
                    assistant_content.append({
                        "type": "tool_use",
                        "id": tu['id'],
                        "name": tu['name'],
                        "input": tu.get('input', {})
                    })
                claude_messages.append({"role": "assistant", "content": assistant_content})
                self._conversation_history.append({"role": "assistant", "content": assistant_content})
                
                # tool_result를 user 메시지로 추가
                claude_messages.append({"role": "user", "content": tool_results})
                self._conversation_history.append({"role": "user", "content": tool_results})
                
                # 그래프 상태 업데이트 대기
                await asyncio.sleep(0.25)
            
            # ========== Tool Use 루프 종료 ==========
            
            if turn >= MAX_TURNS:
                print(f"[ClaudeLlmClient] ⚠️ 최대 턴 수({MAX_TURNS}) 도달 - 강제 종료")
                yield StreamChunk('text', text="\n\n[최대 처리 단계에 도달했습니다]")
            
            # 이력이 너무 길어지면 오래된 것 제거
            if len(self._conversation_history) > 40:
                self._conversation_history = self._conversation_history[-40:]
            
            print(f"[ClaudeLlmClient] Tool Use 완료 (총 {turn}턴, 이력: {len(self._conversation_history)})")


def _scrub_secrets(x: Any) -> str:
    """
    서버 로그/에러에서 API 키가 노출되지 않도록 문자열을 마스킹.
    - OpenAI: sk-...
    - Gemini: AIza...
    - Claude: sk-ant-...
    - JSON/딕셔너리 key: apiKey, geminiApiKey, claudeApiKey
    """
    try:
        s = str(x)
    except Exception:
        return "[unprintable]"
    # common API key patterns
    s = re.sub(r"\bsk-ant-[A-Za-z0-9_\-]{10,}\b", "sk-ant-***REDACTED***", s)
    s = re.sub(r"\bsk-[A-Za-z0-9]{10,}\b", "sk-***REDACTED***", s)
    s = re.sub(r"\bAIza[0-9A-Za-z_\-]{10,}\b", "AIza***REDACTED***", s)
    # JSON-style fields
    s = re.sub(r'("apiKey"\s*:\s*")[^"]+(")', r'\1***REDACTED***\2', s)
    s = re.sub(r'("geminiApiKey"\s*:\s*")[^"]+(")', r'\1***REDACTED***\2', s)
    s = re.sub(r'("claudeApiKey"\s*:\s*")[^"]+(")', r'\1***REDACTED***\2', s)
    return s


@dataclass
class _GeminiCacheEntry:
    client: GeminiLlmClient
    last_used_ts: float


# Gemini 클라이언트 캐시
# - GPT(OpenAI)에서 thread_id는 "대화 스레드" 식별자이며 모델과 독립적이다.
# - Gemini도 동일한 UX/세션 의미를 가지도록 캐시는 thread_id 단위로만 관리하고,
#   모델이 바뀌면 같은 client에서 model만 업데이트해 대화 연속성을 유지한다.
# - 또한 캐시가 무한정 커지지 않도록 TTL/LRU 적용
_GEMINI_CACHE_MAX = int(os.getenv("GEMINI_CLIENT_CACHE_MAX", "200"))
_GEMINI_CACHE_TTL_SEC = int(os.getenv("GEMINI_CLIENT_CACHE_TTL_SEC", "3600"))
_gemini_clients: "OrderedDict[str, _GeminiCacheEntry]" = OrderedDict()


def _gemini_cache_prune(now: float) -> None:
    # TTL 만료 제거
    if _GEMINI_CACHE_TTL_SEC > 0:
        expired = [k for k, v in _gemini_clients.items() if (now - v.last_used_ts) > _GEMINI_CACHE_TTL_SEC]
        for k in expired:
            try:
                del _gemini_clients[k]
            except KeyError:
                pass
    # LRU 초과 제거
    if _GEMINI_CACHE_MAX > 0:
        while len(_gemini_clients) > _GEMINI_CACHE_MAX:
            _gemini_clients.popitem(last=False)


def _gemini_cache_get(key: str) -> Optional[GeminiLlmClient]:
    now = time.time()
    entry = _gemini_clients.get(key)
    if not entry:
        _gemini_cache_prune(now)
        return None
    if _GEMINI_CACHE_TTL_SEC > 0 and (now - entry.last_used_ts) > _GEMINI_CACHE_TTL_SEC:
        try:
            del _gemini_clients[key]
        except KeyError:
            pass
        _gemini_cache_prune(now)
        return None
    entry.last_used_ts = now
    _gemini_clients.move_to_end(key)
    _gemini_cache_prune(now)
    return entry.client


def _gemini_cache_put(key: str, client: GeminiLlmClient) -> None:
    now = time.time()
    _gemini_clients[key] = _GeminiCacheEntry(client=client, last_used_ts=now)
    _gemini_clients.move_to_end(key)
    _gemini_cache_prune(now)

def drop_gemini_client(thread_id: str | None) -> bool:
    """대화 초기화 등에서 특정 thread_id의 Gemini client를 캐시에서 제거."""
    if not thread_id:
        return False
    try:
        if thread_id in _gemini_clients:
            del _gemini_clients[thread_id]
            return True
    except Exception:
        return False
    return False


# Claude 클라이언트 캐시
@dataclass
class _ClaudeCacheEntry:
    client: ClaudeLlmClient
    last_used_ts: float


_CLAUDE_CACHE_MAX = int(os.getenv("CLAUDE_CLIENT_CACHE_MAX", "200"))
_CLAUDE_CACHE_TTL_SEC = int(os.getenv("CLAUDE_CLIENT_CACHE_TTL_SEC", "3600"))
_claude_clients: "OrderedDict[str, _ClaudeCacheEntry]" = OrderedDict()


def _claude_cache_prune(now: float) -> None:
    # TTL 만료 제거
    if _CLAUDE_CACHE_TTL_SEC > 0:
        expired = [k for k, v in _claude_clients.items() if (now - v.last_used_ts) > _CLAUDE_CACHE_TTL_SEC]
        for k in expired:
            try:
                del _claude_clients[k]
            except KeyError:
                pass
    # LRU 초과 제거
    if _CLAUDE_CACHE_MAX > 0:
        while len(_claude_clients) > _CLAUDE_CACHE_MAX:
            _claude_clients.popitem(last=False)


def _claude_cache_get(key: str) -> Optional[ClaudeLlmClient]:
    now = time.time()
    entry = _claude_clients.get(key)
    if not entry:
        _claude_cache_prune(now)
        return None
    if _CLAUDE_CACHE_TTL_SEC > 0 and (now - entry.last_used_ts) > _CLAUDE_CACHE_TTL_SEC:
        try:
            del _claude_clients[key]
        except KeyError:
            pass
        _claude_cache_prune(now)
        return None
    entry.last_used_ts = now
    _claude_clients.move_to_end(key)
    _claude_cache_prune(now)
    return entry.client


def _claude_cache_put(key: str, client: ClaudeLlmClient) -> None:
    now = time.time()
    _claude_clients[key] = _ClaudeCacheEntry(client=client, last_used_ts=now)
    _claude_clients.move_to_end(key)
    _claude_cache_prune(now)


def drop_claude_client(thread_id: str | None) -> bool:
    """대화 초기화 등에서 특정 thread_id의 Claude client를 캐시에서 제거."""
    if not thread_id:
        return False
    try:
        if thread_id in _claude_clients:
            del _claude_clients[thread_id]
            return True
    except Exception:
        return False
    return False


def create_llm_client(
    model: str | None = None,
    thread_id: str | None = None,
    response_id: str | None = None,
    api_key: str | None = None,
    gemini_api_key: str | None = None,
    claude_api_key: str | None = None,
):
    """
    모델에 따라 적절한 LLM 클라이언트를 생성합니다.
    
    """
    # 기본 모델 설정
    if not model:
        import os
        model = os.getenv('OPENAI_MODEL', 'gemini-3-flash-preview')
        
    if model in GEMINI_MODELS:
        # Gemini 캐시는 thread_id 단위로만 관리 (모델과 독립적으로 대화 연속성 유지)
        if thread_id:
            cached = _gemini_cache_get(thread_id)
            if cached:
                # 같은 thread에서 모델이 바뀌었으면 client.model만 업데이트
                if getattr(cached, "model", None) != model:
                    print(f"[create_llm_client] Gemini 모델 업데이트: {getattr(cached,'model',None)} -> {model} (thread={thread_id})")
                    cached.model = model
                print(f"[create_llm_client] Gemini 클라이언트 재사용: {cached.thread_id}")
                return cached
            client = GeminiLlmClient(model=model, thread_id=thread_id, api_key=gemini_api_key)
            _gemini_cache_put(thread_id, client)
            print(f"[create_llm_client] 새 Gemini 클라이언트 생성(지정 thread): {client.thread_id}")
            return client

        # thread_id가 없으면 새로 만들고, 생성된 thread_id로 캐시
        client = GeminiLlmClient(model=model, thread_id=None, api_key=gemini_api_key)
        _gemini_cache_put(client.thread_id, client)
        print(f"[create_llm_client] 새 Gemini 클라이언트 생성(자동 thread): {client.thread_id}")
        return client
    
    elif model in CLAUDE_MODELS:
        # Claude 캐시는 thread_id 단위로만 관리
        if thread_id:
            cached = _claude_cache_get(thread_id)
            if cached:
                if getattr(cached, "model", None) != model:
                    print(f"[create_llm_client] Claude 모델 업데이트: {getattr(cached,'model',None)} -> {model} (thread={thread_id})")
                    cached.model = model
                # Gemini 키가 업데이트되었으면 반영
                if gemini_api_key and getattr(cached, "_gemini_key", None) != gemini_api_key:
                    cached._gemini_key = gemini_api_key
                print(f"[create_llm_client] Claude 클라이언트 재사용: {cached.thread_id}")
                return cached
            client = ClaudeLlmClient(model=model, thread_id=thread_id, api_key=claude_api_key, gemini_key=gemini_api_key)
            _claude_cache_put(thread_id, client)
            print(f"[create_llm_client] 새 Claude 클라이언트 생성(지정 thread): {client.thread_id}")
            return client

        client = ClaudeLlmClient(model=model, thread_id=None, api_key=claude_api_key, gemini_key=gemini_api_key)
        _claude_cache_put(client.thread_id, client)
        print(f"[create_llm_client] 새 Claude 클라이언트 생성(자동 thread): {client.thread_id}")
        return client
    
    else:
        return LlmClient(model=model, thread_id=thread_id, response_id=response_id, api_key=api_key)
