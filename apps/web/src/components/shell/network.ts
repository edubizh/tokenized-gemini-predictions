// The words of the quiet test-network notice: the network mark in the navbar and the venue line in
// the footer. The venue is the one the relayer trades on, as it reports it in `/health`: the
// exchange sandbox, or a simulated venue.

export type Venue = "sandbox" | "mock";
export type Cluster = "devnet" | "localnet";

/** The standing line of the footer. */
export const DISCLAIMER = "Unofficial demo. Not affiliated with any exchange. Test tokens with no value.";

/** The network mark: its full wording, and the short one used where the navbar is narrow. */
export function networkMark(cluster: Cluster): { full: string; short: string } {
  return cluster === "devnet" ? { full: "Solana devnet · test funds", short: "Devnet · test funds" } : { full: "Local validator · test funds", short: "Localnet · test funds" };
}

/** Where orders go, for the footer. */
export function venueLine(venue: Venue): string {
  return venue === "mock" ? "Orders are placed on a simulated venue." : "Orders are placed on the exchange sandbox.";
}
