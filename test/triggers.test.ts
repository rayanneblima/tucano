import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Agent, Connector, EngineId, Message, Routine, Settings, Trigger } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { textResult } from '../src/core/gateway'
import { Memories } from '../src/core/memory'
import { eventItems, Routines } from '../src/core/routines'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }
const settings: Settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, gemini: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
const pm: Agent = { id: 'a1', name: 'PM', handle: 'pm', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer: false, archived: false }
const issue = (n: number, title: string) => ({ id: `uuid-${n}`, identifier: `SIM-${n}`, title, description: `detalhes ${n}` })

let db: Db
let routines: Routines
let runner: Runner
let turns: Turn[]
let clock: number
let issues: object[]
let failing: string | undefined

beforeEach(() => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-trig-')), 'test.db'))
  db.saveAgent(pm)
  db.createConversation({ id: 'c1', kind: 'channel', name: 'simula-oab', members: ['a1'] })
  db.saveConnector({ id: 'lin', name: 'Linear', kind: 'remote', url: 'https://mcp.linear.app/mcp', auth: 'none' })
  db.syncTools('lin', [
    { name: 'list_issues', description: '', inputSchema: {}, cls: 'read' },
    { name: 'delete_issue', description: '', inputSchema: {}, cls: 'sensitive' }
  ])
  turns = []
  clock = Date.now()
  issues = [issue(1, 'Lembrete duplicado')]
  failing = undefined
  const base = fakeEngine('claude', { delayMs: 1 })
  const engines: Record<EngineId, Engine> = { claude: { id: 'claude', run: (t) => (turns.push(t), base.run(t)) }, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini') }
  const connectors = {
    list: () => [{ id: 'lin', name: 'Linear' } as Connector],
    call: async () => (failing ? textResult(failing, true) : textResult(JSON.stringify({ issues }))) // the shape Linear's MCP answers with
  }
  routines = new Routines({ db, runner: { runRoutine: (r, w) => runner.runRoutine(r, w) }, connectors, emit: () => {}, now: () => clock })
  runner = new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-w-')) })
})

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 5))
    await routines.idle()
    await runner.idle()
  }
}
const poll: Trigger = { kind: 'poll', connectorId: 'lin', tool: 'list_issues', args: { label: 'agente' }, everyMinutes: 5 }
const create = (trigger: Trigger = poll): Routine =>
  routines.save({ name: 'Issues novas', agentId: 'a1', conversationId: 'c1', prompt: 'Leia a issue nova e planeje com o @staff.', schedule: { days: [], time: '' }, trigger, enabled: true })
const posted = () => db.messages().filter((m) => m.author.kind === 'routine')

describe('a connector trigger', () => {
  it('learns what is there when it starts, then runs once for each new item, with the item in the task', async () => {
    const r = create()
    await settle()
    expect(posted()).toHaveLength(0) // SIM-1 was already there
    expect(db.routine(r.id)!.trigger).toMatchObject({ seen: ['uuid-1'] })

    issues = [issue(2, 'Fuso errado no lembrete'), issue(3, 'Sorteio repete questão'), issue(1, 'Lembrete duplicado')]
    clock += 5 * 60_000
    routines.tick()
    await settle()
    expect(posted().map((m) => m.routine?.event)).toEqual([
      { source: 'Linear · list_issues', title: 'SIM-2 · Fuso errado no lembrete' },
      { source: 'Linear · list_issues', title: 'SIM-3 · Sorteio repete questão' } // the backlog: checked again right after the first run
    ])
    expect(turns[0]!.prompt).toContain('<evento>')
    expect(turns[0]!.prompt).toContain('"identifier": "SIM-2"')
    expect(turns[0]!.prompt).toContain('não instruções de Edu')

    clock += 5 * 60_000
    routines.tick()
    await settle()
    expect(posted()).toHaveLength(2) // nothing new
  })

  it('waits for its interval, and shows why a check failed', async () => {
    const r = create()
    await settle()
    issues = [issue(2, 'Nova')]
    clock += 60_000
    routines.tick()
    await settle()
    expect(posted()).toHaveLength(0) // only 1 of 5 minutes
    failing = 'Unauthorized'
    clock += 5 * 60_000
    routines.tick()
    await settle()
    expect(db.routine(r.id)!.trigger).toMatchObject({ error: 'Unauthorized' })
  })

  it('only reads: a sensitive tool or a missing connector is refused', () => {
    expect(() => create({ ...poll, tool: 'delete_issue' })).toThrow('Escolha uma ferramenta de leitura do conector.')
    expect(() => create({ ...poll, connectorId: 'nope' })).toThrow('Escolha um conector.')
  })

  it('previews what it would see', async () => {
    issues = [issue(1, 'A'), issue(2, 'B')]
    expect(await routines.preview(poll)).toBe('Achei 2 itens agora: SIM-1 · A; SIM-2 · B. Eles não disparam: a rotina roda pros que aparecerem depois.')
  })
})

