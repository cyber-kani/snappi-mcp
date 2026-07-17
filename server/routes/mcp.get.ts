// GET /mcp — two audiences land here:
//   1. MCP clients probing the SSE server-stream leg of Streamable HTTP.
//      We are a stateless POST-only tools server, so they get a clean
//      405 JSON-RPC error (same CORS headers as the POST route).
//   2. Humans pasting the endpoint URL into a browser. They get a small
//      HTML page explaining what this is, with links to the open-source
//      repo and the token settings page.
// Browsers send `Accept: text/html`; MCP clients ask for JSON/SSE — that
// header is the discriminator.

const INFO_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Snappi MCP Server</title>
<style>
  body { margin:0; font-family: Inter, -apple-system, "Segoe UI", sans-serif; background:#f6f7fb; color:#202020; display:flex; min-height:100vh; align-items:center; justify-content:center; }
  .card { background:#fff; border:1px solid #e6e9ef; border-radius:16px; padding:40px 44px; max-width:560px; margin:24px; box-shadow:0 8px 30px rgba(9,30,66,.06); }
  h1 { font-size:22px; margin:0 0 6px; }
  .sub { color:#676879; font-size:14px; margin:0 0 22px; line-height:1.55; }
  .endpoint { display:block; background:#f1f3f8; border:1px solid #e6e9ef; border-radius:10px; padding:12px 14px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; margin-bottom:22px; word-break:break-all; }
  .row { display:flex; gap:10px; flex-wrap:wrap; }
  a.btn { display:inline-flex; align-items:center; gap:7px; text-decoration:none; font-size:13.5px; font-weight:600; border-radius:10px; padding:10px 16px; border:1px solid #e6e9ef; color:#202020; background:#fff; }
  a.btn.primary { background:#0EA5E9; border-color:#0EA5E9; color:#fff; }
  a.btn:hover { filter:brightness(.97); }
  .note { margin-top:22px; font-size:12.5px; color:#9aa0ab; line-height:1.6; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; background:#f1f3f8; border-radius:5px; padding:1px 5px; font-size:12px; }
  .logo { width:26px; height:41px; margin-bottom:14px; }
</style>
</head>
<body>
<div class="card">
  <img class="logo" src="/snappi-logo.png" alt="Snappi">
  <h1>Snappi MCP Server</h1>
  <p class="sub">This is a <strong>Model Context Protocol</strong> endpoint — it lets AI assistants like Claude and ChatGPT read and update your Snappi boards, tasks and bugs. It speaks JSON-RPC over POST, so there's nothing to see in a browser.</p>
  <span class="endpoint">https://app.snappi.now/mcp</span>
  <div class="row">
    <a class="btn primary" href="/settings/ai-connections">Connect your AI&nbsp;&rarr;</a>
    <a class="btn" href="https://github.com/cyber-kani/snappi-mcp" rel="noopener">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
      Open source on GitHub
    </a>
  </div>
  <p class="note">Connect from <strong>claude.ai</strong> or <strong>ChatGPT</strong> by adding this URL as a connector and clicking Authorize, or from <strong>Claude Code</strong> with a personal token: <code>claude mcp add --transport http snappi https://app.snappi.now/mcp --header "Authorization: Bearer &lt;token&gt;"</code></p>
</div>
</body>
</html>`

export default defineEventHandler((event) => {
  const origin = getRequestHeader(event, 'origin')
  setResponseHeaders(event, {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, DELETE',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    'Vary': 'Origin, Accept',
  })

  // Browsers get the human-readable page; MCP clients (Accept: json / event-stream) get the 405.
  const accept = getRequestHeader(event, 'accept') ?? ''
  if (accept.includes('text/html')) {
    setResponseHeader(event, 'Content-Type', 'text/html; charset=utf-8')
    return INFO_HTML
  }

  setResponseHeader(event, 'Content-Type', 'application/json')
  setResponseStatus(event, 405)
  return { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: SSE not supported, POST only' }, id: null }
})
