import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Call, Verb } from '../types'
import { ORB_FRAMES, ORB_SECONDS } from './orbs'

// The colours WEAVE's map uses for what is being done, and its heat steps, coolest first.
const COLOR: Record<Verb, string> = { Read: '#A3A9E6', Edit: '#E9A6D2', Run: '#F6BE8A', PR: '#CFE19C' }
const HEAT = ['#A3A9E6']
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

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
export function orbSvg(verb: Verb, fill: string = COLOR[verb]): string {
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

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20" fill="${fill}"><style>@media (prefers-reduced-motion:reduce){g{display:none}g:first-of-type{display:inline}}</style>${body}</svg>`
}

/** The WEAVE wordmark: pastel spectrum when idle, solid near-black on a task colour. */
export function wordmarkSvg(solid?: string): string {
  const fill = solid ?? 'url(#w)'
  const defs = solid ? '' : '<defs><linearGradient id="w" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#A3A9E6"/><stop offset=".55" stop-color="#CFE19C"/><stop offset="1" stop-color="#F6BE8A"/></linearGradient></defs>'

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 84 26" width="84" height="26">${defs}<text x="0" y="21" font-family="Righteous, 'Space Grotesk', sans-serif" font-size="22" letter-spacing="1" fill="${fill}">WEAVE</text></svg>`
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

    // The bar counts this turn's calls; the dropdown lists everything touched this session.
    const folders = new Map<string, Map<string, Call[]>>()
    for (const c of open ? list : []) {
      const files = folders.get(c.folder) ?? new Map<string, Call[]>()
      files.set(c.name, [...(files.get(c.name) ?? []), c])
      folders.set(c.folder, files)
    }
    const current = [...mine].reverse().find(c => c.status === 'run')
    const task = live ? (current ?? mine[mine.length - 1]) : undefined
    const INK = '#0A0B0D'
    const ink2 = 'rgba(10,11,13,.62)'
    const recent = [...new Set([...mine].reverse().map(c => c.name))].filter(n => n !== task?.name).slice(0, 3)
    const wordmark = svg(wordmarkSvg(task ? INK : undefined), 'WEAVE', 84)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={2} paddingX={1} backgroundColor={task ? COLOR[task.verb] : undefined}>
          <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
            {wordmark ?? <Text bold color={task ? INK : HEAT[0]}>WEAVE</Text>}
            {task ? (svg(orbSvg(task.verb, '#FFFFFF'), 'working', 20) ?? <Text color={INK}>{glyph}</Text>) : null}
            {task ? <Text bold color={INK}>{task.name}</Text> : null}
            {task ? <Text color={ink2}>{seconds(task, at)}</Text> : null}
          </Box>
          <Box flexDirection="row" gap={3} flexShrink={1} flexGrow={1} overflow="hidden" justifyContent="flex-end">
            {recent.map(n => (
              <Text dimColor={!task} color={task ? ink2 : undefined}>{n}</Text>
            ))}
          </Box>
          <Button key="expand" label={`${mine.length} calls ${open ? '▴' : '▾'}`} onPress={() => update($, isOpen, v => !v)} />
        </Box>
        {[...folders].map(([folder, files]) => (
          <Box flexDirection="column" paddingX={1} marginTop={1}>
            <Text dimColor>{folder.toUpperCase()}</Text>
            {[...files].slice(-12).map(([name, hits]) => {
              const c = hits[hits.length - 1]
              const isRun = c.status === 'run'
              const color = isRun ? COLOR[c.verb] : undefined
              const status = isRun ? 'Running' : c.status === 'err' ? 'Failed' : 'Done'

              return (
                <Box flexDirection="row" gap={1}>
                  <Text color={color} dimColor={!isRun}>{name}</Text>
                  <Box flexGrow={1} />
                  {hits.length > 1 ? <Text color="#E9A6D2">{`×${hits.length}`}</Text> : null}
                  <Text color={color} dimColor={!isRun}>{`${status} · ${seconds(c, at)}`}</Text>
                </Box>
              )
            })}
          </Box>
        ))}
      </Box>
    )
  })
}
