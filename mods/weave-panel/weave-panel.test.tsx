import { expect, mock, test } from 'claude-code/testing'

import { classify, orbSvg } from './hooks/register'

const BAND = {
  plugin: 'weave-panel',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 20 },
} as const

test('files and shell commands map to a folder, a name and a verb', () => {
  const cwd = 'C:\\work\\weave'
  expect(classify('Edit', { file_path: 'C:\\work\\weave\\src\\ui\\src\\main.ts' }, cwd, 'weave')).toEqual({ verb: 'Edit', folder: 'src/ui', name: 'main.ts' })
  expect(classify('Read', { file_path: 'C:\\work\\weave\\README.md' }, cwd, 'weave')).toEqual({ verb: 'Read', folder: 'weave', name: 'README.md' })
  expect(classify('Grep', { path: 'C:\\work\\weave\\test' }, cwd, 'weave')).toEqual({ verb: 'Read', folder: 'test', name: 'Grep' })
  expect(classify('Bash', { command: 'npm test' }, cwd, 'weave')).toEqual({ verb: 'Run', folder: 'weave', name: 'Shell' })
  expect(classify('Bash', { command: 'gh pr create' }, cwd, 'weave')).toEqual({ verb: 'PR', folder: 'weave', name: 'PR' })
})

test('every orb is one looping SVG under the size limit', () => {
  for (const verb of ['Read', 'Edit', 'Run', 'PR'] as const) {
    const source = orbSvg(verb)
    expect(source.startsWith('<svg')).toBe(true)
    expect(source.length).toBeLessThan(60000)
  }
})

test('the panel lists the turn, then expands, on both surfaces', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  mock.clock(on)
  on('turn.start', () => ({ turnId: 't1' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: 'C:\\work\\weave', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: "go", turnId: "t1" })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\work\\weave\\src\\ui\\src\\main.ts', old_string: 'a', new_string: 'b' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /main\.ts/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /SRC\/UI/ })).toBeFalsy()
    await ui.press({ key: 'expand' })
    expect(await ui.find({ type: 'Text', text: /SRC\/UI/ })).toBeTruthy()
    await ui.press({ key: 'expand' })
    await ui.unmount()
  }
})
