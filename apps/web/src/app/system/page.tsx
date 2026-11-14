import { PageHeader, Shell } from "@/components/shell/Shell";
import { EmptyState } from "@/components/ui/EmptyState";

export const metadata = { title: "How it works" };

export default function SystemPage() {
  return (
    <Shell>
      <PageHeader title="How it works">
        A program on Solana devnet holds each order's test dollars. A relayer places the matching order on an exchange sandbox, and tokens are minted only after that order fills. The relayer is trusted to report fills and results honestly; the program limits what it can do to any one order.
      </PageHeader>
      <EmptyState>Relayer status, the reconciliation table and the program's addresses will be shown here.</EmptyState>
    </Shell>
  );
}
