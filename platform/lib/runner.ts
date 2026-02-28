import { dbQuery, engine, withTransaction } from "./db";
import { listEvaluatorsForExperiment } from "./judges";
import { publishExperimentRunRequested } from "./rabbitmq";

type ExperimentContext = {
  id: number;
  dataset_id: number;
  agent_id: number;
  agent_key: string;
  agent_version: string;
  runtime_spec_json: Record<string, unknown>;
  queue_status: string;
};

type RunCaseInput = {
  id: number;
  user_input: string;
  reference_trajectory: unknown;
  reference_output: unknown;
};

type DataItemForRun = RunCaseInput & {
  session_jsonl: string;
  trace_id: string | null;
};

type ExperimentDispatchReady = {
  kind: "ready";
  runCaseCount: number;
  experiment: {
    id: number;
  };
  dataset: {
    id: number;
    name: string;
  };
  agent: {
    id: number;
    name: string;
    agent_key: string;
    version: string;
    runtime_spec_json: Record<string, unknown>;
  };
  scorers: Array<{ id: number; scorer_key: string; name: string; scorer_config: Record<string, unknown> }>;
  runCases: Array<{
    run_case_id: number;
    data_item_id: number;
    attempt_no: number;
    session_jsonl: string;
    user_input: string;
    trace_id: string | null;
    reference_trajectory: unknown;
    reference_output: unknown;
  }>;
};

type ExperimentDispatchEmpty = {
  kind: "empty";
  runCaseCount: 0;
};

type ExperimentDispatchResult = ExperimentDispatchReady | ExperimentDispatchEmpty;

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

  let nextQueueStatus = "idle";
  let nextFinishedAtSql = "NULL";
  if (total === 0) {
    nextQueueStatus = "idle";
  } else if (running > 0 || pending > 0) {
    nextQueueStatus = "consuming";
  } else if (failed === 0) {
    nextQueueStatus = "done";
    nextFinishedAtSql = "CURRENT_TIMESTAMP";
  } else if (success === 0) {
    nextQueueStatus = "failed";
    nextFinishedAtSql = "CURRENT_TIMESTAMP";
  } else {
    nextQueueStatus = "done";
    nextFinishedAtSql = "CURRENT_TIMESTAMP";
  }

  await tx.query(
    `UPDATE experiments
     SET queue_status = $2,
         finished_at = ${nextFinishedAtSql},
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND deleted_at IS NULL`,
    [experimentId, nextQueueStatus]
  );
}

