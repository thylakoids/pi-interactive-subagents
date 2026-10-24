# Agent instructions

## Development checkouts

Before updating or synchronizing a checkout, inspect HEAD, the working tree, and local versus remote history. Preserve local commits and uncommitted work. Pi's Git package updates may reset and clean the checkout; use Git to synchronize development work rather than assuming the remote branch supersedes local changes.

After validating changes, commit and push them unless the user explicitly requests otherwise. Do not leave verified development work only in the package checkout, where an automatic package update could overwrite it. Report any validation or push failure instead of claiming the work is safely synchronized.

## Agent definitions

Agent definitions live in `agents/`. A multi-agent job — a review, a migration, a research
sweep — is a [workflow](docs/workflow.md) script, not a dedicated agent definition: the script
carries the orchestration, and each `agent()` call names an ordinary definition from `agents/`.
`worker.md` is the default when a workflow call names none. Workflow execution constraints
belong in the runtime, not a second agent definition; keep ordinary worker capabilities
available outside workflows.

## Public documentation

Keep repository documentation useful to contributors. Use portable examples and generic paths; keep personal machine details, private configuration locations, and cross-machine operation logs outside this repository.
