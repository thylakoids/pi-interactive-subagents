# Agent instructions

## Development checkouts

Before updating or synchronizing a checkout, inspect HEAD, the working tree, and local versus remote history. Preserve local commits and uncommitted work. Pi's Git package updates may reset and clean the checkout; use Git to synchronize development work rather than assuming the remote branch supersedes local changes.

## Review agents

Agent definitions live in `agents/`. The `review` entry point dispatches correctness and combined code-quality/simplicity reviewers in parallel, then verifies candidate findings. See [docs/review-workflow.md](docs/review-workflow.md).

Review is read-only and does not run tests or other executable checks. Discuss changes to review rules or configured models before implementing them.

## Public documentation

Keep repository documentation useful to contributors. Use portable examples and generic paths; keep personal machine details, private configuration locations, and cross-machine operation logs outside this repository.
