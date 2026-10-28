import { notFound } from "next/navigation";
import { bundleForProcess } from "@transpera-flow/db";
import { DemoFirstPrinciplesFlow } from "@/components/first-principles/flow-clients";
import { demoBundle } from "@/lib/sources/demo";

/**
 * The first-principles flow for one of the Northbeam sample's processes (issue #119): no database, answers kept in
 * this tab. The pipeline starts with a worked example; the others start empty.
 */
export default async function DemoFirstPrinciplesPage(props: PageProps<"/demo/p/[processId]/first-principles">) {
  const { processId } = await props.params;
  const bundle = bundleForProcess(demoBundle(), processId);
  if (!bundle) notFound();
  return (
    <DemoFirstPrinciplesFlow
      key={bundle.process.id}
      processId={bundle.process.id}
      bundle={bundle}
      processHref={`/demo/p/${bundle.process.id}`}
      processesHref="/demo/processes"
      peopleHref="/demo/people"
    />
  );
}
