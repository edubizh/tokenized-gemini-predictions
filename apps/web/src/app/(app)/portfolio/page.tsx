import { PageHeader } from "@/components/shell/Shell";
import { EmptyState } from "@/components/ui/EmptyState";

export default function Page() {
  return (
    <>
      <PageHeader title="Portfolio">Your test-dollar balance and your outcome tokens.</PageHeader>
      <EmptyState>Your positions will be listed here once you hold outcome tokens.</EmptyState>
    </>
  );
}
