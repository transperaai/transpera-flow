"use client";

// A step's context menu (issue #8): right-click a step, or focus it and press
// Shift+F10 or the context-menu key. Every item acts on the step the menu was
// opened on (or on the whole selection, when that step is part of one). The
// choices with a list (kind, pinned person) open in place with
// a Back item, so the menu stays one list for the keyboard: arrow keys move,
// Enter picks, Escape goes back or closes, and focus returns to the step.

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ProcessBundle, StepKind } from "@transpera-flow/db";
import {
  KIND_LABELS,
  OUTCOME_LABELS,
  STEP_KINDS,
  kindProblem,
  pinPerson,
  setStepKind,
} from "@/lib/editor/commands";
import type { ProcessEditor } from "@/lib/editor/editor";
import { splitProblem } from "@/lib/editor/split";

/** Selection-wide actions the menu shares with the keyboard shortcuts (see ProcessView). */
export interface CanvasCommands {
  duplicate: (ids: string[]) => void;
  copy: (ids: string[]) => void;
  remove: (ids: string[]) => void;
  /** Select the step and put focus in the inspector. */
  inspect: (id: string) => void;
  /** Split a step into two new ones; the old one is retired with `replaced_by` (issue #16). */
  split?: (id: string) => void;
  /** Open the page of the process a linked node holds (QA round 2, item 7): on every company map card, and old linked nodes in a process. */
  openProcess?: (processId: string) => void;
}

export interface MenuState {
  /** The step the menu was opened on. */
  id: string;
  /** What the menu acts on: that step, or the selection it belongs to. */
  ids: string[];
  /** Where it opens, relative to the canvas. */
  x: number;
  y: number;
}

type View = "main" | "kind" | "person";

