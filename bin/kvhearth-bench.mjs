#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import { runBenchmark } from '../src/bench/runner.mjs'

const USAGE = 'usage: kvhearth-bench [--host H] [--port N] [--clients C] [--pipeline D] [--seconds S] [--warmup W] [--mix S:G] [--keys K] [--value-size B] [--report text|json] [--out FILE]'

const FLAG_SPECS = {
  '--host': 'host',
  '--port': 'port',
  '--clients': 'clients',
  '--pipeline': 'pipeline',
  '--seconds': 'seconds',
  '--warmup': 'warmup',
  '--mix': 'mix',
  '--keys': 'keys',
  '--value-size': 'valueSize',
  '--report': 'report',
  '--out': 'out',
}

const NUMERIC_FLAGS = [
  ['port', 1, 65535],
  ['clients', 1, 4096],
  ['pipeline', 1, 4096],
  ['seconds', 0, Number.MAX_SAFE_INTEGER],
  ['warmup', 0, Number.MAX_SAFE_INTEGER],
  ['keys', 1, Number.MAX_SAFE_INTEGER],
  ['valueSize', 1, 67108863],
]

function usageExit() {
  process.stderr.write(USAGE + '\n')
  process.exitCode = 2
}

function parseArgs(argv) {
  const parsed = { report: 'text' }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    const key = FLAG_SPECS[token]
    if (key === undefined || i + 1 >= argv.length) return null
    i++
    parsed[key] = argv[i]
  }
  return parsed
}

function renderText(report) {
  const p = report.params
  const lines = [
    'host: ' + p.host,
    'port: ' + p.port,
    'clients: ' + p.clients,
    'pipeline: ' + p.pipeline,
    'seconds: ' + p.seconds,
    'warmup: ' + p.warmup,
    'mix: ' + p.mix,
    'keys: ' + p.keys,
    'value_size: ' + p.valueSize,
    'node_version: ' + p.nodeVersion,
    'platform: ' + p.platform,
    '',
  ]
  const row = (label, value) => label.padEnd(24, ' ') + String(value).padStart(14, ' ')
  lines.push(row('throughput_ops_per_sec', report.opsPerSecond.toFixed(2)))
  lines.push(row('ops_total', String(report.totalOps)))
  lines.push(row('ops_failed', String(report.opsFailed)))
  lines.push(row('latency_p50_ms', report.latencyMs.p50.toFixed(3)))
  lines.push(row('latency_p90_ms', report.latencyMs.p90.toFixed(3)))
  lines.push(row('latency_p99_ms', report.latencyMs.p99.toFixed(3)))
  lines.push(row('latency_p999_ms', report.latencyMs.p999.toFixed(3)))
  lines.push(row('latency_max_ms', report.latencyMs.max.toFixed(3)))
  return lines.join('\n') + '\n'
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed === null) {
    usageExit()
    return
  }
  for (const [key, min, max] of NUMERIC_FLAGS) {
    if (parsed[key] === undefined) continue
    const n = Number(parsed[key])
    if (!Number.isInteger(n) || n < min || n > max) {
      usageExit()
      return
    }
    parsed[key] = n
  }
  if (parsed.report !== 'text' && parsed.report !== 'json') {
    usageExit()
    return
  }
  let report
  try {
    report = await runBenchmark({
      host: parsed.host,
      port: parsed.port,
      clients: parsed.clients,
      pipeline: parsed.pipeline,
      seconds: parsed.seconds,
      warmup: parsed.warmup,
      mix: parsed.mix,
      keys: parsed.keys,
      valueSize: parsed.valueSize,
    })
  } catch (err) {
    process.stderr.write('kvhearth-bench: ' + (err && err.message ? err.message : String(err)) + '\n')
    process.exitCode = 1
    return
  }
  const output = parsed.report === 'json'
    ? JSON.stringify(report, null, 2) + '\n'
    : renderText(report)
  if (parsed.out !== undefined) {
    try {
      await writeFile(parsed.out, output, 'utf8')
    } catch (err) {
      process.stderr.write('kvhearth-bench: cannot write ' + parsed.out + ': ' + (err && err.message) + '\n')
      process.exitCode = 1
      return
    }
  }
  process.stdout.write(output)
  if (report.opsFailed > 0) process.exitCode = 1
}

await main()
