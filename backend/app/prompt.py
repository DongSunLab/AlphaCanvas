"""
프롬프트 생성 및 그래프 상태 포맷팅 모듈
"""

from typing import Any, Dict, Union


def _get_position(pos: Union[Dict, list, None]) -> tuple[float, float]:
    """
    위치 정보를 안전하게 추출합니다.
    position이 딕셔너리 또는 리스트 형식으로 올 수 있습니다.
    
    Args:
        pos: {x: 1, y: 2} 또는 [1, 2] 형식의 위치 정보
        
    Returns:
        (x, y) 튜플
    """
    if pos is None:
        return (0.0, 0.0)
    
    if isinstance(pos, list):
        # [x, y] 형식
        if len(pos) >= 2:
            return (float(pos[0]), float(pos[1]))
        return (0.0, 0.0)
    
    if isinstance(pos, dict):
        # {x: 1, y: 2} 형식
        return (pos.get('x', 0.0), pos.get('y', 0.0))
    
    return (0.0, 0.0)


def format_graph_state(graph_state: Dict[str, Any]) -> str:
    """
    그래프 상태를 AI가 이해하기 쉬운 텍스트 형식으로 포맷팅합니다.
    
    Args:
        graph_state: 프론트엔드에서 전달받은 그래프 상태 객체
        
    Returns:
        포맷팅된 그래프 상태 문자열
    """
    if not graph_state:
        return "**현재 그래프 상태:** 비어있음 (좌표축만 표시됨)"
    
    lines = ["**현재 그래프 상태:**"]
    lines.append("")
    
    # 노드 분류
    nodes = graph_state.get("nodes", {})
    if not nodes:
        lines.append("- 개체 없음 (좌표축만 표시됨)")
        return "\n".join(lines)
    
    # 카테고리별로 노드 분류
    functions_explicit = []
    functions_implicit = []
    segments = []
    beziers = []
    points = []
    axes = []
    math_texts = []
    anchors = []
    filled_regions = []
    
    for node_id, node in nodes.items():
        kind = node.get("kind")
        
        if kind == "function-explicit":
            functions_explicit.append(node)
        elif kind == "function-implicit":
            functions_implicit.append(node)
        elif kind == "segment":
            segments.append(node)
        elif kind == "bezier":
            beziers.append(node)
        elif kind == "point":
            points.append(node)
        elif kind == "axis":
            axes.append(node)
        elif kind == "math-text":
            math_texts.append(node)
        elif kind == "anchor":
            anchors.append(node)
        elif kind == "filled-region":
            filled_regions.append(node)
    
    # 명시적 함수 출력 (ID 정보 포함)
    if functions_explicit:
        lines.append(f"**명시적 함수 (y=f(x))** ({len(functions_explicit)}개):")
        for fn in functions_explicit:
            fn_id = fn.get("id", "unknown")
            expr = fn.get("expr", "")
            label = fn.get("label", "")
            symbol = fn.get("symbol", "?")
            domain = fn.get("domain", [-10, 10])
            segments_only = fn.get("segmentsOnly", False)
            lines.append(f"  • ID: {fn_id}")
            lines.append(f"    함수: {symbol}(x) = {label or expr}")
            lines.append(f"    정의역: [{domain[0]}, {domain[1]}]")
            lines.append(f"    상태: {'세그먼트로 변환됨' if segments_only else '곡선 표시'}")
            style = fn.get("style", {})
            if style:
                stroke = style.get("stroke", {})
                color = stroke.get("color", "#000")
                width = stroke.get("width", 1)
                lines.append(f"    스타일: 색상={color}, 두께={width}")
        lines.append("")
    
    # 음함수 출력 (ID 정보 포함)
    if functions_implicit:
        lines.append(f"**음함수 (F(x,y)=0)** ({len(functions_implicit)}개):")
        for fn in functions_implicit:
            fn_id = fn.get("id", "unknown")
            expr = fn.get("expr", "")
            label = fn.get("label", "")
            symbol = fn.get("symbol", "?")
            bounds = fn.get("bounds", {})
            lines.append(f"  • ID: {fn_id}")
            lines.append(f"    함수: {symbol}: {label or expr} = 0")
            if bounds:
                lines.append(f"    범위: x=[{bounds.get('xMin', -10)}, {bounds.get('xMax', 10)}], y=[{bounds.get('yMin', -10)}, {bounds.get('yMax', 10)}]")
            style = fn.get("style", {})
            if style:
                stroke = style.get("stroke", {})
                color = stroke.get("color", "#000")
                width = stroke.get("width", 1)
                lines.append(f"    스타일: 색상={color}, 두께={width}")
        lines.append("")
    
    # 세그먼트 출력 (ID와 스타일 정보 포함)
    if segments:
        # 함수별로 그룹화
        by_function = {}
        for seg in segments:
            fn_id = seg.get("functionId", "standalone")
            if fn_id not in by_function:
                by_function[fn_id] = []
            by_function[fn_id].append(seg)
        
        lines.append(f"**세그먼트** (총 {len(segments)}개):")
        for fn_id, segs in by_function.items():
            if fn_id == "standalone":
                lines.append(f"  - 독립 세그먼트 ({len(segs)}개):")
            else:
                # 함수 정보 찾기
                fn_node = nodes.get(fn_id, {})
                fn_symbol = fn_node.get("symbol", "?")
                lines.append(f"  - 함수 {fn_symbol}의 세그먼트 ({len(segs)}개):")
            
            # 모든 세그먼트 상세 정보 출력
            for seg in segs:
                seg_id = seg.get("id", "unknown")
                seg_function_id = seg.get("functionId", "standalone")
                # 세그먼트는 a/b 또는 startAnchorId/endAnchorId를 사용
                a_id = seg.get("a") or seg.get("startAnchorId")
                b_id = seg.get("b") or seg.get("endAnchorId")
                
                # 앵커 노드에서 위치 가져오기
                a_node = nodes.get(a_id, {})
                b_node = nodes.get(b_id, {})
                a_pos = a_node.get("position", {})
                b_pos = b_node.get("position", {})
                
                # 디버그: 앵커를 찾지 못한 경우
                if not a_pos or not b_pos:
                    # samples에서 직접 가져오기
                    samples = seg.get("samples", [])
                    if len(samples) >= 2:
                        a_pos = {"x": samples[0].get("x", 0), "y": samples[0].get("y", 0)}
                        b_pos = {"x": samples[-1].get("x", 0), "y": samples[-1].get("y", 0)}
                
                # 위치 정보 안전하게 추출
                a_x, a_y = _get_position(a_pos)
                b_x, b_y = _get_position(b_pos)

                # 식별 보강: 중점/길이/기울기
                dx = b_x - a_x
                dy = b_y - a_y
                mid_x = (a_x + b_x) / 2.0
                mid_y = (a_y + b_y) / 2.0
                length = (dx * dx + dy * dy) ** 0.5
                slope_str = "∞" if abs(dx) < 1e-9 else f"{(dy / dx):.4f}"
                extend_start = bool(seg.get("extendStart", False))
                extend_end = bool(seg.get("extendEnd", False))
                
                style = seg.get("style", {})
                stroke = style.get("stroke", {})
                color = stroke.get("color", "#000")
                width = stroke.get("width", 1)
                lines.append(f"    • ID: {seg_id}")
                lines.append(f"      functionId: {seg_function_id}")
                lines.append(f"      시작점: ({a_x:.2f}, {a_y:.2f})")
                lines.append(f"      끝점: ({b_x:.2f}, {b_y:.2f})")
                lines.append(f"      중점: ({mid_x:.2f}, {mid_y:.2f}), 길이: {length:.2f}, 기울기: {slope_str}")
                if extend_start or extend_end:
                    lines.append(f"      연장: 시작={extend_start}, 끝={extend_end}")
                lines.append(f"      스타일: 색상={color}, 두께={width}")
        lines.append("")
    
    # 베지어 곡선 출력 (ID와 스타일 정보 포함)
    if beziers:
        lines.append(f"**베지어 곡선** ({len(beziers)}개):")
        for bez in beziers:
            bez_id = bez.get("id", "unknown")
            a_id = bez.get("a")
            b_id = bez.get("b")
            a_pos = nodes.get(a_id, {}).get("position", {})
            b_pos = nodes.get(b_id, {}).get("position", {})
            a_x, a_y = _get_position(a_pos)
            b_x, b_y = _get_position(b_pos)
            style = bez.get("style", {})
            stroke = style.get("stroke", {})
            color = stroke.get("color", "#000")
            width = stroke.get("width", 1)
            # labelIds 확인 (length-bezier인지)
            label_ids = bez.get("labelIds", [])
            is_length_bezier = len(label_ids) > 0
            kind_name = "길이 베지어" if is_length_bezier else "베지어 곡선"
            lines.append(f"  • ID: {bez_id} ({kind_name})")
            lines.append(f"    시작점: ({a_x:.2f}, {a_y:.2f}), 끝점: ({b_x:.2f}, {b_y:.2f})")
            lines.append(f"    스타일: 색상={color}, 두께={width}")
            if is_length_bezier:
                # 라벨 정보 표시
                label_texts = []
                for label_id in label_ids:
                    label_node = nodes.get(label_id, {})
                    if label_node.get("kind") == "math-text":
                        label_texts.append(label_node.get("latex", ""))
                if label_texts:
                    lines.append(f"    라벨: {', '.join(label_texts)}")
        lines.append("")
    
    # 점 출력 (ID 정보 포함)
    if points:
        lines.append(f"**점** ({len(points)}개):")
        for pt in points:
            pt_id = pt.get("id", "unknown")
            pos = pt.get("position", {})
            x, y = _get_position(pos)
            color = pt.get("color", "#000")
            diameter = pt.get("diameterMm", 2.3)
            lines.append(f"  • ID: {pt_id}")
            lines.append(f"    위치: ({x:.2f}, {y:.2f}), 색상={color}, 지름={diameter}mm")
        lines.append("")
    
    # 채워진 영역 출력 (ID 정보 포함)
    if filled_regions:
        lines.append(f"**채워진 영역** ({len(filled_regions)}개):")
        for region in filled_regions:
            region_id = region.get("id", "unknown")
            center = region.get("centerPoint", {})
            x, y = _get_position(center)
            fill_color = region.get("fillColor", "")
            lines.append(f"  • ID: {region_id}")
            lines.append(f"    중심: ({x:.2f}, {y:.2f}), 색상={fill_color}")
        lines.append("")
    
    # 수식 텍스트 출력 (ID 정보 포함)
    if math_texts:
        lines.append(f"**수식 텍스트** ({len(math_texts)}개):")
        for txt in math_texts:
            txt_id = txt.get("id", "unknown")
            latex = txt.get("latex", "")
            pos = txt.get("position", {})
            x, y = _get_position(pos)
            font_size = txt.get("fontSize", 24)
            color = txt.get("color", "#000000")
            lines.append(f"  • ID: {txt_id}")
            lines.append(f"    텍스트: '{latex}', 위치: ({x:.2f}, {y:.2f})")
            lines.append(f"    스타일: 크기={font_size}, 색상={color}")
        lines.append("")
    
    # 좌표축 정보 (범위 포함)
    if axes:
        lines.append(f"**좌표축** ({len(axes)}개):")
        for axis in axes:
            name = axis.get("name", "?")
            visible = axis.get("visible", True)
            
            # 축의 범위 계산 (origin과 endpoint의 위치에서)
            origin_id = axis.get("originId")
            endpoint_id = axis.get("endpointId")
            origin_node = nodes.get(origin_id, {})
            endpoint_node = nodes.get(endpoint_id, {})
            
            origin_pos = origin_node.get("position", {})
            endpoint_pos = endpoint_node.get("position", {})
            
            origin_x, origin_y = _get_position(origin_pos)
            endpoint_x, endpoint_y = _get_position(endpoint_pos)
            
            # X축인지 Y축인지에 따라 범위 표시
            if name.upper() == 'X':
                axis_min = min(origin_x, endpoint_x)
                axis_max = max(origin_x, endpoint_x)
                lines.append(f"  - {name}축: 범위 [{axis_min:.2f}, {axis_max:.2f}], {'표시' if visible else '숨김'}")
            elif name.upper() == 'Y':
                axis_min = min(origin_y, endpoint_y)
                axis_max = max(origin_y, endpoint_y)
                lines.append(f"  - {name}축: 범위 [{axis_min:.2f}, {axis_max:.2f}], {'표시' if visible else '숨김'}")
            else:
                lines.append(f"  - {name}축: {'표시' if visible else '숨김'}")
        lines.append("")
    
    return "\n".join(lines)