const mod = () => (typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+");

export function NodeMenu({
  menu,
  bundle,
  editor,
  commands,
  bounds,
  onRename,
  onClose,
}: {
  menu: MenuState;
  bundle: ProcessBundle;
  editor: ProcessEditor;
  commands: CanvasCommands;
  /** The canvas's size, to keep the menu inside it. */
  bounds: { width: number; height: number };
  onRename: (id: string) => void;
  /** Close; `refocus` puts focus back on the step. */
  onClose: (refocus: boolean) => void;
}) {
  const [view, setView] = useState<View>("main");
  const ref = useRef<HTMLDivElement>(null);
  const step = bundle.steps.find((s) => s.id === menu.id);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [view]);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [onClose]);

  if (!step) return null;
  const many = menu.ids.length > 1;
  const working = step.kind !== "start" && step.kind !== "end" && step.kind !== "group" && !step.child_process_id;
  const run = (fn: () => void, refocus = true) => () => {
    fn();
    onClose(refocus);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => items[(i + items.length) % items.length]?.focus();
    const back = view !== "main";
    switch (e.key) {
      case "ArrowDown":
        go(at + 1);
        break;
      case "ArrowUp":
        go(at - 1);
        break;
      case "Home":
        go(0);
        break;
      case "End":
        go(items.length - 1);
        break;
      case "ArrowLeft":
        if (back) setView("main");
        break;
      case "ArrowRight": {
        const sub = (document.activeElement as HTMLElement | null)?.dataset.view as View | undefined;
        if (sub) setView(sub);
        break;
      }
      case "Escape":
        if (back) setView("main");
        else onClose(true);
        break;
      case "Tab":
        onClose(true);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const left = Math.max(4, Math.min(menu.x, bounds.width - 248));
  const top = Math.max(4, Math.min(menu.y, bounds.height - 330));
  const label = many ? `Actions for ${menu.ids.length} steps` : `Actions for ${step.name}`;

  let body: ReactNode;
  if (many) {
    body = (
      <>
        <Item onSelect={run(() => commands.duplicate(menu.ids))} shortcut={`${mod()}D`}>
          Duplicate {menu.ids.length} steps
        </Item>
        <Item onSelect={run(() => commands.copy(menu.ids))} shortcut={`${mod()}C`}>
          Copy {menu.ids.length} steps
        </Item>
        <Separator />
        <Item onSelect={run(() => commands.remove(menu.ids))} shortcut="Del" danger>
          Delete {menu.ids.length} steps
        </Item>
      </>
    );
  } else if (view === "main") {
    const start = step.kind === "start";
    // A node that links to a process: named after it, and it sits in one place only, so it can't be renamed, copied or turned into another kind.
    const linked = step.child_process_id ?? null;
    const noCopy = start ? "A process has one start step." : linked ? "A process sits in one place only." : undefined;
    body = (
      <>
        {linked && commands.openProcess && <Item onSelect={run(() => commands.openProcess!(linked), false)}>Open process page</Item>}
        {!linked && (
          <Item onSelect={run(() => onRename(step.id), false)} shortcut="Enter">
            Rename and edit here
          </Item>
        )}
        <Item onSelect={run(() => commands.inspect(step.id), false)}>Edit in the inspector</Item>
        <Item onSelect={run(() => commands.duplicate([step.id]))} shortcut={`${mod()}D`} disabled={noCopy}>
          Duplicate
        </Item>
        <Item onSelect={run(() => commands.copy([step.id]))} shortcut={`${mod()}C`} disabled={noCopy}>
          Copy
        </Item>
        {commands.split && (
          <Item
            onSelect={run(() => commands.split!(step.id))}
            disabled={splitProblem(bundle, step.id) ?? undefined}
            note="Two new steps take its place; scenarios that changed it ask to be re-pointed."
          >
            Split in two
          </Item>
        )}
        <Separator />
        {!linked && (
          <Item view="kind" onSelect={() => setView("kind")} submenu>
            Change kind
            <span className="ml-1 text-fg-3">({KIND_LABELS[step.kind]})</span>
          </Item>
        )}
        {working && bundle.people.length > 0 && (
          <Item view="person" onSelect={() => setView("person")} submenu>
            Pin to person
          </Item>
        )}
        <Separator />
        <Item onSelect={run(() => commands.remove([step.id]))} shortcut="Del" danger>
          {linked ? "Remove from this map" : "Delete"}
        </Item>
      </>
    );
  } else if (view === "kind") {
    const kinds: StepKind[] = [...STEP_KINDS, ...(step.kind === "subprocess" || step.kind === "group" ? [step.kind] : [])];
    const outgoing = bundle.edges.filter((e) => e.from_step_id === step.id).length;
    const incoming = bundle.edges.filter((e) => e.to_step_id === step.id).length;
    body = (
      <>
        <Back onBack={() => setView("main")}>Change kind</Back>
        {kinds.map((k) => {
          const note =
            k === step.kind
              ? undefined
              : k === "end" && outgoing
                ? `Removes its ${outgoing} outgoing connection${outgoing > 1 ? "s" : ""}.`
                : k === "start" && incoming
                  ? `Removes its ${incoming} incoming connection${incoming > 1 ? "s" : ""}.`
                  : undefined;
          return (
            <Item
              key={k}
              checked={k === step.kind}
              disabled={kindProblem(bundle, step.id, k) ?? undefined}
              note={note}
              onSelect={run(() => editor.run((b) => setStepKind(b, step.id, k)))}
            >
              {KIND_LABELS[k]}
              {k === "end" && step.kind === "end" && step.outcome && <span className="ml-1 text-fg-3">({OUTCOME_LABELS[step.outcome]})</span>}
            </Item>
          );
        })}
      </>
    );
  } else if (view === "person") {
    const roleNames = new Map(bundle.roles.map((r) => [r.id, r.name]));
    const people = bundle.people.filter((p) => p.active || p.id === step.person_id).sort((a, b) => a.name.localeCompare(b.name));
    body = (
      <>
        <Back onBack={() => setView("main")}>Pin to person</Back>
        <Item checked={!step.person_id} onSelect={run(() => editor.run((b) => pinPerson(b, step.id, null)))}>
          Anyone in the role
        </Item>
        {people.map((p) => {
          const roles = bundle.personRoles.filter((r) => r.person_id === p.id).map((r) => roleNames.get(r.role_id));
          return (
            <Item key={p.id} checked={step.person_id === p.id} onSelect={run(() => editor.run((b) => pinPerson(b, step.id, p.id)))}>
              {p.name}
              {roles.length > 0 && <span className="ml-1 text-fg-3">({roles.join(", ")})</span>}
            </Item>
          );
        })}
      </>
    );
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      className="nodrag nopan nowheel absolute z-30 flex max-h-80 w-60 flex-col overflow-y-auto rounded-token border border-line-2 bg-panel py-1 text-xs shadow-token"
      style={{ left, top }}
    >
      {body}
    </div>
  );
}

function Item({
  children,
  onSelect,
  shortcut,
  disabled,
  danger,
  checked,
  submenu,
  view,
  note,
}: {
  children: ReactNode;
  onSelect: () => void;
  shortcut?: string;
  /** Why the item can't be used; it is shown and the item skipped. */
  disabled?: string;
  danger?: boolean;
  /** For a choice among several: whether it is the current one. */
  checked?: boolean;
  submenu?: boolean;
  view?: View;
  note?: string;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      aria-disabled={disabled ? true : undefined}
      aria-haspopup={submenu ? "menu" : undefined}
      data-view={view}
      tabIndex={-1}
      title={disabled}
      onClick={disabled ? undefined : onSelect}
      className={`flex w-full flex-col px-2.5 py-1.5 text-left outline-none focus-visible:bg-accent-soft hover:bg-panel-2 focus:bg-accent-soft aria-disabled:cursor-not-allowed aria-disabled:text-fg-3 aria-disabled:hover:bg-transparent ${danger ? "text-crit" : "text-fg"}`}
    >
      <span className="flex w-full items-center gap-2">
        {checked !== undefined && (
          <span aria-hidden className="w-3 text-accent">
            {checked ? "✓" : ""}
          </span>
        )}
        <span className="flex-1">{children}</span>
        {shortcut && <span className="font-mono text-2xs text-fg-3">{shortcut}</span>}
        {submenu && <span aria-hidden className="text-fg-3">›</span>}
      </span>
      {(note || disabled) && <span className={`text-2xs text-fg-3 ${checked !== undefined ? "pl-5" : ""}`}>{disabled ?? note}</span>}
    </button>
  );
}

function Back({ children, onBack }: { children: ReactNode; onBack: () => void }) {
  return (
    <>
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        onClick={onBack}
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-left font-semibold text-fg outline-none hover:bg-panel-2 focus:bg-accent-soft"
      >
        <span aria-hidden className="text-fg-3">‹</span>
        {children}
        <span className="sr-only">, back</span>
      </button>
      <Separator />
    </>
  );
}

function Separator() {
  return <div role="separator" className="my-1 h-px bg-line" />;
}
