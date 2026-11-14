import { MarketPage } from "@/features/markets/MarketPage";

export const metadata = { title: "Market" };

type Props = { params: Promise<{ symbol: string }>; searchParams: Promise<{ side?: string | string[] }> };

export default async function Page({ params, searchParams }: Props) {
  const { symbol } = await params;
  const { side } = await searchParams;
  return <MarketPage key={symbol} symbol={symbol} initialSide={side === "no" ? "NO" : "YES"} />;
}
