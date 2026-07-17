// GET /mcp — two audiences land here:
//   1. MCP clients probing the SSE server-stream leg of Streamable HTTP.
//      We are a stateless POST-only tools server, so they get a clean
//      405 JSON-RPC error (same CORS headers as the POST route).
//   2. Humans pasting the endpoint URL into a browser. They get a small
//      HTML page explaining what this is, with links to the open-source
//      repo and the token settings page.
// Browsers send `Accept: text/html`; MCP clients ask for JSON/SSE — that
// header is the discriminator.
//
// The page is styled with the app's own tokens (assets/css/main.css):
// Inter body / Geist display, --brand #0EA5E9, light `#f5f6fa` shell and
// the dark `#141619/#21252B` palette via prefers-color-scheme.

const INFO_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Snappi's Model Context Protocol server — connect Claude, ChatGPT and other AI assistants to your boards, tasks and bugs.">
<title>Snappi MCP Server</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="preconnect" href="https://fonts.googleapis.com">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Geist:wght@600;700;800&display=swap');
  :root {
    --text: #202020; --text-soft: #676879; --text-faint: #9aa0ab;
    --surface: #ffffff; --shell: #f5f6fa; --code-bg: #f5f6fa;
    --border: rgba(0,0,0,.06); --border-medium: rgba(0,0,0,.12);
    --brand: #0EA5E9; --brand-deep: #0284C7; --ok: #00C875;
    --shadow: 0 10px 34px rgba(9,30,66,.07);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --text: #E6E8EC; --text-soft: #9BA3AF; --text-faint: #6C7480;
      --surface: #21252B; --shell: #141619; --code-bg: #1A1D22;
      --border: rgba(255,255,255,.09); --border-medium: rgba(255,255,255,.16);
      --shadow: 0 10px 34px rgba(0,0,0,.45);
    }
  }
  * { box-sizing: border-box; }
  body { margin:0; font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif; background:var(--shell); color:var(--text); min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:32px 16px; -webkit-font-smoothing:antialiased; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:36px 40px; max-width:600px; width:100%; box-shadow:var(--shadow); }
  .brandrow { display:flex; align-items:center; gap:12px; margin-bottom:18px; }
  .brandrow img { width:24px; height:38px; }
  .brandrow .name { font-family:'Geist','Inter',sans-serif; font-weight:700; font-size:17px; letter-spacing:-.01em; }
  .status { margin-left:auto; display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:600; color:var(--ok); background:rgba(0,200,117,.1); border-radius:999px; padding:4px 11px; }
  .status .dot { width:7px; height:7px; border-radius:50%; background:var(--ok); }
  .eyebrow { font-size:12px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--brand); margin:0 0 6px; }
  h1 { font-family:'Geist','Inter',sans-serif; font-size:24px; font-weight:800; letter-spacing:-.02em; margin:0 0 8px; }
  .sub { color:var(--text-soft); font-size:14px; line-height:1.6; margin:0 0 18px; }
  .chips { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:20px; }
  .chip { font-size:12px; font-weight:600; color:var(--text-soft); border:1px solid var(--border-medium); border-radius:999px; padding:4px 11px; }
  .endpoint { display:flex; align-items:center; gap:8px; background:var(--code-bg); border:1px solid var(--border); border-radius:10px; padding:6px 6px 6px 14px; margin-bottom:22px; }
  .endpoint code { flex:1; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; word-break:break-all; }
  .copy { font:inherit; font-size:12.5px; font-weight:600; color:var(--text); background:var(--surface); border:1px solid var(--border-medium); border-radius:7px; padding:7px 13px; cursor:pointer; white-space:nowrap; }
  .copy:hover { border-color:var(--brand); color:var(--brand); }
  .connect { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:20px; }
  .how { border:1px solid var(--border); border-radius:12px; padding:14px 16px; }
  .how h3 { margin:0 0 6px; font-size:13px; font-weight:700; }
  .how p { margin:0; font-size:12.5px; color:var(--text-soft); line-height:1.55; }
  .how code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; background:var(--code-bg); border-radius:5px; padding:1px 5px; word-break:break-all; }
  .row { display:flex; gap:10px; flex-wrap:wrap; }
  a.btn { display:inline-flex; align-items:center; gap:7px; text-decoration:none; font-size:13.5px; font-weight:600; border-radius:10px; padding:10px 16px; border:1px solid var(--border-medium); color:var(--text); background:var(--surface); }
  a.btn.primary { background:var(--brand); border-color:var(--brand); color:#fff; }
  a.btn.primary:hover { background:var(--brand-deep); }
  a.btn:hover { border-color:var(--brand); }
  footer { margin-top:22px; font-size:12px; color:var(--text-faint); display:flex; gap:14px; flex-wrap:wrap; justify-content:center; }
  footer a { color:var(--text-faint); text-decoration:none; }
  footer a:hover { color:var(--brand); }
  @media (max-width: 560px) { .card { padding:26px 22px; } .connect { grid-template-columns:1fr; } }
</style>
</head>
<body>
<main class="card">
  <div class="brandrow">
    <img src="/snappi-logo.png" alt="">
    <span class="name">snappi</span>
    <span class="status"><span class="dot"></span>Operational</span>
  </div>
  <p class="eyebrow">&#10022; AI-powered digital intelligence</p>
  <h1>MCP Server</h1>
  <p class="sub">Connect Claude, ChatGPT and other AI assistants to Snappi. Once authorized, your AI can read and update your boards, tasks and bugs — scoped to exactly what your account can see. This endpoint speaks JSON-RPC over POST, so there's nothing more to see in a browser.</p>
  <div class="chips">
    <span class="chip">19 tools · read &amp; write</span>
    <span class="chip">OAuth 2.1 + PKCE</span>
    <span class="chip">Streamable HTTP</span>
    <span class="chip">Open source</span>
  </div>
  <div class="endpoint">
    <code id="url">https://app.snappi.now/mcp</code>
    <button class="copy" onclick="navigator.clipboard.writeText(document.getElementById('url').textContent).then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1600)})">Copy</button>
  </div>
  <div class="connect">
    <div class="how">
      <h3>claude.ai &amp; ChatGPT</h3>
      <p>Settings → Connectors → add this URL. You'll be sent to Snappi to sign in and click <strong>Authorize</strong> — no token to copy.</p>
    </div>
    <div class="how">
      <h3>Claude Code / API</h3>
      <p>Create a token in <a href="/settings/ai-connections" style="color:var(--brand);text-decoration:none;">AI Connections</a>, then:<br><code>claude mcp add --transport http snappi https://app.snappi.now/mcp --header "Authorization: Bearer &lt;token&gt;"</code></p>
    </div>
  </div>
  <div class="row">
    <a class="btn primary" href="/settings/ai-connections">Connect your AI&nbsp;&rarr;</a>
    <a class="btn" href="https://github.com/cyber-kani/snappi-mcp" rel="noopener">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
      GitHub
    </a>
    <a class="btn" href="https://github.com/cyber-kani/snappi-mcp/blob/main/docs/SNAPPI-MCP-SERVER.md" rel="noopener">Docs</a>
  </div>
</main>
<footer>
  <span>&copy; 2026 Snappi</span>
  <a href="https://snappi.now">snappi.now</a>
  <a href="https://modelcontextprotocol.io" rel="noopener">What is MCP?</a>
</footer>
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
