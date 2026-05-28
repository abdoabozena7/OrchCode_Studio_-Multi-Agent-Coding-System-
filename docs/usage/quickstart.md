# Hivo Quickstart

## Setup

Install dependencies from the repository root:

```bash
npm install
```

## Index The Repository

```bash
npm run memory:index
npm run memory:index-status
npm run memory:inspect
```

Refresh if the index is stale:

```bash
npm run memory:index-refresh
```

## Run A Simple Task

```bash
npm run agentic:run -- --mode fast "Explain the repository memory files and do not change files."
```

The command prints the run id and writes artifacts under `.agent_memory/runs/<run_id>/`.

## Run Deep Mode

```bash
npm run agentic:run -- --mode deep "Add one focused test for the memory freshness checker."
```

Deep mode is the default for serious work. It uses richer context, review, validation, repair, and approval gates.

## Inspect Artifacts

```bash
npm run agentic:list-runs
npm run agentic:show-run -- <run_id>
npm run agentic:show-report -- <run_id>
npm run agentic:run-metrics -- <run_id>
npm run agentic:show-artifacts -- <run_id>
npm run agentic:show-run-events -- <run_id>
```

Read one artifact:

```bash
npm run agentic:show-artifact -- <run_id> reports/final_report.json
```

## Memory Learning

```bash
npm run memory:compact
npm run memory:lessons
npm run memory:failed-attempts
npm run memory:decisions
```

## Evals

```bash
npm run eval:phase4
```

The eval suite writes a local summary under `.agent_memory/evals/`.
