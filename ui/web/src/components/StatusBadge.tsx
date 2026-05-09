import type { Status } from "@/lib/api";

export function StatusBadge({ status }: { status: Status }) {
  switch (status) {
    case "up":
      return <span className="badge-success">● up</span>;
    case "down":
      return <span className="badge-danger">● down</span>;
    case "starting":
      return <span className="badge-warn">● starting</span>;
    case "draining":
      return <span className="badge-warn">● draining</span>;
    default:
      return <span className="badge">unknown</span>;
  }
}
