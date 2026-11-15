import { notFound } from "next/navigation";
import { EventPage } from "@/features/event/EventPage";
import { eventIntent } from "@/lib/routes";

export const metadata = { title: "Market" };

type Props = { params: Promise<{ event: string }>; searchParams: Promise<{ c?: string | string[]; side?: string | string[]; action?: string | string[] }> };

/** One event, by the venue's event ticker. `?c=` selects a contract, `?side=` a side, `?action=sell` the sell tab. */
export default async function Page({ params, searchParams }: Props) {
  const { event } = await params;
  // The form of a ticker, as the relayer proxy accepts it.
  if (!/^[A-Z0-9]{1,32}$/.test(event)) notFound();
  const intent = eventIntent(await searchParams);
  return <EventPage key={event} ticker={event} contract={intent.contract} initialSide={intent.side} initialAction={intent.action} />;
}
