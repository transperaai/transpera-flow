// The fixed sentences the clients-and-servicing calibration writes (engine `client-calibration.ts` and the panel), as patterns:
// what is stored of a note or a reason is only text that matches one of them, so nothing typed in an uploaded file can be
// stored through them (D27). Framework-free for tests.

const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;
const DATE = String.raw`\d{1,2} [A-Z][a-z]+ \d{4}`;

const SENTENCES: RegExp[] = [
  // Reasons nothing is proposed or measured.
  /^One-off work ends by design, so churn isn't measured for it\.$/,
  new RegExp(String.raw`^The file covers ${NUM} weeks; at least \d+ are needed\.$`),
  new RegExp(String.raw`^Too few to measure: \d+ of the \d+(?: clients)? needed\.$`),
  new RegExp(String.raw`^Only \d+ clients? left in the period; at least \d+ are needed\.$`),
  /^A file of current clients only can't show churn: include the clients who left, with the date they left\.$/,
  /^More than every client leaving each month: check the dates\.$/,
  /^No clients of this service are simulated here\.$/,
  /^Count them in Settings → Client groups first\.$/,
  /^Its clients couldn't leave in the simulation\.$/,
  /^This workspace's live process can't be simulated yet, so today's driver pressure can't be measured\.$/,
  /^Fix it on the map first\.$/,
  /^Today's driver pressure hasn't been measured yet\.$/,
  /^Not in the clients file\.$/,
  /^No servicing work is set to come in as ad-hoc requests\.$/,
  /^Needs the clients file too\.$/,
  /^Needs the servicing log\.$/,
  // Churn notes.
  new RegExp(String.raw`^\d+ of \d+ clients left over ${NUM} weeks \(${NUM}% a month\)\.$`),
  new RegExp(String.raw`^\d+ are clients on ${DATE}(?:, and Client groups counts \d+)?\.$`),
  /^No driver adds churn today, so normal churn is the measured churn\.$/,
  new RegExp(String.raw`^Today's drivers add ${NUM}% to it, so normal churn is ${NUM}%: ${NUM}% × ${NUM} gives the ${NUM}% measured\.$`),
  /^Today's drivers more than double this service's churn, so normal churn is under half of what was measured\.$/,
  /^Check the driver weights\.$/,
  /^Approximate: the simulation moved a little between runs\.$/,
  // Check notes.
  new RegExp(String.raw`^\d+ of \d+ tasks due by ${DATE} were done after their due date or not at all(?: \(\d+%\))?\.$`),
  new RegExp(
    String.raw`^\d+ ad-hoc requests? done(?:, ${NUM} working hours on average)? (?:taking each request as coming in one SLA before it was due, as the simulation does|from when each was requested|from when each was requested where that is logged \(\d+ of \d+\), otherwise one SLA before it was due)\.$`,
  ),
  /^Their processes have different SLAs, so the smallest was used\.$/,
  new RegExp(String.raw`^\d+ new clients? had a first delivery(?:, ${NUM} working days after they started on average)?(?:; \d+ with nothing done yet left out)?\.$`),
];

/** The text if every sentence of it is one of ours, else null. */
export function knownMessage(text: string | null | undefined, max = 1000): string | null {
  if (!text || text.length > max) return null;
  const sentences = text.split(/(?<=\.) (?=[A-Z0-9])/);
  return sentences.every((s) => SENTENCES.some((re) => re.test(s))) ? text : null;
}
