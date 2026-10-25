export type Verb = 'Read' | 'Edit' | 'Run' | 'PR'

/** One tool call, reduced to the folder and file it touched. */
export type Call = {
  id: string
  verb: Verb
  folder: string
  name: string
  status: 'run' | 'done' | 'err'
  turn: number
  start: number
  end: number
}

declare module 'claude-code' {
  interface PluginState {
    'weave-panel': {
      calls: Call[]
      isOpen: boolean
      turn: number
      working: boolean
      now: number
    }
  }
}
