from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import asyncio
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
from .agent import Tools, AgentLoop
import os
from pathlib import Path
import sys

# Windows 콘솔(cp949 등)에서 이모지/특수문자 출력 시 UnicodeEncodeError가 날 수 있어
# stdout/stderr를 UTF-8로 재설정 시도 (실패해도 무시)
try:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 프론트엔드 dist 경로 확인 (먼저 정의해야 다른 설정에서 사용 가능)
FRONTEND_DIST = Path(__file__).parent.parent.parent / "frontend" / "dist"
IS_DEV = not FRONTEND_DIST.exists()

print(f"[Startup] IS_DEV={IS_DEV} (dist exists: {FRONTEND_DIST.exists()})")

# 운영 보안: 공격면 축소 옵션들
# - 문서(/docs, /redoc, /openapi.json)는 운영에서 꺼두는 것을 권장
# - 개발 모드에서는 항상 문서 활성화
disable_docs = (not IS_DEV) and os.getenv("DISABLE_API_DOCS", "").strip().lower() in ("1", "true", "yes", "y", "on")
app = FastAPI(
    title="AlphaStudio Backend",
    docs_url=None if disable_docs else "/docs",
    redoc_url=None if disable_docs else "/redoc",
    openapi_url=None if disable_docs else "/openapi.json",
)

# (선택) Host 헤더 allowlist (Host header 공격/오픈 리다이렉트류 방지)
# 예: ALLOWED_HOSTS=alpha.example.com,localhost,127.0.0.1
# 개발 모드에서는 이 검사를 건너뜀
allowed_hosts_env = os.getenv("ALLOWED_HOSTS", "").strip()
if allowed_hosts_env and not IS_DEV:
    allowed_hosts = [h.strip() for h in allowed_hosts_env.split(",") if h.strip()]
    # starlette는 와일드카드도 지원하지만 운영에서는 구체 호스트 권장
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)
elif IS_DEV:
    print("[Startup] DEV MODE: TrustedHostMiddleware 비활성화")

# CORS 설정
# 개발 모드에서는 모든 오리진 허용
cors_origins_env = os.getenv("CORS_ORIGINS", "*")
cors_allow_credentials_env = os.getenv("CORS_ALLOW_CREDENTIALS")

if IS_DEV:
    # 개발 모드: 모든 오리진 허용
    cors_origins = ["*"]
    cors_allow_credentials = False
    print("[Startup] DEV MODE: CORS 모든 오리진 허용")
elif cors_origins_env == "*":
    cors_origins = ["*"]
    # 보안 기본값: 모든 오리진 허용 시 쿠키/인증정보 허용은 위험 (또한 CORS 스펙상 '*' + credentials는 부적절)
    cors_allow_credentials = False
else:
    cors_origins = [origin.strip() for origin in cors_origins_env.split(",")]
    cors_allow_credentials = True

# 명시적으로 오버라이드 가능 (예: 로컬 개발에서만 true)
if cors_allow_credentials_env is not None:
    cors_allow_credentials = cors_allow_credentials_env.strip().lower() in ("1", "true", "yes", "y", "on")

print(f"[CORS] Allowed origins: {cors_origins}")
print(f"[CORS] allow_credentials: {cors_allow_credentials}")

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=cors_allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 프론트엔드 정적 파일 서빙
FRONTEND_PUBLIC = Path(__file__).parent.parent.parent / "frontend" / "public"

if FRONTEND_DIST.exists():
    # 프로덕션 모드: dist 폴더 서빙
    print(f"[Startup] Serving frontend from: {FRONTEND_DIST}")
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")
elif FRONTEND_PUBLIC.exists():
    # 개발 모드: public 폴더 서빙 (이미지, 폰트 등)
    print(f"[Startup] Serving public assets from: {FRONTEND_PUBLIC}")
    
    @app.get("/{filename}")
    async def serve_public_files(filename: str):
        """개발 모드에서 public 폴더의 파일 제공"""
        # 보안: path traversal 차단 (예: ../../Windows/system.ini)
        # - filename은 단일 파일명만 허용 (슬래시/역슬래시 불가)
        # - resolve 후 FRONTEND_PUBLIC 내부인지 확인
        if not filename or any(sep in filename for sep in ("/", "\\", "\x00")):
            from fastapi import HTTPException
            raise HTTPException(status_code=404)
        try:
            base = FRONTEND_PUBLIC.resolve()
            file_path = (FRONTEND_PUBLIC / filename).resolve()
        except Exception:
            from fastapi import HTTPException
            raise HTTPException(status_code=404)
        if not str(file_path).startswith(str(base)):
            from fastapi import HTTPException
            raise HTTPException(status_code=404)
        if file_path.exists() and file_path.is_file():
            return FileResponse(str(file_path))
        
        from fastapi import HTTPException
        raise HTTPException(status_code=404)

