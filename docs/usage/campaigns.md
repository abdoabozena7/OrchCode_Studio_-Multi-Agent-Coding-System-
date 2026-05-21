# Campaigns

Campaigns organize large goals into operator-driven milestones. They do not imply background processing; each safe step runs when the operator invokes a command.

## Create

```bash
npm run campaign:create -- "Modernize the memory indexing layer for large repositories"
```

## Plan

```bash
npm run campaign:plan -- <campaign_id>
```

Planning creates deterministic milestones and records risks such as stale indexes.

## Run The Next Step

```bash
npm run campaign:run-next -- <campaign_id> --mode deep
```

Use `--dry-run` to inspect what would be selected without invoking the orchestrator:

```bash
npm run campaign:run-next -- <campaign_id> --dry-run
```

## Pause And Resume

```bash
npm run campaign:pause -- <campaign_id>
npm run campaign:resume -- <campaign_id>
```

Resume changes campaign status only. It does not resurrect a background worker.

## Inspect

```bash
npm run campaign:status -- <campaign_id>
npm run campaign:metrics -- <campaign_id>
npm run campaign:report -- <campaign_id>
```

Artifacts live under `.agent_memory/campaigns/<campaign_id>/`.
