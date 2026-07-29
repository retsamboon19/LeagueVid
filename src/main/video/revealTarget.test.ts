import { describe, expect, it } from 'vitest'
import { planReveal } from './revealTarget'

const FILE = 'H:\\LeagueVid\\recordings\\League of Legends 2026-07-29 22-52-51.mp4'
const FOLDER = 'H:\\LeagueVid\\recordings'

/** Existence check over a fixed set of paths. */
function present(...paths: string[]) {
  return (path: string): boolean => paths.includes(path)
}

describe('planReveal', () => {
  it('selects the file when it is there', () => {
    expect(planReveal(FILE, present(FILE, FOLDER))).toEqual({
      action: 'select-file',
      path: FILE,
      reason: null
    })
  })

  // A recording moved or deleted outside the app is common, and opening its
  // folder is still useful -- as long as the user is told that's what happened.
  it('opens the folder when the file has gone but the folder remains', () => {
    const plan = planReveal(FILE, present(FOLDER))
    expect(plan.action).toBe('open-folder')
    expect(plan.path).toBe(FOLDER)
    expect(plan.reason).toContain('no longer there')
  })

  it('does nothing, and says so, when neither exists', () => {
    const plan = planReveal(FILE, present())
    expect(plan.action).toBe('none')
    expect(plan.path).toBe('')
    expect(plan.reason).toContain('Neither the file nor the folder')
  })

  it('handles a missing path rather than opening something arbitrary', () => {
    const plan = planReveal('', present(FOLDER))
    expect(plan.action).toBe('none')
    expect(plan.reason).toContain('no file path')
  })

  // The older revealClip helper falls back to the clips folder, which for a
  // recording stored elsewhere would open a completely unrelated directory and
  // look like it worked.
  it('never falls back to a directory unrelated to the file', () => {
    const plan = planReveal('D:\\Elsewhere\\game.mp4', present('H:\\LeagueVid\\clips'))
    expect(plan.action).toBe('none')
    expect(plan.path).not.toContain('clips')
  })

  it('works for a file sitting at a drive root', () => {
    const plan = planReveal('D:\\game.mp4', present('D:\\'))
    expect(plan.action).toBe('open-folder')
    expect(plan.path).toBe('D:\\')
  })
})
