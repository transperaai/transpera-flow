// The Upload process dialog on a bare page, for the browser tests in ../upload-process-browser.test.ts. Bundled by
// esbuild and driven through `window.mountUpload`; nothing here ships. The server side is stood in for by the real file
// checker and a fixed company (roles, existing process names), so what the dialog shows is what the app would show.

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { checkProcessFileText, processTextFrom } from "@transpera-flow/db/process-file";
import { UploadProcessDialog, type UploadProcess } from "@/components/processes/upload-process-dialog";
import { sourceLabel, uploadSizeProblem, type CreateUploadInput, type UploadPreview } from "@/lib/processes/upload";

export interface HarnessCompany {
  roles: { id: string; name: string }[];
  /** Process names that already exist. */
  processes: string[];
  /** What the next create answers with (an error message), or nothing for success. */
  createError?: string;
  /** What the next create throws: a plain failure, or the redirect a successful create ends in. */
  createThrows?: "failure" | "redirect";
  /** The pages the fake server can fetch by link: address to the page's text (an HTML page or JSON). Any other link can't be opened. */
  links?: Record<string, string>;
}

declare global {
  interface Window {
    mountUpload: (company: HarnessCompany) => void;
    /** Every create the dialog made, as the server action would have received it. */
    uploads: CreateUploadInput[];
    previews: number;
  }
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function makeUpload(company: HarnessCompany): UploadProcess {
  return {
    async preview(input) {
      window.previews++;
      let text: string;
      let source: string;
      if (input.kind === "link") {
        source = sourceLabel(input.url);
        const page = company.links?.[input.url];
        if (page === undefined) return { error: "Couldn't find that web address. Check the link and try again." };
        const found = processTextFrom(page);
        if (found.error !== undefined) return { error: found.error };
        text = found.text;
      } else {
        text = input.text;
        source = sourceLabel(input.fileName);
      }
      const tooBig = uploadSizeProblem(new Blob([text]).size);
      const check = tooBig ? { file: null, errors: [tooBig], warnings: [] } : checkProcessFileText(text);
      if (!check.file) {
        const preview: UploadPreview = { source, name: "", kind: "pipeline", steps: 0, links: 0, groups: 0, errors: check.errors, warnings: check.warnings, roles: [], matchedRoles: [], unknownRoles: [], unknownPeople: [], nameTaken: null };
        return { preview };
      }
      const matched: UploadPreview["matchedRoles"] = [];
      const unknown: string[] = [];
      for (const s of check.file.steps) {
        if (!s.role || matched.some((m) => norm(m.name) === norm(s.role!)) || unknown.some((u) => norm(u) === norm(s.role!))) continue;
        const role = company.roles.find((r) => norm(r.name) === norm(s.role!));
        if (role) matched.push({ name: s.role, role: role.name });
        else unknown.push(s.role);
      }
      return {
        ...(input.kind === "link" ? { text } : {}),
        preview: {
          source,
          name: check.file.name,
          kind: check.file.kind,
          steps: check.file.steps.length,
          links: check.file.links.length,
          groups: check.file.groups.length,
          errors: check.errors,
          warnings: check.warnings,
          roles: company.roles,
          matchedRoles: matched,
          unknownRoles: unknown,
          unknownPeople: [],
          nameTaken: company.processes.find((p) => norm(p) === norm(check.file!.name)) ?? null,
        },
      };
    },
    async create(input) {
      window.uploads.push(input);
      if (company.createThrows === "failure") throw new Error("network down");
      if (company.createThrows === "redirect") throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;push;/w/x/p/y/edit;307;" });
      return company.createError ? { error: company.createError } : {};
    },
  };
}

function Harness({ company }: { company: HarnessCompany }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Upload process
      </button>
      <UploadProcessDialog open={open} onOpenChange={setOpen} upload={makeUpload(company)} />
    </>
  );
}

window.uploads = [];
window.previews = 0;
window.mountUpload = (company) => {
  createRoot(document.getElementById("root")!).render(<Harness company={company} />);
};
