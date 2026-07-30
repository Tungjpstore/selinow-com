# State system

Every data-driven component must consciously implement applicable states.

| State | Required content |
|---|---|
| Loading | readable skeleton or progress, never blank |
| Empty | why empty + next action |
| Success | explicit confirmation, not only green |
| Warning | impact + deadline when relevant |
| Blocked | human explanation + remediation route |
| Waiting user | one action outside/inside system clearly stated |
| Waiting provider | last check + retry + expected next signal |
| Error/retry | safe message + request ID when support is needed |
| Forbidden | current role lacks permission |
| Plan limited | capability/limit and plan path, not technical error |
| Suspended | new mutations blocked; history/export behavior explained |

## Status component anatomy

1. semantic icon;
2. short label;
3. impact statement;
4. last updated time;
5. primary remediation action;
6. secondary help/details;
7. stable safe code when needed.
