import { dbQuery } from "@/lib/db";
import { requireUser } from "@/lib/supabase-auth";
import { AgentIcon, DatasetIcon, FlaskIcon, JudgeIcon, TraceIcon } from "./components/icons";

export default async function HomePage() {
  await requireUser();

  const [datasets, items, agents, evaluators, experiments, runs, traces, logs] = await Promise.all([
    dbQuery<{ c: string }>("SELECT CAST(COUNT(*) AS CHAR) AS c FROM datasets WHERE deleted_at IS NULL"),
    dbQuery<{ c: string }>("SELECT CAST(COUNT(*) AS CHAR) AS c FROM data_items WHERE deleted_at IS NULL"),
    dbQuery<{ c: string }>("SELECT CAST(COUNT(*) AS CHAR) AS c FROM agents WHERE deleted_at IS NULL"),
    dbQuery<{ c: string }>("SELECT CAST(COUNT(*) AS CHAR) AS c FROM evaluators WHERE deleted_at IS NULL"),
    dbQuery<{ c: string }>("SELECT CAST(COUNT(*) AS CHAR) AS c FROM experiments WHERE deleted_at IS NULL"),
    dbQuery<{ c: string }>("SELECT CAST(COUNT(*) AS CHAR) AS c FROM run_cases WHERE is_latest = TRUE"),
    dbQuery<{ c: string }>("SELECT CAST(COUNT(*) AS CHAR) AS c FROM otel_traces WHERE deleted_at IS NULL"),
    dbQuery<{ c: string }>("SELECT CAST(COUNT(*) AS CHAR) AS c FROM otel_logs WHERE deleted_at IS NULL")
  ]);

  const cards = [
    { title: "评测集", value: datasets.rows[0].c, icon: DatasetIcon },
    { title: "DataItems", value: items.rows[0].c, icon: DatasetIcon },
    { title: "Agents", value: agents.rows[0].c, icon: AgentIcon },
    { title: "启用评估器", value: evaluators.rows[0].c, icon: JudgeIcon },
    { title: "实验", value: experiments.rows[0].c, icon: FlaskIcon },
    { title: "运行", value: runs.rows[0].c, icon: FlaskIcon },
    { title: "OTEL Traces", value: traces.rows[0].c, icon: TraceIcon },
    { title: "OTEL Logs", value: logs.rows[0].c, icon: TraceIcon }
  ];

  return (
    <div className="grid overview-page">
      <section className="page-hero">
        <div className="breadcrumb">平台 / 总览</div>
        <h1>总览</h1>
      </section>

      <section className="overview-kpi-grid">
        {cards.map((card) => (
          <article key={card.title} className="card overview-kpi-card">
            <div className="overview-kpi-head">
              <span className="overview-kpi-icon" aria-hidden>
                <card.icon width={16} height={16} />
              </span>
              <span className="overview-kpi-title">{card.title}</span>
            </div>
            <div className="overview-kpi-value">{card.value}</div>
            <div className="overview-kpi-meta">当前有效记录</div>
          </article>
        ))}
      </section>

      <section className="overview-info-grid">
        <section className="card overview-info-card">
          <h2>运行流程</h2>
          <p>1. 选择 dataset + agent(version)</p>
          <p>2. 使用 case 的 session_jsonl + user_input 运行</p>
          <p>3. 产出 trajectory + output 并由 Judge 评分</p>
        </section>

        <section className="card overview-info-card">
          <h2>OpenTelemetry 上报入口</h2>
          <p>
            Traces: <code>POST /api/otel/v1/traces</code>
          </p>
          <p>
            Logs: <code>POST /api/otel/v1/logs</code>
          </p>
          <p>支持 OTLP JSON(resourceSpans/resourceLogs) 与简化 spans/logs JSON。</p>
        </section>
      </section>
    </div>
  );
}
