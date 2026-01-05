from __future__ import annotations



from typing import Any, Dict, List, Optional, Tuple, TypedDict, Literal, Union

import uuid
import os
import time

# Load .env file
try:
    from dotenv import load_dotenv, find_dotenv
    env_path = find_dotenv(usecwd=False)
    if not env_path:
        env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), '.env')
    loaded = load_dotenv(env_path)
    # 운영에서 파일 시스템 경로/환경 로드 여부를 과하게 로그로 남기지 않도록 기본은 조용히 처리
    if (os.getenv("DEBUG_ENV_LOAD", "") or "").strip().lower() in ("1", "true", "yes", "y", "on"):
        print(f"[agent.py] .env 로드: {env_path}, 성공={loaded}")
except Exception as e:
    if (os.getenv("DEBUG_ENV_LOAD", "") or "").strip().lower() in ("1", "true", "yes", "y", "on"):
        print(f"[agent.py] .env 로드 실패: {e}")





# --- Public types -----------------------------------------------------------



Vec2 = Tuple[float, float]





class DrawSegmentSpec(TypedDict, total=False):

    kind: Literal["segment"]

    id: str

    p1: Vec2

    p2: Vec2

    style: Dict[str, Any]

    extendStart: bool

    extendEnd: bool





class DrawLineSpec(TypedDict, total=False):

    kind: Literal["line"]

    id: str

    p1: Vec2

    p2: Vec2

    style: Dict[str, Any]





class DrawBezierSpec(TypedDict, total=False):

    kind: Literal["bezier"]

    id: str

    a: Vec2

    b: Vec2

    c1: Vec2

    c2: Vec2

    style: Dict[str, Any]



class DrawArrowSpec(TypedDict, total=False):

    kind: Literal["arrow"]

    id: str

    a: Vec2

    b: Vec2

    c1: Vec2

    c2: Vec2

    style: Dict[str, Any]

    showStartArrow: bool

    showEndArrow: bool

    arrowSize: float



class DrawLengthBezierSpec(TypedDict, total=False):

    kind: Literal["length-bezier"]

    id: str

    a: Vec2

    b: Vec2

    c1: Vec2

    c2: Vec2

    label: str  # LaTeX label text (자동으로 math-text 생성)

    labelIds: List[str]  # math-text label IDs (선택적, label이 제공되면 자동 추가됨)





class DrawPointSpec(TypedDict, total=False):

    kind: Literal["point"]

    id: str

    position: Vec2

    diameterMm: float

    color: str





class DrawRegionSpec(TypedDict, total=False):

    kind: Literal["filled-region"]

    id: str

    centerPoint: Vec2

    fillColor: str





class DrawFunctionSpec(TypedDict, total=False):

    kind: Literal["function"]

    id: str

    expression: str

    style: Dict[str, Any]

    domain: Tuple[float, float]  # 정의역 [xMin, xMax]





class DrawFunctionImplicitSpec(TypedDict, total=False):

    kind: Literal["function-implicit"]

    id: str

    expression: str

    style: Dict[str, Any]





class DrawMathTextSpec(TypedDict, total=False):

    kind: Literal["math-text"]

    id: str

    latex: str

    position: Vec2

    fontSize: float

    color: str





DrawSpec = Union[

    DrawSegmentSpec,

    DrawLineSpec,

    DrawBezierSpec,

    DrawArrowSpec,

    DrawLengthBezierSpec,

    DrawPointSpec,

    DrawRegionSpec,

    DrawFunctionSpec,

    DrawFunctionImplicitSpec,

    DrawMathTextSpec,

]





class RemoveByIdSpec(TypedDict):

    mode: Literal["by-id"]

    ids: List[str]





class RemoveByQuerySpec(TypedDict, total=False):

    mode: Literal["by-query"]

    kind: Optional[str]

    functionId: Optional[str]





RemoveSpec = Union[RemoveByIdSpec, RemoveByQuerySpec]