export async function runExperiment(experimentId: number, _triggeredBy: string) {
  const dispatch: ExperimentDispatchResult = await withTransaction(async (tx) => {
    const exp = await tx.query<ExperimentContext>(
      `SELECT e.id, e.dataset_id, e.agent_id, e.queue_status, a.agent_key, a.version AS agent_version, a.runtime_spec_json
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
    if (experiment.queue_status !== "idle") {
      throw new Error("Experiment already started; use retry failed.");
    }

    const evaluators = await listEvaluatorsForExperiment(experimentId);
    if (evaluators.length === 0) {
      throw new Error("Experiment has no evaluators");
    }
    const scorers = evaluators.map((item) => ({
      id: item.id,
      scorer_key: item.evaluator_key,
      name: item.name,
      scorer_config: {
        prompt_template: item.prompt_template,
        base_url: item.base_url,
        model_name: item.model_name,
        api_style: item.api_style,
        api_key: item.api_key
      }
    }));

    await tx.query(
      `UPDATE experiments
       SET queue_status = 'queued',
           queued_at = CURRENT_TIMESTAMP,
           queue_message_id = NULL,
           started_at = NULL,
           finished_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND deleted_at IS NULL`,
      [experimentId]
    );

    const datasetRow = await tx.query<{ id: number; name: string }>(
      `SELECT id, name FROM datasets WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [experiment.dataset_id]
    );
    const dataset = datasetRow.rows[0];
    if (!dataset) {
      throw new Error("Dataset not found");
    }

    const agentRow = await tx.query<{ id: number; name: string; runtime_spec_json: Record<string, unknown> }>(
      `SELECT id, name, runtime_spec_json FROM agents WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [experiment.agent_id]
    );
    const agent = agentRow.rows[0];
    if (!agent) {
      throw new Error("Agent not found");
    }

    const items = await tx.query<DataItemForRun>(
      `SELECT id, session_jsonl, user_input, trace_id, reference_trajectory, reference_output
       FROM data_items
       WHERE dataset_id = $1 AND deleted_at IS NULL
       ORDER BY created_at ASC`,
      [experiment.dataset_id]
    );

    if (items.rows.length === 0) {
      await tx.query(
        `UPDATE experiments
         SET queue_status = 'idle',
             queue_message_id = NULL,
             queued_at = NULL,
             started_at = NULL,
             finished_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND deleted_at IS NULL`,
        [experimentId]
      );
      return { kind: "empty", runCaseCount: 0 };
    }

    const runCases: Array<{
      run_case_id: number;
      data_item_id: number;
      attempt_no: number;
      session_jsonl: string;
      user_input: string;
      trace_id: string | null;
      reference_trajectory: unknown;
      reference_output: unknown;
    }> = [];

    for (const item of items.rows) {
      const runCaseId = await insertAndGetId(
        tx as unknown as Tx,
        `INSERT INTO run_cases (
          experiment_id, data_item_id, agent_id, attempt_no, is_latest, status,
          created_at, updated_at
        ) VALUES ($1, $2, $3, 1, TRUE, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [experiment.id, item.id, experiment.agent_id]
      );
      if (!runCaseId) {
        throw new Error(`Failed to create run_case for data_item=${item.id}`);
      }
      runCases.push({
        run_case_id: runCaseId,
        data_item_id: item.id,
        attempt_no: 1,
        session_jsonl: item.session_jsonl,
        user_input: item.user_input,
        trace_id: item.trace_id,
        reference_trajectory: item.reference_trajectory,
        reference_output: item.reference_output
      });
    }

    return {
      kind: "ready",
      runCaseCount: items.rows.length,
      experiment: {
        id: experiment.id
      },
      dataset: {
        id: dataset.id,
        name: dataset.name
      },
      agent: {
        id: agent.id,
        name: agent.name,
        agent_key: experiment.agent_key,
        version: experiment.agent_version,
        runtime_spec_json: agent.runtime_spec_json
      },
      scorers,
      runCases
    };
  });

  if (dispatch.kind === "empty") {
    return { runCaseCount: 0, queueMessageId: null };
  }

  let queueResult: { messageId: string; queueName: string };
  try {
    queueResult = await publishExperimentRunRequested({
      experiment_id: dispatch.experiment.id,
      dataset: dispatch.dataset,
      agent: dispatch.agent,
      scorers: dispatch.scorers,
      run_cases: dispatch.runCases,
      triggered_by: _triggeredBy
    });
    await dbQuery(
      `UPDATE experiments
       SET queue_message_id = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND deleted_at IS NULL`,
      [dispatch.experiment.id, queueResult.messageId]
    );
  } catch (error) {
    await withTransaction(async (tx) => {
      await tx.query(
        `UPDATE experiments
         SET queue_status = 'idle',
             queue_message_id = NULL,
             queued_at = NULL,
             started_at = NULL,
             finished_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [dispatch.experiment.id]
      );
      await tx.query(`DELETE FROM run_cases WHERE experiment_id = $1`, [dispatch.experiment.id]);
    });
    throw error;
  }

  return { runCaseCount: dispatch.runCaseCount, queueMessageId: queueResult.messageId };
}

export async function retryFailedRunCases(experimentId: number, _triggeredBy: string) {
  const dispatch = await withTransaction(async (tx) => {
    const exp = await tx.query<ExperimentContext>(
      `SELECT e.id, e.dataset_id, e.agent_id, e.queue_status, a.agent_key, a.version AS agent_version, a.runtime_spec_json
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
    const scorers = evaluators.map((item) => ({
      id: item.id,
      scorer_key: item.evaluator_key,
      name: item.name,
      scorer_config: {
        prompt_template: item.prompt_template,
        base_url: item.base_url,
        model_name: item.model_name,
        api_style: item.api_style,
        api_key: item.api_key
      }
    }));

    await tx.query(
      `UPDATE experiments
       SET queue_status = 'queued',
           queued_at = CURRENT_TIMESTAMP,
           queue_message_id = NULL,
           started_at = NULL,
           finished_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [experimentId]
    );

    const failedLatest = await tx.query<{
      run_case_id: number;
      data_item_id: number;
      attempt_no: number;
      session_jsonl: string;
      user_input: string;
      trace_id: string | null;
      reference_trajectory: unknown;
      reference_output: unknown;
    }>(
      `SELECT rc.id AS run_case_id, rc.data_item_id, rc.attempt_no, di.session_jsonl, di.user_input, di.trace_id, di.reference_trajectory, di.reference_output
       FROM run_cases rc
       JOIN data_items di ON di.id = rc.data_item_id
       WHERE rc.experiment_id = $1
         AND rc.is_latest = TRUE
         AND rc.status = 'failed'
      ORDER BY rc.created_at ASC`,
      [experimentId]
    );

    if (failedLatest.rows.length === 0) {
      await updateExperimentStatus(tx as unknown as Tx, experimentId);
      return { kind: "empty" as const, retried: 0 };
    }

    const datasetRow = await tx.query<{ id: number; name: string }>(
      `SELECT id, name FROM datasets WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [experiment.dataset_id]
    );
    const dataset = datasetRow.rows[0];
    if (!dataset) {
      throw new Error("Dataset not found");
    }

    const agentRow = await tx.query<{ id: number; name: string; runtime_spec_json: Record<string, unknown> }>(
      `SELECT id, name, runtime_spec_json FROM agents WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [experiment.agent_id]
    );
    const agent = agentRow.rows[0];
    if (!agent) {
      throw new Error("Agent not found");
    }

    const runCases: Array<{
      run_case_id: number;
      data_item_id: number;
      attempt_no: number;
      session_jsonl: string;
      user_input: string;
      trace_id: string | null;
      reference_trajectory: unknown;
      reference_output: unknown;
    }> = [];
    const replacedPairs: Array<{ oldRunCaseId: number; newRunCaseId: number }> = [];

    for (const row of failedLatest.rows) {
      await tx.query(`UPDATE run_cases SET is_latest = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [row.run_case_id]);
      const nextAttempt = row.attempt_no + 1;
      const newRunCaseId = await insertAndGetId(
        tx as unknown as Tx,
        `INSERT INTO run_cases (
          experiment_id, data_item_id, agent_id, attempt_no, is_latest, status,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, TRUE, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [experiment.id, row.data_item_id, experiment.agent_id, nextAttempt]
      );
      if (!newRunCaseId) {
        throw new Error(`Failed to create retry run_case for data_item=${row.data_item_id}`);
      }
      replacedPairs.push({ oldRunCaseId: row.run_case_id, newRunCaseId });
      runCases.push({
        run_case_id: newRunCaseId,
        data_item_id: row.data_item_id,
        attempt_no: nextAttempt,
        session_jsonl: row.session_jsonl,
        user_input: row.user_input,
        trace_id: row.trace_id,
        reference_trajectory: row.reference_trajectory,
        reference_output: row.reference_output
      });
    }

    return {
      kind: "ready" as const,
      retried: failedLatest.rows.length,
      experiment: { id: experiment.id },
      dataset: {
        id: dataset.id,
        name: dataset.name
      },
      agent: {
        id: agent.id,
        name: agent.name,
        agent_key: experiment.agent_key,
        version: experiment.agent_version,
        runtime_spec_json: agent.runtime_spec_json
      },
      scorers,
      runCases,
      replacedPairs
    };
  });

  if (dispatch.kind === "empty") {
    return { retried: 0, queueMessageId: null };
  }

  let queueResult: { messageId: string; queueName: string };
  try {
    queueResult = await publishExperimentRunRequested({
      experiment_id: dispatch.experiment.id,
      dataset: dispatch.dataset,
      agent: dispatch.agent,
      scorers: dispatch.scorers,
      run_cases: dispatch.runCases,
      triggered_by: _triggeredBy
    });
    await dbQuery(
      `UPDATE experiments
       SET queue_message_id = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND deleted_at IS NULL`,
      [dispatch.experiment.id, queueResult.messageId]
    );
  } catch (error) {
    await withTransaction(async (tx) => {
      for (const pair of dispatch.replacedPairs) {
        await tx.query(`DELETE FROM run_cases WHERE id = $1`, [pair.newRunCaseId]);
        await tx.query(`UPDATE run_cases SET is_latest = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [pair.oldRunCaseId]);
      }
      await tx.query(
        `UPDATE experiments
         SET queue_message_id = NULL,
             queued_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [dispatch.experiment.id]
      );
      await updateExperimentStatus(tx as unknown as Tx, dispatch.experiment.id);
    });
    throw error;
  }

  return { retried: dispatch.retried, queueMessageId: queueResult.messageId };
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
     SET queue_status = 'failed',
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
