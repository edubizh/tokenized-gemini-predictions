"use client";

import { useEffect } from "react";
import { ProblemView } from "@/components/shell/Problem";
import { Shell } from "@/components/shell/Shell";
import { Button } from "@/components/ui/Button";

/** Shown in place of a page that threw while drawing. Nothing is signed or sent by drawing a page. */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset(): void }) {
  useEffect(() => {
    document.title = "Something went wrong · Outcome Tokens";
    console.error(error);
  }, [error]);

  return (
    <Shell>
      <ProblemView kind="Something went wrong" title="This page could not be shown" action={<Button onClick={reset}>Try again</Button>}>
        The app hit an error while drawing this page; nothing was signed or sent, and what you hold on Solana is unchanged.
      </ProblemView>
    </Shell>
  );
}
