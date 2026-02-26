import { dbQuery } from "@/lib/db";
import { requireUser } from "@/lib/supabase-auth";
import { AgentIcon, DatasetIcon, FlaskIcon, JudgeIcon, TraceIcon } from "./components/icons";

export default async function HomePage() {
  await requireUser();

  const [datasets, items, agents, evaluators, experiments, runs, traces] = await Promise.all([
    dbQuery<{ c: string }>("SELECT CAST(COUNT(*) AS CHAR) AS c FROM datasets WHERE deleted_at IS NULL"),
    dbQuery<{ c: string }>("SELECT CAST(COUNT(*) AS CHAR) AS c FROM data_items WHERE deleted_at IS NULL"),
    dbQuery<{ c: string }>("SELECT CAST(COUNT(*) AS CHAR) AS c FROM agents WHERE deleted_at IS NULL"),
    dbQuery<{ c: string }>("SELECT CAST(COUNT(*) AS CHAR) AS c FROM evaluators WHERE deleted_at IS NULL"),
    dbQuery<{ c: string }>("SELECT CAST(COUNT(*) AS CHAR) AS c FROM experiments WHERE deleted_at IS NULL"),
    dbQuery<{ c: string }>("SELECT CAST(COUNT(*) AS CHAR) AS c FROM experiment_runs"),
    dbQuery<{ c: string }>("SELECT CAST(COUNT(*) AS CHAR) AS c FROM traces WHERE deleted_at IS NULL")
  ]);

  const cards = [
    { title: "评测集", value: datasets.rows[0].c, icon: DatasetIcon },
    { title: "DataItems", value: items.rows[0].c, icon: DatasetIcon },
    { title: "Agents", value: agents.rows[0].c, icon: AgentIcon },
    { title: "启用评估器", value: evaluators.rows[0].c, icon: JudgeIcon },
    { title: "实验", value: experiments.rows[0].c, icon: FlaskIcon },
    { title: "运行", value: runs.rows[0].c, icon: FlaskIcon },
    { title: "Trace", value: traces.rows[0].c, icon: TraceIcon }
  ];

  return (
    <div className="grid cols-2">
      {cards.map((card) => (
        <section key={card.title} className="card">
          <div className="muted" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <card.icon width={14} height={14} />
            {card.title}
          </div>
          <div className="stat">{card.value}</div>
        </section>
      ))}

      <section className="card">
        <h2>运行流程</h2>
        <p className="muted">1. 选择 dataset + agent(version)</p>
        <p className="muted">2. 使用 case 的 session_jsonl + user_input 运行</p>
        <p className="muted">3. 产出 trajectory + output 并由 Judge 评分</p>
      </section>

      <section className="card">
        <h2>OpenTelemetry 上报入口</h2>
        <p className="muted">
          Endpoint: <code>POST /api/otel/v1/traces</code>
        </p>
        <p className="muted">支持 OTLP JSON(resourceSpans) 与简化 spans JSON。</p>
      </section>
    </div>
  );
}
