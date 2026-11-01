// node-pty's prebuilt helper arrives without the execute bit, and a shell then fails to start.
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', 'node_modules', 'node-pty', 'prebuilds')
if (existsSync(root)) for (const dir of readdirSync(root)) if (existsSync(join(root, dir, 'spawn-helper'))) chmodSync(join(root, dir, 'spawn-helper'), 0o755)
