// Sales OS index — the Board is the default view, so /salesos redirects there. The Worklist lives at
// /salesos/worklist and the Table at /salesos/table (both rendered under the shared shell).

import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function SalesOsIndex(): never {
  redirect("/salesos/board");
}
