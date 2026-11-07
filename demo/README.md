# Demo

A development server for ghostterm: Vite serves `demo/` and `lib/` with hot reload, and a WebSocket at `/ws` connects the page to a real shell through a PTY.

```bash
bun run demo                 # http://127.0.0.1:8000/demo/
PORT=3000 bun run demo
```

The other page, `colors-demo.html`, is a manual check for color rendering.

## Access

The server binds to `127.0.0.1` and only accepts loopback hostnames (`localhost`, `127.0.0.1`, `::1`). Set `HOST=<host>` to bind elsewhere; when serving through other hostnames, or binding a wildcard such as `HOST=0.0.0.0`, list the browser-visible hostnames in `GHOSTTERM_ALLOWED_HOSTS=host1,host2`.

Vite serves only `demo/`, `lib/`, `node_modules/` and the WASM files; the rest of the repository (`.git`, scripts, ...) is refused.

The page fetches a per-run token from `/api/token` on the same origin before opening `/ws`. The server rejects `/ws` when the token is missing, the `Host` is not allowed, or the WebSocket `Origin` does not match the host.

On the socket, the page sends terminal input as binary frames and control messages (`{"type":"resize","cols":...,"rows":...}`) as JSON text frames, so typed or pasted text is never taken for a command. The server sends shell output as text frames.

This server gives full shell access. Keep the default loopback bind unless you know who can reach it.
