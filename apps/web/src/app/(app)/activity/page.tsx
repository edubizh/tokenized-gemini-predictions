import { PageHeader } from "@/components/shell/Shell";
import { EmptyState } from "@/components/ui/EmptyState";

export default function Page() {
  return (
    <>
      <PageHeader title="Activity">Your orders, newest first, each with its receipt.</PageHeader>
      <EmptyState>Your orders will be listed here after you place the first one.</EmptyState>
    </>
  );
}
