# Git and GitHub maintenance

The GitHub remote (`origin`, `retsamboon19/LeagueVid`) is the project's
maintained record. Keep it current without being asked.

## Standing expectations

- After completing a unit of work that builds and typechecks, commit it and
  push to `origin`. Don't leave finished work sitting uncommitted.
- Before committing, run `npm run typecheck` and `npm run build`. A commit
  should never break the build.
- Work happens on `master` for this project — it's a solo repo and history
  is linear. Push directly to `master` rather than opening branches/PRs,
  unless the change is large or experimental enough to be worth isolating.
- Stage specific files by name. Never `git add -A` or `git add .`, so that
  unrelated local experiments don't get swept in.
- `.env` holds the Riot API key and is gitignored. Never stage it, and never
  echo its contents into chat, commit messages, or files.

## Commit message style

Conventional-commit prefix, imperative subject under ~70 chars, then a body
explaining *why* when the reasoning isn't obvious from the diff:

```
feat: detect solo kills under enemy turrets as tower dives

Riot's API has no under-turret flag, so this is derived locally from the
timeline kill position against a static turret coordinate table.
```

Prefixes in use: `feat`, `fix`, `refactor`, `docs`, `chore`, `perf`.

## What not to do

- No `--amend` on pushed commits, no force pushes, no `reset --hard`, no
  `clean -fd` without explicit permission.
- No `--no-verify`.
- Don't touch git config.
