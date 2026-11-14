import { RECONNECT_WORDS, type ReconnectView } from "./reconnect";

/** A short address as `shortAddress` writes it: four characters, an ellipsis, four more. */
const SHORT_ADDRESS = /([1-9A-HJ-NP-Za-km-z]{4}\u2026[1-9A-HJ-NP-Za-km-z]{4})/;

/** What to say beside a Reconnect wallet button, with any address in it set in mono. */
export function ReconnectWords({ reconnect }: { reconnect: ReconnectView }) {
  const parts = (reconnect.problem ?? RECONNECT_WORDS).split(SHORT_ADDRESS);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <span key={index} className="mono">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}
