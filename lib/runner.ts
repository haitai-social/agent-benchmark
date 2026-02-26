import { dbQuery, engine, withTransaction } from "./db";
import { listEvaluatorsForExperiment, scoreByEvaluatorList } from "./judges";

type ExperimentContext = {
  id: number;
  dataset_id: number;
  agent_id: number;
  agent_key: string;
  agent_version: string;
  docker_image: string;
  run_locked: boolean;
};

type DataItemForRun = {
  id: number;
  user_input: string;
  reference_trajectory: unknown;
  reference_output: unknown;
};

function asCount(value: unknown) {
  return Number(value ?? 0);
}

type Tx = {
  query: <T>(text: string, params?: unknown[]) => Promise<{ rows: T[]; insertId?: number }>;
};

async function insertAndGetId(tx: Tx, text: string, params: unknown[]) {
  if (engine === "mysql") {
    const inserted = await tx.query(text, params);
    return Number((inserted as { insertId?: number }).insertId ?? 0);
  }
  const inserted = await tx.query<{ id: number }>(`${text} RETURNING id`, params);
  return inserted.rows[0]?.id ?? 0;
}

async function updateExperimentStatus(tx: Tx, experimentId: number) {
  const summary = await tx.query<{
    total_count: number | string;
    running_count: number | string;
    pending_count: number | string;
    success_count: number | string;
    failed_count: number | string;
  }>(
    `SELECT
       COUNT(*) AS total_count,
       SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_count,
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
       SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
     FROM run_cases
     WHERE experiment_id = $1 AND is_latest = TRUE`,
    [experimentId]
  );

  const counts = summary.rows[0];
  const total = asCount(counts?.total_count);
  const running = asCount(counts?.running_count);
  const pending = asCount(counts?.pending_count);
  const success = asCount(counts?.success_count);
  const failed = asCount(counts?.failed_count);

  let nextStatus = "ready";
  let nextFinishedAtSql = "NULL";
  if (total === 0) {
    nextStatus = "ready";
  } else if (running > 0 || pending > 0) {
    nextStatus = "running";
  } else if (failed === 0) {
    nextStatus = "finished";
    nextFinishedAtSql = "CURRENT_TIMESTAMP";
  } else if (success === 0) {
    nextStatus = "failed";
    nextFinishedAtSql = "CURRENT_TIMESTAMP";
  } else {
    nextStatus = "partial_failed";
    nextFinishedAtSql = "CURRENT_TIMESTAMP";
  }

  await tx.query(
    `UPDATE experiments
     SET status = $2,
         finished_at = ${nextFinishedAtSql},
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND deleted_at IS NULL`,
    [experimentId, nextStatus]
  );
}

