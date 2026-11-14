import { PageHeader } from "@/components/shell/Shell";
import { EmptyState } from "@/components/ui/EmptyState";

export default function Page() {
  return (
    <>
      <PageHeader title="Market">One market: the question, the price to beat, the countdown and the order ticket.</PageHeader>
      <EmptyState>The order ticket for this market will appear here.</EmptyState>
    </>
  );
}
