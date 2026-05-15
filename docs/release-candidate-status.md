# Release Candidate Status

This branch is a release-candidate stabilization snapshot for the current OrchCode Studio operator console.

## Current capabilities

- The operator console shows run progress, lifecycle phases, pending decisions, and current review state.
- Agents have visible contracts, bounded ownership, and work journals.
- The review gate shows attribution confidence instead of inventing precise ownership.
- Proposed patch diff data is compared with post-apply git snapshots, and the preferred evidence source is now Rust/Tauri-owned snapshot capture during patch apply.
- Verification is reconciliation-aware, so apply success alone does not imply trusted completion.
- Runtime sessions can restore from the current `sessions.json` snapshot when the runtime token and snapshot data are both still available.
- The branch now includes a durable SQLite runtime-event foundation, and replay-based restore can rebuild sessions conservatively when durable event history is sufficient.
- Snapshot restore remains distinct from durable event replay, and the UI should treat snapshot-based restore as a fallback rather than replay-authoritative truth.
- Missing or partial data is shown honestly as unknown, unavailable, shared, unattributed, or manual-review-required.
- Existing non-empty workspaces now trigger automatic project intake, conservative continuation detection, and compact context-pack generation before implementation planning proceeds.
- Existing-project continuation now creates a scoped module execution plan, carries guardrails into worker contracts, and validates proposed changes against owned/caution/forbidden paths before review/apply.

## Known limitations

- There is still no full replay-authoritative restore across every lifecycle path, and there is no single end-to-end authoritative event log yet.
- Snapshot restore remains the common fallback path whenever durable runtime events are missing or insufficient for safe replay.
- Reconciliation now prefers Rust/Tauri-owned Git snapshot capture during patch apply, while any remaining desktop forwarding is transport or fallback rather than the primary evidence source.
- Exact per-agent line attribution is unavailable for shared files.
- Non-git workspaces may report reconciliation as unavailable.
- `localStorage` recent sessions are convenience history only and are not authoritative runtime truth.
- Durable replay is conservative and may mark a session as `reconciliation_required`, `corrupt`, or `non_restorable` instead of treating it as safely resumable.
- Command safety still depends on heuristic policy classification and should not be treated as sandbox-grade containment.
- Command provenance is now recorded more explicitly, but heuristic classification still does not equal sandboxing.
- Background command tracking is more durable than before, but it is still not a full process supervisor and incomplete background jobs may restore as `orphaned` or `reconciliation_required`.
- Run intent now models `run_to_green`, but the automated repair loop itself is still deferred to a later prompt.
- Module-scope validation is a planning and review guardrail, not a perfect sandbox, and broader automated repair remains deferred to the next prompt.

## Manual QA checklist

1. Start a run and confirm the run header and progress phases update.
2. Open agent detail and confirm contracts, journals, and current actions render without fake placeholders.
3. Inspect the review gate before apply and confirm attribution confidence, unknowns, and blockers are visible.
4. Apply a patch and confirm reconciliation becomes matched, diverged, pending, or unavailable rather than implicitly trusted.
5. Inspect verification checks and confirm apply success is not treated as verification success by itself.
6. Trigger a diverged or unavailable reconciliation case and confirm the UI asks for manual inspection.
7. Run a policy-classified command and confirm the UI distinguishes manual approval, policy classification, and blocked/denied outcomes.
8. Run or simulate a background command and confirm background start is not shown as completed success.
9. Restart the app and confirm saved recent sessions are presented as history only unless a live runtime token is still available.
10. Confirm restored sessions distinguish `event_replayed` from `snapshot_restored`, and that orphaned/non-restorable states do not appear safely resumable.

## Operator trust boundary

The current trust boundary is intentionally conservative:

- Rust remains the file-write authority.
- Rust also executes approved commands, but command classification and network/background detection remain heuristic.
- The runtime owns review, attribution, reconciliation, and verification state presentation.
- Rust/Tauri now captures preferred Git reconciliation evidence during patch apply, but non-git workspaces or missing Git data can still leave reconciliation unavailable and manual-review-only.
- Durable replay remains a separate restore concern from reconciliation authority.
- Background job records are durable enough for conservative restore and operator visibility, but they are not a full backend-owned process supervision system.
