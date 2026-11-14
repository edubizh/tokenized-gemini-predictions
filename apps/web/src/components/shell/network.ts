// The words of the fixed test-network notice. They follow the venue the relayer trades on, as it
// reports it in `/health`: the exchange sandbox, or a simulated venue.

export type Venue = "sandbox" | "mock";

/** Two short sentences; each stays on one line of the strip. */
export function networkNotice(venue: Venue): [string, string] {
  return [venue === "mock" ? "Devnet demo with a simulated venue." : "Devnet and sandbox demo.", "Test tokens with no value."];
}
