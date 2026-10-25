import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Call, Verb } from '../types'
import { ORB_FRAMES, ORB_SECONDS } from './orbs'

// The colours WEAVE's map uses for what is being done, and its heat steps, coolest first.
const COLOR: Record<Verb, string> = { Read: '#A3A9E6', Edit: '#E9A6D2', Run: '#F6BE8A', PR: '#CFE19C' }
const ING: Record<Verb, string> = { Read: 'Reading', Edit: 'Editing', Run: 'Running', PR: 'Opening PR' }
const HEAT = ['#A3A9E6', '#C3A5DD', '#E9A6D2', '#F6BE8A', '#F1A9B0']
const heat = (n: number) => HEAT[n >= 11 ? 4 : n >= 7 ? 3 : n >= 4 ? 2 : n >= 2 ? 1 : 0]
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const FOLDER = 'M1.5 4.5a1 1 0 0 1 1-1h3.6l1.4 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z'

const calls = atom({ plugin: 'weave-panel', key: 'calls' } as const, [])
const isOpen = atom({ plugin: 'weave-panel', key: 'isOpen' } as const, false)
const turn = atom({ plugin: 'weave-panel', key: 'turn' } as const, 0)
const working = atom({ plugin: 'weave-panel', key: 'working' } as const, false)
const now = atom({ plugin: 'weave-panel', key: 'now' } as const, 0)

/** The folder and file a tool call touched, by fixed rules: no model involved. */
export function classify(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  root: string,
): { verb: Verb; folder: string; name: string } {
  const text = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const path = (text('file_path') || text('notebook_path') || text('path')).replace(/\\/g, '/')
  const base = cwd.replace(/\\/g, '/').replace(/\/$/, '')
  const rel = path.startsWith(base + '/') ? path.slice(base.length + 1) : path
  const at = (verb: Verb) => {
    const parts = rel.split('/').filter(Boolean)
    const isFile = path !== '' && tool !== 'Grep' && tool !== 'Glob' && tool !== 'LS'
    const folder = path ? (isFile ? parts.slice(0, -1) : parts).slice(0, 2).join('/') : ''

    return { verb, folder: folder || root, name: isFile ? (parts[parts.length - 1] ?? tool) : tool }
  }
  if (tool === 'Read') return at('Read')
  if (tool === 'Grep' || tool === 'Glob' || tool === 'LS') return at('Read')
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit' || tool === 'MultiEdit') return at('Edit')
  if (tool === 'WebFetch' || tool === 'WebSearch') return { verb: 'Read', folder: root, name: tool }
  if (tool === 'Bash') {
    const isPr = /\b(gh\s+pr|git\s+push)\b/.test(text('command'))

    return { verb: isPr ? 'PR' : 'Run', folder: root, name: isPr ? 'PR' : 'Shell' }
  }

  return { verb: 'Run', folder: root, name: tool }
}

/** The thinking-orbs animation WEAVE's map draws, baked into one looping SVG in the verb's colour. */
export function orbSvg(verb: Verb): string {
  const frames = ORB_FRAMES[verb]
  const n = frames.length
  const body = frames
    .map((dots, k) => {
      const times = k === 0 ? `0;${1 / n};1` : k === n - 1 ? `0;${k / n};1` : `0;${k / n};${(k + 1) / n};1`
      const values = k === 0 ? '1;0;0' : k === n - 1 ? '0;1;1' : '0;1;0;0'
      const circles = dots.map(d => `<circle cx="${d[0]}" cy="${d[1]}" r="${d[2]}" opacity="${d[3]}"/>`).join('')

      return `<g opacity="0"><animate attributeName="opacity" dur="${ORB_SECONDS}s" repeatCount="indefinite" calcMode="discrete" keyTimes="${times}" values="${values}"/>${circles}</g>`
    })
    .join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20" fill="${COLOR[verb]}">${body}</svg>`
}

export function folderSvg(tint: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14"><path d="${FOLDER}" fill="none" stroke="${tint}" stroke-width="1.5" stroke-linejoin="round"/></svg>`
}

const seconds = (c: Call, at: number) => `${Math.max(0, Math.round(((c.status === 'run' ? at : c.end) - c.start) / 1000))}s`

