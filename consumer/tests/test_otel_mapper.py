from domain.otel_mapper import map_spans_to_trajectory


def test_map_spans_to_trajectory_orders_and_computes_latency() -> None:
    spans = [
        {
            "span_id": "b",
            "parent_span_id": "a",
            "name": "tool_call",
            "start_time": "2026-02-28T10:00:02Z",
            "end_time": "2026-02-28T10:00:03Z",
            "status": "ok",
            "attributes": {"tool.name": "search"},
            "raw": {"events": [{"name": "start"}]},
        },
        {
            "span_id": "a",
            "parent_span_id": None,
            "name": "root",
            "start_time": "2026-02-28T10:00:01Z",
            "end_time": "2026-02-28T10:00:04Z",
            "status": "ok",
            "attributes": {"benchmark.run_case_id": "7"},
            "raw": {},
        },
    ]

    trajectory = map_spans_to_trajectory(spans)
    assert len(trajectory) == 2
    assert trajectory[0]["step"] == 1
    assert trajectory[0]["span_id"] == "a"
    assert trajectory[1]["span_id"] == "b"
    assert trajectory[1]["latency_ms"] == 1000
    assert trajectory[1]["attributes"]["tool.name"] == "search"
