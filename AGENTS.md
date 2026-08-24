# LeagueVid repository instructions

## Workspace roles

- `H:\LeagueVid` is the development workspace. Make all source, configuration, documentation, and release-preparation changes here.
- `LeagueVid Main` is the installed release-build test area. Do not edit, patch, or copy development files into it directly.
- The only supported way to change `LeagueVid Main` is through LeagueVid's **Check for Updates** flow after a newer release has been published.

## GitHub and release policy

- After every user-approved project change, run the relevant checks and commit the task files locally.
- Do not push commits, tags, releases, installers, or other changes to GitHub unless the user explicitly asks for a push.
- For this project, "update GitHub" includes refreshing the current GitHub Release and its downloadable installer; pushing source code alone is not complete.
- Every published change must use a version higher than the latest published release so installed clients can discover it through Check for Updates. Use a patch bump for normal fixes and branding updates; never move or reuse a published version tag.
- Use a minor or major bump only for a correspondingly larger change or when the user explicitly requests one.
- After triggering a release rebuild, wait for the workflow to finish and verify that the tag resolves to the intended commit and the release asset has a new update timestamp.
