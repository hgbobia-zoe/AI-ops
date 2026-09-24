// Voice-agent tool registry — the visible permission contract.

import { ToolRegistryView } from "@/components/communications/ToolRegistryView";
import { TOOL_REGISTRY } from "@/lib/comms/toolRegistry";

export const dynamic = "force-dynamic";

export default function ToolRegistryPage(): React.JSX.Element {
  return <ToolRegistryView tools={TOOL_REGISTRY} />;
}
