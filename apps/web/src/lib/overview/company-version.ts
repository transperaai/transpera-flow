// Which company map the Overview draws (QA wave 1): the live one, or, for `?version=N`, an earlier published version, read only.

import type { ProcessPart } from "@transpera-flow/db";

export interface CompanyMapView {
  /** The map to draw. */
  map: ProcessPart | null;
  /** The earlier version's number, or null when the live map is shown. */
  viewingVersion: number | null;
  /** The Editor opens the live map's draft; it is not offered on an earlier version. */
  canEdit: boolean;
}

/** `found` is what `?version=N` named (null when it names nothing); naming the live version is just the live map. */
export function companyMapView(live: ProcessPart | null, found: ProcessPart | null, canEdit: boolean): CompanyMapView {
  const earlier = found && live && found.revision.id !== live.revision.id ? found : null;
  return { map: earlier ?? live, viewingVersion: earlier ? earlier.revision.number : null, canEdit: canEdit && !!live && !earlier };
}
