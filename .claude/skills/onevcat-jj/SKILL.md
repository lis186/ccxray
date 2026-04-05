# jj (Jujutsu) — Version Control for Agent Workflows

jj is a version control tool that coexists with Git. You use jj locally; the remote is still standard Git. GitHub and collaborators see ordinary git commits and branches.

This skill teaches you how to use jj correctly and idiomatically, especially in agent-assisted development workflows.

## Core Mental Model

jj revolves around **changes**, not branches. Key differences from Git:

- **No staging area.** File modifications are automatically part of the current change. There is no `git add`.
- **No stash.** Just `jj new` to start fresh work; previous changes stay where they are.
- **No detached HEAD.** `jj edit` lets you jump to any change and keep working; descendants auto-rebase.
- **Branches are called bookmarks** and are only needed when pushing to a remote.

The working copy IS a change. Every file modification is instantly tracked in the current change.

## Detecting a jj Repo

Before performing version control operations, check if the repo uses jj:

```bash
# If .jj/ exists, use jj commands — not git commands
test -d .jj && echo "jj repo"
```

When a repo has both `.jj/` and `.git/` (colocated mode), always prefer jj commands for local operations.

## Setup

To initialize jj in an existing Git repo (colocated mode — keeps `.git/` alongside `.jj/`):

```bash
jj git init --colocate
```

After init, you may need to track remote bookmarks so jj knows about remote branches:

```bash
jj bookmark track master@origin        # Track a specific remote branch
```

jj will usually hint you about this if it's needed.

## Essential Commands

### Inspect State

```bash
jj log                    # Show change graph + status (replaces git log + git status)
jj diff                   # Show diff of current change vs parent
jj diff -r <change>       # Show diff of a specific change
```

`jj log` output shows `@` for the current change and short Change IDs (e.g., `kxryzmsp`). Change IDs are stable across rebases — use them freely as references. You can use unique prefixes (e.g., `kx` instead of `kxryzmsp`) as long as they are unambiguous.

### Work on Changes

```bash
jj describe -m "feat: add auth module"   # Set/update description of current change
jj describe -r <change> -m "new msg"     # Update description of any change
jj new                                    # Finish current change, start a new empty one
jj new <change>                           # Start new work branching from a specific change
jj commit -m "feat: ..."                  # Shorthand: describe current + start new (equivalent to describe + new)
jj edit <change>                          # Jump to an existing change and continue editing it
jj abandon                                # Discard the current change entirely
jj abandon <change>                       # Discard a specific change
```

**`jj new` is your primary "next task" command.** It seals the current change and gives you a fresh workspace. No add, no commit ceremony.

**`jj abandon`** discards a change completely. The change's modifications are absorbed into its parent. Use it to clean up empty changes, throw away unwanted work, or remove a change from a chain.

**`jj edit` is safe:** if the target change is immutable (already pushed to remote), jj will refuse with an error. You do not need to check this yourself.

After `jj edit`, modifying files amends that change in place. All descendant changes auto-rebase — you never need to manually rebase after editing an ancestor.

### Reorganize History

```bash
jj split                                 # Interactively split current change into two (or more)
jj split -r <change>                     # Split a specific change
jj rebase -s <source> -d <destination>   # Move a change (and its descendants) to a new parent
jj rebase -d <destination>               # Rebase current branch onto destination
jj undo                                  # Undo the last jj operation (any operation)
jj op log                                # View operation-level history
jj op restore <operation-id>             # Restore repo to any previous operation state
```

`jj split` opens an interactive editor by default (when no filesets are given). Select which files/hunks belong to the first change; the rest automatically become the second. Repeat to split further.

`jj undo` undoes the last operation regardless of what it was — rebase, split, describe, anything. It is always safe. Nothing is ever truly lost in jj.

### Remote Interaction (Git Bridge)

```bash
jj git fetch                             # Fetch from remote (like git fetch)
jj rebase -d master                      # Rebase current work onto latest master
jj bookmark track master@origin          # Track a remote branch (needed after init or for new remotes)
jj bookmark create my-feature -r @       # Create a bookmark (= git branch) pointing at current change
jj bookmark create my-feature -r <chg>   # Create a bookmark pointing at a specific change
jj bookmark set my-feature -r <change>   # Move an existing bookmark to a different change
jj git push                              # Push all changed bookmarks to remote
jj git push --bookmark my-feature        # Push only a specific bookmark
jj git push --deleted                    # Push bookmark deletions to remote (after jj abandon)
```

Remote Git branches are automatically mapped to jj **bookmarks** on fetch. The `master` (or `main`) you see in `jj log` IS the remote branch, accessed via bookmark.

After `jj git init --colocate` or when a new remote branch appears, you may need `jj bookmark track <name>@<remote>` to tell jj to follow it. jj will hint you when this is needed.

