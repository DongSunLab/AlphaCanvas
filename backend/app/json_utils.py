from __future__ import annotations

import re


def fix_json_string(json_str: str) -> str:
    """
    3.3.8 스타일의 견고한 JSON 복구기(경량화).
    모델이 생성한 느슨한 JSON을 표준 JSON에 가깝게 보정한다.
    """
    s = json_str
    # 1) 키에 큰따옴표 추가
    s = re.sub(r'([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:', r'\1"\2":', s)
    # 2) 작은따옴표 → 큰따옴표
    s = s.replace("'", '"')
    # 3) 후행 쉼표 제거
    s = re.sub(r',\s*}', '}', s)
    s = re.sub(r',\s*]', ']', s)
    # 4) 괄호 보정
    open_b, close_b = s.count('{'), s.count('}')
    if open_b > close_b:
        s += '}' * (open_b - close_b)
    open_a, close_a = s.count('['), s.count(']')
    if open_a > close_a:
        s += ']' * (open_a - close_a)
    # 5) 숫자 따옴표 제거
    s = re.sub(r':\s*"(-?\d+\.?\d*)"', r':\1', s)
    return s


def extract_last_json_block(text: str) -> str | None:
    """
    텍스트에서 마지막 JSON 객체 블록을 찾아 원문 문자열로 반환한다.
    ```json ... ``` 형태나 중괄호 블록 모두 지원.
    """
    code_fenced = list(re.finditer(r"```json\s*([\s\S]*?)\s*```", text, re.IGNORECASE))
    if code_fenced:
        return code_fenced[-1].group(1)
    # fallback: 가장 마지막 중괄호 블록 (얕은 탐색)
    last_open = text.rfind('{')
    last_close = text.rfind('}')
    if last_open != -1 and last_close != -1 and last_close > last_open:
        return text[last_open:last_close + 1]
    return None


