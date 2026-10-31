import { redirect } from "next/navigation";

/** The People page became the Capacity page (capacity build P5); old links and bookmarks land there. */
export default async function WorkspacePeopleRedirect(props: PageProps<"/w/[slug]/people">) {
  const { slug } = await props.params;
  redirect(`/w/${slug}/capacity`);
}
