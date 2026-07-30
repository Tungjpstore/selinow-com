# Data authority rules

| Data | Client may display/edit | Authority |
|---|---|---|
| Shop selection | yes | authenticated server membership |
| Tenant storefront | no client authority | hostname resolution |
| Product draft fields | yes | server validation/persistence |
| Cart convenience | localStorage allowed | server quote at checkout |
| Price | display only | server/database |
| Stock | display state | server/database |
| Payment | display verified state | provider + server verification |
| Fulfillment | display server state | fulfillment engine |
| Role/permission | adapt UI | server authorization |
| Readiness | show progress | server-computed |
| Plan limits | show runtime value | entitlements/database |
| Secret fields | one-way input | secure server endpoint |
