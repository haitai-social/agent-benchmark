import { revalidatePath } from "next/cache";
import { dbQuery } from "@/lib/db";
import { runExperiment } from "@/lib/runner";
import { requireUser } from "@/lib/supabase-auth";
import { FlaskIcon } from "@/app/components/icons";

async function runNow(formData: FormData) {
  "use server";
  const user = await requireUser();

  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await runExperiment(id, user.id);
  revalidatePath(`/experiments/${id}`);
  revalidatePath("/experiments");
}

export default async function ExperimentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();

  const { id } = await params;

  const [exp, runs, latestRunItems] = await Promise.all([
    dbQuery<{
      id: string;
      name: string;
      dataset_name: string;
      agent_version: string;
      status: string;
      created_at: string;
    }>(
      `SELECT e.id, e.name, d.name AS dataset_name, e.agent_version, e.status, e.created_at
       FROM experiments e JOIN datasets d ON d.id = e.dataset_id
       WHERE e.id = $1`,
      [id]
    ),
    dbQuery<{ id: string; status: string; started_at: string; finished_at: string | null; summary: Record<string, unknown> }>(
      `SELECT id, status, started_at, finished_at, summary
       FROM experiment_runs WHERE experiment_id = $1 ORDER BY started_at DESC`,
      [id]
    ),
    dbQuery<{
      run_id: string;
      data_item_id: string;
      final_score: number;
      environment_build_status: string;
      input_delivery_status: string;
      judge_scores: unknown;
      logs: string;
    }>(
      `SELECT r.run_id, r.data_item_id, r.final_score, r.environment_build_status, r.input_delivery_status, r.judge_scores, r.logs
       FROM run_item_results r
       JOIN experiment_runs er ON er.id = r.run_id
       WHERE er.experiment_id = $1
       ORDER BY r.created_at DESC LIMIT 200`,
      [id]
    )
  ]);

  if (exp.rowCount === 0) {
    return <section className="card">实验不存在</section>;
  }

  const e = exp.rows[0];

  return (
    <div className="grid">
      <section className="card">
        <h2 style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <FlaskIcon width={16} height={16} />
          {e.name}
        </h2>
        <p className="muted">评测集: {e.dataset_name}</p>
        <p className="muted">
          Agent版本: <code>{e.agent_version}</code> | 状态: {e.status}
        </p>
        <form action={runNow}>
          <input type="hidden" name="id" value={id} />
          <button type="submit">运行实验</button>
        </form>
      </section>

      <section className="card">
        <h3 style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <FlaskIcon width={14} height={14} />
          运行记录
        </h3>
        <table>
          <thead>
            <tr>
              <th>Run ID</th>
              <th>状态</th>
              <th>开始/结束</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            {runs.rows.map((run) => (
              <tr key={run.id}>
                <td><code>{run.id}</code></td>
                <td>{run.status}</td>
                <td>
                  <div>{new Date(run.started_at).toLocaleString()}</div>
                  <div className="muted">{run.finished_at ? new Date(run.finished_at).toLocaleString() : "-"}</div>
                </td>
                <td className="muted">{JSON.stringify(run.summary)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h3 style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <FlaskIcon width={14} height={14} />
          运行结果明细
        </h3>
        <table>
          <thead>
            <tr>
              <th>Run / Item</th>
              <th>环境构建</th>
              <th>输入下发</th>
              <th>分数</th>
              <th>Judge</th>
              <th>日志</th>
            </tr>
          </thead>
          <tbody>
            {latestRunItems.rows.map((it, idx) => (
              <tr key={`${it.run_id}-${it.data_item_id}-${idx}`}>
                <td>
                  <div><code>{it.run_id.slice(0, 8)}</code></div>
                  <div className="muted"><code>{it.data_item_id.slice(0, 8)}</code></div>
                </td>
                <td>{it.environment_build_status}</td>
                <td>{it.input_delivery_status}</td>
                <td>{it.final_score}</td>
                <td className="muted">{JSON.stringify(it.judge_scores).slice(0, 120)}...</td>
                <td className="muted">{it.logs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
