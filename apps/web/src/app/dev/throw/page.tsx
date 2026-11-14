import { notFound } from "next/navigation";
import { Thrower } from "./Thrower";

export const metadata = { title: "Error page" };
export const dynamic = "force-dynamic";

/** Development only: a page that throws while drawing, to see the error page. */
export default function ThrowPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <Thrower />;
}