def create_agent_instance():
    """각 WebSocket 연결마다 독립적인 Agent 인스턴스를 생성"""
    tools = Tools()
    agent = AgentLoop(tools)
    print(f"[WS] New agent instance created. Thread ID: {agent._thread_id}")
    return agent


class Vec2(BaseModel):
    x: float
    y: float


class IntersectionsRequest(BaseModel):
    segments: List[Dict[str, Any]]
    tolerance: float | None = 1e-6


@app.get("/health")
def health():
    return {"ok": True}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    # (옵션) WSS/HTTPS 강제: 운영에서 평문 WS를 막아 전송 중 키 탈취 위험을 줄임
    # - 개발 모드에서는 항상 OFF (env 설정 무시)
    # - 운영 모드에서는 env 설정 또는 기본값(true) 적용
    if IS_DEV:
        require_secure = False
    else:
        require_secure_env = os.getenv("REQUIRE_SECURE_WS")
        if require_secure_env is None or require_secure_env.strip() == "":
            # 운영(프론트 dist 서빙)에서는 기본적으로 secure를 강제 (리버스 프록시 뒤에서는 X-Forwarded-Proto로 판별)
            require_secure = True
        else:
            require_secure = require_secure_env.strip().lower() in ("1", "true", "yes", "y", "on")
    if require_secure:
        # FastAPI 내부 scheme은 리버스 프록시 뒤에서 ws로 보일 수 있으니 X-Forwarded-Proto도 확인
        xf_proto = None
        try:
            xf_proto = ws.headers.get("x-forwarded-proto") if hasattr(ws, "headers") else None
        except Exception:
            xf_proto = None
        scheme = None
        try:
            scheme = ws.url.scheme  # 'ws' or 'wss' (환경에 따라)
        except Exception:
            scheme = None
        is_secure = (scheme == "wss") or (xf_proto == "https")
        if not is_secure:
            try:
                await ws.close(code=4403)
            finally:
                return

    # (선택) WebSocket 인증 토큰: 설정되면 토큰 없이는 연결을 거부
    # - 개발 모드에서는 토큰 검사 건너뜀
    if not IS_DEV:
        expected = os.getenv("WS_AUTH_TOKEN")
        if expected:
            token = None
            try:
                token = ws.query_params.get("token")
            except Exception:
                token = None
            if not token:
                auth = ws.headers.get("authorization") if hasattr(ws, "headers") else None
                if auth and isinstance(auth, str) and auth.lower().startswith("bearer "):
                    token = auth[7:].strip()
            if token != expected:
                try:
                    await ws.close(code=4401)
                finally:
                    return

    # (선택) Origin allowlist 검사 (CSWSH 방지)
    # - 브라우저에서 오는 WebSocket은 Origin 헤더를 보냅니다.
    # - 운영에서는 프론트 도메인만 허용하는 것을 권장합니다.
    # - 개발 모드에서는 이 검사를 건너뜁니다.
    # 설정 예:
    #   WS_ALLOWED_ORIGINS=https://alpha.example.com,https://www.alpha.example.com
    if not IS_DEV:
        allowed_origins_env = os.getenv("WS_ALLOWED_ORIGINS", "").strip()
        allowed: List[str] = []
        if allowed_origins_env:
            allowed = [o.strip() for o in allowed_origins_env.split(",") if o.strip()]
        else:
            # 운영에서 WS_ALLOWED_ORIGINS를 깜빡하면 CSWSH/남용에 취약해질 수 있어,
            # CORS_ORIGINS가 명시된 경우(그리고 "*"가 아닌 경우) 그 값을 WS allowlist로 재사용합니다.
            if isinstance(cors_origins, list) and cors_origins and cors_origins != ["*"]:
                allowed = list(cors_origins)
        if allowed:
            origin = None
            try:
                origin = ws.headers.get("origin") if hasattr(ws, "headers") else None
            except Exception:
                origin = None
            # Origin 없는 클라이언트(서버-서버 등)는 기본적으로 거부하지 않음.
            # 브라우저에서만 공격이 현실적이므로, origin이 있는 경우에만 강제.
            if origin and origin not in allowed:
                try:
                    await ws.close(code=4403)  # forbidden
                finally:
                    return

    # (선택) 메시지 크기 제한(DoS 방지). 기본 2MB.
    # FastAPI의 receive_json은 내부에서 텍스트를 받아 파싱하므로, 크기 제한을 하려면 receive_text로 선검사하는 편이 안전합니다.
    try:
        MAX_WS_MSG_BYTES = int(os.getenv("WS_MAX_MSG_BYTES", "2097152"))
    except Exception:
        MAX_WS_MSG_BYTES = 2097152

    # (선택) 이미지/그래프 상태 제한 (DoS 방지)
    try:
        MAX_IMAGES = int(os.getenv("WS_MAX_IMAGES", "2"))
    except Exception:
        MAX_IMAGES = 2
    try:
        MAX_IMAGE_B64_CHARS = int(os.getenv("WS_MAX_IMAGE_B64_CHARS", "20000000"))  # ~15MB binary
    except Exception:
        MAX_IMAGE_B64_CHARS = 20000000
    try:
        MAX_GRAPH_NODES = int(os.getenv("WS_MAX_GRAPH_NODES", "5000"))
    except Exception:
        MAX_GRAPH_NODES = 5000

    await ws.accept()
    print("[WS] Client connected")
    
    # 각 WebSocket 연결마다 독립적인 Agent 인스턴스 생성 (사용자별 격리)
    agent = create_agent_instance()
    print(f"[WS] Agent ready. Thread ID: {agent._thread_id}, History: {len(agent.conversation_history)} messages")
    
    # 현재 실행 중인 스트림 태스크 추적
    current_stream_task = None
    current_stream_request_id: Optional[str] = None
    # 같은 WebSocket 연결에서 Chat 요청이 겹치면(더블클릭/연타/네트워크 재전송)
    # Agent 상태(conversation_history/thread_id)가 경합하며 섞일 수 있으므로 직렬화
    chat_lock = asyncio.Lock()
    
    # 도구 적용 결과를 받기 위한 큐 (프론트엔드 → 백엔드 → LLM)
    action_result_queue: asyncio.Queue = asyncio.Queue()
    
    # WebSocket 연결 시 현재 thread ID 전송
    if agent._thread_id:
        await ws.send_json({
            "type": "Agent/Session.Init",
            "payload": {"threadId": agent._thread_id}
        })
    
    try:
        while True:
            # 크기 제한을 위해 text로 받은 뒤 JSON 파싱
            raw = await ws.receive_text()
            if isinstance(raw, str) and len(raw.encode("utf-8", errors="ignore")) > MAX_WS_MSG_BYTES:
                try:
                    await ws.close(code=1009)  # Message Too Big
                finally:
                    return
            try:
                import json
                msg = json.loads(raw) if isinstance(raw, str) else {}
            except Exception:
                # invalid json
                try:
                    await ws.close(code=1003)  # Unsupported Data
                finally:
                    return
            t = msg.get("type")
            rid = msg.get("requestId")
            print(f"[WS] Received: type={t}, requestId={rid}")
            
            if t == "Compute/Intersections.Request":
                payload = msg.get("payload", {})
                segs = payload.get("segments", [])
                await ws.send_json({
                    "type": "Compute/Intersections.Result",
                    "requestId": rid,
                    "payload": {"points": [], "diagnostics": {"note": "stub"}},
                })
            
            elif t == "Agent/Chat.Request":
                async with chat_lock:
                    # LLM 스트리밍 요청 with session management
                    pld = msg.get("payload", {})
                    text = pld.get("text", "")
                    system = pld.get("system")
                    history = pld.get("history")
                    session_id = pld.get("sessionId")  # 클라이언트가 보낸 session ID
                    response_id = pld.get("responseId")  # 클라이언트가 보낸 response ID
                    graph_state = pld.get("graphState")  # 클라이언트가 보낸 그래프 상태
                    images = pld.get("images")  # 클라이언트가 보낸 이미지들
                    model = pld.get("model")  # 클라이언트가 선택한 모델
                    api_key = pld.get("apiKey")  # 사용자별 OpenAI API Key (옵션)
                    gemini_api_key = pld.get("geminiApiKey")  # 사용자별 Gemini API Key (옵션)
                    claude_api_key = pld.get("claudeApiKey")  # 사용자별 Claude API Key (옵션)

                    # --- 입력 제한(DoS 방지) ---
                    try:
                        if graph_state and isinstance(graph_state, dict):
                            nodes = graph_state.get("nodes", {})
                            if isinstance(nodes, dict) and len(nodes) > MAX_GRAPH_NODES:
                                await ws.send_json({
                                    "type": "Agent/Action.Error",
                                    "requestId": rid,
                                    "payload": {"error": f"graphState too large (nodes={len(nodes)} > {MAX_GRAPH_NODES})"}
                                })
                                continue
                        if images:
                            if not isinstance(images, list):
                                images = None
                            else:
                                if len(images) > MAX_IMAGES:
                                    await ws.send_json({
                                        "type": "Agent/Action.Error",
                                        "requestId": rid,
                                        "payload": {"error": f"too many images ({len(images)} > {MAX_IMAGES})"}
                                    })
                                    continue
                                for img in images:
                                    if not isinstance(img, dict):
                                        await ws.send_json({
                                            "type": "Agent/Action.Error",
                                            "requestId": rid,
                                            "payload": {"error": "invalid image payload"}
                                        })
                                        raise ValueError("invalid image payload")
                                    b64 = img.get("base64", "")
                                    if isinstance(b64, str) and len(b64) > MAX_IMAGE_B64_CHARS:
                                        await ws.send_json({
                                            "type": "Agent/Action.Error",
                                            "requestId": rid,
                                            "payload": {"error": f"image too large (base64 chars={len(b64)} > {MAX_IMAGE_B64_CHARS})"}
                                        })
                                        raise ValueError("image too large")
                    except Exception:
                        # already responded with error
                        continue

                    # 이미 스트림이 돌고 있는데 새 Chat 요청이 오면, 기존 스트림을 먼저 확실히 종료(Aborted 송신)하고 시작
                    if current_stream_task and not current_stream_task.done():
                        print(f"[Agent/Chat] New chat arrived while streaming. Cancelling previous stream requestId={current_stream_request_id}")
                        current_stream_task.cancel()
                        try:
                            # 중요: 프론트는 Aborted/End를 받으면 currentStreamRequestId를 null로 지우므로
                            # 새 Stream.Start를 보내기 전에 반드시 이전 task 종료를 기다려야 requestId가 꼬이지 않음.
                            await asyncio.wait_for(asyncio.shield(current_stream_task), timeout=2.0)
                        except (asyncio.CancelledError, asyncio.TimeoutError):
                            pass
                        except Exception as e:
                            print(f"[Agent/Chat] Previous stream cancel wait error: {e}")
                        current_stream_task = None
                        current_stream_request_id = None

                    # Avoid logging user content (prompts can contain personal data).
                    # Log only metadata needed for debugging/operations.
                    print(
                        f"[Agent/Chat] textLen={len(text) if isinstance(text, str) else 0}, model={model}, sessionId={session_id}, responseId={response_id}, "
                        f"graphNodes={len(graph_state.get('nodes', {})) if graph_state else 0}, images={len(images) if images else 0}, "
                        f"hasApiKey={bool(api_key)}, hasGeminiKey={bool(gemini_api_key)}, hasClaudeKey={bool(claude_api_key)}"
                    )
                    
                    # 도구 적용 결과 큐를 tools에 설정
                    agent.tools.set_action_result_queue(action_result_queue)
                    
                    await ws.send_json({"type": "Agent/Stream.Start", "requestId": rid})

                    async def stream_task(request_id: str):
                        cancelled = False
                        try:
                            if hasattr(agent, 'run_chat_stream'):
                                async for out in agent.run_chat_stream(
                                    text,
                                    system_prompt=system,
                                    history=history,
                                    session_id=session_id,
                                    response_id=response_id,
                                    graph_state=graph_state,
                                    images=images,
                                    model=model,
                                    api_key=api_key,
                                    gemini_api_key=gemini_api_key,
                                    claude_api_key=claude_api_key,
                                ):
                                    out["requestId"] = request_id
                                    await ws.send_json(out)

                                    # Session 업데이트 로깅
                                    if out.get('type') == 'Agent/Session.Update':
                                        print(f"[Agent/Chat] Session updated: {out.get('payload')}")
                            else:
                                raise AttributeError("agent.run_chat_stream missing")

                        except asyncio.CancelledError:
                            cancelled = True
                            print(f"[Agent/Chat] Stream cancelled")
                            await ws.send_json({
                                "type": "Agent/Stream.Aborted",
                                "requestId": request_id
                            })
                            raise
                        except Exception as e:
                            print(f"[Agent/Chat] Error: {e}")
                            import traceback
                            traceback.print_exc()
                            await ws.send_json({
                                "type": "Agent/Action.Error",
                                "requestId": request_id,
                                "payload": {"error": str(e)}
                            })
                        finally:
                            if not cancelled:
                                await ws.send_json({"type": "Agent/Stream.End", "requestId": request_id})
                            print(f"[Agent/Chat] Stream ended (requestId={request_id})")

                    # 태스크 생성 (백그라운드에서 실행, await 하지 않음)
                    current_stream_request_id = rid
                    current_stream_task = asyncio.create_task(stream_task(rid))
                    print(f"[Agent/Chat] Stream task created and running in background (requestId={rid})")
            
            elif t == "Agent/Stream.Abort":
                # 스트림 중단 요청
                print(f"[Agent/Stream.Abort] ========== 중단 요청 수신 ==========")
                print(f"[Agent/Stream.Abort] requestId={rid}")
                print(f"[Agent/Stream.Abort] current_stream_task={current_stream_task}")
                print(f"[Agent/Stream.Abort] task.done()={current_stream_task.done() if current_stream_task else 'N/A'}")
                
                # requestId가 현재 스트림과 다르면 무시 (구형/중복 abort)
                if current_stream_request_id and rid and rid != current_stream_request_id:
                    print(f"[Agent/Stream.Abort] Ignored: rid={rid} != current_stream_request_id={current_stream_request_id}")
                    continue

                sent_abort = False
                if current_stream_task and not current_stream_task.done():
                    print(f"[Agent/Stream.Abort] Cancelling stream task...")
                    current_stream_task.cancel()
                    
                    # 태스크 취소 완료 대기 (최대 2초)
                    try:
                        await asyncio.wait_for(asyncio.shield(current_stream_task), timeout=2.0)
                        # stream_task가 CancelledError를 처리하며 Agent/Stream.Aborted를 보냄
                        sent_abort = True
                    except (asyncio.CancelledError, asyncio.TimeoutError):
                        # timeout이면 task가 Aborted를 못 보냈을 수 있으니 아래에서 서버가 직접 보냄
                        sent_abort = False
                    except Exception as e:
                        print(f"[Agent/Stream.Abort] Task wait error: {e}")
                    
                    print(f"[Agent/Stream.Abort] Stream task cancelled")
                else:
                    print(f"[Agent/Stream.Abort] No active task to cancel")
                
                # task가 Aborted를 못 보냈거나, 애초에 task가 없으면 서버가 직접 Aborted 전송
                if not sent_abort:
                    await ws.send_json({
                        "type": "Agent/Stream.Aborted",
                        "requestId": rid
                    })
                    print(f"[Agent/Stream.Abort] Sent Aborted response")
                current_stream_task = None
                current_stream_request_id = None
            
            elif t == "Agent/Session.Get":
                # 현재 세션 정보 요청
                await ws.send_json({
                    "type": "Agent/Session.Info",
                    "requestId": rid,
                    "payload": {
                        "threadId": agent._thread_id,
                        "historyLength": len(agent.conversation_history)
                    }
                })
            
            elif t == "Agent/Session.Clear":
                # 대화 이력 초기화
                print(f"[Agent/Session] Clearing history. Current: {len(agent.conversation_history)} messages")
                # Gemini/Claude는 서버가 대화 이력을 메모리 캐시에 들고 있으므로,
                # "대화 초기화" 시 해당 thread 캐시도 같이 제거해 GPT와 동일한 의미로 맞춘다.
                old_thread_id = agent._thread_id
                try:
                    from .llm import drop_gemini_client, drop_claude_client
                    if drop_gemini_client(old_thread_id):
                        print(f"[Agent/Session] Dropped Gemini cached client for thread={old_thread_id}")
                    if drop_claude_client(old_thread_id):
                        print(f"[Agent/Session] Dropped Claude cached client for thread={old_thread_id}")
                except Exception:
                    pass
                agent.conversation_history = []
                agent._thread_id = None
                agent._previous_response_id = None
                agent.memory_summary = ""
                print(f"[Agent/Session] History cleared")
                await ws.send_json({
                    "type": "Agent/Session.Cleared",
                    "requestId": rid,
                    "payload": {"success": True}
                })
            
            elif t == "Agent/GraphState.Response":
                # 프론트엔드에서 최신 그래프 상태 응답 (view 도구용)
                pld = msg.get("payload", {})
                graph_state = pld.get("graphState")
                
                if graph_state:
                    # 그래프 상태 포맷팅
                    from .prompt import format_graph_state
                    formatted_state = format_graph_state(graph_state)
                    
                    print(f"[Agent/GraphState] 최신 상태 수신: {len(graph_state.get('nodes', {}))}개 노드")
                    
                    # Tools 인스턴스의 graph_state 업데이트
                    agent.tools.set_graph_state(graph_state)
                    
                    # Future가 대기 중이면 결과 설정
                    if agent.tools._view_state_future and not agent.tools._view_state_future.done():
                        agent.tools._view_state_future.set_result(formatted_state)
                        print(f"[Agent/GraphState] Future에 결과 설정 완료")
                    else:
                        print(f"[Agent/GraphState] Future 없음 또는 이미 완료됨")
                else:
                    print(f"[Agent/GraphState] 상태 없음")
            
            elif t == "Agent/Action.Applied":
                # 프론트엔드에서 도구 적용 결과 응답 (LLM에게 전달)
                pld = msg.get("payload", {})
                event_type = pld.get("eventType", "Unknown")
                event_id = pld.get("eventId")
                success = pld.get("success", False)
                message = pld.get("message")
                error = pld.get("error")
                
                result_info = {
                    "eventType": event_type,
                    "eventId": event_id,
                    "success": success,
                    "message": message,
                    "error": error,
                }
                
                if success:
                    print(f"[Agent/Action.Applied] ✅ 성공: {event_type} ({event_id}) - {message}")
                else:
                    print(f"[Agent/Action.Applied] ❌ 실패: {event_type} ({event_id}) - {error}")
                
                # 큐에 결과 추가 (LLM이 대기 중이면 받아감)
                try:
                    action_result_queue.put_nowait(result_info)
                except asyncio.QueueFull:
                    print(f"[Agent/Action.Applied] 큐가 가득 참, 결과 버림")
                
                # agent.tools에 마지막 결과 저장 (llm.py에서 참조 가능)
                agent.tools.set_last_action_result(result_info)
            
            else:
                await ws.send_json({
                    "type": "Error", 
                    "requestId": rid, 
                    "message": f"Unknown type {t}"
                })
                
    except WebSocketDisconnect:
        print(f"[WS] Client disconnected. Final thread ID: {agent._thread_id}")
        return


# 프론트엔드 SPA 라우팅 (프로덕션 모드) - Catch-all
if FRONTEND_DIST.exists():
    @app.get("/")
    async def serve_root():
        return FileResponse(str(FRONTEND_DIST / "index.html"))
    
    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        # API 엔드포인트로 시작하는 경로는 404 (라우터가 처리 못한 경우)
        if full_path.startswith(("api/", "ws", "health")):
            return {"error": "Not found"}, 404
        
        # 정적 파일이 존재하면 제공
        file_path = FRONTEND_DIST / full_path
        if file_path.exists() and file_path.is_file():
            return FileResponse(str(file_path))
        
        # 그 외 모든 경로는 SPA fallback
        return FileResponse(str(FRONTEND_DIST / "index.html"))