**Workflow for pushing:**
1. Finish your work (describe the change)
2. `jj bookmark create <name> -r <change>` — give it a Git branch name
3. `jj git push` — push to remote (or `--bookmark <name>` for just one)

**Cleanup after abandoning a pushed change:**
When you `jj abandon` a change that had a bookmark pushed to remote, the bookmark is deleted locally. Use `jj git push --deleted` to sync that deletion to the remote.

### Parallel Workspaces

```bash
jj workspace add ../workspace-name       # Create a parallel workspace (like git worktree)
```

Each workspace gets its own directory but shares the underlying repository store. Multiple agents can work in separate workspaces simultaneously from the same base, then merge results with `jj new <change1> <change2> ...`.

## Agent Workflow Patterns

These patterns leverage jj's strengths for agent-assisted development.

### Pattern 1: Start Next Task

Just `jj new` and begin. No need to add, commit, push, or create a branch first. The previous change is automatically preserved.

```bash
jj new
jj describe -m "feat: implement avatar upload"
# start working...
```

### Pattern 2: Interrupt and Resume

To handle an urgent task mid-work:

```bash
jj new master            # Branch off master for the urgent fix
# ... do the fix ...
jj describe -m "fix: critical auth bug"
jj edit <previous-change> # Jump back to where you were
# ... resume previous work ...
```

No stash, no branch switching, no state to restore.

### Pattern 3: Split After the Fact

After producing a large change, split it into logical pieces:

```bash
jj split                 # Interactive: pick files/hunks for first change, rest goes to second
jj split                 # Split again if needed
```

If a split goes wrong, `jj undo` and try again.

### Pattern 4: Skeleton Planning (Recommended for Complex Tasks)

Create empty changes as a plan, then fill them in order:

```bash
jj commit -m "refactor: extract auth module"
jj commit -m "feat: add token refresh logic"
jj commit -m "test: update auth tests"
jj commit -m "docs: update API documentation"
```

Then work through them:

```bash
jj edit <first-change>   # Jump to first skeleton change
# ... implement ...
jj edit <next-change>    # Jump to next (previous work auto-rebases descendants)
# ... implement ...
```

Each change's description serves as both the commit message and the acceptance criteria. Verify your implementation matches the description before moving on.

The description field supports the same format as git commit messages: first line is the title, blank line, then body. You can write detailed specs or prompts in the body with `-m`.

### Pattern 5: Undo and Recover

```bash
jj undo                  # Undo last operation, no questions asked
jj op log                # See full operation history if you need to go further back
jj op restore <op-id>    # Jump to any point in operation history
```

Prefer `jj undo` over trying to manually reverse changes. It is always correct and safe.

## Common Mistakes to Avoid

- **Do not use `git add`, `git commit`, `git stash`, or `git checkout` in a jj repo.** Use jj equivalents instead.
- **Do not try to `jj edit` an immutable (published) change** without good reason. jj will block this. If you need to fix something in published history, use `jj new <change>` to create a follow-up change instead.
- **Do not create bookmarks for local-only work.** Bookmarks are only needed when pushing to remote. Local work is tracked by Change IDs.
- **Do not worry about "losing" changes.** jj's operation log preserves everything. Use `jj undo` or `jj op restore` to recover from any mistake.

## Quick Reference

| Task | jj command |
|------|-----------|
| Initialize in existing git repo | `jj git init --colocate` |
| See what's going on | `jj log` |
| Describe current change | `jj describe -m "..."` |
| Start next task | `jj new` |
| Branch from specific change | `jj new <change>` |
| Edit an older change | `jj edit <change>` |
| Discard a change | `jj abandon` / `jj abandon <change>` |
| Split a change | `jj split` |
| Undo anything | `jj undo` |
| Fetch remote | `jj git fetch` |
| Track a remote branch | `jj bookmark track <name>@<remote>` |
| Rebase onto master | `jj rebase -d master` |
| Create bookmark for push | `jj bookmark create <name> -r @` |
| Move existing bookmark | `jj bookmark set <name> -r <change>` |
| Push to remote | `jj git push` |
| Push specific bookmark | `jj git push --bookmark <name>` |
| Push bookmark deletions | `jj git push --deleted` |
| Merge multiple changes | `jj new <chg1> <chg2> ...` |
| Parallel workspace | `jj workspace add <path>` |

## Beyond This Skill

This skill covers the most common operations. For advanced usage not covered here, use:

```bash
jj help                  # List all commands
jj help <command>        # Detailed help for a specific command
jj help -k <keyword>     # Search help by keyword
```

jj has rich functionality (revsets, templates, custom aliases, conflict resolution, etc.) that you can explore via `jj help` and apply based on the situation. The official documentation is at https://jj-vcs.github.io/jj/.
