// The red mark on a node or line that has something to fix before the process can simulate (editor brainstorm, item 4). It explains
// itself: the reasons show on hover and when the mark has keyboard focus (Tab to it), and a screen reader reads them from its label.

/** A small red "!" with its reasons in a bubble. Nothing when there are none. */
export function ProblemMark({ problems, className = "absolute -top-2 -right-2" }: { problems: readonly string[]; className?: string }) {
  if (!problems.length) return null;
  const text = problems.join(" ");
  return (
    <span className={`group/problem nodrag nopan ${className} z-20`} data-problem-mark>
      <span
        role="img"
        tabIndex={0}
        aria-label={`To fix: ${text}`}
        className="flex size-5 cursor-help items-center justify-center rounded-full border-2 border-panel bg-crit text-2xs font-bold text-crit-fg outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-crit"
      >
        !
      </span>
      <span
        role="tooltip"
        data-problem-reasons
        className="pointer-events-none absolute top-6 right-0 z-30 hidden w-56 rounded-token border border-crit bg-panel p-2 text-left text-xs font-normal text-fg shadow-token group-focus-within/problem:block group-hover/problem:block"
      >
        {problems.length === 1 ? (
          problems[0]
        ) : (
          <ul className="list-disc pl-4">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </span>
    </span>
  );
}
