import { Suspense } from "react";
import { MarketsIndex, MarketsLoading } from "@/features/markets/MarketsIndex";

export const metadata = { title: "Markets" };

/** The entry: every market, for everyone. The filters live in the query string, read in the browser. */
export default function Page() {
  return (
    <Suspense fallback={<MarketsLoading />}>
      <MarketsIndex />
    </Suspense>
  );
}
