import { permanentRedirect } from "next/navigation";

/** Retired: test funds are a step where a wallet would trade, not a page. */
export default function Page(): never {
  permanentRedirect("/");
}