export const register: Register = on => {
  let cwd = ''
  let root = 'project'
  let cancel: (() => void) | undefined

  on('session.start', async ($, e, next) => {
    cwd = e.cwd ?? ''
    root = cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? 'project'
    await update($, calls, () => [])
    await update($, working, () => false)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, turn, n => n + 1)
    await update($, working, () => true)
    cancel?.()
    try {
      // Redraws the seconds and the terminal's spinner once a second while a turn runs.
      const timer = $.clock.every(1000, () => {
        void $.clock.now().then(t => update($, now, () => t))
      })
      cancel = () => timer.cancel()
    } catch {
      cancel = undefined
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    cancel?.()
    cancel = undefined
    await update($, working, () => false)
    await update($, now, () => 0)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const at = await $.clock.now()
    const id = e.tool_use_id ?? `${e.tool}-${at}`
    const t = await read($, turn)
    const hit = classify(e.tool, e as unknown as Record<string, unknown>, cwd, root)
    const call: Call = { id, ...hit, status: 'run', turn: t, start: at, end: at }
    await update($, calls, list => [...list, call].slice(-300))

    const ran = await next(e)

    const end = await $.clock.now()
    const status = ran.deny !== undefined || ran.isError === true ? 'err' : 'done'
    await update($, calls, list => list.map(c => (c.id === id ? { ...c, status, end } : c)))

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, calls)
    const t = await read($, turn)
    const open = await read($, isOpen)
    const live = await read($, working)
    const tick = await read($, now)
    const mine = list.filter(c => c.turn === t)
    if (e.props.hasSurvey || mine.length === 0) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const at = tick || Math.max(...mine.map(c => c.end))
    const glyph = SPIN[Math.floor(at / 1000) % SPIN.length]
    const svg = (source: string, alt: string, size: number) =>
      e.surface === 'desktop'
        ? ($.ui.resolve(e) as unknown as { Svg: (p: Record<string, unknown>) => never }).Svg({ source, alt, width: size, height: size, isInteractive: true })
        : null

    // Collapsed: this turn's files grouped by folder, the last three folders, three files each.
    // Expanded: everything touched this session, each file tinted by how often it was touched.
    const folders = new Map<string, Map<string, Call[]>>()
    for (const c of open ? list : mine) {
      const files = folders.get(c.folder) ?? new Map<string, Call[]>()
      files.set(c.name, [...(files.get(c.name) ?? []), c])
      folders.set(c.folder, files)
    }
    const shown = open ? [...folders] : [...folders].slice(-3)
    const running = mine.filter(c => c.status === 'run').length

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="#8E95DB" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>
            {`WEAVE · ${live ? 'live' : 'last turn'} · ${open ? `${folders.size} folders` : `${mine.length} calls`}${running ? ` · ${running} running` : ''}`}
          </Text>
          <Button key="expand" label={open ? '⤡ collapse' : '⤢ expand'} onPress={() => update($, isOpen, v => !v)} />
        </Box>
        {shown.map(([folder, files]) => {
          const all = [...files.values()].flat()
          const tint = all.some(c => c.status === 'run') ? COLOR[all[all.length - 1].verb] : HEAT[0]
          const entries = [...files].slice(open ? -12 : -3)

          return (
            <Box flexDirection="column">
              <Box flexDirection="row" gap={1}>
                {svg(folderSvg(tint), 'folder', 14) ?? <Text color={tint}>▭</Text>}
                <Text dimColor>{folder}</Text>
              </Box>
              {entries.map(([name, hits], i) => {
                const c = hits[hits.length - 1]
                const isRun = c.status === 'run'
                const color = open && !isRun ? heat(hits.length) : COLOR[c.verb]
                const status = isRun ? ING[c.verb] : c.status === 'err' ? 'Failed' : 'Done'

                return (
                  <Box flexDirection="row" gap={1} alignItems="center">
                    <Text color={color}>{i === entries.length - 1 ? ' ╰┄' : ' ├┄'}</Text>
                    <Text color={color}>▌</Text>
                    {isRun ? (svg(orbSvg(c.verb), ING[c.verb], 20) ?? <Text color={color}>{glyph}</Text>) : <Text color={color}>•</Text>}
                    <Text dimColor={!isRun}>{name}</Text>
                    <Box flexGrow={1} />
                    {open && hits.length > 1 ? <Text color={color}>{`×${hits.length}`}</Text> : null}
                    <Text dimColor>{`${status} · ${seconds(c, at)}`}</Text>
                    <Text color={color}>{isRun ? '●' : '○'}</Text>
                  </Box>
                )
              })}
            </Box>
          )
        })}
      </Box>
    )
  })
}
