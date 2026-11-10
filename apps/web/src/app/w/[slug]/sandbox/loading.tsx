import { SandboxSkeleton } from "@/components/shell/skeletons";

/** Shown while the Sandbox's loaders run: the workbench's shape (toolbar, levers pane, verdict, figures and the charts' grid). */
export default function LoadingSandbox() {
  return <SandboxSkeleton />;
}
