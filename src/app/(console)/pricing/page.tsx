// Delivery Pricing calculator (any signed-in staff). Prices a delivery run with the same formula as
// zoeeventsdmv.com/calculator: base + mileage + a % of the pre-discount subtotal, per leg.

import { DeliveryCalculator } from "@/components/DeliveryCalculator";

export const dynamic = "force-dynamic";

export default function PricingPage(): React.JSX.Element {
  return <DeliveryCalculator />;
}
