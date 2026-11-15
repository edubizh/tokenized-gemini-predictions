import { permanentRedirect } from "next/navigation";

/** The markets are the start page. */
export default function Page(): never {
  permanentRedirect("/");
}
