import { dbQuery, engine, withTransaction } from "./db";
import { scoreByEvaluators } from "./judges";

type RunSummary = {
  itemCount: number;
  avgScore: number;
  successCount: number;
};

export async function runExperiment(experimentId: number, triggeredBy: string) {
  try {
    return await withTransaction(async (tx) => {
      const exp = await tx.query<{
        id: number;
        dataset_id: number;
        name: string;
        agent_id: number;
        agent_key: string;
        agent_version: string;
        docker_image: string;
      }>(
        `SELECT e.id, e.dataset_id, e.name, e.agent_id, a.agent_key, a.version AS agent_version, a.docker_image
         FROM experiments e
         JOIN agents a ON a.id = e.agent_id
         WHERE e.id = $1`,
        [experimentId]
      );

      if (exp.rowCount === 0) {
        throw new Error("Experiment not found");
      }

      await tx.query(`UPDATE experiments SET status = 'running' WHERE id = $1`, [experimentId]);

      let runId = 0;
      if (engine === "mysql") {
        const inserted = await tx.query(
          `INSERT INTO experiment_runs (experiment_id, status, triggered_by) VALUES ($1, 'running', $2)`,
          [experimentId, triggeredBy]
        );
        runId = Number((inserted as { insertId?: number }).insertId ?? 0);
      } else {
        const inserted = await tx.query<{ id: number }>(
          `INSERT INTO experiment_runs (experiment_id, status, triggered_by) VALUES ($1, 'running', $2) RETURNING id`,
          [experimentId, triggeredBy]
        );
        runId = inserted.rows[0]?.id ?? 0;
      }
      if (!runId) {
        throw new Error("Failed to create experiment run");
      }

      const items = await tx.query<{
        id: number;
        session_jsonl: string;
        user_input: string;
        reference_trajectory: unknown;
        reference_output: unknown;
      }>(
        `SELECT id, session_jsonl, user_input, reference_trajectory, reference_output
         FROM data_items WHERE dataset_id = $1 ORDER BY created_at ASC`,
        [exp.rows[0].dataset_id]
      );

      const scores: number[] = [];
      let successCount = 0;

      for (const item of items.rows) {
        const environmentBuildStatus = "success";
        const inputDeliveryStatus = item.user_input.trim() ? "success" : "failed";
        const replayTrajectory = item.reference_trajectory ?? [];
        const replayOutput = item.reference_output ?? {};

        const judge = await scoreByEvaluators({
          trajectory: replayTrajectory,
          agentOutput: replayOutput,
          tools: [],
          userInput: item.user_input
        });

        if (judge.finalScore >= 0.9) {
          successCount += 1;
        }
        scores.push(judge.finalScore);

        await tx.query(
          `INSERT INTO run_item_results (
            run_id, data_item_id, environment_build_status, input_delivery_status,
            agent_trajectory, agent_output, judge_scores, final_score, logs
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            runId,
            item.id,
            environmentBuildStatus,
            inputDeliveryStatus,
            JSON.stringify(replayTrajectory),
            JSON.stringify(replayOutput),
            JSON.stringify(judge.results),
            judge.finalScore,
            `agent=${exp.rows[0].agent_key}@${exp.rows[0].agent_version}; image=${exp.rows[0].docker_image}; mode=replay`
          ]
        );
      }

      const avg = scores.length ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(3)) : 0;
      const summary: RunSummary = {
        itemCount: items.rows.length,
        avgScore: avg,
        successCount
      };

      await tx.query(
        `UPDATE experiment_runs
         SET status = 'finished', finished_at = CURRENT_TIMESTAMP, summary = $2
         WHERE id = $1`,
        [runId, JSON.stringify(summary)]
      );

      await tx.query(`UPDATE experiments SET status = 'ready' WHERE id = $1`, [experimentId]);

      return { runId, summary };
    });
  } catch (error) {
    await dbQuery(`UPDATE experiments SET status = 'failed' WHERE id = $1`, [experimentId]);
    throw error;
  }
}
