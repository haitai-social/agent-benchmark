from __future__ import annotations

import json
import logging
import os
import subprocess
from dataclasses import dataclass
from typing import Any

from domain.contracts import CaseExecutionResult
from .config import Settings

logger = logging.getLogger(__name__)


@dataclass
class DbRepository:
    settings: Settings

    @classmethod
    def from_settings(cls, settings: Settings) -> "DbRepository":
        return cls(settings=settings)

    def persist_case_result(
        self,
        *,
        experiment_id: int,
        run_case_id: int,
        result: CaseExecutionResult,
        runtime_snapshot: dict[str, Any],
    ) -> None:
        if self.settings.database_engine == "postgres":
            self._persist_case_result_postgres(
                experiment_id=experiment_id,
                run_case_id=run_case_id,
                result=result,
                runtime_snapshot=runtime_snapshot,
            )
            return
        self._persist_case_result_mysql(
            experiment_id=experiment_id,
            run_case_id=run_case_id,
            result=result,
            runtime_snapshot=runtime_snapshot,
        )

    def _persist_case_result_postgres(
        self,
        *,
        experiment_id: int,
        run_case_id: int,
        result: CaseExecutionResult,
        runtime_snapshot: dict[str, Any],
    ) -> None:
        try:
            import psycopg  # type: ignore
        except Exception as exc:
            raise RuntimeError("E_DB_DRIVER_MISSING: install psycopg[binary] for postgres persistence") from exc

        if not (self.settings.postgres_server and self.settings.postgres_user and self.settings.postgres_db):
            raise RuntimeError("E_DB_CONFIG_MISSING: postgres env vars are not configured")

        dsn = (
            f"host={self.settings.postgres_server} "
            f"port={self.settings.postgres_port} "
            f"user={self.settings.postgres_user} "
            f"password={self.settings.postgres_password or ''} "
            f"dbname={self.settings.postgres_db}"
        )
        with psycopg.connect(dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE run_cases
                       SET status = %s,
                           agent_trajectory = %s::jsonb,
                           agent_output = %s::jsonb,
                           latency_ms = %s,
                           logs = %s,
                           error_message = %s,
                           runtime_snapshot_json = %s::jsonb,
                           inspect_eval_id = %s,
                           inspect_sample_id = %s,
                           usage_json = %s::jsonb,
                           finished_at = CURRENT_TIMESTAMP,
                           updated_at = CURRENT_TIMESTAMP
                     WHERE id = %s
                    """,
                    (
                        result.status,
                        json.dumps(result.trajectory) if result.trajectory is not None else None,
                        json.dumps(result.output) if result.output is not None else None,
                        result.latency_ms,
                        result.logs,
                        result.error_message or None,
                        json.dumps(runtime_snapshot),
                        result.inspect_eval_id or None,
                        result.inspect_sample_id or None,
                        json.dumps(result.usage),
                        run_case_id,
                    ),
                )
                cur.execute("DELETE FROM run_case_scores WHERE run_case_id = %s", (run_case_id,))
                for scorer in result.scorer_results:
                    cur.execute(
                        """
                        INSERT INTO run_case_scores(run_case_id, scorer_key, score, reason, raw_result_json)
                        VALUES (%s, %s, %s, %s, %s::jsonb)
                        """,
                        (
                            run_case_id,
                            str(scorer.get("scorer_key", "unknown")),
                            float(scorer.get("score", 0.0)),
                            str(scorer.get("reason", "")),
                            json.dumps(scorer.get("raw_result", {})),
                        ),
                    )
                if result.scorer_results:
                    cur.execute(
                        "UPDATE run_cases SET final_score = (SELECT AVG(score) FROM run_case_scores WHERE run_case_id = %s) WHERE id = %s",
                        (run_case_id, run_case_id),
                    )
                self._refresh_experiment_status_postgres(cur, experiment_id)
            conn.commit()

    def _refresh_experiment_status_postgres(self, cur: Any, experiment_id: int) -> None:
        cur.execute(
            """
            SELECT
              COUNT(*) AS total_count,
              SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_count,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
              SUM(CASE WHEN status IN ('failed', 'timeout') THEN 1 ELSE 0 END) AS failed_count
            FROM run_cases
            WHERE experiment_id = %s AND is_latest = TRUE
            """,
            (experiment_id,),
        )
        total, running, pending, success, failed = cur.fetchone()
        run_status = "idle"
        if total > 0 and (running > 0 or pending > 0):
            run_status = "consuming"
        elif total > 0 and failed == 0:
            run_status = "done"
        elif total > 0 and success == 0:
            run_status = "failed"
        elif total > 0:
            run_status = "done"
        cur.execute(
            """
            UPDATE experiments
               SET queue_status = %s,
                   finished_at = CASE WHEN %s IN ('done', 'failed') THEN CURRENT_TIMESTAMP ELSE finished_at END,
                   updated_at = CURRENT_TIMESTAMP
             WHERE id = %s
            """,
            (run_status, run_status, experiment_id),
        )

    def _persist_case_result_mysql(
        self,
        *,
        experiment_id: int,
        run_case_id: int,
        result: CaseExecutionResult,
        runtime_snapshot: dict[str, Any],
    ) -> None:
        try:
            import pymysql  # type: ignore
        except Exception as exc:
            logger.warning("code=E_DB_DRIVER_FALLBACK driver=pymysql err=%s", exc)
            self._persist_case_result_mysql_cli(
                experiment_id=experiment_id,
                run_case_id=run_case_id,
                result=result,
                runtime_snapshot=runtime_snapshot,
            )
            return

        if not (self.settings.mysql_server and self.settings.mysql_user and self.settings.mysql_db):
            raise RuntimeError("E_DB_CONFIG_MISSING: mysql env vars are not configured")

        conn = pymysql.connect(
            host=self.settings.mysql_server,
            port=self.settings.mysql_port,
            user=self.settings.mysql_user,
            password=self.settings.mysql_password or "",
            database=self.settings.mysql_db,
            autocommit=False,
        )
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE run_cases
                       SET status = %s,
                           agent_trajectory = %s,
                           agent_output = %s,
                           latency_ms = %s,
                           logs = %s,
                           error_message = %s,
                           runtime_snapshot_json = %s,
                           inspect_eval_id = %s,
                           inspect_sample_id = %s,
                           usage_json = %s,
                           finished_at = CURRENT_TIMESTAMP,
                           updated_at = CURRENT_TIMESTAMP
                     WHERE id = %s
                    """,
                    (
                        result.status,
                        json.dumps(result.trajectory) if result.trajectory is not None else None,
                        json.dumps(result.output) if result.output is not None else None,
                        result.latency_ms,
                        result.logs,
                        result.error_message or None,
                        json.dumps(runtime_snapshot),
                        result.inspect_eval_id or None,
                        result.inspect_sample_id or None,
                        json.dumps(result.usage),
                        run_case_id,
                    ),
                )
                cur.execute("DELETE FROM run_case_scores WHERE run_case_id = %s", (run_case_id,))
                for scorer in result.scorer_results:
                    cur.execute(
                        """
                        INSERT INTO run_case_scores(run_case_id, scorer_key, score, reason, raw_result_json)
                        VALUES (%s, %s, %s, %s, %s)
                        """,
                        (
                            run_case_id,
                            str(scorer.get("scorer_key", "unknown")),
                            float(scorer.get("score", 0.0)),
                            str(scorer.get("reason", "")),
                            json.dumps(scorer.get("raw_result", {})),
                        ),
                    )
                if result.scorer_results:
                    cur.execute(
                        "UPDATE run_cases SET final_score = (SELECT AVG(score) FROM run_case_scores WHERE run_case_id = %s) WHERE id = %s",
                        (run_case_id, run_case_id),
                    )
                self._refresh_experiment_status_mysql(cur, experiment_id)
            conn.commit()
        finally:
            conn.close()

    def _persist_case_result_mysql_cli(
        self,
        *,
        experiment_id: int,
        run_case_id: int,
        result: CaseExecutionResult,
        runtime_snapshot: dict[str, Any],
    ) -> None:
        if not (self.settings.mysql_server and self.settings.mysql_user and self.settings.mysql_db):
            raise RuntimeError("E_DB_CONFIG_MISSING: mysql env vars are not configured")
        if self.settings.mysql_password is None:
            raise RuntimeError("E_DB_CONFIG_MISSING: MYSQL_PASSWORD is not configured")

        def lit(value: Any) -> str:
            if value is None:
                return "NULL"
            if isinstance(value, bool):
                return "1" if value else "0"
            if isinstance(value, (int, float)):
                return str(value)
            text = str(value)
            text = text.replace("\\", "\\\\").replace("'", "\\'")
            return f"'{text}'"

        sql_parts = [
            "START TRANSACTION",
            (
                "UPDATE run_cases SET "
                f"status={lit(result.status)}, "
                f"agent_trajectory={lit(json.dumps(result.trajectory) if result.trajectory is not None else None)}, "
                f"agent_output={lit(json.dumps(result.output) if result.output is not None else None)}, "
                f"latency_ms={lit(result.latency_ms)}, "
                f"logs={lit(result.logs)}, "
                f"error_message={lit(result.error_message or None)}, "
                f"runtime_snapshot_json={lit(json.dumps(runtime_snapshot))}, "
                f"inspect_eval_id={lit(result.inspect_eval_id or None)}, "
                f"inspect_sample_id={lit(result.inspect_sample_id or None)}, "
                f"usage_json={lit(json.dumps(result.usage))}, "
                "finished_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP "
                f"WHERE id={lit(run_case_id)}"
            ),
            f"DELETE FROM run_case_scores WHERE run_case_id={lit(run_case_id)}",
        ]
        for scorer in result.scorer_results:
            sql_parts.append(
                "INSERT INTO run_case_scores(run_case_id, scorer_key, score, reason, raw_result_json) VALUES ("
                f"{lit(run_case_id)}, "
                f"{lit(str(scorer.get('scorer_key', 'unknown')))}, "
                f"{lit(float(scorer.get('score', 0.0)))}, "
                f"{lit(str(scorer.get('reason', '')))}, "
                f"{lit(json.dumps(scorer.get('raw_result', {})))}"
                ")"
            )
        if result.scorer_results:
            sql_parts.append(
                f"UPDATE run_cases SET final_score=(SELECT AVG(score) FROM run_case_scores WHERE run_case_id={lit(run_case_id)}) WHERE id={lit(run_case_id)}"
            )
        sql_parts.extend(
            [
                (
                    "SET @total=(SELECT COUNT(*) FROM run_cases WHERE experiment_id="
                    f"{lit(experiment_id)} AND is_latest=TRUE)"
                ),
                (
                    "SET @running=(SELECT COALESCE(SUM(CASE WHEN status='running' THEN 1 ELSE 0 END),0) "
                    f"FROM run_cases WHERE experiment_id={lit(experiment_id)} AND is_latest=TRUE)"
                ),
                (
                    "SET @pending=(SELECT COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) "
                    f"FROM run_cases WHERE experiment_id={lit(experiment_id)} AND is_latest=TRUE)"
                ),
                (
                    "SET @success=(SELECT COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END),0) "
                    f"FROM run_cases WHERE experiment_id={lit(experiment_id)} AND is_latest=TRUE)"
                ),
                (
                    "SET @failed=(SELECT COALESCE(SUM(CASE WHEN status IN ('failed','timeout') THEN 1 ELSE 0 END),0) "
                    f"FROM run_cases WHERE experiment_id={lit(experiment_id)} AND is_latest=TRUE)"
                ),
                (
                    "SET @run_status=(CASE "
                    "WHEN @total=0 THEN 'idle' "
                    "WHEN @running>0 OR @pending>0 THEN 'consuming' "
                    "WHEN @failed=0 THEN 'done' "
                    "WHEN @success=0 THEN 'failed' "
                    "ELSE 'done' END)"
                ),
                (
                    "UPDATE experiments SET "
                    "queue_status=@run_status, "
                    "finished_at=IF(@run_status IN ('done','failed'), CURRENT_TIMESTAMP, finished_at), "
                    "updated_at=CURRENT_TIMESTAMP "
                    f"WHERE id={lit(experiment_id)}"
                ),
                "COMMIT",
            ]
        )
        sql = ";\n".join(sql_parts) + ";"
        env = dict(os.environ)
        env["MYSQL_PWD"] = self.settings.mysql_password
        proc = subprocess.run(
            [
                "mysql",
                "-h",
                self.settings.mysql_server,
                "-P",
                str(self.settings.mysql_port),
                "-u",
                self.settings.mysql_user,
                self.settings.mysql_db,
                "-e",
                sql,
            ],
            check=False,
            capture_output=True,
            text=True,
            env=env,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"E_DB_PERSIST_CLI: {proc.stderr.strip()}")

    def _refresh_experiment_status_mysql(self, cur: Any, experiment_id: int) -> None:
        cur.execute(
            """
            SELECT
              COUNT(*) AS total_count,
              SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_count,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
              SUM(CASE WHEN status IN ('failed', 'timeout') THEN 1 ELSE 0 END) AS failed_count
            FROM run_cases
            WHERE experiment_id = %s AND is_latest = TRUE
            """,
            (experiment_id,),
        )
        row = cur.fetchone() or (0, 0, 0, 0, 0)
        total, running, pending, success, failed = [int(v or 0) for v in row]
        run_status = "idle"
        if total > 0 and (running > 0 or pending > 0):
            run_status = "consuming"
        elif total > 0 and failed == 0:
            run_status = "done"
        elif total > 0 and success == 0:
            run_status = "failed"
        elif total > 0:
            run_status = "done"
        cur.execute(
            """
            UPDATE experiments
               SET queue_status = %s,
                   finished_at = IF(%s IN ('done', 'failed'), CURRENT_TIMESTAMP, finished_at),
                   updated_at = CURRENT_TIMESTAMP
             WHERE id = %s
            """,
            (run_status, run_status, experiment_id),
        )
