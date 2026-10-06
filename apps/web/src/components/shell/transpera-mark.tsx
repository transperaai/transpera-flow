/**
 * The Transpera Flow mark at the top of the sidebar. It is drawn from `--brand-mark`, never `--accent`, so a client's accent
 * (client branding, issue #34) doesn't recolour it: only the workspace tile is the client's. Inline style, so it needs no
 * generated class.
 */
export function TransperaMark() {
  return (
    <span
      aria-hidden
      data-transpera-mark=""
      className="size-[22px] shrink-0 rounded-md"
      style={{ backgroundImage: "conic-gradient(from 200deg, var(--brand-mark), var(--chart-1), var(--chart-5), var(--brand-mark))" }}
    />
  );
}
