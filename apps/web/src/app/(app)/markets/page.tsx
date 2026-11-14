import { PageHeader } from "@/components/shell/Shell";
import { EmptyState } from "@/components/ui/EmptyState";

export default function Page() {
  return (
    <>
      <PageHeader title="Markets">Fifteen-minute contracts that can be traded now, with test dollars.</PageHeader>
      <EmptyState>Live markets will be listed here, each with its countdown and its YES and NO prices.</EmptyState>
    </>
  );
}
