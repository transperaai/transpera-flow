import { describe, expect, it } from "vitest";
import { priceRiseTradeoff } from "@/lib/sandbox/price-rise";

// The price rise's trade-off (docs/plans/sandbox-p3-brief.md §2.5), by hand: two replications of three months, a rise in month 1.
//   with the rise:    revenue [10,12,12] and [10,11,13]; the rise's own part [0,3,3] and [0,2,2]; one client lost in month 1 of the first.
//   without the rise: revenue [10,10,10] both; nobody lost.
//   gained = the rise part: 6 and 4 (mean 5).  net = revenue difference: 4 and 4 (mean 4).  lost = gained - net: 2 and 0 (mean 1).
//   extra leavers: 1 and 0 (mean 0.5).  Loss per leaver = (2 + 0) / (1 + 0) = 2.  Break-even = 5 / 2 = 2.5 leavers.
const withRise = { revenue: [[10, 12, 12], [10, 11, 13]], rise: [[0, 3, 3], [0, 2, 2]], clientsLost: [[0, 1, 0], [0, 0, 0]] };
const without = { revenue: [[10, 10, 10], [10, 10, 10]], rise: [[0, 0, 0], [0, 0, 0]], clientsLost: [[0, 0, 0], [0, 0, 0]] };

describe("priceRiseTradeoff", () => {
  it("is gained, lost and net by month and for the run, with the extra leavers", () => {
    const t = priceRiseTradeoff(withRise, without, [1])!;
    expect(t.gained.map((s) => s.mean)).toEqual([0, 2.5, 2.5]);
    expect(t.net.map((s) => s.mean)).toEqual([0, 1.5, 2.5]);
    expect(t.lost.map((s) => s.mean)).toEqual([0, 1, 0]);
    expect(t.extraLeavers.map((s) => s.mean)).toEqual([0, 0.5, 0]);
    expect([t.total.gained.mean, t.total.net.mean, t.total.lost.mean, t.total.extraLeavers.mean]).toEqual([5, 4, 1, 0.5]);
    expect(t.firstRise).toBe(1);
  });

  it("reads float noise between two runs as nothing: the months before the rise are exactly 0", () => {
    const noisy = { revenue: [[10 + 1e-12, 12], [10 - 3e-12, 11]], rise: [[0, 3], [0, 2]], clientsLost: [[0, 0], [0, 0]] };
    const flat = { revenue: [[10, 10], [10, 10]], rise: [[0, 0], [0, 0]], clientsLost: [[0, 0], [0, 0]] };
    const t = priceRiseTradeoff(noisy, flat, [1])!;
    expect(Object.is(t.net[0]!.mean, 0)).toBe(true);
    expect(t.lost[0]!.mean).toBe(0);
    expect(t.net[1]!.mean).toBe(1.5);
  });

  it("works out the loss per leaver from the run and the break-even: how many extra leavers cancel the gain", () => {
    const t = priceRiseTradeoff(withRise, without, [1])!;
    expect(t).toMatchObject({ lossPerLeaver: 2, breakEven: 2.5, extraNow: 0.5, estimated: false });
    expect(t.breakEvenRate).toBeNull();
    // As a monthly churn: 2.5 extra leavers over 50 client-months after the rise.
    expect(priceRiseTradeoff(withRise, without, [1], { clientMonthsAfter: 50 })!.breakEvenRate).toBeCloseTo(0.05);
  });

  it("estimates the loss per leaver when the rise lost almost nobody: the fee times half the months left, and says so", () => {
    const none = { ...withRise, clientsLost: [[0, 0, 0], [0, 0, 0]] };
    const t = priceRiseTradeoff(none, without, [1], { monthlyFee: 100 })!;
    // Rise in month 1 of 3: two months after it, so 100 x 2 / 2 = 100 per leaver, and 5 gained covers 0.05 of one.
    expect(t).toMatchObject({ estimated: true, lossPerLeaver: 100, extraNow: 0 });
    expect(t.breakEven).toBeCloseTo(0.05);
  });

  it("has a loss per leaver of 0 and a break-even of 0 without a fee to estimate by, and is null with no rise or no run", () => {
    expect(priceRiseTradeoff({ ...withRise, clientsLost: [[0, 0, 0], [0, 0, 0]] }, without, [1])).toMatchObject({ lossPerLeaver: 0, breakEven: 0 });
    expect(priceRiseTradeoff(withRise, without, [])).toBeNull();
    expect(priceRiseTradeoff({ revenue: [], rise: [], clientsLost: [] }, without, [1])).toBeNull();
  });
});
