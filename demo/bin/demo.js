#!/usr/bin/env node

/**
 * ghostterm demo server: Vite serving demo/ and lib/ with hot reload, plus a WebSocket PTY at /ws.
 *
 * Run with: bun run demo
 */

import fs from 'fs';
import http from 'http';
import { homedir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// Node-pty for cross-platform PTY support
import pty from '@lydell/node-pty';
// WebSocket server
import { WebSocketServer } from 'ws';

import {
  createAuthConfig,
  isLoopbackHost,
  isWildcardBindHost,
  validateTokenRequest,
  validateWebSocketRequest,
} from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HTTP_PORT = parsePort(process.env.PORT || '8000');
const AUTH_CONFIG = createAuthConfig();
const HOST = AUTH_CONFIG.bindHost;

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535: ${value}`);
  }
  return port;
}

const repoRoot = path.join(__dirname, '..', '..');
if (!fs.existsSync(path.join(repoRoot, 'ghostty-vt.wasm'))) {
  console.error('Error: ghostty-vt.wasm not found. Run: ./scripts/fetch-wasm.sh');
  process.exit(1);
}

// What the page needs; everything else in the repo (.git, scripts, ...) is not served.
const SERVED_PATHS = [
  path.join(repoRoot, 'demo'),
  path.join(repoRoot, 'lib'),
  path.join(repoRoot, 'node_modules'),
  path.join(repoRoot, 'ghostty-vt.wasm'),
  path.join(repoRoot, 'ghostty-vt-fast.wasm'),
];

// ============================================================================
// HTTP helpers
// ============================================================================

function parseRequestUrl(req) {
  try {
    return new URL(req.url || '/', 'http://127.0.0.1');
  } catch (_error) {
    return null;
  }
}

function writeHttpDecision(res, decision) {
  res.writeHead(decision.status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(decision.reason);
}

function writeTokenResponse(res) {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify({ token: AUTH_CONFIG.token }));
}

function handleTokenRequest(req, res, url) {
  if (url.pathname !== '/api/token') {
    return false;
  }

  if (req.method !== 'GET') {
    res.writeHead(405, {
      Allow: 'GET',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end('Method Not Allowed');
    return true;
  }

  const decision = validateTokenRequest(AUTH_CONFIG, {
    host: req.headers.host,
    origin: req.headers.origin,
  });

  if (!decision.ok) {
    writeHttpDecision(res, decision);
    return true;
  }

  writeTokenResponse(res);
  return true;
}

// ============================================================================
// WebSocket Server (using ws package)
// ============================================================================

const sessions = new Map();

function getShell() {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

/** A terminal width or height from the client, or null unless it is an integer from 1 to 1000. */
function parseDimension(value) {
  const n = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : null;
}

/** A valid control message from a text frame, or null. */
function parseControlMessage(text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch (_error) {
    return null;
  }
  if (msg?.type === 'resize') {
    const cols = parseDimension(msg.cols);
    const rows = parseDimension(msg.rows);
    return cols && rows ? { type: 'resize', cols, rows } : null;
  }
  return null;
}

function createPtySession(cols, rows) {
  const shell = getShell();

  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: cols,
    rows: rows,
    cwd: homedir(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
  });

  return ptyProcess;
}

// WebSocket server attached to HTTP server (same port)
const wss = new WebSocketServer({ noServer: true });

function rejectUpgrade(socket, decision) {
  if (socket.destroyed) {
    return;
  }

  const body = decision.reason + '\n';
  socket.write(
    `HTTP/1.1 ${decision.status} ${decision.reason}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'X-Content-Type-Options: nosniff\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      '\r\n' +
      body
  );
  socket.destroy();
}

function handleWebSocketUpgrade(req, socket, head) {
  const url = parseRequestUrl(req);
  if (!url) {
    rejectUpgrade(socket, { status: 400, reason: 'Bad Request' });
    return true;
  }

  if (url.pathname !== '/ws') {
    return false;
  }

  const decision = validateWebSocketRequest(AUTH_CONFIG, {
    host: req.headers.host,
    origin: req.headers.origin,
    token: url.searchParams.get('token'),
  });

  if (!decision.ok) {
    rejectUpgrade(socket, decision);
    return true;
  }

  if (!socket.destroyed && !socket.readableEnded) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }
  return true;
}

