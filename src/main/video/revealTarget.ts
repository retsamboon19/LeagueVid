import { dirname } from 'path'

// Decides what "show in folder" should actually do.
//
// Pure, with existence passed in, because the three cases have different
// outcomes and only one of them is the happy path: the file is there, the file
// has moved but its folder remains, or neither exists. Reaching for the shell
// before working that out is how a button ends up silently doing nothing.

export type RevealAction = 'select-file' | 'open-folder' | 'none'

export interface RevealPlan {
  action: RevealAction
  /** What to hand to the shell. Empty when there's nothing to open. */
  path: string
  /** Worth telling the user, when the outcome isn't what they asked for. */
  reason: string | null
}

export function planReveal(filePath: string, exists: (path: string) => boolean): RevealPlan {
  if (!filePath) {
    return { action: 'none', path: '', reason: 'This entry has no file path recorded.' }
  }

  if (exists(filePath)) {
    return { action: 'select-file', path: filePath, reason: null }
  }

  // Deliberately not the clips folder, which is where the older revealClip
  // helper falls back to. For a recording stored anywhere else that would open a
  // completely unrelated directory and look like it worked.
  const parent = dirname(filePath)
  if (parent && parent !== filePath && exists(parent)) {
    return {
      action: 'open-folder',
      path: parent,
      reason: 'That file is no longer there, so its folder was opened instead.'
    }
  }

  return {
    action: 'none',
    path: '',
    reason: 'Neither the file nor the folder it was in still exists.'
  }
}
