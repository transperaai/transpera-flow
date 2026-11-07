import { redirect } from "next/navigation";

/** Purposes is a section of Settings now: the old address (bookmarks, earlier links) lands on it. */
export default async function PurposesPage(props: PageProps<"/w/[slug]/settings/purposes">) {
  const { slug } = await props.params;
  redirect(`/w/${encodeURIComponent(slug)}/settings#purposes`);
}