wss.on('connection', (ws, req) => {
  const url = parseRequestUrl(req);
  if (!url) {
    ws.close();
    return;
  }
  const cols = parseDimension(url.searchParams.get('cols')) ?? 80;
  const rows = parseDimension(url.searchParams.get('rows')) ?? 24;

  // Create PTY
  const ptyProcess = createPtySession(cols, rows);
  sessions.set(ws, { pty: ptyProcess });

  // PTY -> WebSocket
  ptyProcess.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n\x1b[33mShell exited (code: ${exitCode})\x1b[0m\r\n`);
      ws.close();
    }
  });

  // WebSocket -> PTY. Binary frames are terminal input; text frames are JSON control messages,
  // so nothing typed or pasted is ever taken for a command.
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      ptyProcess.write(data.toString('utf8'));
      return;
    }
    const msg = parseControlMessage(data.toString('utf8'));
    if (msg?.type === 'resize') {
      ptyProcess.resize(msg.cols, msg.rows);
    }
  });

  ws.on('close', () => {
    const session = sessions.get(ws);
    if (session) {
      session.pty.kill();
      sessions.delete(ws);
    }
  });

  ws.on('error', () => {
    // Ignore socket errors (connection reset, etc.)
  });

  // Send welcome message
  const C = '\x1b[1;36m'; // Cyan
  const G = '\x1b[1;32m'; // Green
  const Y = '\x1b[1;33m'; // Yellow
  const R = '\x1b[0m'; // Reset
  ws.send(`${C}╔══════════════════════════════════════════════════════════════╗${R}\r\n`);
  ws.send(
    `${C}║${R}  ${G}Welcome to ghostterm!${R}                                       ${C}║${R}\r\n`
  );
  ws.send(`${C}║${R}                                                              ${C}║${R}\r\n`);
  ws.send(`${C}║${R}  You have a real shell session with full PTY support.        ${C}║${R}\r\n`);
  ws.send(
    `${C}║${R}  Try: ${Y}ls${R}, ${Y}cd${R}, ${Y}top${R}, ${Y}vim${R}, or any command!                      ${C}║${R}\r\n`
  );
  ws.send(`${C}╚══════════════════════════════════════════════════════════════╝${R}\r\n\r\n`);
});

// ============================================================================
// Startup
// ============================================================================

function formatUrlHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function printBanner(url) {
  console.log('\n' + '═'.repeat(60));
  console.log('  🚀 ghostterm demo server');
  console.log('═'.repeat(60));
  console.log(`\n  📺 Open: ${url}`);
  console.log(`  📡 WebSocket PTY: same endpoint /ws`);
  console.log('  🔐 WebSocket auth: per-run same-origin token');
  console.log(`  🐚 Shell: ${getShell()}`);
  console.log(`  📁 Home: ${homedir()}`);
  console.log('  🔥 Hot reload enabled via Vite');
  console.log('\n  ⚠️  This server provides shell access.');
  console.log('     It binds to ' + HOST + ' and rejects cross-origin WebSockets.');
  if (isWildcardBindHost(HOST) || !isLoopbackHost(HOST)) {
    console.log(
      '     Remote access requires GHOSTTERM_ALLOWED_HOSTS and can expose your shell if misconfigured.'
    );
  }
  console.log('     Only use for local development.\n');
  console.log('═'.repeat(60));
  console.log('  Press Ctrl+C to stop.\n');
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\nShutting down...');
  for (const [ws, session] of sessions.entries()) {
    session.pty.kill();
    ws.close();
  }
  wss.close();
  process.exit(0);
});

// Start Vite with the token endpoint and the /ws upgrade handler attached
{
  const { createServer } = await import('vite');
  const vite = await createServer({
    root: repoRoot,
    plugins: [
      {
        name: 'ghostterm-demo-auth',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const url = parseRequestUrl(req);
            if (!url) {
              writeHttpDecision(res, { status: 400, reason: 'Bad Request' });
              return;
            }

            if (handleTokenRequest(req, res, url)) {
              return;
            }

            next();
          });
        },
      },
    ],
    server: {
      host: HOST,
      port: HTTP_PORT,
      strictPort: true,
      cors: false,
      allowedHosts: AUTH_CONFIG.allowedHosts,
      fs: {
        strict: true,
        allow: SERVED_PATHS,
      },
    },
  });

  await vite.listen();

  // Attach WebSocket handler AFTER Vite has fully initialized
  // Use prependListener (not prependOnceListener) so it runs for every request
  // This ensures our handler runs BEFORE Vite's handlers
  if (vite.httpServer) {
    vite.httpServer.prependListener('upgrade', (req, socket, head) => {
      // ONLY handle /ws - everything else passes through unchanged to Vite.
      if (handleWebSocketUpgrade(req, socket, head)) {
        return;
      }

      // For non-/ws paths, explicitly do nothing and let the event propagate.
      // The key is: don't return, don't touch the socket, just let Vite process it.
    });
  }

  printBanner(`http://${formatUrlHost(HOST)}:${HTTP_PORT}/demo/`);
}
