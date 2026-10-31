"use client";

// The free-play Sandbox's levers, on the left (capacity build P7, brief "The short version"; the prototype's `.levers`). Every change is a new `PlayState`:
// the page re-runs, debounced, and nothing is saved. Market, Win new clients, Lose clients, Prices (with "Clients react", D36), People and Reset.

import { MARKET_PRESETS, type MarketPresetKey } from "@transpera-flow/engine";
import { PRICE_REACTION, defaultPlay, type CapacitySetup, type PlayMarket, type PlayState, type PriceReaction } from "@transpera-flow/db";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { formatNumber } from "@/lib/format";
import type { PlayMonths } from "./play-types";

const FIELD = "flex min-w-0 flex-col gap-1 text-xs text-muted-foreground";

function Group({ title, children, id }: { title: string; children: React.ReactNode; id: string }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-2 border-0 p-0" data-lever-group={id}>
      <legend className="mb-1 font-heading text-sm font-semibold">{title}</legend>
      {children}
    </fieldset>
  );
}

function Slider({ id, label, value, min, max, step, unit, onChange }: { id: string; label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-1 text-sm" data-lever={id}>
      <span className="flex justify-between gap-2">
        {label}
        <b className="tabular-nums" data-lever-value>
          {value > 0 && min < 0 ? "+" : ""}
          {formatNumber(value, 0)}
          {unit}
        </b>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} className="w-full accent-[var(--accent)]" />
    </label>
  );
}

function MonthSelect({ value, months, onChange, label, id, disabled }: { value: number; months: PlayMonths; onChange: (m: number) => void; label: string; id?: string; disabled?: boolean }) {
  return (
    <label className={FIELD}>
      {label}
      <NativeSelect value={value} onChange={(e) => onChange(Number(e.target.value))} data-lever={id} aria-label={label} disabled={disabled}>
        {months.long.map((m, i) => (
          <option key={i} value={i}>
            {m}
          </option>
        ))}
      </NativeSelect>
    </label>
  );
}

