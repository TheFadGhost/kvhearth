#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { KvhearthClient } from '../src/client/lib.mjs';
import { resolveTheme, renderReply } from '../src/client/render.mjs';

const VERSION = '0.1.0';
const HELP = `kvhearth-cli ${VERSION}
usage: node bin/kvhearth-cli.mjs [options] [--eval "COMMAND"]

options:
  --host HOST      server address (default 127.0.0.1)
  --port PORT      server port (default 7379)
  --theme THEME    dark | light | plain (default dark; plain when not a TTY)
  --no-color       disable colours regardless of theme
  --eval "..."     run one command non-interactively and exit
  --version        print version
  --help           this text

The client always sends binary-safe typed requests.
NO_COLOR=1 in the environment also disables colour.
Type QUIT or press Ctrl-D to leave the interactive session.`;

function parseArgs(argv) {
  const out = { host: '127.0.0.1', port: 7379, theme: null, noColor: false, eval: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--host': out.host = argv[++i]; break;
      case '--port': out.port = Number(argv[++i]); break;
      case '--theme': out.theme = argv[++i]; break;
      case '--no-color': out.noColor = true; break;
      case '--eval': out.eval = argv[++i]; break;
      case '--version': console.log(`kvhearth-cli ${VERSION}`); process.exit(0);
      case '--help': process.stdout.write(HELP + '\n'); process.exit(0);
      default:
        process.stderr.write(`kvhearth-cli: unknown option '${argv[i]}'\n`);
        process.exit(2);
    }
  }
  return out;
}

export function tokenizeEval(text) {
  const tokens = [];
  let current = '';
  let hasToken = false;
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '\\' && i + 1 < text.length) {
        const decoded = decodeEscape(text[i + 1], text, i);
        current += decoded.value;
        i = decoded.consumed;
        continue;
      }
      if (ch === '"') { inQuote = false; continue; }
      current += ch;
    } else if (ch === '"') {
      inQuote = true;
      hasToken = true;
    } else if (ch === ' ' || ch === '\t') {
      if (current !== '' || hasToken) { tokens.push(current); current = ''; hasToken = false; }
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (inQuote) throw new Error('unterminated quote');
  if (current !== '' || hasToken) tokens.push(current);
  return tokens.map((token) => Buffer.from(token, 'latin1'));
}

function decodeEscape(next, text, index) {
  switch (next) {
    case 'n': return { value: '\n', consumed: index + 1 };
    case 'r': return { value: '\r', consumed: index + 1 };
    case 't': return { value: '\t', consumed: index + 1 };
    case '0': return { value: '\0', consumed: index + 1 };
    case '\\': return { value: '\\', consumed: index + 1 };
    case '"': return { value: '"', consumed: index + 1 };
    case 'x': {
      const hex = text.slice(index + 2, index + 4);
      const value = Number.parseInt(hex, 16);
      if (Number.isNaN(value)) throw new Error(`invalid \\x escape: \\x${hex}`);
      return { value: String.fromCharCode(value), consumed: index + 3 };
    }
    default:
      throw new Error(`unknown escape: \\${next}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const theme = resolveTheme(options);
  const client = new KvhearthClient({ host: options.host, port: options.port });

  try {
    await client.connect();
  } catch (err) {
    process.stderr.write(`kvhearth-cli: cannot connect to ${options.host}:${options.port} (${err.message})\n`);
    process.exit(1);
  }

  client.on('push', (reply) => {
    process.stdout.write(theme.dim('(pushed) ') + renderReply(reply, theme) + '\n');
  });

  if (options.eval !== null) {
    const args = tokenizeEval(options.eval);
    try {
      const reply = await client.cmd(args);
      console.log(renderReply(reply, theme));
    } catch (err) {
      if (err.reply) console.log(renderReply(err.reply, theme));
      else {
        process.stderr.write(`kvhearth-cli: ${err.message}\n`);
        client.destroy();
        process.exit(1);
      }
    }
    client.destroy();
    return;
  }

  const label = theme.prompt(`kvhearth:${options.host}:${options.port}> `);
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: label,
    terminal: process.stdout.isTTY === true,
  });
  rl.prompt();
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (trimmed === '') { rl.prompt(); return; }
    const verb = trimmed.split(/\s+/)[0].toLowerCase();
    if (verb === 'quit' || verb === 'exit') { rl.close(); return; }
    let args;
    try {
      args = tokenizeEval(trimmed);
    } catch (err) {
      console.log(theme.error(`(error) ${err.message}`));
      rl.prompt();
      return;
    }
    try {
      const reply = await client.cmd(args);
      console.log(renderReply(reply, theme));
    } catch (err) {
      if (err.reply) console.log(renderReply(err.reply, theme));
      else {
        console.log(theme.error(`(error) ${err.message}`));
        rl.close();
        return;
      }
    }
    rl.prompt();
  });
  rl.on('close', () => {
    client.destroy();
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`kvhearth-cli: fatal: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
