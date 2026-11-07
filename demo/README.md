# Demo

A development server for ghostterm: Vite serves `demo/` and `lib/` with hot reload, and a WebSocket at `/ws`
connects the page to a real shell through a PTY.

```bash
bun run demo                 # http://127.0.0.1:8000/demo/
PORT=3000 bun run demo
```

The other pages, `colors-demo.html` and `scrollbar-test.html`, are manual checks for color rendering and the
scrollbar.

## Access

The server binds to `127.0.0.1` and only accepts loopback hostnames (`localhost`, `127.0.0.1`, `::1`). Set
`HOST=<host>` to bind elsewhere; when serving through other hostnames, or binding a wildcard such as
`HOST=0.0.0.0`, list the browser-visible hostnames in `GHOSTTERM_ALLOWED_HOSTS=host1,host2`.

The page fetches a per-run token from `/api/token` on the same origin before opening `/ws`. The server rejects
`/ws` when the token is missing, the `Host` is not allowed, or the WebSocket `Origin` does not match the host.

This server gives full shell access. Keep the default loopback bind unless you know who can reach it.
