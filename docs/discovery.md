# Read-only interface discovery

The implementation follows an operator-approved inspection of an already-signed-in Singapore MiMo Token Plan console on 2026-10-27. This public note deliberately omits account identifiers, real balances, cookie values and private infrastructure addresses.

## Verified

- The plan console displayed Singapore integration URLs, Credits, monthly/overall plan counters, an optional compensation pool, and UTC-labelled validity.
- Existing signed-in `GET https://platform.xiaomimimo.com/api/v1/tokenPlan/usage` and `/detail` returned HTTP 200, business `code: 0`, with no query parameters.
- A single same-path usage GET omitting browser credentials returned HTTP 401, business code 401.
- The inspected request carried `x-timeZone: Europe/Kiev`, while the UI explicitly labelled the displayed `currentPeriodEnd` as UTC. The collector preserves that header; standalone replay and header semantics are not qualified.
- The page warned about up to five-minute provider delay. No quota reset timestamp was observed.

## Schema mapping

| Selector | Meaning |
| --- | --- |
| `data.usage.items[name=plan_total_token]` | Plan Credits used/limit |
| `data.monthUsage.items[name=month_total_token]` | Monthly Credits used/limit, overlaps plan |
| `data.usage.items[name=compensation_total_token]` | Optional separate compensation pool |
| `detail.data.planCode` | Known plan tier mapping; unknown tiers omitted |
| `detail.data.currentPeriodEnd` | Valid-until UTC, not reset |
| `detail.data.expired` | Vendor expiry flag |

Select by exact name, never array position. Returned rounded fraction fields differ in precision; compute from validated counters. Missing/duplicate required pools or unsafe numeric values mean schema change, not zero use. Do not sum plan and monthly pools or add hypothetical compensation/PAYG balances.

## Not established

- A supported inference-key-authenticated quota API.
- The minimum session-cookie set, its lifecycle, expiry refresh, or successful standalone protected-cookie replay.
- A match between the observed console subscription and any separately configured CPA inference key.
- Production collector/network topology or live dashboard accuracy.

The fixture is entirely **synthetic**, including balances and dates. It is a minimal field projection, not a HAR or unredacted vendor-body export. Browser discovery closed only its owned tab/session and preserved existing pages. Do not repeat discovery or auto-export cookies as an installation shortcut.
