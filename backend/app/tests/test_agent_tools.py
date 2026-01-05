from __future__ import annotations

import pytest

from backend.app.agent.tools import Tools
from backend.app.agent.agent_loop import AgentLoop


def test_draw_point_and_remove_by_id():
    tools = Tools()
    loop = AgentLoop(tools)

    res = loop.run_action({
        "tool": "draw",
        "spec": {"type": "point", "x": 1, "y": 2}
    })
    assert res["count"] == 1
    item_id = res["ids"][0]
    assert tools.get_item(item_id) is not None

    rem = loop.run_action({
        "tool": "remove",
        "spec": {"id": item_id}
    })
    assert rem["count"] == 1
    assert tools.get_item(item_id) is None


def test_draw_batch_and_remove_by_type_and_query():
    tools = Tools()
    loop = AgentLoop(tools)

    res = loop.run_action({
        "tool": "draw",
        "specs": [
            {"type": "segment", "p1": [0, 0], "p2": [1, 1], "style": {"dash": True}},
            {"type": "segment", "p1": [1, 0], "p2": [2, 1]},
            {"type": "circle", "center": [0, 0], "radius": 2},
            {"type": "text", "text": "hi", "at": [0, 0]},
        ],
    })
    assert res["count"] == 4

    # remove by type
    rem_seg = loop.run_action({
        "tool": "remove",
        "spec": {"type": "byType", "value": "segment"}
    })
    assert rem_seg["count"] == 2

    # remove by query
    rem_text = loop.run_action({
        "tool": "remove",
        "spec": {"query": {"type": "text", "text": "hi"}}
    })
    assert rem_text["count"] == 1


def test_remove_all():
    tools = Tools()
    loop = AgentLoop(tools)

    loop.run_action({
        "tool": "draw",
        "specs": [
            {"type": "point", "x": 1, "y": 1},
            {"type": "line", "p1": [0, 0], "p2": [1, 0]},
            {"type": "vector", "from": [0, 0], "to": [1, 1]},
        ],
    })

    assert len(tools.get_all_items()) == 3

    rem_all = loop.run_action({
        "tool": "remove",
        "spec": {"type": "all"}
    })
    assert rem_all["count"] == 3
    assert len(tools.get_all_items()) == 0


