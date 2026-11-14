"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { Shell } from "@/components/shell/Shell";
import { Notice } from "@/components/ui/Notice";
import { Skeleton } from "@/components/ui/Skeleton";
import { RelayerNotice } from "@/features/markets/RelayerNotice";
import { useConfig } from "@/lib/config";
import { useAccount } from "@/lib/privy/account";

type Verdict = "loading" | "to_landing" | "to_welcome" | "allow";

/**
 * Every page in this group needs a login and a registered trader. Not logged in: back to `/`.
 * No Trader account (or nothing deployed yet): to `/welcome`, which explains what to do.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  const config = useConfig();
  const account = useAccount();
  const pathname = usePathname();
  const router = useRouter();
  const onWelcome = pathname === "/welcome";

  let verdict: Verdict;
  if (!account.ready) verdict = "loading";
  else if (!account.authenticated) verdict = "to_landing";
  else if (onWelcome) verdict = "allow";
  else if (!config.bootstrapped) verdict = "to_welcome";
  else if (!account.wallet || account.trader === "unknown") verdict = "loading";
  else if (account.trader === "missing") verdict = "to_welcome";
  else verdict = "allow";

  useEffect(() => {
    if (verdict === "to_landing") router.replace("/");
    if (verdict === "to_welcome") router.replace("/welcome");
  }, [verdict, router]);

  return (
    <Shell>
      {verdict === "allow" ? (
        <>
          <RelayerNotice />
          {children}
        </>
      ) : (
        <div aria-busy="true" style={{ display: "grid", gap: "var(--space-3)" }}>
          <span className="sr-only">Loading your account</span>
          {account.stale && (
            <Notice tone="caution" title="Solana devnet is not answering">
              Your account could not be read yet. The app keeps trying; nothing is lost.
            </Notice>
          )}
          <Skeleton width="12rem" height="1.95rem" />
          <span />
          <Skeleton width="100%" height="56px" />
          <Skeleton width="100%" height="56px" />
          <Skeleton width="100%" height="56px" />
        </div>
      )}
    </Shell>
  );
}
