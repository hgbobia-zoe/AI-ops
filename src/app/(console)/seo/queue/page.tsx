// SEO Growth — Review Queue. The human go/no-go on finished drafts before anything ships. Server component:
// loads the drafts awaiting review and hands them to the client view. Approval clears a draft to publish but
// never publishes it — publishing is a separate authorized step.

import { reviewQueueRows } from "@/lib/seo/produce";
import { SeoReviewQueue } from "@/components/seo/SeoReviewQueue";

export const dynamic = "force-dynamic";

export default function SeoReviewQueuePage(): React.JSX.Element {
  return <SeoReviewQueue rows={reviewQueueRows()} />;
}
