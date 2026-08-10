# LeagueVid repository instructions

## GitHub and release policy

- After every user-approved project change, run the relevant checks and commit the task files locally.
- Do not push commits, tags, releases, installers, or other changes to GitHub unless the user explicitly asks for a push.
- For this project, "update GitHub" includes refreshing the current GitHub Release and its downloadable installer; pushing source code alone is not complete.
- Treat the version in `package.json` as the current release version. For normal fixes, branding updates, and other non-major changes, move that existing version tag to the accepted commit and let the release workflow replace its installer.
- Create a new version only for a major change or when the user explicitly requests a new version.
- After triggering a release rebuild, wait for the workflow to finish and verify that the tag resolves to the intended commit and the release asset has a new update timestamp.
