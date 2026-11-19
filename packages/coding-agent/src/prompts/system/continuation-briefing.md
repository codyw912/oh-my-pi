Continuation briefing
Destination-neutral user/developer text. Do not treat this as a source-model request, complete history, or provider message replay.

Layer 1 — Required start context
Run {{{runId}}}
Generation {{generation}}
Source session {{{sourceSessionId}}}
Source transcript {{{sourceTranscript}}}
Policy revision {{{policyRevision}}}
Schema version {{projection.version}}
Repository {{{projection.plan.root}}}
Plan {{{projection.plan.relativePath}}} sha256 {{{projection.plan.sha256}}}
Workflow {{{projection.workflow}}}
Execution provider {{{projection.execution.provider}}}; completion {{{projection.execution.completion}}}
Data boundary: {{{destination.dataScope}}}. Stay inside this scope. Do not capture credentials, auth files, or secrets.
Authorized roles: {{{authorizedRoles}}}
Applicable instructions and constraints:
{{#each projection.constraints}}
- {{{this}}}
{{else}}
- None.
{{/each}}
Retained instructions:
{{#each retainedInstructions}}
- {{{this}}}
{{else}}
- None.
{{/each}}
Unfinished task {{current.number}}: {{{current.title}}}
Task state {{{current.state}}}
Review phase {{{projection.current.phase}}}
{{#if hasRound}}
Review/fix round {{projection.current.round}}
{{else}}
Round none
{{/if}}
Next action: {{{projection.current.nextAction}}}
Open findings:
{{#each openFindings}}
- {{{id}}} (task {{task}}): {{{summary}}}
{{else}}
- None.
{{/each}}
Binding decisions:
{{#each projection.decisions}}
- {{{id}}}: {{{summary}}}
{{else}}
- None.
{{/each}}
Rejected approaches:
{{#each projection.rejectedApproaches}}
- {{{id}}}: {{{summary}}} — {{{reason}}}
{{else}}
- None.
{{/each}}
Completed task identities that must not redispatch:
{{#each completed}}
- task {{number}}: {{{title}}} [{{{state}}}] must not redispatch{{#if landingOutstanding}}; landing/claim obligation remains{{/if}}
{{else}}
- None.
{{/each}}
Todos:
{{#each projection.todos}}
- [{{{status}}}] {{{id}}}: {{{content}}}
{{else}}
- None recorded.
{{/each}}
Role obligations:
{{#each roleObligations}}
- {{{this}}}
{{else}}
- None.
{{/each}}
Live project services:
{{#each services}}
- {{{name}}} id {{{id}}} startedAt {{startedAt}} persist {{persist}} detached {{detached}}{{#if pid}} pid {{pid}}{{/if}}{{#if owner}} owner {{{owner}}}{{/if}}
{{else}}
- None.
{{/each}}

Layer 2 — Focused working set
Exact current task brief (authoritative; do not paraphrase over it):
{{{currentBriefText}}}
Current report: {{{currentReport}}}
Current review package: {{{currentReviewPackage}}}
{{#if hasCommits}}
Reviewed commits base {{{commitBase}}}; head {{{commitHead}}}
{{/if}}
{{#if current.claim}}
Execution claim {{{current.claim.ref}}} status {{{current.claim.status}}}{{#if hasClaimRevision}}; revision {{current.claim.observedRevision}}{{/if}}
{{/if}}

Layer 3 — Indexed recovery references
Retrieve these only when the current task needs them. Pointers are not complete history.
Source transcript {{{sourceTranscript}}}
Other tasks (status/obligation summaries only):
{{#each otherTasks}}
- task {{number}}: {{{title}}} [{{{state}}}/{{{phase}}}] {{#if completed}}must not redispatch{{else}}{{#if nextAction}}obligation: {{{nextAction}}}{{else}}not current{{/if}}{{/if}}
{{#if reportReference}}
  report {{{reportReference}}}
{{/if}}
{{#if reviewReference}}
  review package {{{reviewReference}}}
{{/if}}
{{else}}
- None.
{{/each}}
Discoveries (free-form evidence; do not invent workflow completion):
{{#each discoveries}}
- {{{summary}}}
{{#each references}}
  evidence {{{this}}}
{{/each}}
{{else}}
- None recorded.
{{/each}}
