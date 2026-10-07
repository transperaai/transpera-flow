import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy policy · Transpera Flow" };

const UPDATED = "7 October 2026";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-heading text-lg font-semibold text-fg">{title}</h2>
      {children}
    </section>
  );
}

/** Public privacy policy (also the URL on Google's OAuth consent screen). */
export default function PrivacyPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-12 text-base leading-relaxed text-fg-2">
      <header className="flex flex-col gap-1">
        <p className="flex items-center gap-2.5 font-display text-base font-bold tracking-tight text-fg">
          <span aria-hidden className="size-[22px] rounded-md bg-[conic-gradient(from_200deg,var(--accent),var(--chart-1),var(--chart-5),var(--accent))]" />
          Transpera Flow
        </p>
        <h1 className="font-heading text-2xl font-semibold tracking-tight text-fg">Privacy policy</h1>
        <p className="text-sm text-muted-foreground">Last updated {UPDATED}</p>
      </header>

      <p>
        Transpera Flow is a process-simulation tool provided by Transpera AI (&ldquo;we&rdquo;) to its clients as part
        of our consulting services. This policy explains what we collect, why, and who we share it with.
      </p>

      <Section title="What we collect">
        <ul className="list-disc pl-5">
          <li>
            <strong>Your account:</strong> when you sign in with Google we receive your name, email address and profile
            picture. We use them only to identify you and show who made changes.
          </li>
          <li>
            <strong>Workspace data:</strong> the processes, people, roles, clients, findings and scenarios you or we
            enter while modelling your business. This can include staff names, working hours and cost rates.
          </li>
          <li>
            <strong>Technical data:</strong> sign-in sessions and standard server logs (such as IP address and request
            times) kept by our hosting providers for security and troubleshooting, and error reports when something breaks (see Service providers).
          </li>
        </ul>
      </Section>

      <Section title="How we use it">
        <p>
          Only to provide the service: running simulations, showing results to people with access to your workspace,
          producing reports, and keeping the service secure. We model people for capacity, not performance. We do not
          sell your data, use it for advertising, or use it to train AI models.
        </p>
      </Section>

      <Section title="Who can see it">
        <p>
          Each workspace is private to its members and to Transpera AI consultants working with you. Access is enforced
          in the database, not just the interface.
        </p>
      </Section>

      <Section title="Service providers">
        <ul className="list-disc pl-5">
          <li>Supabase: database, sign-in and file storage, hosted in Sydney, Australia.</li>
          <li>Vercel: web hosting.</li>
          <li>
            Sentry: error reports when something in the app breaks: which page, what failed in our code, and the browser and
            device type. Names, email addresses, pay, the contents of your workspace and share links are removed before a report
            is sent, and IP addresses are not stored. Hosted in the European Union (Germany).
          </li>
          <li>Google: sign-in.</li>
          <li>
            Anthropic: explains a saved run, only when someone asks. It receives the
            figures being described and the names of the process, its steps, roles and scenarios; the names of your staff and
            clients are replaced with labels before anything is sent. Anthropic doesn&rsquo;t use it to train models.
          </li>
        </ul>
      </Section>

      <Section title="Your client data">
        <p>
          For data about your staff and customers, your company is the controller and Transpera AI processes it on your
          behalf under the data processing terms in our services agreement.
        </p>
      </Section>

      <Section title="Google user data">
        <p>
          Transpera Flow&rsquo;s use of information received from Google APIs adheres to the{" "}
          <a
            className="text-accent underline"
            href="https://developers.google.com/terms/api-services-user-data-policy"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements. We request only your basic profile and email address.
        </p>
      </Section>

      <Section title="Keeping and deleting data">
        <p>
          We keep workspace data while your engagement is active. You can ask us to export or delete your account or
          workspace at any time, and we will do so within 30 days, apart from backups, which expire on their own
          schedule.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Questions or requests:{" "}
          <a className="text-accent underline" href="mailto:austin@transpera.ai">
            austin@transpera.ai
          </a>
          .
        </p>
      </Section>
    </main>
  );
}
