// Hover pop-ups inside an `overflow: hidden` card, for ../tooltip-browser.test.ts: a chart tooltip (the time split by process and the
// revenue line) and a help (i) bubble, in a card that sits against the right and bottom of the window. Nothing here ships.

import { createRoot } from "react-dom/client";
import { Help } from "@/components/help";
import { MrrChart } from "@/components/overview/charts";
import { TimeSplitChart } from "@/components/overview/trend-charts";

declare global {
  interface Window {
    mountTooltips: () => void;
  }
}

const points = [0, 1, 2, 3, 4, 5].map((month) => ({ month, mean: 1000 + month * 400, lo: 900 + month * 300, hi: 1100 + month * 500 }));

window.mountTooltips = () => {
  createRoot(document.getElementById("root")!).render(
    <>
      <div data-card style={{ position: "absolute", right: 0, bottom: 270, width: 360, height: 330, overflow: "hidden", border: "1px solid #888", padding: 8, boxSizing: "border-box" }}>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Help label="Test setting" description="What this setting does, in a sentence." example="An example of it." />
        </div>
        <div data-split-box>
          <TimeSplitChart rows={[{ id: "p", name: "Onboarding", handsOn: 30, waitingForPerson: 50, waitingOnOthers: 20, share: 0.3 }]} months={3} />
        </div>
      </div>
      <div data-card style={{ position: "absolute", right: 0, bottom: 0, width: 360, height: 270, overflow: "hidden", border: "1px solid #888", padding: 8, boxSizing: "border-box" }}>
        <div data-mrr-box>
          <MrrChart points={points} horizonMonths={6} currency="GBP" />
        </div>
      </div>
    </>,
  );
};
