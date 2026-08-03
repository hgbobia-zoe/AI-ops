# Zapier Tables — created table IDs

These 12 tables were created programmatically in the Zoe Dispatch Zapier account
(owner account 18442468) on 2026-08-03. All fields are text (string) type.

| Table | Table ID |
|---|---|
| Vehicles | `01KZ47GK3MA39X9WKEV5KVMDD7` |
| Drivers | `01KZ47HKD85XWZ6MV7XQRM9BK0` |
| Customers | `01KZ47HR6PP4R0EAC0XMQ7GRWZ` |
| Routes | `01KZ47HZFFP34JR4DC4QF0TDGS` |
| Stops | `01KZ47JVZX31DP7Z70DN6JPWY2` |
| Events | `01KZ47K1KATNFSCS7YRZR46B10` |
| Transitions | `01KZ47KPMK7Y8J9PFMYWNTF48K` |
| Messages | `01KZ47KW1J9AGZ56VDH8H7K91Y` |
| TrackingLinks | `01KZ47M1VMAMHK6S9JPKTD3B32` |
| AutomationLogs | `01KZ47MM487FZAF2ZM4BS89FW1` |
| Exceptions | `01KZ47MS2SN78Z7KE8AJ0GCPC4` |
| AuditLogs | `01KZ47MY5SG5E7YY1QQTX1R4BZ` |

## Next: seed the Transitions table
Import [`transitions.seed.csv`](transitions.seed.csv) into the **Transitions** table
(Zapier Tables → open table → Import → CSV). It holds the 13 legal state-machine rows.

## Wire the app to live data (M2)
Set these in `.env.local` / Vercel and implement the `TODO(M2)` branches in
`src/app/api/route/route.ts` and `src/app/api/vehicles/route.ts`:

```
ZAPIER_TABLES_API_KEY=...            # from Zapier Tables API settings
ZAPIER_ROUTES_TABLE_ID=01KZ47HZFFP34JR4DC4QF0TDGS
ZAPIER_STOPS_TABLE_ID=01KZ47JVZX31DP7Z70DN6JPWY2
USE_MOCK_DATA=false
```