export function PlayLevers({
  play,
  setPlay,
  setup,
  months,
  expectedWinsPerMonth,
}: {
  play: PlayState;
  setPlay: (next: PlayState) => void;
  setup: CapacitySetup;
  months: PlayMonths;
  /** What the lead flow brings a month, in clients, for the note under "Win new clients". */
  expectedWinsPerMonth: number | null;
}) {
  const set = (p: Partial<PlayState>) => setPlay({ ...play, ...p });
  const people = setup.people.filter((p) => p.active);
  const roles = setup.roles.filter((r) => r.active !== false);
  const clients = setup.clients.filter((c) => c.active);
  const tiers = setup.tiers;
  const listEdit = <T,>(key: "leavers" | "hires" | "lose", i: number, patch: Partial<T>) =>
    set({ [key]: (play[key] as unknown as T[]).map((x, j) => (j === i ? { ...x, ...patch } : x)) } as Partial<PlayState>);
  const listDel = (key: "leavers" | "hires" | "lose", i: number) => set({ [key]: (play[key] as unknown[]).filter((_, j) => j !== i) } as Partial<PlayState>);

  return (
    <aside aria-label="Levers" className="flex min-w-0 flex-col gap-5 rounded-token border border-line bg-panel p-4" data-play-levers>
      <Group title="Market" id="market">
        <div className="grid grid-cols-2 gap-2">
          <label className={FIELD}>
            Conditions
            <NativeSelect value={play.market} onChange={(e) => set({ market: e.target.value as PlayMarket })} data-lever="market" aria-label="Market conditions">
              <option value="today">As today</option>
              {(Object.keys(MARKET_PRESETS) as MarketPresetKey[]).map((k) => (
                <option key={k} value={k}>
                  {MARKET_PRESETS[k].name}
                </option>
              ))}
            </NativeSelect>
          </label>
          <MonthSelect value={play.marketFrom} months={months} onChange={(m) => set({ marketFrom: m })} label="From" id="marketFrom" />
        </div>
        <Slider id="leads" label="Leads" value={play.leads} min={-50} max={50} step={5} unit="%" onChange={(v) => set({ leads: v })} />
        <Slider id="win" label="Win rate" value={play.win} min={-50} max={50} step={5} unit="%" onChange={(v) => set({ win: v })} />
      </Group>

      <Group title="Win new clients" id="add">
        <div className="grid grid-cols-2 gap-2">
          {setup.departments.map((d) => (
            <label key={d.id} className={FIELD}>
              {d.name} a month
              <Input
                type="number"
                min={0}
                max={50}
                inputMode="numeric"
                value={play.add[d.id] ?? 0}
                onChange={(e) => set({ add: { ...play.add, [d.id]: Math.max(0, Math.min(50, Math.round(Number(e.target.value) || 0))) } })}
                data-lever={`add:${d.id}`}
                aria-label={`${d.name} clients a month`}
              />
            </label>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <MonthSelect value={play.addFrom} months={months} onChange={(m) => set({ addFrom: m })} label="Starting" id="addFrom" />
          <label className={FIELD}>
            For
            <NativeSelect value={play.addMonths} onChange={(e) => set({ addMonths: Number(e.target.value) })} data-lever="addMonths" aria-label="For how many months">
              {[1, 2, 3, 6, 9, 12].map((n) => (
                <option key={n} value={n}>
                  {n} month{n > 1 ? "s" : ""}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className={FIELD}>
            Tier
            <NativeSelect value={play.addTier} onChange={(e) => set({ addTier: e.target.value })} data-lever="addTier" aria-label="Tier of the new clients">
              <option value="mix">Usual mix</option>
              {tiers.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name}
                </option>
              ))}
            </NativeSelect>
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          {expectedWinsPerMonth !== null ? `On top of the ${formatNumber(expectedWinsPerMonth, 1)} a month expected from lead flow. ` : "On top of lead flow. "}
          They go straight to onboarding and servicing, on the least busy people.
        </p>
      </Group>

      <Group title="Lose clients" id="lose">
        <Slider id="churn" label="Churn" value={play.churn} min={-50} max={100} step={5} unit="%" onChange={(v) => set({ churn: v })} />
        {play.lose.map((x, i) => (
          <div key={i} className="grid grid-cols-[1fr_auto_7rem_auto] items-center gap-2" data-lose-row>
            <NativeSelect value={x.id} onChange={(e) => listEdit<{ id: string }>("lose", i, { id: e.target.value })} aria-label="Client who leaves">
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
            <span className="text-xs">leaves in</span>
            <NativeSelect value={x.month} onChange={(e) => listEdit<{ month: number }>("lose", i, { month: Number(e.target.value) })} aria-label="Month they leave">
              {months.long.map((m, j) => (
                <option key={j} value={j}>
                  {m}
                </option>
              ))}
            </NativeSelect>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => listDel("lose", i)} aria-label="Remove">
              ✕
            </Button>
          </div>
        ))}
        {clients.length > 0 && (
          <div>
            <Button type="button" variant="outline" size="sm" data-lever="addLose" onClick={() => set({ lose: [...play.lose, { id: clients[0]!.id, month: 3 }] })}>
              + A named client leaves
            </Button>
          </div>
        )}
      </Group>

      <Group title="Prices" id="price">
        <Slider id="price" label="Price change" value={play.price} min={-20} max={30} step={1} unit="%" onChange={(v) => set({ price: v })} />
        <div className="grid grid-cols-3 gap-2">
          <label className={FIELD}>
            Tiers
            <NativeSelect value={play.priceTier} onChange={(e) => set({ priceTier: e.target.value })} data-lever="priceTier" aria-label="Tiers the price change is for">
              <option value="all">All</option>
              {tiers.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name}
                </option>
              ))}
            </NativeSelect>
          </label>
          <MonthSelect value={play.priceFrom} months={months} onChange={(m) => set({ priceFrom: m })} label="From" id="priceFrom" />
          <label className={FIELD}>
            Clients react
            <NativeSelect value={play.priceReaction} onChange={(e) => set({ priceReaction: e.target.value as PriceReaction })} data-lever="priceReaction" aria-label="How clients react to a price change">
              {(Object.keys(PRICE_REACTION) as PriceReaction[]).map((k) => (
                <option key={k} value={k}>
                  {PRICE_REACTION[k].label}
                </option>
              ))}
            </NativeSelect>
          </label>
        </div>
        <p className="text-xs text-muted-foreground">A rise lifts churn for 3 months. How much depends on the reaction, from each tier&apos;s own &ldquo;extra churn for each 10% rise&rdquo; in Set up.</p>
      </Group>

      <Group title="People" id="people">
        {play.leavers.map((x, i) => (
          <div key={`l${i}`} className="grid grid-cols-[1fr_auto_7rem_auto] items-center gap-2" data-leaver-row>
            <NativeSelect value={x.person} onChange={(e) => listEdit<{ person: string }>("leavers", i, { person: e.target.value })} aria-label="Person who leaves">
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
            <span className="text-xs">leaves in</span>
            <NativeSelect value={x.month} onChange={(e) => listEdit<{ month: number }>("leavers", i, { month: Number(e.target.value) })} aria-label="Month they leave">
              {months.long.map((m, j) => (
                <option key={j} value={j}>
                  {m}
                </option>
              ))}
            </NativeSelect>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => listDel("leavers", i)} aria-label="Remove">
              ✕
            </Button>
          </div>
        ))}
        {play.hires.map((x, i) => (
          <div key={`h${i}`} className="grid grid-cols-[auto_1fr_auto_7rem_auto] items-center gap-2" data-hire-row>
            <span className="text-xs">Hire</span>
            <NativeSelect value={x.role} onChange={(e) => listEdit<{ role: string }>("hires", i, { role: e.target.value })} aria-label="Role to hire">
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </NativeSelect>
            <span className="text-xs">from</span>
            <NativeSelect value={x.month} onChange={(e) => listEdit<{ month: number }>("hires", i, { month: Number(e.target.value) })} aria-label="Month they start">
              {months.long.map((m, j) => (
                <option key={j} value={j}>
                  {m}
                </option>
              ))}
            </NativeSelect>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => listDel("hires", i)} aria-label="Remove">
              ✕
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          {people.length > 0 && (
            <Button type="button" variant="outline" size="sm" data-lever="addLeaver" onClick={() => set({ leavers: [...play.leavers, { person: people[0]!.id, month: 3 }] })}>
              + Someone leaves
            </Button>
          )}
          {roles.length > 0 && (
            <Button type="button" variant="outline" size="sm" data-lever="addHire" onClick={() => set({ hires: [...play.hires, { role: roles[0]!.id, month: 3 }] })}>
              + Hire
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">New hires take about {setup.rampDefault.length} months to reach full speed (the ramp in Set up).</p>
      </Group>

      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => setPlay(defaultPlay())} data-play-reset>
          Reset levers
        </Button>
      </div>
    </aside>
  );
}
