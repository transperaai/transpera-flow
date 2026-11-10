/** The small purple dot on a button that opens the Editor: the one place the Editor's colour shows outside the Editor's own chrome. */
export function EditMarker() {
  return <span aria-hidden data-edit-marker className="size-2 shrink-0 rounded-full bg-edit" />;
}
