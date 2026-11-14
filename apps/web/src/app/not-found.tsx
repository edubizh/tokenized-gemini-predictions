import { Shell } from "@/components/shell/Shell";
import { ProblemView } from "@/components/shell/Problem";
import { ButtonLink } from "@/components/ui/Button";

export const metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <Shell>
      <ProblemView kind="Page not found" title="There is nothing at this address" action={<ButtonLink href="/">Back to the start</ButtonLink>}>
        The link may be mistyped, or it pointed to something this demo no longer keeps.
      </ProblemView>
    </Shell>
  );
}
