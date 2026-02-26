import Link from "next/link";
import type { ReactNode } from "react";

type EntityDrawerProps = {
  closeHref: string;
  title: string;
  children: ReactNode;
  closeLabel?: string;
  drawerClassName?: string;
  bodyClassName?: string;
  headerActions?: ReactNode;
};

export function EntityDrawer({
  closeHref,
  title,
  children,
  closeLabel = "关闭抽屉蒙层",
  drawerClassName = "",
  bodyClassName = "",
  headerActions
}: EntityDrawerProps) {
  return (
    <div className="action-overlay">
      <Link href={closeHref} className="action-overlay-dismiss" aria-label={closeLabel} />
      <aside className={`action-drawer ${drawerClassName}`.trim()}>
        <div className="action-drawer-header">
          <h3>{title}</h3>
          <div className="action-drawer-header-actions">
            {headerActions}
            <Link href={closeHref} className="icon-btn" aria-label="关闭">
              <span style={{ fontSize: 18, lineHeight: 1 }}>×</span>
            </Link>
          </div>
        </div>
        <div className={`action-drawer-body ${bodyClassName}`.trim()}>{children}</div>
      </aside>
    </div>
  );
}
