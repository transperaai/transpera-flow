/** A share link that has expired, been turned off, or never existed: the same words for all three, so nothing is given away. */
export default function SharedNotFound() {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-3 px-4 py-16" data-share-not-found>
      <h1 className="font-heading text-2xl font-semibold tracking-tight">This link has expired or been turned off.</h1>
      <p className="text-sm text-muted-foreground">Ask whoever sent it for a new one.</p>
    </main>
  );
}
