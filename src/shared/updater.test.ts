import { describe, expect, it } from 'vitest'
import { compareVersions, updateIsAvailable } from './updater'

const currentCommit = '1111111111111111111111111111111111111111'
const latestCommit = '2222222222222222222222222222222222222222'

describe('compareVersions', () => {
  it('compares major, minor and patch versions numerically', () => {
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('0.3.1', '0.3.1')).toBe(0)
    expect(compareVersions('0.3.0', '0.3.1')).toBe(-1)
  })
})

describe('updateIsAvailable', () => {
  it('offers a newer semantic version', () => {
    expect(updateIsAvailable('0.3.0', '0.4.0', currentCommit, latestCommit)).toEqual({
      available: true,
      sameVersionRefresh: false
    })
  })

  it('offers a rebuilt installer when the existing version tag moves', () => {
    expect(updateIsAvailable('0.3.0', '0.3.0', currentCommit, latestCommit)).toEqual({
      available: true,
      sameVersionRefresh: true
    })
  })

  it('does not offer the installed asset again', () => {
    expect(updateIsAvailable('0.3.0', '0.3.0', currentCommit, currentCommit)).toEqual({
      available: false,
      sameVersionRefresh: false
    })
  })

  it('does not offer an update from an uncommitted development build', () => {
    expect(updateIsAvailable('0.3.0', '0.3.0', 'development', latestCommit)).toEqual({
      available: false,
      sameVersionRefresh: false
    })
  })
})
