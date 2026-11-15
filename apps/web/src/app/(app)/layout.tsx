import type { ReactNode } from "react";
import { Shell } from "@/components/shell/Shell";

/** Every page is inside the shell and open to everyone. What belongs to an account asks for a login in place. */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <Shell>{children}</Shell>;
}
