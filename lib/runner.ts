import { dbQuery, withTransaction } from "./db";
import { scoreByEvaluators } from "./judges";

type RunSummary = {
  itemCount: number;
  avgScore: number;
  successCount: number;
};

function isEnvBuildable(snapshot: unknown) {
  if (snapshot && typeof snapshot === "object") return true;
  if (typeof snapshot === "string") return snapshot.trim().length > 0;
  return false;
}

export async function runExperiment(experimentId: string) {
  try {
    return await withTransaction(async (tx) => {
      const exp = await tx.query<{
      id: string;
      dataset_id: string;
      agent_version: string;
      name: string;
      }>(
        `SELECT id, dataset_id, agent_version, name FROM experiments WHERE id = $1`,
        [experimentId]
      );

      if (exp.rowCount === 0) {
        throw new Error("Experiment not found");
      }

      await tx.query(`UPDATE experiments SET status = 'running' WHERE id = $1`, [experimentId]);

      const runId = crypto.randomUUID();
      await tx.query(
        `INSERT INTO experiment_runs (id, experiment_id, status) VALUES ($1, $2, 'running')`,
        [runId, experimentId]
      );

      const items = await tx.query<{
        id: string;
        environment_snapshot: unknown;
        user_input: string;
        agent_trajectory: unknown;
        agent_output: unknown;
      }>(
        `SELECT id, environment_snapshot, user_input, agent_trajectory, agent_output
         FROM data_items WHERE dataset_id = $1 ORDER BY created_at ASC`,
        [exp.rows[0].dataset_id]
      );

      const scores: number[] = [];
      let successCount = 0;

      for (const item of items.rows) {
        const environmentBuildStatus = isEnvBuildable(item.environment_snapshot) ? "success" : "failed";
        const inputDeliveryStatus = item.user_input.trim() ? "success" : "failed";

        const judge = await scoreByEvaluators({
          trajectory: item.agent_trajectory,
          agentOutput: item.agent_output,
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
            JSON.stringify(item.agent_trajectory),
            JSON.stringify(item.agent_output),
            JSON.stringify(judge.results),
            judge.finalScore,
            `agent_version=${exp.rows[0].agent_version}; mode=replay`
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
