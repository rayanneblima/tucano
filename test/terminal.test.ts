import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import { Terminals } from '../src/core/terminal'

const folder = realpathSync(mkdtempSync(join(tmpdir(), 'ad-term-')))
let events: CoreEvent[] = []
let t: Terminals | undefined
const make = (over: Partial<ConstructorParameters<typeof Terminals>[0]> = {}): Terminals => {
  events = []
  t = new Terminals({ emit: (e) => events.push(e), env: async () => ({ ...process.env, PS1: '$ ', SEGREDO_DO_CANAL: undefined }), shell: () => '/bin/sh', cwd: () => folder, allowed: true, ...over })
  return t
}
const printed = (id: string): string => events.flatMap((e) => (e.type === 'terminal' && e.channelId === id ? [e.data] : [])).join('')
const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 50))
}
afterEach(() => t?.closeAll())

const hasPty = process.platform !== 'win32' && (await import('node-pty').then(() => true, () => false))

describe.runIf(hasPty)('the terminal', () => {
  it('runs a real shell in the channel’s folder, with no channel keys', async () => {
    const term = make()
    await term.open('c1', 80, 24)
    term.input('c1', 'echo "pasta=$(pwd) chave=[$SEGREDO_DO_CANAL] cols=$(stty size)"\n')
    await until(() => printed('c1').includes('cols=24 80'))
    expect(printed('c1')).toContain(`pasta=${folder}`)
    expect(printed('c1')).toContain('chave=[]')
  })

  it('one per channel: opening again keeps the shell and returns what it printed', async () => {
    const term = make()
    await term.open('c1', 80, 24)
    term.input('c1', 'FICA=sim; echo marca-um\n')
    await until(() => printed('c1').includes('marca-um\r\n') )
    const again = await term.open('c1', 100, 30)
    expect(again.output).toContain('marca-um')
    term.input('c1', 'echo "ainda=$FICA $(stty size)"\n')
    await until(() => printed('c1').includes('ainda=sim 30 100'))
    await term.open('c2', 80, 24)
    term.input('c2', 'echo "outro=[$FICA]"\n')
    await until(() => printed('c2').includes('outro=[]'))
    expect(printed('c2')).toContain('outro=[]')
  })

  it('asked twice at once, opens one shell', async () => {
    let loads = 0
    const term = make({ load: async () => (loads++, (await import('node-pty')).spawn as never) })
    await Promise.all([term.open('c1', 80, 24), term.open('c1', 80, 24)])
    expect(loads).toBe(1)
  })

  it('closed while opening, leaves no shell behind', async () => {
    const term = make()
    const opening = term.open('c1', 80, 24)
    term.close('c1')
    await opening
    term.input('c1', 'echo fantasma\n')
    await new Promise((r) => setTimeout(r, 300))
    expect(printed('c1')).toBe('')
  })

  it('says when the shell ends, and closing one leaves no event behind', async () => {
    const term = make()
    await term.open('c1', 80, 24)
    term.input('c1', 'exit\n')
    await until(() => events.some((e) => e.type === 'terminal_exit'))
    expect(events.some((e) => e.type === 'terminal_exit' && e.channelId === 'c1')).toBe(true)
    events = []
    await term.open('c2', 80, 24)
    term.close('c2')
    await new Promise((r) => setTimeout(r, 200))
    expect(events.some((e) => e.type === 'terminal_exit')).toBe(false)
  })

})

describe('a terminal that can’t open', () => {
  it('refuses on a server, and says so when the component is missing', async () => {
    await expect(make({ allowed: false }).open('c1', 80, 24)).rejects.toThrow(/servidor/)
    await expect(make({ load: () => Promise.reject(new Error('sem binario')) }).open('c1', 80, 24)).rejects.toThrow(/componente/)
  })
})
