import Image from "next/image";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/supabase-auth";
import { sanitizeNextPath } from "@/lib/safe-redirect";
import { DatasetIcon, FlaskIcon, GitHubIcon, GoogleIcon, JudgeIcon, TraceIcon } from "../components/icons";
import brandLogo from "@/app/icon.png";

export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next = "/" } = await searchParams;
  const user = await getCurrentUser();
  if (user) {
    redirect("/");
  }

  const safeNext = sanitizeNextPath(next);
  const features = [
    { icon: DatasetIcon, label: "Datasets 与 DataItems" },
    { icon: JudgeIcon, label: "评估器管理" },
    { icon: TraceIcon, label: "Trace 检索" },
    { icon: FlaskIcon, label: "实验运行" }
  ];

  return (
    <div className="login-wrap login-wrap-v3">
      <div className="login-gradient" />
      <section className="login-card login-card-v3">
        <div className="login-main-grid">
          <div className="login-copy">
            <h1>Agent Benchmark</h1>
            <p className="login-lead">
              一站式管理评测集、评估器、Trace 与实验任务，
              <span className="nowrap-cn">清晰对比</span>每次版本迭代的效果变化，并基于统一视图快速定位问题样本、验证优化是否真正生效。
            </p>

            <div className="login-feature-grid">
              {features.map((item) => (
                <div className="login-feature" key={item.label}>
                  <item.icon width={14} height={14} />
                  {item.label}
                </div>
              ))}
            </div>

            <div className="login-data-pills">
              <span>Dataset</span>
              <span>Evaluator</span>
              <span>Trace</span>
              <span>Experiment</span>
            </div>
          </div>

          <aside className="login-auth-pane">
            <div className="login-auth-logo">
              <Image src={brandLogo} alt="Agent Benchmark" width={40} height={40} />
            </div>
            <h2>登录 HaitAI</h2>
            <p>选择你的账号继续访问</p>
            <div className="login-auth-divider" />
            <div className="login-auth-meta">
              <span>统一账号</span>
              <span>权限同步</span>
              <span>秒级登录</span>
            </div>

            <div className="login-cta-row">
              <a href={`/auth/login?provider=github&next=${encodeURIComponent(safeNext)}`} className="oauth-btn oauth-btn-github">
                <GitHubIcon width={16} height={16} />
                使用 GitHub 登录
              </a>
              <a href={`/auth/login?provider=google&next=${encodeURIComponent(safeNext)}`} className="oauth-btn oauth-btn-google">
                <GoogleIcon width={16} height={16} />
                使用 Google 登录
              </a>
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}
