"""
prompt.py 모듈의 테스트
"""

import pytest
from app.prompt import format_graph_state, build_system_prompt


def test_format_graph_state_empty():
    """빈 그래프 상태 포맷팅 테스트"""
    result = format_graph_state({})
    assert "비어있음" in result
    assert "좌표축만 표시됨" in result


def test_format_graph_state_with_explicit_function():
    """명시적 함수가 있는 그래프 상태 포맷팅 테스트"""
    graph_state = {
        "nodes": {
            "fn-1": {
                "kind": "function-explicit",
                "id": "fn-1",
                "expr": "x**2",
                "label": "x^2",
                "symbol": "f",
                "domain": [-5, 5],
                "style": {
                    "stroke": {
                        "color": "#0066cc",
                        "width": 0.8
                    }
                },
                "segmentsOnly": False
            }
        },
        "view": {
            "scale": 1.5,
            "translate": {"x": 0, "y": 0}
        }
    }
    
    result = format_graph_state(graph_state)
    
    # 명시적 함수 정보 확인
    assert "명시적 함수" in result
    assert "f(x)" in result
    assert "x^2" in result
    assert "[-5, 5]" in result
    assert "#0066cc" in result


def test_format_graph_state_with_implicit_function():
    """음함수가 있는 그래프 상태 포맷팅 테스트"""
    graph_state = {
        "nodes": {
            "fn-1": {
                "kind": "function-implicit",
                "id": "fn-1",
                "expr": "x**2 + y**2 - 25",
                "label": "x^2 + y^2 - 25",
                "symbol": "g",
                "bounds": {
                    "xMin": -10,
                    "xMax": 10,
                    "yMin": -10,
                    "yMax": 10
                },
                "style": {
                    "stroke": {
                        "color": "#000000",
                        "width": 1.0
                    }
                }
            }
        }
    }
    
    result = format_graph_state(graph_state)
    
    # 음함수 정보 확인
    assert "음함수" in result
    assert "g:" in result
    assert "x^2 + y^2 - 25" in result
    assert "범위:" in result
    assert "#000000" in result


def test_format_graph_state_with_points():
    """점이 있는 그래프 상태 포맷팅 테스트"""
    graph_state = {
        "nodes": {
            "pt-1": {
                "kind": "point",
                "id": "pt-1",
                "position": {"x": 1.5, "y": 2.25},
                "color": "#000000"
            },
            "pt-2": {
                "kind": "point",
                "id": "pt-2",
                "position": {"x": -3.0, "y": 4.5},
                "color": "#000000"
            }
        }
    }
    
    result = format_graph_state(graph_state)
    
    # 점 정보 확인
    assert "점" in result
    assert "(1.50, 2.25)" in result
    assert "(-3.00, 4.50)" in result
    assert "#000000" in result
    assert "#000000" in result


def test_format_graph_state_with_segments():
    """세그먼트가 있는 그래프 상태 포맷팅 테스트"""
    graph_state = {
        "nodes": {
            "fn-1": {
                "kind": "function-explicit",
                "id": "fn-1",
                "symbol": "f"
            },
            "seg-1": {
                "kind": "segment",
                "id": "seg-1",
                "functionId": "fn-1"
            },
            "seg-2": {
                "kind": "segment",
                "id": "seg-2",
                "functionId": "fn-1"
            },
            "seg-3": {
                "kind": "segment",
                "id": "seg-3",
                "functionId": "standalone"
            }
        }
    }
    
    result = format_graph_state(graph_state)
    
    # 세그먼트 정보 확인
    assert "세그먼트" in result
    assert "총 3개" in result or "3개" in result
    assert "함수 f" in result


def test_format_graph_state_with_lines():
    """직선이 있는 그래프 상태 포맷팅 테스트"""
    graph_state = {
        "nodes": {
            "anchor-1": {
                "kind": "anchor",
                "id": "anchor-1",
                "position": {"x": 0, "y": 0}
            },
            "anchor-2": {
                "kind": "anchor",
                "id": "anchor-2",
                "position": {"x": 5, "y": 5}
            },
            "line-1": {
                "kind": "line",
                "id": "line-1",
                "a": "anchor-1",
                "b": "anchor-2"
            }
        }
    }
    
    result = format_graph_state(graph_state)
    
    # 직선 정보 확인
    assert "직선" in result
    assert "(0.00, 0.00)" in result
    assert "(5.00, 5.00)" in result


def test_build_system_prompt_without_graph_state():
    """그래프 상태 없이 시스템 프롬프트 생성 테스트"""
    result = build_system_prompt(None, "gpt-4")
    
    # 기본 정보 확인
    assert "AlphaStudio" in result
    assert "gpt-4" in result
    assert "중요" in result
    assert "매 턴마다" in result
    assert "draw(spec_json)" in result
    assert "remove(spec_json)" in result


def test_build_system_prompt_with_graph_state():
    """그래프 상태를 포함한 시스템 프롬프트 생성 테스트"""
    graph_state = {
        "nodes": {
            "fn-1": {
                "kind": "function-explicit",
                "id": "fn-1",
                "expr": "x**2",
                "label": "x^2",
                "symbol": "f",
                "domain": [-10, 10]
            }
        }
    }
    
    result = build_system_prompt(graph_state, "gpt-4")
    
    # 기본 정보 확인
    assert "AlphaStudio" in result
    assert "gpt-4" in result
    
    # 그래프 상태 정보 확인
    assert "현재 그래프 상태" in result
    assert "명시적 함수" in result
    assert "f(x)" in result
    assert "x^2" in result


def test_format_graph_state_with_filled_region():
    """채워진 영역이 있는 그래프 상태 포맷팅 테스트"""
    graph_state = {
        "nodes": {
            "region-1": {
                "kind": "filled-region",
                "id": "region-1",
                "centerPoint": {"x": 2.5, "y": 3.5},
                "fillColor": "rgb(230, 230, 230)"
            }
        }
    }
    
    result = format_graph_state(graph_state)
    
    # 채워진 영역 정보 확인
    assert "채워진 영역" in result
    assert "(2.50, 3.50)" in result
    assert "rgb(230, 230, 230)" in result


def test_format_graph_state_with_math_text():
    """수식 텍스트가 있는 그래프 상태 포맷팅 테스트"""
    graph_state = {
        "nodes": {
            "text-1": {
                "kind": "math-text",
                "id": "text-1",
                "latex": "f(x) = x^2",
                "position": {"x": 1.0, "y": 2.0}
            }
        }
    }
    
    result = format_graph_state(graph_state)
    
    # 수식 텍스트 정보 확인
    assert "수식 텍스트" in result
    assert "f(x) = x^2" in result
    assert "(1.00, 2.00)" in result


def test_format_graph_state_with_axes():
    """좌표축이 있는 그래프 상태 포맷팅 테스트"""
    graph_state = {
        "nodes": {
            "axis-x": {
                "kind": "axis",
                "id": "axis-x",
                "name": "X",
                "visible": True
            },
            "axis-y": {
                "kind": "axis",
                "id": "axis-y",
                "name": "Y",
                "visible": False
            }
        }
    }
    
    result = format_graph_state(graph_state)
    
    # 좌표축 정보 확인
    assert "좌표축" in result
    assert "X축:" in result
    assert "Y축:" in result
    assert "표시" in result
    assert "숨김" in result


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