async function runOneCase(
  tx: Tx,
  experiment: ExperimentContext,
  item: DataItemForRun,
  attemptNo: number,
  evaluators: Array<{ id: number; evaluator_key: string; name: string; prompt_template: string; base_url: string; model_name: string }>
) {
  const runCaseId = await insertAndGetId(
    tx,
    `INSERT INTO run_cases (
      experiment_id, data_item_id, agent_id, attempt_no, is_latest, status,
      started_at, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, TRUE, 'running', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [experiment.id, item.id, experiment.agent_id, attemptNo]
  );

  if (!runCaseId) {
    throw new Error(`Failed to create run_case for data_item=${item.id}`);
  }

  try {
    const replayTrajectory = item.reference_trajectory ?? [];
    const replayOutput = item.reference_output ?? {};
    const startedMs = Date.now();

    const judged = await scoreByEvaluatorList(evaluators, {
      trajectory: replayTrajectory,
      agentOutput: replayOutput,
      tools: [],
      userInput: item.user_input
    });

    for (const result of judged.results) {
      await tx.query(
        `INSERT INTO evaluate_results (run_case_id, evaluator_id, score, reason, raw_result)
         VALUES ($1, $2, $3, $4, $5)`,
        [runCaseId, result.evaluatorId, result.score, result.reason, JSON.stringify(result.raw)]
      );
    }

    const latency = Date.now() - startedMs;
    await tx.query(
      `UPDATE run_cases
       SET status = 'success',
           final_score = $2,
           agent_trajectory = $3,
           agent_output = $4,
           latency_ms = $5,
           input_tokens = $6,
           output_tokens = $7,
           logs = $8,
           finished_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [
        runCaseId,
        judged.finalScore,
        JSON.stringify(replayTrajectory),
        JSON.stringify(replayOutput),
        latency,
        null,
        null,
        `agent=${experiment.agent_key}@${experiment.agent_version}; image=${experiment.docker_image}; mode=replay`
      ]
    );
  } catch (error) {
    await tx.query(
      `UPDATE run_cases
       SET status = 'failed',
           error_message = $2,
           logs = $3,
           finished_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [runCaseId, error instanceof Error ? error.message : String(error), `agent=${experiment.agent_key}; error`]
    );
  }
}

export async function runExperiment(experimentId: number, _triggeredBy: string) {
  return withTransaction(async (tx) => {
    const exp = await tx.query<ExperimentContext>(
      `SELECT e.id, e.dataset_id, e.agent_id, e.run_locked, a.agent_key, a.version AS agent_version, a.docker_image
       FROM experiments e
       JOIN datasets d ON d.id = e.dataset_id AND d.deleted_at IS NULL
       JOIN agents a ON a.id = e.agent_id AND a.deleted_at IS NULL
       WHERE e.id = $1 AND e.deleted_at IS NULL`,
      [experimentId]
    );

    if (exp.rows.length === 0) {
      throw new Error("Experiment not found");
    }

    const experiment = exp.rows[0];
    if (experiment.run_locked) {
      throw new Error("Experiment already started; use retry failed.");
    }

    const evaluators = await listEvaluatorsForExperiment(experimentId);
    if (evaluators.length === 0) {
      throw new Error("Experiment has no evaluators");
    }

    await tx.query(
      `UPDATE experiments
       SET status = 'running', run_locked = TRUE, started_at = CURRENT_TIMESTAMP, finished_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND deleted_at IS NULL`,
      [experimentId]
    );

    const items = await tx.query<DataItemForRun>(
      `SELECT id, user_input, reference_trajectory, reference_output
       FROM data_items
       WHERE dataset_id = $1 AND deleted_at IS NULL
       ORDER BY created_at ASC`,
      [experiment.dataset_id]
    );

    if (items.rows.length === 0) {
      await tx.query(
        `UPDATE experiments
         SET status = 'ready',
             run_locked = FALSE,
             started_at = NULL,
             finished_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND deleted_at IS NULL`,
        [experimentId]
      );
      return { runCaseCount: 0 };
    }

    for (const item of items.rows) {
      await runOneCase(tx as unknown as Tx, experiment, item, 1, evaluators);
    }

    await updateExperimentStatus(tx as unknown as Tx, experimentId);

    return { runCaseCount: items.rows.length };
  });
}

export async function retryFailedRunCases(experimentId: number, _triggeredBy: string) {
  return withTransaction(async (tx) => {
    const exp = await tx.query<ExperimentContext>(
      `SELECT e.id, e.dataset_id, e.agent_id, e.run_locked, a.agent_key, a.version AS agent_version, a.docker_image
       FROM experiments e
       JOIN datasets d ON d.id = e.dataset_id AND d.deleted_at IS NULL
       JOIN agents a ON a.id = e.agent_id AND a.deleted_at IS NULL
       WHERE e.id = $1 AND e.deleted_at IS NULL`,
      [experimentId]
    );

    if (exp.rows.length === 0) {
      throw new Error("Experiment not found");
    }

    const experiment = exp.rows[0];
    const evaluators = await listEvaluatorsForExperiment(experimentId);
    if (evaluators.length === 0) {
      throw new Error("Experiment has no evaluators");
    }

    await tx.query(`UPDATE experiments SET status = 'running', finished_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [experimentId]);

    const failedLatest = await tx.query<{
      run_case_id: number;
      data_item_id: number;
      attempt_no: number;
      user_input: string;
      reference_trajectory: unknown;
      reference_output: unknown;
    }>(
      `SELECT rc.id AS run_case_id, rc.data_item_id, rc.attempt_no, di.user_input, di.reference_trajectory, di.reference_output
       FROM run_cases rc
       JOIN data_items di ON di.id = rc.data_item_id
       WHERE rc.experiment_id = $1
         AND rc.is_latest = TRUE
         AND rc.status = 'failed'
       ORDER BY rc.created_at ASC`,
      [experimentId]
    );

    for (const row of failedLatest.rows) {
      await tx.query(`UPDATE run_cases SET is_latest = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [row.run_case_id]);
      await runOneCase(
        tx as unknown as Tx,
        experiment,
        {
          id: row.data_item_id,
          user_input: row.user_input,
          reference_trajectory: row.reference_trajectory,
          reference_output: row.reference_output
        },
        row.attempt_no + 1,
        evaluators
      );
    }

    await updateExperimentStatus(tx as unknown as Tx, experimentId);

    return { retried: failedLatest.rows.length };
  });
}

export async function refreshExperimentStatus(experimentId: number) {
  return withTransaction(async (tx) => {
    await updateExperimentStatus(tx as unknown as Tx, experimentId);
    return true;
  });
}

export async function markExperimentFailed(experimentId: number, reason: string) {
  await dbQuery(
    `UPDATE experiments
     SET status = 'failed',
         finished_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND deleted_at IS NULL`,
    [experimentId]
  );
  await dbQuery(
    `UPDATE run_cases
     SET status = 'failed', error_message = $2, updated_at = CURRENT_TIMESTAMP
     WHERE experiment_id = $1 AND is_latest = TRUE AND status IN ('pending', 'running')`,
    [experimentId, reason]
  );
}