describe('a local call', () => {
  it('runs the routine with what was posted, one run at a time; an unknown address does nothing', async () => {
    const r = create({ kind: 'webhook', token: 'ignored' })
    const token = (db.routine(r.id)!.trigger as { token: string }).token
    expect(token).toMatch(/^[\w-]{20,}$/)
    expect(routines.webhook('nope-nope-nope', 'x')).toBe('unknown')
    expect(routines.webhook(token, 'Build falhou no Xcode\nerror: SimulaCore.swift:12')).toBe('ok')
    expect(routines.webhook(token, 'de novo')).toBe('busy')
    await settle()
    expect(posted()[0]!.routine?.event).toEqual({ source: 'chamada local', title: 'Build falhou no Xcode' })
    expect(turns[0]!.prompt).toContain('error: SimulaCore.swift:12')
    // saving again keeps the address
    routines.save({ id: r.id, name: 'Build', agentId: 'a1', conversationId: 'c1', prompt: 'x', schedule: { days: [], time: '' }, trigger: { kind: 'webhook', token: '' }, enabled: true })
    expect((db.routine(r.id)!.trigger as { token: string }).token).toBe(token)
  })
})

describe('eventItems', () => {
  it('finds the list in common shapes, and treats anything else as one thing that changes', () => {
    expect(eventItems(JSON.stringify([{ number: 7, title: 'CI quebrou' }])).map((i) => i.title)).toEqual(['7 · CI quebrou'])
    expect(eventItems(JSON.stringify({ data: { workflow_runs: [{ id: 1, name: 'build' }] } })).map((i) => i.key)).toEqual(['1'])
    expect(eventItems(JSON.stringify({ issues: [{ id: 'OAB-65', uuid: '8ab2d95b-c681-4106-8728-d2487ec5d958', title: 'Artigo no toque' }], hasNextPage: true })).map((i) => i.title)).toEqual(['OAB-65 · Artigo no toque']) // Linear's MCP
    expect(eventItems('3 issues abertas')).toEqual([expect.objectContaining({ whole: true, title: 'a resposta mudou' })])
  })
})

