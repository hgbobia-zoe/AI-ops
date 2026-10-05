// The Zoe Event Rentals warehouse — the fixed origin for every delivery leg. Coordinates are hardcoded
// because the origin never moves and a suite-numbered address ("#4A") trips keyless geocoders, so only
// the venue needs geocoding and the warehouse leg can never silently fail. Shared by the distance API
// (one-way miles) and the route-aware optimizer (incremental insertion against the warehouse endpoints).

import type { LatLng } from "@/lib/eta/geo";

export const WAREHOUSE_ADDRESS = "12712 Rock Creek Mill Rd #4A, North Bethesda, MD 20852";
export const WAREHOUSE_COORDS: LatLng = { lat: 39.0638628, lng: -77.1127462 };
