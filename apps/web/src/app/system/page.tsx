import { Shell } from "@/components/shell/Shell";
import { SystemPage } from "@/features/system/SystemPage";
import { loadConfig } from "@/lib/config.server";

export const metadata = { title: "How it works" };
export const dynamic = "force-dynamic";

export default function Page() {
  const { public: config, deployment } = loadConfig();
  return (
    <Shell>
      <SystemPage addresses={{ program: config.programId, config: deployment?.config ?? null, stableMint: config.stableMint, treasury: deployment?.treasury ?? null }} />
    </Shell>
  );
}