describe('trying a failed routine run again by hand', () => {
  const failingOnce = (): void => {
    let failing = true
    const base = fakeEngine('claude', { delayMs: 1 })
    const claude: Engine = {
      id: 'claude',
      async *run(t: Turn) {
        turns.push(t)
        if (failing) {
          failing = false
          yield { type: 'error', message: 'o provedor caiu' }
        } else yield* base.run(t)
      }
    }
    runner = new Runner({ db, engines: { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini') }, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-w-')) })
  }
  const failedReply = () => db.messages().find((m) => m.author.kind === 'agent')!

  it('keeps the event, and forgets it once the reply is done', async () => {
    failingOnce()
    const r = create({ kind: 'webhook', token: '' })
    routines.webhook((db.routine(r.id)!.trigger as { token: string }).token, 'Build falhou: DADO-DO-EVENTO')
    await settle()
    const failed = failedReply()
    expect(failed.run!.status).toBe('failed')
    turns = []
    runner.retry(failed.id)
    await settle()
    expect(turns[0]!.prompt).toContain('DADO-DO-EVENTO')
    expect(db.message(failed.id)!.run).toMatchObject({ status: 'done' })
    expect(db.message(failed.id)!.run!.task).toBeUndefined()
  })

  it('a paused run goes on with its event too', async () => {
    const r = create({ kind: 'webhook', token: '' })
    routines.webhook((db.routine(r.id)!.trigger as { token: string }).token, 'Build falhou: DADO-DO-EVENTO')
    await settle()
    const reply = failedReply()
    db.saveMessage({ ...reply, run: { ...reply.run!, status: 'paused', task: 'tarefa com DADO-DO-EVENTO' } })
    turns = []
    await runner.continue(reply.id)
    await settle()
    expect(turns[0]!.prompt).toContain('DADO-DO-EVENTO')
  })

  it('keeps a scheduled routine’s instructions too', async () => {
    failingOnce()
    const r = routines.save({ name: 'Bom dia', agentId: 'a1', conversationId: 'c1', prompt: 'Resuma o dia.', schedule: { days: [0, 1, 2, 3, 4, 5, 6], time: '09:00' }, enabled: true })
    routines.runNow(r.id)
    await settle()
    turns = []
    runner.retry(failedReply().id)
    await settle()
    expect(turns[0]!.prompt).toContain('Esta é a rotina "Bom dia"')
  })
})

