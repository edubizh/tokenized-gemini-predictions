"use client";

import type { ReactNode } from "react";
import { PageHeader } from "@/components/shell/Shell";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { Skeleton } from "@/components/ui/Skeleton";
import { useAccount } from "@/lib/privy/account";

/**
 * Stands where something belongs to an account, for a visitor who has not logged in: what a login
 * shows, in one sentence, and the way in.
 */
export function LoggedOut({ title, children }: { title: string; children: ReactNode }) {
  const { ready, login } = useAccount();
  return (
    <Notice
      title={title}
      action={
        <Button variant="primary" size="row" onClick={login} disabled={!ready} data-testid="login">
          Log in
        </Button>
      }
    >
      {children}
    </Notice>
  );
}

export interface AccountOnlyProps {
  /** The page's title: "Portfolio". */
  title: string;
  /** What a login shows on this page, in one sentence. */
  sentence: string;
  /** The page, drawn for a logged-in visitor only. */
  children: ReactNode;
}

/** A page that belongs to an account. Everyone can open it; logged out, it is its title and the logged-out state. */
export function AccountOnly({ title, sentence, children }: AccountOnlyProps) {
  const { ready, authenticated } = useAccount();
  if (ready && authenticated) return children;
  return (
    <>
      <PageHeader title={title} />
      {ready ? (
        <LoggedOut title={`Log in to see your ${title.toLowerCase()}`}>{sentence}</LoggedOut>
      ) : (
        <div aria-busy="true">
          <span className="sr-only">Loading your account</span>
          <Skeleton width="100%" height="4.5rem" />
        </div>
      )}
    </>
  );
}