class EditSpec(TypedDict, total=False):

    id: str  # 수정할 개체의 ID (필수)

    style: Optional[Dict[str, Any]]  # 스타일 업데이트

    position: Optional[Vec2]  # 위치 업데이트 (point, math-text 등)

    p1: Optional[Vec2]  # segment, line의 시작점

    p2: Optional[Vec2]  # segment, line의 끝점

    a: Optional[Vec2]  # bezier의 시작점

    b: Optional[Vec2]  # bezier의 끝점

    c1: Optional[Vec2]  # bezier의 제어점1

    c2: Optional[Vec2]  # bezier의 제어점2

    latex: Optional[str]  # math-text의 텍스트

    fontSize: Optional[float]  # math-text의 폰트 크기

    color: Optional[str]  # 색상 (point, math-text 등)

    diameterMm: Optional[float]  # point의 지름

    fillColor: Optional[str]  # filled-region의 색상

    centerPoint: Optional[Vec2]  # filled-region의 중심점

    expression: Optional[str]  # function의 수식

    domain: Optional[Tuple[float, float]]  # function의 정의역

    extendStart: Optional[bool]  # segment의 시작점 연장

    extendEnd: Optional[bool]  # segment의 끝점 연장

    label: Optional[str]  # length-dashed의 라벨





# --- Core ------------------------------------------------------------------





def _gen_id(prefix: str) -> str:

    return f"{prefix}-{uuid.uuid4().hex[:8]}"





