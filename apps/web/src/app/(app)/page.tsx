import { MarketsIndex } from "@/features/markets/MarketsIndex";

export const metadata = { title: "Markets" };

/** The entry: every market, for everyone. */
export default function Page() {
  return <MarketsIndex />;
}
