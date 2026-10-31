"use client";

import { useActionState, useState, useTransition } from "react";
import type { RoleRow } from "@transpera-flow/db";
import { TextField, ToggleField } from "@/components/fields";
import { HelpLabel } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SaveOutcome, Saver } from "@/lib/fields/field-controller";
import { inUse, type RoleField, type RoleUsage } from "@/lib/roles";
import { createRole, removeRole, saveRoleField, type ActionResult } from "./actions";

type Scalar = string | number | boolean | null;

/** A saver for one column of one role. */
const roleSaver =
  <T extends Scalar>(roleId: string, field: RoleField): Saver<T> =>
  (base, next) =>
    saveRoleField(roleId, field, base, next) as Promise<SaveOutcome<T>>;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function AddRole({ workspaceId }: { workspaceId: string }) {
  const [state, action, pending] = useActionState<ActionResult, FormData>(createRole.bind(null, workspaceId), {});
  return (
    <form action={action} className="mb-4 flex flex-wrap items-end gap-2">
      <label className="flex min-w-0 flex-col gap-1">
        <HelpLabel label="Name" description="The kind of work, as your team says it. Steps, people and clients name roles." example="Strategist" />
        <Input name="name" required maxLength={200} />
      </label>
      <Button type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add role"}
      </Button>
      {state.error && (
        <p role="alert" className="w-full text-crit">
          {state.error}
        </p>
      )}
    </form>
  );
}

/** What else a role has (the part of a row that opens): Set up shows it under "More". */
export function RoleMore({ role, usage, canEdit }: { role: Pick<RoleRow, "id" | "name" | "color" | "active" | "leadership">; usage: RoleUsage; canEdit: boolean }) {
  const disabled = !canEdit;
  return (
    <div className="grid gap-4 px-1 pt-3 pb-2 sm:grid-cols-2">
        <TextField label="Name" value={role.name} save={roleSaver(role.id, "name")} disabled={disabled} help={{ description: "The kind of work, as your team says it. Steps and people name roles.", example: "Strategist" }} />
        <ToggleField
          label="Status"
          value={role.active}
          save={roleSaver(role.id, "active")}
          onLabel="Active"
          offLabel="Inactive: hidden from pickers; steps and people that have it keep it"
          disabled={disabled} help={{ description: "Inactive roles are hidden from pickers. Steps and people that already have the role keep it.", example: "Make a role inactive when you stop using it, instead of removing it." }} />
        {(
          <ToggleField
            label="Leadership"
            value={role.leadership}
            save={roleSaver(role.id, "leadership")}
            onLabel="Leadership: left out of clients per employee and revenue per employee"
            offLabel="Not leadership: counted in clients per employee and revenue per employee"
            disabled={disabled}
            help={{ description: "Leadership roles are left out of the clients-per-employee and revenue-per-employee figures. Whether their salaries count in DLER is a separate setting under People.", example: "Founder, Head of Client Services." }}
          />
        )}
        <p className="text-fg-2 sm:col-span-2">
          Used by {plural(usage.steps, "step")} · {plural(usage.people, "person", "people")}
          {usage.services > 0 && <> · {plural(usage.services, "service")} (fallback load)</>}
        </p>
        {canEdit && !inUse(usage) && (
          <div className="sm:col-span-2">
            <RemoveRole roleId={role.id} name={role.name} />
          </div>
        )}
    </div>
  );
}

function RemoveRole({ roleId, name }: { roleId: string; name: string }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  if (!confirming) {
    return (
      <Button variant="link" size="xs" className="h-auto p-0 text-muted-foreground underline hover:text-destructive" type="button" onClick={() => setConfirming(true)}>
        Remove role
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span>Remove {name}? This can&apos;t be undone.</span>
      <Button variant="destructive" size="sm"
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await removeRole(roleId);
            setError(r.error);
          })
        }
      >
        {pending ? "Removing…" : "Remove"}
      </Button>
      <Button variant="outline" size="sm" type="button" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
      {error && (
        <p role="alert" className="w-full text-crit">
          {error}
        </p>
      )}
    </div>
  );
}
