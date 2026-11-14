import { notFound } from "next/navigation";
import { Shell } from "@/components/shell/Shell";
import { Gallery } from "@/features/gallery/Gallery";

export const metadata = { title: "Design reference" };
export const dynamic = "force-dynamic";

/** Development only: the reference page of the design system, inside the real shell. */
export default function GalleryPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <Shell>
      <Gallery anchorMs={Date.now()} />
    </Shell>
  );
}
