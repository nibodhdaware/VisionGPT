import { redirect } from "next/navigation";

export default function DatasetPage() {
  redirect("/?mode=dataset");
}
