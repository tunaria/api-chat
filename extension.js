// API Chat: a panel that runs the Claude CLI in print mode, billed to an API key kept in the
// editor's SecretStorage. Every permission request (from the main agent or any subagent it
// delegates to) is routed to the panel through permission-mcp.js for the person to answer.
const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

const KEY = 'apiChat.anthropicKey';

function findClaude() {
  const roots = ['.antigravity-ide', '.vscode', '.cursor'].map((d) => path.join(os.homedir(), d, 'extensions'));
  const hits = [];
  for (const r of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(r); } catch { continue; }
    for (const d of dirs) {
      if (!d.startsWith('anthropic.claude-code-')) continue;
      const exe = path.join(r, d, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
      if (fs.existsSync(exe)) hits.push({ exe, mtime: fs.statSync(exe).mtimeMs });
    }
  }
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits.length ? hits[0].exe : 'claude';
}

async function getKey(ctx, ask) {
  let k = await ctx.secrets.get(KEY);
  if (!k || ask) {
    k = await vscode.window.showInputBox({ prompt: 'Anthropic API key', password: true, ignoreFocusOut: true });
    if (k) await ctx.secrets.store(KEY, k.trim());
  }
  return k && k.trim();
}

function activate(ctx) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('apiChat.setKey', () => getKey(ctx, true)),
    vscode.commands.registerCommand('apiChat.clearKey', async () => { await ctx.secrets.delete(KEY); vscode.window.showInformationMessage('API Chat key cleared.'); }),
    vscode.commands.registerCommand('apiChat.open', () => openPanel(ctx)),
  );
}

function openPanel(ctx) {
  const panel = vscode.window.createWebviewPanel('apiChat', 'API Chat', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
  panel.webview.html = fs.readFileSync(path.join(ctx.extensionPath, 'media', 'chat.html'), 'utf8');
  const ws = vscode.workspace.workspaceFolders;
  let sessionId = null, proc = null, spent = 0;
  const post = (m) => panel.webview.postMessage(m);
  post({ type: 'init', cwd: ws ? ws[0].uri.fsPath : os.homedir() });

  // Permission bridge: permission-mcp.js POSTs here; the answer comes from the panel's buttons.
  const token = crypto.randomBytes(24).toString('hex');
  const pending = new Map();
  const alwaysAllow = new Set();
  const subTools = new Set(); // tool_use ids issued inside a subagent
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/ask' || req.headers['x-token'] !== token) { res.statusCode = 403; return res.end(); }
    let s = '';
    req.on('data', (d) => (s += d));
    req.on('end', () => {
      let a; try { a = JSON.parse(s); } catch { res.statusCode = 400; return res.end(); }
      const reply = (decision) => res.end(JSON.stringify(decision === 'deny'
        ? { behavior: 'deny', message: 'The person denied this.' }
        : { behavior: 'allow', updatedInput: a.input }));
      if (alwaysAllow.has(a.tool_name)) return reply('allow');
      const id = crypto.randomBytes(8).toString('hex');
      pending.set(id, (decision) => { if (decision === 'always') alwaysAllow.add(a.tool_name); reply(decision); });
      post({ type: 'ask', id, tool: a.tool_name, sub: subTools.has(a.tool_use_id), input: JSON.stringify(a.input, null, 2).slice(0, 4000) });
    });
  });
  server.listen(0, '127.0.0.1');

  const mcpFile = path.join(ctx.globalStorageUri.fsPath, 'mcp.json');
  fs.mkdirSync(path.dirname(mcpFile), { recursive: true });

  const denyAll = () => { for (const f of pending.values()) f('deny'); pending.clear(); };

  panel.webview.onDidReceiveMessage(async (m) => {
    if (m.type === 'answer') { const f = pending.get(m.id); if (f) { pending.delete(m.id); f(m.decision); } return; }
    if (m.type === 'stop') { denyAll(); if (proc) proc.kill(); return; }
    if (m.type === 'new') { sessionId = null; alwaysAllow.clear(); post({ type: 'sys', text: 'New conversation.' }); return; }
    if (m.type !== 'send') return;
    if (proc) { post({ type: 'sys', text: 'Still running; press Stop first.' }); return; }
    const key = await getKey(ctx, false);
    if (!key) { post({ type: 'sys', text: 'No API key set.' }); return; }

    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { apichat: {
      command: process.execPath,
      args: [path.join(ctx.extensionPath, 'permission-mcp.js')],
      env: { ELECTRON_RUN_AS_NODE: '1', API_CHAT_PORT: String(server.address().port), API_CHAT_TOKEN: token },
    } } }));

    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', m.model, '--permission-mode', m.mode,
      '--mcp-config', mcpFile, '--permission-prompt-tool', 'mcp__apichat__approve'];
    if (sessionId) args.push('--resume', sessionId);
    const env = { ...process.env, ANTHROPIC_API_KEY: key };
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    proc = cp.spawn(findClaude(), args, { cwd: m.cwd, env, windowsHide: true });
    proc.stdin.end(m.text);
    post({ type: 'busy', on: true });

    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { post({ type: 'sys', text: line }); continue; }
        if (ev.session_id) sessionId = ev.session_id;
        const sub = !!ev.parent_tool_use_id;
        if (ev.type === 'assistant') {
          for (const c of ev.message.content || []) {
            if (c.type === 'text') post({ type: 'text', text: c.text, sub });
            else if (c.type === 'tool_use') {
              if (sub) subTools.add(c.id);
              const label = c.name === 'Agent' || c.name === 'Task' ? `Delegating to subagent: ${c.input.description || ''}` : c.name + ' ' + JSON.stringify(c.input).slice(0, 300);
              post({ type: 'tool', text: label, sub });
            }
          }
        } else if (ev.type === 'result') {
          spent += ev.total_cost_usd || 0;
          post({ type: 'sys', text: `Done (${ev.subtype}) · this run $${(ev.total_cost_usd || 0).toFixed(3)} · panel total $${spent.toFixed(3)}` });
        }
      }
    });
    proc.stderr.on('data', (d) => post({ type: 'err', text: d.toString() }));
    proc.on('close', () => { proc = null; denyAll(); post({ type: 'busy', on: false }); });
    proc.on('error', (e) => { proc = null; post({ type: 'err', text: String(e) }); post({ type: 'busy', on: false }); });
  });
  panel.onDidDispose(() => { denyAll(); if (proc) proc.kill(); server.close(); });
}

module.exports = { activate, deactivate() {} };
