// Opens a video's folder in Explorer, with the file selected.
//
// Shared between the library tile and the player, because "where is this file"
// is a question people ask from both places.
//
// The error handling is the point. The first version awaited the IPC call and
// only reported the outcomes the main process described -- so anything that
// failed *before* that, most obviously a renderer running against a preload
// build that predates the channel, rejected silently and the button looked
// broken with no clue why. A silent failure on a button that opens a window is
// the worst possible outcome, since there is nothing to distinguish it from
// having done nothing at all.

export async function revealVideoInFolder(filePath: string): Promise<void> {
  const reveal = window.api.video?.revealInFolder

  if (typeof reveal !== 'function') {
    // Almost always a stale renderer: the channel exists in the current source
    // but not in the running build.
    window.alert(
      'This build of LeagueVid cannot open folders yet. Restart the app to pick up the latest version.'
    )
    return
  }

  try {
    const result = await reveal(filePath)
    // On success Explorer comes to the front, which is its own confirmation, so
    // only a caveat is worth interrupting for.
    if (result.reason) window.alert(result.reason)
  } catch (err) {
    window.alert(`Could not open the folder: ${(err as Error).message}`)
  }
}
