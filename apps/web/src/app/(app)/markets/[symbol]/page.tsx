import { MarketPage } from "@/features/markets/MarketPage";
import { ticketIntent } from "@/features/ticket/intent";

export const metadata = { title: "Market" };

type Props = { params: Promise<{ symbol: string }>; searchParams: Promise<{ side?: string | string[]; action?: string | string[] }> };

export default async function Page({ params, searchParams }: Props) {
  const { symbol } = await params;
  const intent = ticketIntent(await searchParams);
  return <MarketPage key={symbol} symbol={symbol} initialSide={intent.side} initialAction={intent.action} />;
}
