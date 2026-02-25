import { dbQuery } from "@/lib/db";
import { requireUser } from "@/lib/supabase-auth";
import { DatasetIcon, FlaskIcon, JudgeIcon, TraceIcon } from "./components/icons";

export default async function HomePage() {
  await requireUser();

  const [datasets, items, evaluators, experiments, runs, traces] = await Promise.all([
    dbQuery<{ c: string }>("SELECT CAST(COUNT(*) AS CHAR) AS c FROM datasets"),
    dbQuery<{ c: string }>("SELECT CAST(COUNT(*) AS CHAR) AS c FROM data_items"),
    dbQuery<{ c: string }>("SELECT CAST(COUNT(*) AS CHAR) AS c FROM evaluators"),
    dbQuery<{ c: string }>("SELECT CAST(COUNT(*) AS CHAR) AS c FROM experiments"),
    dbQuery<{ c: string }>("SELECT CAST(COUNT(*) AS CHAR) AS c FROM experiment_runs"),
    dbQuery<{ c: string }>("SELECT CAST(COUNT(*) AS CHAR) AS c FROM traces")
  ]);

  const cards = [
    { title: "评测集", value: datasets.rows[0].c, icon: DatasetIcon },
    { title: "数据项", value: items.rows[0].c, icon: DatasetIcon },
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
        <p className="muted">1. 根据 environment-snapshot 构建环境</p>
        <p className="muted">2. 下发 user-input 作为目标</p>
        <p className="muted">3. 使用 trajectory + output + LLM Judge 评分</p>
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