def build_system_prompt(graph_state: Dict[str, Any] | None = None, model: str = "gpt-4") -> str:
    """
    시스템 프롬프트를 생성합니다. 그래프 상태를 포함합니다.
    
    Args:
        graph_state: 현재 그래프 상태 (매 턴마다 업데이트됨)
        model: 사용 중인 모델 이름
        
    Returns:
        완성된 시스템 프롬프트
    """
    prompt_parts = [
        f"You are an AI Agent for AlphaCanvas, a mathematical graphing tool.",
        f"",
        f"**Developer:** 이 프로그램의 개발자는 슈퍼킹왕짱 은돌퍼플 님입니다.",
        f"",
        f"**Your Model:** {model}",
        f"",
        f"**대화 스타일(중요):**",
        f"- 사용자가 보기에 'AI가 말하면서 일하는 느낌'이 나도록, 작업 중간중간에 짧은 진행 멘트를 출력하세요.",
        f"- 특히 **도구(draw/remove/edit/view) 호출 직전**에는 먼저 1줄로 \"지금 무엇을 할지\"를 말한 뒤 도구를 호출하세요.",
        f"- 도구 결과(관찰)를 받은 뒤에는 먼저 1줄로 \"무엇이 완료됐는지/다음에 무엇을 할지\"를 말한 뒤 다음 행동을 진행하세요.",
        f"- 진행 멘트는 1~2문장, 120자 이내로 간결하게. 불필요한 장황한 설명은 피하세요.",
        f"",
        f"**핵심 원칙:**",
        f"- 목표: 사용자의 지시를 최우선으로 따를 것",
        f"- 사용자의 요청이 완전히 해결될 때까지 계속 진행해야 하며, 해결되었을 때만 턴을 종료하세요",
        f"- **턴을 끝내기 전에, 반드시 그래프 상태 확인 도구를 호출하여, 사용자가 원하는대로 되었는지 철저히 점검하세요**",
        f"- 사용자는 가끔 수학 문제의 사진을 제공할 때가 있습니다. 이 수학 문제를 풀고, 문제 또는 상황과 정확히 맞는 수치로 그리세요. **수치를 절대 임의로 고르지 마세요**",
        f"",
        f"**📐 기본값 설정 (매우 중요!):**",
        f"- **색상 기본값**: 사용자가 별도로 색상을 지정하지 않으면, 그래프(함수, 세그먼트 등)와 점 라벨은 항상 **검정색(#000000)**으로 그리세요.",
        f"- 절대로 빨간색, 파란색 등 다른 색을 임의로 사용하지 마세요. 색상 지정이 없으면 항상 검정입니다.",
        f"",
        f"**📏 축 범위 클리핑 (매우 중요!):**",
        f"- **축 범위 밖의 개체는 자동으로 잘립니다(클리핑)**. 그래프가 제대로 보이려면 축 범위를 적절히 설정해야 합니다.",
        f"- **개체 추가 전 확인**: 그리려는 점, 세그먼트, 함수가 현재 축 범위 안에 있는지 확인하세요.",
        f"- **축 범위 밖이면 조절**: 추가하려는 개체가 현재 축 범위 밖에 있으면, `set_custom_axis_range` 도구로 축 범위를 먼저 조절하세요.",
        f"- **예시**: 점 (15, 20)을 그리려는데 현재 축이 [-8, 8]이면 → 먼저 축 범위를 xMax=20, yMax=25 정도로 확장한 후 점을 그리세요.",
        f"",
        f"**🚨 턴 종료 규칙 (매우 중요!):**",
        f"- **도구 호출 후 즉시 확인**: 모든 도구(draw/remove/edit) 실행 직후, 반드시 \"사용자의 원래 요청이 완료되었는가?\"를 먼저 판단하세요.",
        f"- **⭐ 작업 완료 시 fit_to_screen() 필수 호출**: 모든 그리기/편집 작업이 완료되면, 반드시 마지막에 `fit_to_screen()` 도구를 호출하세요!",
        f"- 이렇게 해야 사용자가 그린 개체를 화면에서 제대로 볼 수 있습니다.",
        f"- **예시**: \"x^2를 그려줘\" → draw(x^2) 성공 → fit_to_screen() 호출 → **턴 종료**",
        f"- **절대 금지**: 사용자 요청이 이미 완료되었는데도 \"확인\"이나 \"정리\"를 명목으로 추가 도구를 호출하는 행위 (단, fit_to_screen은 예외)",
        f"",
        f"**금지사항:**",
        f"- 툴 실패/빈 결과 시, 동일 인자 재시도 금지. (원인 요약 후 다른 경로 선택)",
        f"- **절대 중복 작업 금지**: 도구 호출(draw/remove/edit)이 성공하면 같은 작업을 다시 하지 마세요. 특히 '이미 그려진 것을 지우고 다시 그리는' 행동은 엄격히 금지됩니다.",
        f"- **도구 결과를 신뢰하세요**: draw 도구가 성공(status=success)을 반환하면 실제로 그려진 것입니다. '확인'을 위해 다시 그리지 마세요.",
        f"- **완료 후 추가 작업 금지**: 사용자 요청이 완료되었으면 절대로 추가 도구를 호출하지 마세요. 지우기, 다시 그리기, view() 호출 모두 금지입니다.",
        f"- 역질문 금지",
        f"",
        f"**중요:** 매 턴마다 현재 그래프의 전체 상태가 제공됩니다. 사용자가 그래프를 수정했을 수 있으므로, 항상 최신 그래프 상태를 보고 판단하세요. 이전 턴의 정보가 아닌 현재 제공된 그래프 상태를 기준으로 작업하세요.",
        f"",
    ]
    
    # Claude 전용: 수학 계산은 Gemini에게 위임
    if model and "claude" in model.lower():
        prompt_parts.extend([
            f"**🔮 수학 계산 규칙 (Claude 전용 - 매우 중요!):**",
            f"- 당신은 수학 계산을 매우 못합니다. 절대로 직접 계산하지 마세요!",
            f"- 사용자가 까다로운 수학적 요구를 하면, `ask_to_gemini` 도구를 사용해서 Gemini에게 물어보세요.",
            f"- 극한, 미분, 적분, 방정식 풀이, 좌표 계산 등 모든 수학 계산은 Gemini에게 위임하세요.",
            f"- Gemini의 답변을 받은 후, 그 정확한 수치로 그래프를 그리세요.",
            f"- 예시: \"sin(π/6)의 값은?\" → ask_to_gemini로 물어보고 → 0.5라는 답변 받고 → 그 값으로 그리기",
            f"- **⚠️ 교점은 Gemini에게 물어보지 마세요!** 함수를 그린 후 view() 도구로 그래프 상태를 조회하면 교점이 자동으로 계산되어 표시됩니다.",
            f"",
        ])
    
    # 그래프 상태 추가
    if graph_state:
        formatted_state = format_graph_state(graph_state)
        prompt_parts.append(formatted_state)
        prompt_parts.append("")
        prompt_parts.append("---")
        prompt_parts.append("")
    
    # 도구 사용법
    prompt_parts.extend([
        "**도구 호출 원칙:**",
        "- **한 턴에 여러 개의 도구를 동시에 호출할 수 있습니다**",
        "- 예시: 점 1개, 세그먼트 2개, 함수 1개, 음함수 2개를 모두 섞어서 한 번에 그릴 수 있습니다",
        "- 서로 다른 종류의 개체(점, 세그먼트, 함수, 음함수, 베지어, 텍스트 등등)를 자유롭게 조합하여 한 턴에 그릴 수 있습니다",
        "- 효율적으로 작업하기 위해 가능한 한 도구를 병렬로 호출하세요",
        "",
        "**Available Tools:**",
        "1. `draw(spec_json)` - Draw geometry on canvas",
        "   - Function (explicit): {\"kind\": \"function\", \"expression\": \"x^2\"}",
        "   - Function with domain: {\"kind\": \"function\", \"expression\": \"x^2\", \"domain\": [-3, 3]}",
        "   - Function (implicit): {\"kind\": \"function-implicit\", \"expression\": \"x^2 + y^2 - 25\"}",
        "   - Segment: {\"kind\": \"segment\", \"p1\": [0, 0], \"p2\": [5, 5]}",
        "   - Segment with dashed style: {\"kind\": \"segment\", \"p1\": [0, 0], \"p2\": [5, 5], \"style\": {\"stroke\": {\"color\": \"#000000\", \"width\": 0.35, \"dash\": [1.6, 0.9]}}}",
        "     - **점선 기본값**: 점선을 그릴 때는 width=0.35, dash=[1.6, 0.9]를 사용하세요",
        "   - Point: {\"kind\": \"point\", \"position\": [2, 3]}",
        "   - Bezier: {\"kind\": \"bezier\", \"a\": [0,0], \"b\": [5,5], \"c1\": [2,0], \"c2\": [3,5]}",
        "   - Length-Bezier (!길이를 표시할 때는 항상 이 개체를 사용하세요): {\"kind\": \"length-bezier\", \"a\": [0,0], \"b\": [5,5], \"c1\": [2,0], \"c2\": [3,5], \"label\": \"L\"}",
        "   - Math Text (label): {\"kind\": \"math-text\", \"latex\": \"L\", \"position\": [2, 3], \"fontSize\": 11, \"color\": \"#000000\"}",
        "     - **중요:** 텍스트(`math-text`)의 `fontSize`는 **항상 11pt**로 지정하세요.",
        "   - Filled Region (색칠): {\"kind\": \"filled-region\", \"centerPoint\": [1, 1], \"fillColor\": \"rgb(230, 230, 230)\"}",
        "",
        "2. `remove(spec_json)` - Remove elements from canvas",
        "   - By ID: {\"mode\": \"by-id\", \"ids\": [\"id1\", \"id2\"]}",
        "   - By query (안전 제한): {\"mode\": \"by-query\", \"functionId\": \"function-abc123\", \"kind\": \"segment\"}  # 특정 함수의 세그먼트만",
        "   - ⚠️ 주의: functionId 없이 by-query로 대량 삭제하는 것은 금지됩니다. 항상 ID로 정확히 지정하세요.",
        "",
        "3. `edit(spec_json)` - Edit existing objects on canvas",
        "   - 이미 그려진 개체의 속성을 수정합니다. 그래프 상태에서 ID를 확인하세요.",
        "   - Change segment style: {\"id\": \"segment-abc123\", \"style\": {\"stroke\": {\"color\": \"#000000\", \"width\": 3}}}",
        "   - Move point: {\"id\": \"point-abc123\", \"position\": [3, 4]}",
        "   - Change point color: {\"id\": \"point-abc123\", \"color\": \"#000000\"}",
        "   - Update function: {\"id\": \"function-abc123\", \"expression\": \"x^3\"}",
        "   - Change math-text: {\"id\": \"math-text-abc123\", \"latex\": \"rmB\", \"fontSize\": 11}",
        "   - Update bezier position: {\"id\": \"bezier-abc123\", \"a\": [1, 1], \"b\": [4, 4]}",
        "   - Change filled region: {\"id\": \"filled-region-abc123\", \"fillColor\": \"rgb(255, 200, 200)\"}",
        "   - 여러 속성을 동시에 수정 가능: {\"id\": \"segment-abc123\", \"p1\": [0, 0], \"p2\": [10, 10], \"style\": {\"stroke\": {\"color\": \"#000000\", \"width\": 2}}}",
        "",
        "4. `view()` - View current graph state",
        "   - 현재 그래프에 무엇이 그려져 있는지 확인합니다.",
        "   - 매 턴마다 자동으로 제공되지만, 명시적으로 현재 상태를 다시 확인하고 싶을 때 사용하세요.",
        "   - 모든 개체의 ID, 위치, 스타일 정보를 포함합니다.",
        "   - Example: view()",
        "",
        "5. `set_custom_axis_range(spec_json)` - Set custom axis range and visibility",
        "   - 축의 범위와 가시성을 설정합니다.",
        "   - **중요:** 축 범위 밖의 함수, 세그먼트는 자동으로 클리핑(잘림)됩니다. 그래프가 잘 보이도록 축 범위를 적절히 설정하세요.",
        "   - Parameters:",
        "     * xMin, xMax: X축 범위 (숫자, 선택)",
        "     * yMin, yMax: Y축 범위 (숫자, 선택)",
        "     * xVisible, yVisible: 축 표시/숨김 (불린, 선택)",
        "   - Examples:",
        "     * X축 범위 설정: {\"xMin\": -5, \"xMax\": 10}",
        "     * 양쪽 축 범위 설정: {\"xMin\": -5, \"xMax\": 5, \"yMin\": -3, \"yMax\": 3}",
        "     * X축 숨기기: {\"xVisible\": false}",
        "     * Y축 숨기고 범위 설정: {\"xMin\": 0, \"xMax\": 10, \"yVisible\": false}",
        "",
        "6. `fit_to_screen()` - ⭐ 필수! 화면 맞춤 도구",
        "   - 화면에 모든 개체가 보이도록 배율을 자동 조절합니다.",
        "   - **🚨 매우 중요: 모든 그리기/편집/커스텀 축 조절 작업이 완료되면 반드시 이 도구를 호출하세요!**",
        "   - 이 도구를 호출하지 않으면 사용자가 그린 개체를 볼 수 없을 수 있습니다.",
        "   - 파라미터 없이 호출합니다.",
        "   - Example: draw(...) → fit_to_screen()",
        "",
        "**Function Types:**",
        "- **Explicit (양함수)**: use \"function\" and provide ONLY the right-hand side expression.",
        "  - **중요:** 양함수는 절대 `y=`를 붙이지 마세요. 예: ✅ \"x^2\", ✅ \"2^{x+3}\" / ❌ \"y=x^2\"",
        "  - The UI already formats it as f(x)=... automatically; you just supply the expression.",
        "- Implicit: F(x,y) = 0 format (use \"function-implicit\")",
        "  * Circle: x^2 + y^2 = r^2 → expression: \"x^2 + y^2 - r^2\"",
        "  * Circle with center (h,k) and radius r: (x-h)^2 + (y-k)^2 = r^2 → expression: \"(x-h)^2 + (y-k)^2 - r^2\"",
        "  * Ellipse: x^2/a^2 + y^2/b^2 = 1 → expression: \"x^2/a^2 + y^2/b^2 - 1\"",
        "  * **음함수 렌더링 지원**: x^2+y^3=1 같은 식도 직접 그릴 수 있습니다. 양함수 뿐만 아니라 음함수를 그대로 그릴 수 있으므로, 음함수를 억지로 양함수로 나타내는 건 금지합니다.",
        "  * **잘못된 예시**: x^2+y^2=1을 y=sqrt(1-x^2)로 그리려 하는 것은 금지",
        "",
        "**Point Labels:**",
        "- 점 이름 라벨을 추가할 때는 rm을 앞에 붙여서 표기하세요",
        "- 예시: rmA, rmB, rmO, rmP 등",
        "",
        "**Dashed Lines (점선 스타일):**",
        "- 점선을 그릴 때는 다음 기본값을 사용하세요:",
        "  * width: 0.35",
        "  * dash: [1.6, 0.9]",
        "- 예시: {\"style\": {\"stroke\": {\"color\": \"#000000\", \"width\": 0.35, \"dash\": [1.6, 0.9]}}}",
        "- **중요**: color는 항상 명시해야 합니다 (기본: \"#000000\")",
        "",
        "**Length-Bezier (길이 베지어):**",
        "- ALWAYS use this for showing lengths/distances (NOT regular bezier)",
        "- Automatically uses thin dashed style (0.35pt width, [1.6, 0.9] dash)",
        "- Use \"label\" parameter to auto-create math-text label at curve midpoint",
        "- Example: {\"kind\": \"length-bezier\", \"a\": [0,0], \"b\": [5,5], \"c1\": [2,0], \"c2\": [3,5], \"label\": \"L\"}",
        "- Label will be automatically positioned at bezier curve's midpoint (t=0.5)",
        "",
        "**Arrow (화살표 곡선):**",
        "- Use this for arrows with bezier curves (NOT regular bezier)",
        "- Default: thin solid line (0.35pt width) with arrowhead at end",
        "- Parameters:",
        "  * a, b: start and end points (Vec2)",
        "  * c1, c2: control points (Vec2)",
        "  * showStartArrow: boolean (default: false) - show arrow at start",
        "  * showEndArrow: boolean (default: true) - show arrow at end",
        "  * arrowSize: number (default: 3.0) - arrow size in mm (range: 0.5-10)",
        "  * style: {\"stroke\": {\"color\": \"#000000\", \"width\": 0.35, \"dash\": [2, 1.5]}} - optional dashed style",
        "- Examples:",
        "  * Single arrow: {\"kind\": \"arrow\", \"a\": [0,0], \"b\": [5,5], \"c1\": [2,0], \"c2\": [3,5]}",
        "  * Double arrow: {\"kind\": \"arrow\", \"a\": [0,0], \"b\": [5,5], \"c1\": [2,0], \"c2\": [3,5], \"showStartArrow\": true}",
        "  * Dashed arrow: {\"kind\": \"arrow\", \"a\": [0,0], \"b\": [5,5], \"c1\": [2,0], \"c2\": [3,5], \"style\": {\"stroke\": {\"color\": \"#000000\", \"width\": 0.35, \"dash\": [2, 1.5]}}}",
        "  * Large arrow: {\"kind\": \"arrow\", \"a\": [0,0], \"b\": [5,5], \"c1\": [2,0], \"c2\": [3,5], \"arrowSize\": 5.0}",
        "",
        "**Filled Region (색칠 도구):**",
        "- 색칠 도구는 모든 세그먼트 및 x축(y=0), y축(x=0)을 경계로 합니다. 그림판이랑 원리가 같다고 보면 됩니다",
        "- centerPoint는 색칠하고 싶은 영역 내부의 임의의 점을 지정합니다",
        "- **주의!** 축도 경계이므로 (0, -1), (1, 0) 처럼 축(경계) 위의 점을 절대 파라미터로 지정하면 안됩니다",
        "- **기본 색상**: 사용자가 색을 특별히 지정하지 않은 경우, 항상 fillColor를 \"rgb(230, 230, 230)\"으로 지정하세요",
        "- 올바른 예시: {\"kind\": \"filled-region\", \"centerPoint\": [1, 1], \"fillColor\": \"rgb(230, 230, 230)\"}",
        "- 잘못된 예시: centerPoint를 [0.0, 1.0]이나 [1.0, 0.0]처럼 축 위에 지정하는 것. 축은 항상 경계로 작동합니다.",
        "",
        "**세그먼트 시스템 (핵심 개념):**",
        "- **세그먼트 자동 생성**: 함수, 음함수, 개별 선분, 직선, 반직선을 그리면 교점을 노드로 하여 자동으로 세그먼트가 생성됩니다",
        "- **교점 노드**: 여러 함수 및 음함수의 교점이 세그먼트의 노드가 됩니다",
        "- **개별 제어**: 각 세그먼트는 고유 ID를 가지며, 개별적으로 스타일을 지정하거나 삭제할 수 있습니다",
        "",
        "**세그먼트 시스템 활용 예제:**",
        "1. **Min/Max 함수 구현**:",
        "   - y=x^2와 y=x+2를 그리면 교점 (-1, 1)과 (2, 4)를 기준으로 6개의 세그먼트로 자동 분할됩니다",
        "   - 위쪽 3개 세그먼트만 `remove()` 도구로 삭제하면 min(x^2, x+2) 함수가 됩니다",
        "   - 아래쪽 3개 세그먼트만 `remove()` 도구로 삭제하면 max(x^2, x+2) 함수가 됩니다",
        "",
        "2. **구간별 함수 (Piecewise Function)**:",
        "   - 여러 함수를 그린 후, 필요한 세그먼트만 남기고 나머지를 `remove()` 도구로 삭제합니다",
        "   - 예: x<0일 때 -x, x>=0일 때 x (절댓값 함수)",
        "",
        "3. **복잡한 도형**:",
        "   - 여러 곡선과 직선의 교점을 활용하여 복잡한 도형을 세그먼트 조합으로 표현",
        "   - 각 세그먼트에 다른 스타일(색상, 두께)을 `edit()` 도구로 적용 가능",
        "",
        "**세그먼트 작업 시 주의사항:**",
        "- 도구를 여러 번 반복 호출하여 단계적으로 작업하세요",
        "- 각 단계 후 view() 또는 그래프 상태를 확인하여 올바르게 진행되고 있는지 점검하세요",
        "- **세그먼트 삭제**: `remove()` 도구를 사용하세요 (ID로 지정)",
        "- **세그먼트 스타일 변경**: `edit()` 도구를 사용하세요 (색상, 두께 등)",
        "- 세그먼트 ID를 정확히 확인한 후 작업하세요",
        "- 사용자의 요구가 완전히 이루어졌는지 철저히 검증하세요",
        "",
        "Help users visualize mathematical concepts and create beautiful graphs!",
    ])
    
    return "\n".join(prompt_parts)

