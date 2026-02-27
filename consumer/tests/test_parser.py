from domain.parser import parse_message


def test_parse_message_with_mock_config() -> None:
    payload = {
        "message_type": "experiment.run.requested",
        "schema_version": "v2",
        "message_id": "m1",
        "produced_at": "2024-01-01T00:00:00Z",
        "source": {"service": "platform", "queue": "q"},
        "experiment": {"id": 1, "triggered_by": "u"},
        "dataset": {"id": 2, "name": "d"},
        "agent": {
            "id": 3,
            "name": "a",
            "agent_key": "k",
            "version": "v",
            "runtime_spec_json": {"agent_image": "busybox:latest", "runtime_type": "agno_docker"},
        },
        "scorers": [],
        "run_cases": [
            {
                "run_case_id": 10,
                "data_item_id": 20,
                "attempt_no": 1,
                "session_jsonl": "[]",
                "user_input": "hi",
                "trace_id": None,
                "reference_trajectory": [],
                "reference_output": {},
                "mock_config": {
                    "routes": [
                        {"path": "/healthz", "method": "GET", "status_code": 200, "body": "ok"}
                    ]
                },
            }
        ],
        "consumer_hints": {},
    }
    msg = parse_message(payload)
    assert msg.run_cases[0].mock_config is not None
    assert msg.run_cases[0].mock_config.routes[0].path == "/healthz"
