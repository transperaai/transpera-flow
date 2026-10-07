import { Page } from "@/components/shell/page";
import { PhoneNotice } from "@/components/shell/phone-read-only";
import { demoBundle } from "@/lib/sources/demo";
import { ChurnDriversSettings } from "../../w/[slug]/settings/churn-drivers-settings";

/** Settings, Churn drivers on the demo: Northbeam's clients simulated in this tab, with weights you can move. Nothing is saved. */
export default function DemoChurnDriversPage() {
  return (
    <Page title="Settings" eyebrow="Company">
      <PhoneNotice />
      <ChurnDriversSettings mode="demo" workspaceId={null} bundle={demoBundle()} rows={[]} />
    </Page>
  );
}
