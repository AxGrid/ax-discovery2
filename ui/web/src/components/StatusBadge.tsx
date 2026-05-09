import type { Status } from "@/lib/api";
import { Badge } from "@/components/ui";

export function StatusBadge({ status }: { status: Status }) {
  switch (status) {
    case "up":
      return <Badge variant="success" dot>up</Badge>;
    case "down":
      return <Badge variant="danger" dot>down</Badge>;
    case "starting":
      return <Badge variant="warning" dot>starting</Badge>;
    case "draining":
      return <Badge variant="warning" dot>draining</Badge>;
    default:
      return <Badge variant="neutral">unknown</Badge>;
  }
}