class Tools:

    """

    New 버전용 경량 Tools.



    - draw/remove/edit/view 도구로 다양한 도형 조작과 상태 확인을 지원.

    - 반환값은 프론트엔드가 적용할 수 있는 이벤트 형태로 표준화함.

      (프론트 WS 미연동 상태이므로 백엔드 테스트는 구조만 검증)

    """



    def __init__(self):

        self.graph_state: Optional[Dict[str, Any]] = None

        self._view_state_future: Optional[Any] = None  # asyncio.Future for view state
        
        self._last_action_result: Optional[Dict[str, Any]] = None  # 프론트엔드 도구 적용 결과
        
        self._action_result_queue: Optional[Any] = None  # asyncio.Queue for action results



    def set_graph_state(self, graph_state: Dict[str, Any]):

        """현재 그래프 상태를 저장"""

        self.graph_state = graph_state
    
    def set_last_action_result(self, result: Dict[str, Any]):
        """프론트엔드에서 받은 도구 적용 결과 저장"""
        self._last_action_result = result
    
    def get_last_action_result(self) -> Optional[Dict[str, Any]]:
        """마지막 도구 적용 결과 반환"""
        return self._last_action_result
    
    def set_action_result_queue(self, queue: Any):
        """도구 적용 결과 큐 설정"""
        self._action_result_queue = queue



    def set_view_state_future(self, future: Any):

        """view 도구가 기다릴 Future 설정"""

        self._view_state_future = future



    def view(self) -> str:

        """

        현재 그래프 상태를 반환합니다.

        AI가 현재 캔버스에 무엇이 그려져 있는지 확인할 때 사용합니다.

        

        프론트엔드는 매 액션 후 자동으로 최신 상태를 전송하므로,

        저장된 graph_state를 바로 포맷팅하여 반환합니다.

        """

        if not self.graph_state:

            return "**현재 그래프 상태:** 비어있음 (좌표축만 표시됨)"

        

        from .prompt import format_graph_state

        return format_graph_state(self.graph_state)



    def draw(self, spec: DrawSpec) -> Dict[str, Any]:

        kind = spec.get("kind")

        if kind not in {"segment", "line", "bezier", "arrow", "length-bezier", "point", "filled-region", "function", "function-implicit", "math-text"}:

            raise ValueError(f"Unsupported draw kind: {kind}")



        if "id" not in spec or not spec["id"]:

            # Assign stable-ish id with kind prefix

            new_id = _gen_id(kind or "node")

        else:

            new_id = str(spec["id"])  # preserve provided id



        # Normalization per kind (validate required fields)

        if kind in ("segment", "line"):

            p1 = spec.get("p1")

            p2 = spec.get("p2")

            if not isinstance(p1, (list, tuple)) or not isinstance(p2, (list, tuple)):

                raise ValueError("p1, p2 are required (Vec2)")

            # 스타일 정규화: color가 없으면 기본 검은색 추가
            style = spec.get("style") or {"stroke": {"color": "#000000", "width": 0.8}}
            if "stroke" in style and "color" not in style["stroke"]:
                style["stroke"]["color"] = "#000000"

            payload: Dict[str, Any] = {

                "id": new_id,

                "p1": [float(p1[0]), float(p1[1])],

                "p2": [float(p2[0]), float(p2[1])],

                "style": style,

            }

            if kind == "segment":

                payload["extendStart"] = bool(spec.get("extendStart", False))

                payload["extendEnd"] = bool(spec.get("extendEnd", False))

            # kind를 올바른 타입 이름으로 변환
            type_name = kind.capitalize() if kind != "filled-region" else "FilledRegion"
            
            return {

                "type": f"Draw/{type_name}",

                "payload": payload,

            }



        if kind == "bezier":

            a = spec.get("a"); b = spec.get("b"); c1 = spec.get("c1"); c2 = spec.get("c2")

            if not (isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)) and isinstance(c1, (list, tuple)) and isinstance(c2, (list, tuple))):

                raise ValueError("a, b, c1, c2 are required (Vec2)")

            style = spec.get("style") or {"stroke": {"color": "#000000", "width": 0.8}}

            return {

                "type": "Draw/Bezier",

                "payload": {

                    "id": new_id,

                    "a": [float(a[0]), float(a[1])],

                    "b": [float(b[0]), float(b[1])],

                    "c1": [float(c1[0]), float(c1[1])],

                    "c2": [float(c2[0]), float(c2[1])],

                    "style": style,

                },

            }



        if kind == "arrow":

            a = spec.get("a"); b = spec.get("b"); c1 = spec.get("c1"); c2 = spec.get("c2")

            if not (isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)) and isinstance(c1, (list, tuple)) and isinstance(c2, (list, tuple))):

                raise ValueError("a, b, c1, c2 are required (Vec2)")

            style = spec.get("style") or {"stroke": {"color": "#000000", "width": 0.35}}

            showStartArrow = spec.get("showStartArrow", False)

            showEndArrow = spec.get("showEndArrow", True)

            arrowSize = spec.get("arrowSize", 3.0)

            return {

                "type": "Draw/Arrow",

                "payload": {

                    "id": new_id,

                    "a": [float(a[0]), float(a[1])],

                    "b": [float(b[0]), float(b[1])],

                    "c1": [float(c1[0]), float(c1[1])],

                    "c2": [float(c2[0]), float(c2[1])],

                    "style": style,

                    "showStartArrow": showStartArrow,

                    "showEndArrow": showEndArrow,

                    "arrowSize": arrowSize,

                },

            }



        if kind == "length-bezier":

            a = spec.get("a"); b = spec.get("b"); c1 = spec.get("c1"); c2 = spec.get("c2")

            if not (isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)) and isinstance(c1, (list, tuple)) and isinstance(c2, (list, tuple))):

                raise ValueError("a, b, c1, c2 are required (Vec2)")

            # Length-bezier는 고정된 스타일 사용
            style = {"stroke": {"color": "#000000", "width": 0.35, "dash": [1.6, 0.9]}}

            # 라벨 ID 처리
            label_text = spec.get("label")
            label_ids = list(spec.get("labelIds", []))  # 기존 labelIds 복사
            label_id = None
            label_position = None
            
            if label_text:
                # 베지어 곡선 중간점 계산 (t=0.5)
                mid_x = (a[0] + 3*c1[0] + 3*c2[0] + b[0]) / 8
                mid_y = (a[1] + 3*c1[1] + 3*c2[1] + b[1]) / 8
                
                # Math-text 라벨 ID 생성
                label_id = _gen_id("math-text")
                label_ids.append(label_id)
                label_position = [mid_x, mid_y]

            payload: Dict[str, Any] = {

                "id": new_id,

                "a": [float(a[0]), float(a[1])],

                "b": [float(b[0]), float(b[1])],

                "c1": [float(c1[0]), float(c1[1])],

                "c2": [float(c2[0]), float(c2[1])],

                "style": style,

                "labelIds": label_ids,

            }
            
            # 라벨 정보 추가 (프론트엔드에서 자동 생성)
            if label_text and label_id and label_position:
                payload["labelText"] = str(label_text)
                payload["labelId"] = label_id
                payload["labelPosition"] = label_position

            return {

                "type": "Draw/LengthBezier",

                "payload": payload,

            }



        if kind == "point":

            pos = spec.get("position")

            if not isinstance(pos, (list, tuple)):

                raise ValueError("position is required (Vec2)")

            diameter = float(spec.get("diameterMm", 2.3))

            color = str(spec.get("color", "#000000"))

            stroke_color = spec.get("strokeColor")

            stroke_width = spec.get("strokeWidth")

            payload = {

                "id": new_id,

                "position": [float(pos[0]), float(pos[1])],

                "diameterMm": diameter,

                "color": color,

            }

            if stroke_color:

                payload["strokeColor"] = str(stroke_color)

            if stroke_width:

                payload["strokeWidth"] = float(stroke_width)

            return {

                "type": "Draw/Point",

                "payload": payload,

            }



        if kind == "filled-region":

            cp = spec.get("centerPoint")

            if not isinstance(cp, (list, tuple)):

                raise ValueError("centerPoint is required (Vec2)")

            fill = str(spec.get("fillColor", "rgb(230, 230, 230)"))

            return {

                "type": "Draw/FilledRegion",

                "payload": {

                    "id": new_id,

                    "centerPoint": [float(cp[0]), float(cp[1])],

                    "fillColor": fill,

                },

            }



        if kind == "function":

            expr = spec.get("expression")

            if not expr or not isinstance(expr, str):

                raise ValueError("expression is required (string)")

            # Default stroke color should match manual drawing (black)
            style = spec.get("style") or {"stroke": {"color": "#000000", "width": 0.8}}

            payload: Dict[str, Any] = {

                "id": new_id,

                "expression": str(expr),

                "style": style,

            }

            # 정의역 지정 (선택적)

            if "domain" in spec and spec["domain"]:

                domain = spec["domain"]

                if isinstance(domain, (list, tuple)) and len(domain) == 2:

                    payload["domain"] = [float(domain[0]), float(domain[1])]

            return {

                "type": "Draw/Function",

                "payload": payload,

            }



        if kind == "function-implicit":

            expr = spec.get("expression")

            if not expr or not isinstance(expr, str):

                raise ValueError("expression is required (string)")

            # Default stroke color should match manual drawing (black)
            style = spec.get("style") or {"stroke": {"color": "#000000", "width": 0.8}}

            return {

                "type": "Draw/FunctionImplicit",

                "payload": {

                    "id": new_id,

                    "expression": str(expr),

                    "style": style,

                },

            }

        
        if kind == "math-text":

            latex = spec.get("latex")

            if not latex or not isinstance(latex, str):

                raise ValueError("latex is required (string)")

            pos = spec.get("position")

            if not isinstance(pos, (list, tuple)):

                raise ValueError("position is required (Vec2)")

            # Treat fontSize as points; default to 11pt to match manual labels
            fontSize = float(spec.get("fontSize", 11))

            color = str(spec.get("color", "#000000"))

            return {

                "type": "Draw/MathText",

                "payload": {

                    "id": new_id,

                    "latex": str(latex),

                    "position": [float(pos[0]), float(pos[1])],

                    "fontSize": fontSize,

                    "color": color,

                },

            }



        # Should not reach here

        raise ValueError(f"Unsupported draw spec: {spec}")



    def remove(self, spec: RemoveSpec) -> Dict[str, Any]:

        mode = spec.get("mode")

        if mode == "by-id":

            ids = spec.get("ids", [])

            if not isinstance(ids, list) or not all(isinstance(x, str) for x in ids):

                raise ValueError("remove(by-id): 'ids' must be a list of strings")

            return {

                "type": "Remove/ById",

                "payload": {"ids": ids},

            }

        if mode == "by-query":

            query: Dict[str, Any] = {}

            # 안전장치:
            # - by-query는 매우 광범위한 삭제가 될 수 있어, 함수 세그먼트 정리(특정 functionId) 용도로만 허용한다.
            # - clear-all(필터 없는 by-query)은 금지한다.
            kind = spec.get("kind")
            function_id = spec.get("functionId")

            if not kind and not function_id:
                raise ValueError(
                    "remove(by-query): 필터 없는 삭제(clear-all)는 금지됩니다. "
                    "삭제할 개체의 ID 목록을 사용해 remove(by-id)로 지정하세요."
                )

            # functionId 없는 by-query는 'kind=segment' 같은 대량 삭제로 이어져 오작동이 잦다.
            # 따라서 functionId가 있을 때만 by-query를 허용한다.
            if not function_id:
                raise ValueError(
                    "remove(by-query): functionId 없이 실행할 수 없습니다(광범위 삭제 방지). "
                    "view()/그래프 상태에서 ID를 확인한 뒤 remove(by-id)로 삭제하세요."
                )

            if kind:
                query["kind"] = str(kind)

            query["functionId"] = str(function_id)

            return {

                "type": "Remove/ByQuery",

                "payload": query,

            }

        raise ValueError(f"Unsupported remove mode: {mode}")

    

    def edit(self, spec: EditSpec) -> Dict[str, Any]:

        """

        이미 그려진 개체의 속성을 수정합니다.

        제공된 속성만 업데이트하고, 나머지는 유지됩니다.

        """

        obj_id = spec.get("id")

        if not obj_id:

            raise ValueError("edit: 'id' is required")



        # 업데이트할 속성들을 수집

        updates: Dict[str, Any] = {}



        # 스타일 업데이트

        if "style" in spec and spec["style"] is not None:

            updates["style"] = spec["style"]



        # 위치 관련 속성들

        if "position" in spec and spec["position"] is not None:

            pos = spec["position"]

            updates["position"] = [float(pos[0]), float(pos[1])]



        if "p1" in spec and spec["p1"] is not None:

            p1 = spec["p1"]

            updates["p1"] = [float(p1[0]), float(p1[1])]



        if "p2" in spec and spec["p2"] is not None:

            p2 = spec["p2"]

            updates["p2"] = [float(p2[0]), float(p2[1])]



        if "a" in spec and spec["a"] is not None:

            a = spec["a"]

            updates["a"] = [float(a[0]), float(a[1])]



        if "b" in spec and spec["b"] is not None:

            b = spec["b"]

            updates["b"] = [float(b[0]), float(b[1])]



        if "c1" in spec and spec["c1"] is not None:

            c1 = spec["c1"]

            updates["c1"] = [float(c1[0]), float(c1[1])]



        if "c2" in spec and spec["c2"] is not None:

            c2 = spec["c2"]

            updates["c2"] = [float(c2[0]), float(c2[1])]



        if "centerPoint" in spec and spec["centerPoint"] is not None:

            cp = spec["centerPoint"]

            updates["centerPoint"] = [float(cp[0]), float(cp[1])]



        # 텍스트 및 표현식

        if "latex" in spec and spec["latex"] is not None:

            updates["latex"] = str(spec["latex"])



        if "expression" in spec and spec["expression"] is not None:

            updates["expression"] = str(spec["expression"])



        if "label" in spec and spec["label"] is not None:

            updates["label"] = str(spec["label"])



        # 숫자 속성들

        if "fontSize" in spec and spec["fontSize"] is not None:

            updates["fontSize"] = float(spec["fontSize"])



        if "diameterMm" in spec and spec["diameterMm"] is not None:

            updates["diameterMm"] = float(spec["diameterMm"])



        # 색상

        if "color" in spec and spec["color"] is not None:

            updates["color"] = str(spec["color"])



        if "fillColor" in spec and spec["fillColor"] is not None:

            updates["fillColor"] = str(spec["fillColor"])



        # 불린 속성들

        if "extendStart" in spec and spec["extendStart"] is not None:

            updates["extendStart"] = bool(spec["extendStart"])



        if "extendEnd" in spec and spec["extendEnd"] is not None:

            updates["extendEnd"] = bool(spec["extendEnd"])



        # 정의역

        if "domain" in spec and spec["domain"] is not None:

            domain = spec["domain"]

            if isinstance(domain, (list, tuple)) and len(domain) == 2:

                updates["domain"] = [float(domain[0]), float(domain[1])]



        if not updates:

            raise ValueError("edit: No valid properties to update")



        return {

            "type": "Edit/Object",

            "payload": {

                "id": str(obj_id),

                "updates": updates,

            },

        }


    def set_custom_axis_range(self, spec: Dict[str, Any]) -> Dict[str, Any]:

        """

        커스텀 축 범위와 가시성을 설정합니다.

        

        spec 형식:

        {

            "xMin": -5,        // X축 시작값 (선택)

            "xMax": 10,        // X축 끝값 (선택)

            "yMin": -3,        // Y축 시작값 (선택)

            "yMax": 8,         // Y축 끝값 (선택)

            "xVisible": true,  // X축 가시성 (선택, 기본값: true)

            "yVisible": true   // Y축 가시성 (선택, 기본값: true)

        }

        """

        payload: Dict[str, Any] = {}

        

        # 축 범위 설정

        if "xMin" in spec and spec["xMin"] is not None:

            payload["xMin"] = float(spec["xMin"])

        if "xMax" in spec and spec["xMax"] is not None:

            payload["xMax"] = float(spec["xMax"])

        if "yMin" in spec and spec["yMin"] is not None:

            payload["yMin"] = float(spec["yMin"])

        if "yMax" in spec and spec["yMax"] is not None:

            payload["yMax"] = float(spec["yMax"])

        

        # 가시성 설정

        if "xVisible" in spec:

            payload["xVisible"] = bool(spec["xVisible"])

        if "yVisible" in spec:

            payload["yVisible"] = bool(spec["yVisible"])

        

        return {

            "type": "Set/CustomAxisRange",

            "payload": payload,

        }


    def fit_to_screen(self) -> Dict[str, Any]:

        """

        화면 맞춤: 축 범위에 맞게 배율을 조절하여 모든 개체가 화면에 보이도록 합니다.

        모든 그리기 작업이 완료된 후 호출하세요.

        """

        return {

            "type": "Set/FitToScreen",

            "payload": {},

        }



