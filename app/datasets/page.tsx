import Link from "next/link";
import { revalidatePath } from "next/cache";
import { dbQuery } from "@/lib/db";
import { requireUser } from "@/lib/supabase-auth";
import { FilterIcon, PlusIcon, RefreshIcon, SearchIcon } from "../components/icons";
import { SubmitButton } from "../components/submit-button";

async function createDataset(formData: FormData) {
  "use server";
  const user = await requireUser();

  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  if (!name) return;
  await dbQuery(
    `INSERT INTO datasets (name, description, created_by, updated_by, updated_at)
     SELECT $1, $2, $3, $3, CURRENT_TIMESTAMP
     WHERE NOT EXISTS (SELECT 1 FROM datasets WHERE name = $4)`,
    [name, description, user.id, name]
  );
  revalidatePath("/datasets");
}

async function deleteDataset(formData: FormData) {
  "use server";
  await requireUser();

  const idRaw = String(formData.get("id") ?? "").trim();
  const id = Number(idRaw);
  if (!idRaw || !Number.isInteger(id) || id <= 0) return;
  await dbQuery(`DELETE FROM datasets WHERE id = $1`, [id]);
  revalidatePath("/datasets");
}

export default async function DatasetsPage({
  searchParams
}: {
  searchParams: Promise<{ q?: string; panel?: string }>;
}) {
  await requireUser();

  const { q = "", panel = "none" } = await searchParams;
  const queryText = q.trim();
  const creating = panel === "create";

  const { rows } = await dbQuery<{
    id: number;
    name: string;
    description: string;
    item_count: number;
    created_by: string;
    updated_by: string;
    updated_at: string;
  }>(
    `SELECT
      d.id,
      d.name,
      d.description,
      d.created_by,
      d.updated_by,
      d.updated_at,
      COUNT(i.id) AS item_count
     FROM datasets d
     LEFT JOIN data_items i ON i.dataset_id = d.id
     WHERE ($1 = '' OR LOWER(d.name) LIKE CONCAT('%', LOWER($2), '%'))
     GROUP BY d.id, d.name, d.description, d.created_by, d.updated_by, d.updated_at
     ORDER BY d.updated_at DESC`,
    [queryText, queryText]
  );

  const listHref = `/datasets${queryText ? `?${new URLSearchParams({ q: queryText }).toString()}` : ""}`;
  const createHref = `${listHref}${listHref.includes("?") ? "&" : "?"}panel=create`;

  return (
    <div className="grid">
      <section className="page-hero">
        <div className="breadcrumb">评测 &nbsp;/&nbsp; 评测集</div>
        <h1>评测集</h1>
        <p className="muted">管理数据集、字段结构与版本演进。</p>
      </section>

      <section className="toolbar-row">
        <form action="/datasets" className="search-form">
          <label className="input-icon-wrap">
            <SearchIcon width={16} height={16} />
            <input name="q" defaultValue={queryText} placeholder="搜索名称" />
          </label>
          <button type="submit" className="ghost-btn">
            <FilterIcon width={16} height={16} /> 筛选
          </button>
        </form>

        <div className="action-group">
          <a href={listHref || "/datasets"} className="icon-btn" aria-label="刷新">
            <RefreshIcon width={16} height={16} />
          </a>
          <Link href={createHref} className="primary-btn">
            <PlusIcon width={16} height={16} /> 新建评测集
          </Link>
        </div>
      </section>

      <section className="card table-card">
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>列名</th>
              <th>数据项</th>
              <th>最新版本</th>
              <th>描述</th>
              <th>更新人</th>
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/datasets/${row.id}`} className="link-strong">
                    {row.name}
                  </Link>
                </td>
                <td>
                  <div className="tag-row">
                    <span className="tag">input</span>
                    <span className="tag">reference_output</span>
                    <span className="tag">trajectory</span>
                  </div>
                </td>
                <td>{row.item_count}</td>
                <td>-</td>
                <td className="muted">{row.description || "-"}</td>
                <td>{row.updated_by.slice(0, 8)}</td>
                <td>{new Date(row.updated_at).toLocaleString()}</td>
                <td>
                  <div className="row-actions">
                    <Link href={`/datasets/${row.id}`} className="text-btn">
                      详情
                    </Link>
                    <form action={deleteDataset}>
                      <input type="hidden" name="id" value={row.id} />
                      <SubmitButton className="text-btn danger" pendingText="删除中...">
                        删除
                      </SubmitButton>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {creating ? (
        <div className="action-overlay">
          <Link href={listHref || "/datasets"} className="action-overlay-dismiss" aria-label="关闭抽屉蒙层" />
          <aside className="action-drawer">
            <div className="action-drawer-header">
              <h3>新建评测集</h3>
              <Link href={listHref || "/datasets"} className="icon-btn" aria-label="关闭">
                <span style={{ fontSize: 18, lineHeight: 1 }}>×</span>
              </Link>
            </div>
            <div className="action-drawer-body">
              <p className="muted">创建新的评测集，用于承载 data items 与后续实验运行。</p>
              <form action={createDataset} className="menu-form">
                <input name="name" placeholder="评测集名称" required />
                <textarea name="description" placeholder="描述" />
                <SubmitButton pendingText="创建中...">创建</SubmitButton>
              </form>
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
