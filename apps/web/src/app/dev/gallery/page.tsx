import { notFound } from "next/navigation";
import { Gallery } from "@/features/gallery/Gallery";

export const metadata = { title: "Component gallery" };
export const dynamic = "force-dynamic";

/** Development only: every component in every state, fed by fixtures. */
export default function GalleryPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <Gallery anchorMs={Date.now()} />;
}