class AgentLoop:

    """고급 LLM 에이전트 with Thread/Session 관리 (3.3.8 스타일)"""



    def __init__(self, tools: Tools):

        self.tools = tools
        
        # Thread/Session 관리
        self._thread_id: Optional[str] = None
        self._assistant_id: Optional[str] = None
        self._previous_response_id: Optional[str] = None
        
        # 대화 이력 관리
        self.conversation_history: List[Dict[str, Any]] = []
        self.memory_summary: str = ""
        
        # OpenAI 클라이언트 (지연 초기화)
        self.openai_client = None
        self.openai_api_key = os.getenv('OPENAI_API_KEY')
        
        # 워밍업 상태
        self._warmup_done = False
        
        print(f"[AgentLoop] 초기화됨, API_KEY={'있음' if self.openai_api_key else '없음'}")
    
    def _ensure_openai_client(self):
        """OpenAI 클라이언트 지연 초기화"""
        if self.openai_client is not None:
            return self.openai_client
        if not self.openai_api_key:
            return None
        try:
            import openai
            self.openai_client = openai.OpenAI(api_key=self.openai_api_key)
            print("[AgentLoop] OpenAI 클라이언트 생성됨")
        except Exception as e:
            print(f"[AgentLoop] OpenAI 클라이언트 생성 실패: {e}")
            self.openai_client = None
        return self.openai_client
    
    def _extract_thread_id(self, obj: Any) -> Optional[str]:
        """응답 객체에서 thread_id 추출"""
        try:
            if obj is None:
                return None
            if isinstance(obj, dict):
                for key in ("thread_id", "conversation_id", "session_id"):
                    if key in obj and obj[key]:
                        return str(obj[key])
            if hasattr(obj, "thread_id"):
                return str(obj.thread_id)
            if hasattr(obj, "conversation_id"):
                return str(obj.conversation_id)
        except Exception:
            pass
        return None
    
    def _extract_response_id(self, obj: Any) -> Optional[str]:
        """응답 객체에서 response_id 추출"""
        try:
            if obj is None:
                return None
            if isinstance(obj, dict):
                if "id" in obj:
                    return str(obj["id"])
            if hasattr(obj, "id"):
                return str(obj.id)
        except Exception:
            pass
        return None
    
    def _get_recent_history(self, n: int = 4) -> List[Dict[str, Any]]:
        """최근 N턴의 대화 이력만 반환"""
        if len(self.conversation_history) <= n * 2:
            return self.conversation_history
        return self.conversation_history[-n*2:]
    
    def _create_memory_summary(self, old_history: List[Dict[str, Any]]) -> str:
        """오래된 대화를 요약"""
        # 간단한 요약 (나중에 LLM으로 개선 가능)
        summary_parts = []
        for msg in old_history[-10:]:  # 최근 10개만
            role = msg.get("role", "")
            content = str(msg.get("content", ""))[:100]
            summary_parts.append(f"{role}: {content}")
        return " | ".join(summary_parts)



    async def run_chat_stream(
        self,
        user_text: str,
        system_prompt: str | None = None,
        history: List[Dict[str, Any]] | None = None,
        session_id: Optional[str] = None,
        response_id: Optional[str] = None,
        graph_state: Optional[Dict[str, Any]] = None,
        images: Optional[List[Dict[str, Any]]] = None,
        model: Optional[str] = None,
        api_key: Optional[str] = None,
        gemini_api_key: Optional[str] = None,
        claude_api_key: Optional[str] = None,
    ):

        """LLM 스트리밍 + 툴콜 파싱 + 실행 + Thread 관리"""

        from .llm import create_llm_client, GEMINI_MODELS
        from .json_utils import extract_last_json_block, fix_json_string
        from .prompt import build_system_prompt
        
        # Session ID로 thread 복원
        if session_id and session_id != self._thread_id:
            print(f"[AgentLoop] Session ID 변경: {self._thread_id} -> {session_id}")
            self._thread_id = session_id
        
        # Response ID 복원
        if response_id and response_id != self._previous_response_id:
            print(f"[AgentLoop] Response ID 변경: {self._previous_response_id} -> {response_id}")
            self._previous_response_id = response_id
        
        # 대화 이력에 사용자 메시지 추가
        self.conversation_history.append({'role': 'user', 'content': user_text})

        # 그래프 상태를 Tools에 설정
        if graph_state:
            self.tools.set_graph_state(graph_state)
            print(f"[AgentLoop] 그래프 상태를 Tools에 설정 (노드 수: {len(graph_state.get('nodes', {}))})")
        
        # 그래프 상태가 제공된 경우 사용자 메시지에 프리픽스로 추가
        # - Gemini는 서버 측에서 대화 이력을 캐시하므로, 매 턴 그래프 상태를 user content에 붙이면
        #   이력이 급격히 커져 컨텍스트가 망가지고(=반복/오작동) 비용도 증가한다.
        # - Gemini는 llm.py에서 system_instruction에 최신 graph_state를 포함하도록 처리한다.
        actual_user_text = user_text
        # model이 None일 수 있어 기본값을 동일하게 맞춘다.
        effective_model = model or os.getenv('OPENAI_MODEL', 'gemini-3-flash-preview')
        if graph_state and (effective_model not in GEMINI_MODELS):
            from .prompt import format_graph_state
            graph_state_text = format_graph_state(graph_state)
            actual_user_text = f"{graph_state_text}\n\n---\n\n**사용자 요청:** {user_text}"
            print(f"[AgentLoop] 그래프 상태를 메시지에 포함 (노드 수: {len(graph_state.get('nodes', {}))})")
        
        # 이미지가 제공된 경우 로깅
        if images:
            print(f"[AgentLoop] 이미지 첨부됨: {len(images)}개")

        # OpenAI Agents SDK는 thread_id로 대화 이력을 자동 관리하므로
        # 현재 메시지만 전송 (이력 중복 방지)
        msgs: List[Dict[str, Any]] = []

        # 현재 사용자 메시지만 추가
        # 이미지가 있으면 content를 배열 형식으로 변환 (Agents SDK 방식)
        if images and len(images) > 0:
            content_parts = [{'type': 'input_text', 'text': actual_user_text}]
            for img in images:
                data_url = f"data:{img.get('mimeType', 'image/png')};base64,{img.get('base64', '')}"
                content_parts.append({
                    'type': 'input_image',
                    'image_url': data_url
                })
            msgs.append({'role': 'user', 'content': content_parts})
        else:
            msgs.append({'role': 'user', 'content': actual_user_text})
        
        print(f"[AgentLoop] 메시지 전송 (model={model}): {len(msgs)}개")

        # 모델에 따라 적절한 클라이언트 생성 (사용자별 API 키 지원)
        client = create_llm_client(
            model=model,
            thread_id=self._thread_id,
            response_id=self._previous_response_id,
            api_key=api_key,
            gemini_api_key=gemini_api_key,
            claude_api_key=claude_api_key,
        )
        
        assistant_response = ""

        try:
            # Fallback: 일부 모델/프로바이더는 reasoning 채널을 일관되게 보내지 않고
            # 추론(풀이 과정)을 일반 텍스트로만 출력하는 경우가 있다.
            # 이런 경우를 위해, 텍스트 스트림에서 아래 태그를 감지하여 추론 델타로 분리한다.
            #
            #   [[REASONING]] ... [[/REASONING]]
            #
            # 단, 이미 reasoning 채널(chunk.type=='reasoning')을 실제로 받기 시작하면
            # 태그 파싱은 중복을 막기 위해 자동으로 비활성화한다.
            SAW_REASONING_CHANNEL = False
            TEXT_PARSE_IN_REASONING = False
            TEXT_PARSE_BUF = ""

            async for chunk in client.stream_chat(msgs, tools_impl=self.tools):
                if chunk.type == 'text' and chunk.text:
                    assistant_response += chunk.text

                    # reasoning 채널이 없을 때만 태그 파싱
                    if not SAW_REASONING_CHANNEL:
                        TEXT_PARSE_BUF += str(chunk.text)

                        # 스트리밍 파서: 버퍼에서 최대한 토큰을 뽑아낸다.
                        while TEXT_PARSE_BUF:
                            if not TEXT_PARSE_IN_REASONING:
                                start = TEXT_PARSE_BUF.find('[[REASONING]]')
                                if start < 0:
                                    # 태그가 없으면 전부 일반 텍스트
                                    yield {'type': 'Agent/Stream.Delta', 'payload': {'delta': TEXT_PARSE_BUF}}
                                    TEXT_PARSE_BUF = ""
                                    break
                                # 태그 전의 텍스트 먼저 전송
                                if start > 0:
                                    yield {'type': 'Agent/Stream.Delta', 'payload': {'delta': TEXT_PARSE_BUF[:start]}}
                                # 태그 소비
                                TEXT_PARSE_BUF = TEXT_PARSE_BUF[start + len('[[REASONING]]'):]
                                TEXT_PARSE_IN_REASONING = True
                                continue
                            else:
                                end = TEXT_PARSE_BUF.find('[[/REASONING]]')
                                if end < 0:
                                    # 닫힘 태그가 없으면 전부 추론 델타로
                                    yield {'type': 'Agent/Reasoning.Delta', 'payload': {'delta': TEXT_PARSE_BUF}}
                                    TEXT_PARSE_BUF = ""
                                    break
                                if end > 0:
                                    yield {'type': 'Agent/Reasoning.Delta', 'payload': {'delta': TEXT_PARSE_BUF[:end]}}
                                TEXT_PARSE_BUF = TEXT_PARSE_BUF[end + len('[[/REASONING]]'):]
                                TEXT_PARSE_IN_REASONING = False
                                continue
                    else:
                        # 기존 로직 유지
                        yield {'type': 'Agent/Stream.Delta', 'payload': {'delta': chunk.text}}
                
                elif chunk.type == 'reasoning' and chunk.text:
                    # 추론 과정 스트리밍
                    SAW_REASONING_CHANNEL = True
                    yield {'type': 'Agent/Reasoning.Delta', 'payload': {'delta': chunk.text}}

                elif chunk.type == 'tool':
                    tc = chunk.tool_call or {}

                    if 'result' in tc:
                        result = tc['result']
                        
                        # 배치 결과인 경우 각 항목을 개별 이벤트로 전송
                        if isinstance(result, dict) and result.get('type') == 'batch':
                            print(f"[AgentLoop] 배치 도구 결과 전송: {result.get('count', 0)}개")
                            for item_result in result.get('results', []):
                                yield {'type': 'Agent/Action.Result', 'payload': {'event': item_result}}
                        else:
                            print(f"[AgentLoop] 도구 결과 전송: {result}")
                            yield {'type': 'Agent/Action.Result', 'payload': {'event': result}}

                    elif 'error' in tc:
                        print(f"[AgentLoop] 도구 오류: {tc['error']}")
                        yield {'type': 'Agent/Action.Error', 'payload': {'error': tc['error']}}
                
                elif chunk.type == 'tool_start':
                    # 도구 실행 "시작" 이벤트: 프론트가 즉시 pending UI를 띄울 수 있도록 한다.
                    tc = chunk.tool_call or {}
                    args = tc.get('args')
                    name = tc.get('name')

                    def emit_one(item: Any):
                        if isinstance(item, dict) and isinstance(item.get('type'), str):
                            # tools spec는 보통 {"type": "...", "payload": {...}} 형태
                            yield {'type': 'Agent/Action.Start', 'payload': {'event': {'type': item.get('type'), 'payload': item.get('payload', {})}}}
                            return
                        if name == 'view':
                            yield {'type': 'Agent/Action.Start', 'payload': {'event': {'type': 'Tool/View', 'payload': {}}}}
                            return
                        yield {'type': 'Agent/Action.Start', 'payload': {'event': {'type': f"Tool/{name or 'unknown'}", 'payload': {}}}}

                    if isinstance(args, list):
                        for it in args:
                            for e in emit_one(it):
                                yield e
                    else:
                        for e in emit_one(args):
                            yield e
                
                elif chunk.type == 'thread_id' and chunk.text:
                    # Thread ID 업데이트
                    new_thread_id = chunk.text
                    if new_thread_id != self._thread_id:
                        self._thread_id = new_thread_id
                        print(f"[AgentLoop] Thread ID 갱신: {self._thread_id}")
                        yield {'type': 'Agent/Session.Update', 'payload': {'threadId': self._thread_id}}
                
                elif chunk.type == 'response_id' and chunk.text:
                    # Response ID 업데이트
                    self._previous_response_id = chunk.text
                    print(f"[AgentLoop] Response ID 갱신: {self._previous_response_id}")
                    yield {'type': 'Agent/Session.Update', 'payload': {'threadId': self._thread_id, 'responseId': self._previous_response_id}}
        
        except Exception as e:
            print(f"[AgentLoop] stream_chat 오류: {e}")
            import traceback
            traceback.print_exc()
            yield {'type': 'Agent/Action.Error', 'payload': {'error': str(e)}}
        
        # 대화 이력에 assistant 응답 추가
        if assistant_response:
            self.conversation_history.append({'role': 'assistant', 'content': assistant_response})