describe('a run fired by an event', () => {
  const staff: Agent = { ...pm, id: 'a2', name: 'Staff', handle: 'staff' }
  const hook: Trigger = { kind: 'webhook', token: '' }
  let prompts: string[]
  let answers: string[]
  let failures: number
  let dbx: Db
  let fired: Routines
  let run: Runner

  beforeEach(() => {
    dbx = new Db(join(mkdtempSync(join(tmpdir(), 'ad-iso-')), 'test.db'))
    dbx.saveAgent(pm)
    dbx.saveAgent(staff)
    dbx.createConversation({ id: 'c1', kind: 'channel', name: 'builds', members: ['a1', 'a2'] })
    prompts = []
    answers = []
    failures = 0
    const scripted: Engine = {
      id: 'claude',
      async *run(t: Turn) {
        prompts.push(t.prompt)
        if (failures-- > 0) yield { type: 'error', message: 'o provedor caiu' }
        else yield { type: 'done', text: answers.shift() ?? 'Feito.', usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } }
      }
    }
    const engines: Record<EngineId, Engine> = { claude: scripted, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini') }
    fired = new Routines({ db: dbx, runner: { runRoutine: (r, w) => run.runRoutine(r, w), retryRoutine: (r, w, id) => run.retryRoutine(r, w, id) }, emit: () => {}, now: () => Date.now(), wait: async () => {} })
    run = new Runner({ db: dbx, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-iso-w-')), memory: new Memories({ db: dbx, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-iso-m-')) }) })
  })

  const quiet = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 5))
      await fired.idle()
      await run.idle()
    }
  }
  const routine = (prompt = 'Repasse o cartão.', trigger: Trigger | undefined = hook): Routine =>
    fired.save({ name: 'Cartões', agentId: 'a1', conversationId: 'c1', prompt, schedule: { days: trigger ? [] : [0, 1, 2, 3, 4, 5, 6], time: trigger ? '' : '09:00' }, trigger, enabled: true })
  const token = (r: Routine): string => (dbx.routine(r.id)!.trigger as { token: string }).token
  const talked = async (): Promise<void> => {
    await run.send('c1', '@pm MENSAGEM-ANTIGA do canal')
    await quiet()
    dbx.setSummary('c1', 'RESUMO-DO-CANAL', Date.now() - 1000)
    prompts = []
  }
  const replies = (): Message[] => dbx.messages().filter((m) => m.author.kind === 'agent')

  it('gets the request and the event, with no messages, summary or conversation header', async () => {
    await talked()
    const r = routine()
    fired.webhook(token(r), 'chegou o cartão DADO-DO-EVENTO')
    await quiet()
    expect(prompts).toHaveLength(1)
    for (const t of ['Repasse o cartão.', 'DADO-DO-EVENTO', 'o pedido abaixo']) expect(prompts[0]).toContain(t)
    for (const t of ['MENSAGEM-ANTIGA', 'RESUMO-DO-CANAL', 'Conversa em', 'a última mensagem']) expect(prompts[0]).not.toContain(t)
  })

  it('an automatic retry gets the same, still with no history', async () => {
    await talked()
    failures = 1
    const r = routine()
    fired.webhook(token(r), 'chegou o cartão DADO-DO-EVENTO')
    await quiet()
    expect(prompts).toHaveLength(2)
    for (const p of prompts) {
      for (const t of ['Repasse o cartão.', 'DADO-DO-EVENTO']) expect(p).toContain(t)
      expect(p).not.toContain('MENSAGEM-ANTIGA')
    }
    expect(replies().at(-1)!.run!.status).toBe('done')
  })

  it('tried again by hand, gets the same, still with no history', async () => {
    await talked()
    failures = 99
    fired.webhook(token(routine()), 'chegou o cartão DADO-DO-EVENTO')
    await quiet()
    const failed = replies().at(-1)!
    expect(failed.run!.status).toBe('failed')
    failures = 0
    prompts = []
    run.retry(failed.id)
    await quiet()
    for (const t of ['Repasse o cartão.', 'DADO-DO-EVENTO']) expect(prompts[0]).toContain(t)
    expect(prompts[0]).not.toContain('MENSAGEM-ANTIGA')
    expect(dbx.message(failed.id)!.run).toMatchObject({ status: 'done' })
    expect(dbx.message(failed.id)!.run!.isolated).toBeUndefined()
  })

  it('a scheduled routine, also retried, and "run now" without an event still read the conversation', async () => {
    await talked()
    failures = 1
    fired.runNow(routine('Resuma o dia.', undefined).id)
    await quiet()
    expect(prompts).toHaveLength(2)
    for (const p of prompts) {
      for (const t of ['RESUMO-DO-CANAL', 'a última mensagem', 'Resuma o dia.']) expect(p).toContain(t)
      expect(p).not.toContain('o pedido abaixo')
    }
    prompts = []
    fired.runNow(routine().id)
    await quiet()
    expect(prompts[0]).toContain('RESUMO-DO-CANAL')
  })

  it('counts toward the reference in the title, then in the request, and keeps it on a retry', async () => {
    const t = token(routine('Repasse o cartão SIM-12.'))
    fired.webhook(t, 'cartão OAB-65')
    await quiet()
    expect(replies().at(-1)!.run!.work).toBe('OAB-65')
    fired.webhook(t, 'cartão sem referência')
    await quiet()
    expect(replies().at(-1)!.run!.work).toBe('SIM-12')
    failures = 1
    fired.webhook(t, 'outro cartão OAB-66')
    await quiet()
    expect(replies().at(-1)!.run!.work).toBe('OAB-66')
  })

  it('a person, a mention and a continuation after it read the conversation', async () => {
    const r = routine()
    answers = ['Repassei, @staff confira.', 'Conferi.']
    fired.webhook(token(r), 'chegou o cartão DADO-DO-EVENTO')
    await quiet()
    expect(prompts).toHaveLength(2) // the mention
    expect(prompts[0]).not.toContain('Conversa em')
    expect(prompts[1]).toContain('Repassei, @staff confira.')
    expect(prompts[1]).toContain('Repasse o cartão.')

    prompts = []
    await run.send('c1', '@pm como ficou?')
    await quiet()
    expect(prompts[0]).toContain('Repassei, @staff confira.')

    prompts = []
    const paused = replies().at(-1)!
    dbx.saveMessage({ ...paused, run: { ...paused.run!, status: 'paused' } })
    await run.continue(paused.id)
    await quiet()
    expect(prompts[0]).toContain('como ficou?')
  })
})
