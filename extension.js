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
const PREFS = 'apiChat.prefs';
const CONVS = 'apiChat.conversations';
const CTX = 'apiChat.context'; // { [folderPath]: text }
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'TodoWrite'];
const SHELL = new Set(['Bash', 'PowerShell']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
// true when p resolves inside one of roots (case-insensitive on Windows, no ".." escapes)
function insideRoots(p, roots) {
  const norm = (x) => { const r = path.resolve(x); return process.platform === 'win32' ? r.toLowerCase() : r; };
  const t = norm(p);
  return roots.some((r) => { const b = norm(r); return t === b || t.startsWith(b.endsWith(path.sep) ? b : b + path.sep); });
}
const CHAIN = /[;&|<>`(){}$@]/;
const LAUNCHERS = new Set(['bash','sh','zsh','cmd','cmd.exe','powershell','powershell.exe','pwsh','pwsh.exe','node','python','python3','py','perl','ruby','iex','invoke-expression','env','xargs','sudo','start','start-process','wsl','git-bash']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

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

// A shell command is "simple" when it has no chaining, piping, redirection or substitution,
// and is a single line. Only simple commands can be approved by prefix.
const simpleWords = (cmd) => {
  if (typeof cmd !== 'string' || CHAIN.test(cmd) || /[\r\n]/.test(cmd.trim())) return null;
  const w = cmd.trim().split(/\s+/).filter(Boolean);
  return w.length ? w : null;
};
const shellPrefix = (cmd) => {
  const w = simpleWords(cmd);
  if (!w || w.length < 2 || LAUNCHERS.has(w[0].toLowerCase())) return null;
  return w.slice(0, 2).join(' ');
};
const prefixMatches = (cmd, prefix) => { const w = simpleWords(cmd); const p = String(prefix || '').split(' '); return !!w && p.length >= 2 && !LAUNCHERS.has(p[0].toLowerCase()) && prefix.split(' ').every((x, i) => w[i] === x); };

// CLI transcript lookup: ~/.claude/projects/<slug>/<id>.jsonl
function findTranscript(cwd, id) {
  const base = path.join(os.homedir(), '.claude', 'projects');
  const direct = path.join(base, String(cwd || '').replace(/[^A-Za-z0-9]/g, '-'), id + '.jsonl');
  if (fs.existsSync(direct)) return direct;
  let dirs = [];
  try { dirs = fs.readdirSync(base); } catch { return null; }
  for (const d of dirs) { const f = path.join(base, d, id + '.jsonl'); if (fs.existsSync(f)) return f; }
  return null;
}
function readHistory(file) {
  const out = [];
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { return out; }
  for (const line of lines) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!e.message || (e.type !== 'user' && e.type !== 'assistant')) continue;
    const sub = !!e.isSidechain;
    const c = e.message.content;
    if (e.type === 'user') {
      if (typeof c === 'string') out.push({ type: 'you', text: c, sub });
      else if (Array.isArray(c)) for (const p of c) if (p.type === 'text') out.push({ type: 'you', text: p.text, sub });
    } else if (Array.isArray(c)) {
      for (const p of c) {
        if (p.type === 'text') out.push({ type: 'text', text: p.text, sub });
        else if (p.type === 'tool_use') out.push({ type: 'tool', text: p.name, sub });
      }
    }
  }
  return out;
}

function openPanel(ctx) {
  const g = ctx.globalState;
  const panel = vscode.window.createWebviewPanel('apiChat', 'API Chat', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
  panel.webview.html = fs.readFileSync(path.join(ctx.extensionPath, 'media', 'chat.html'), 'utf8');
  const ws = vscode.workspace.workspaceFolders;
  let sessionId = null, proc = null, spent = 0;
  const post = (m) => panel.webview.postMessage(m);

  const convs = () => g.get(CONVS, []);
  const saveConvs = (list) => g.update(CONVS, list);
  const sendConvs = () => post({ type: 'convs', list: convs().slice().sort((a, b) => b.updated - a.updated), current: sessionId });
  const ctxFor = (cwd) => (g.get(CTX, {})[cwd] || '');

  // Pick up print-mode (sdk-cli) sessions the CLI saved on disk that the list doesn't know about,
  // e.g. runs from before an extension reload. Only reads the first 256 KB of recent transcripts.
  function importTranscripts() {
    const root = path.join(os.homedir(), '.claude', 'projects');
    const known = new Set(convs().map((c) => c.id)), found = [];
    const cutoff = Date.now() - 30 * 86400000;
    let dirs = []; try { dirs = fs.readdirSync(root); } catch { return; }
    for (const d of dirs) {
      let files = []; try { files = fs.readdirSync(path.join(root, d)); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const id = f.slice(0, -6);
        if (known.has(id)) continue;
        const fp = path.join(root, d, f);
        let st; try { st = fs.statSync(fp); } catch { continue; }
        if (st.mtimeMs < cutoff) continue;
        let head = '';
        try { const fd = fs.openSync(fp, 'r'); const b = Buffer.alloc(Math.min(st.size, 262144)); fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd); head = b.toString('utf8'); } catch { continue; }
        if (!head.includes('"entrypoint":"sdk-cli"')) continue;
        let cwd = '', title = '', model = '';
        for (const line of head.split('\n')) {
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          if (!cwd && ev.cwd) cwd = ev.cwd;
          if (!model && ev.message && ev.message.model) model = ev.message.model;
          if (!title && ev.type === 'user' && ev.message) {
            const c = ev.message.content;
            const t = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((x) => x.type === 'text') || {}).text : '';
            if (t) title = t.replace(/^ultracode:\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 60);
          }
          if (cwd && title && model) break;
        }
        if (title) found.push({ id, title, cwd, model, updated: st.mtimeMs, cost: 0 });
      }
    }
    if (found.length) saveConvs(convs().concat(found));
  }
  importTranscripts();

  const prefs = Object.assign({ model: 'claude-sonnet-5-5', effort: 'high', mode: 'default', autoReads: true, ultracode: false,
    cwd: ws ? ws[0].uri.fsPath : os.homedir(), extraDirs: '' }, g.get(PREFS, {}));
  const sendInit = () => { post({ type: 'init', prefs: Object.assign({}, prefs, g.get(PREFS, {})), context: ctxFor(Object.assign({}, prefs, g.get(PREFS, {})).cwd) }); sendConvs(); };
  sendInit();

  // Permission bridge: permission-mcp.js POSTs here; the answer comes from the panel's buttons.
  const token = crypto.randomBytes(24).toString('hex');
  const pending = new Map();
  let run = { mode: 'default', autoReads: false, roots: [] }; // settings of the run in progress
  const alwaysAllow = new Set();   // non-shell tool names approved for this conversation
  let prefixes = new Set();        // shell command prefixes approved for this conversation
  const subTools = new Set(); // tool_use ids issued inside a subagent
  const persistPrefixes = () => {
    if (!sessionId) return;
    const list = convs(); const c = list.find((x) => x.id === sessionId);
    if (c) { c.prefixes = [...prefixes]; saveConvs(list); }
  };
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/ask' || req.headers['x-token'] !== token) { res.statusCode = 403; return res.end(); }
    let s = '';
    req.on('data', (d) => (s += d));
    req.on('end', () => {
      let a; try { a = JSON.parse(s); } catch { res.statusCode = 400; return res.end(); }
      const reply = (decision) => res.end(JSON.stringify(decision === 'deny'
        ? { behavior: 'deny', message: 'The person denied this.' }
        : { behavior: 'allow', updatedInput: a.input }));
      const isShell = SHELL.has(a.tool_name);
      const cmd = isShell && a.input ? a.input.command : null;
      if (!isShell && alwaysAllow.has(a.tool_name)) return reply('allow');
      // honor the panel's own settings when the CLI still asks (e.g. a path outside its folders)
      const fp = a.input && (a.input.file_path || a.input.notebook_path || a.input.path);
      if (run.autoReads && READ_TOOLS.includes(a.tool_name)) return reply('allow');
      if (run.mode === 'acceptEdits' && EDIT_TOOLS.has(a.tool_name) && typeof fp === 'string' && insideRoots(fp, run.roots)) return reply('allow');
      if (isShell) for (const p of prefixes) if (prefixMatches(cmd, p)) return reply('allow');
      const prefix = isShell ? shellPrefix(cmd) : null;
      const id = crypto.randomBytes(8).toString('hex');
      pending.set(id, (decision) => {
        if (decision === 'always' && !isShell) alwaysAllow.add(a.tool_name);
        if (decision === 'prefix' && prefix) { prefixes.add(prefix); persistPrefixes(); }
        reply(decision === 'deny' ? 'deny' : 'allow');
      });
      post({ type: 'ask', id, tool: a.tool_name, shell: isShell, prefix, sub: subTools.has(a.tool_use_id), input: JSON.stringify(a.input, null, 2).slice(0, 4000) });
    });
  });
  server.listen(0, '127.0.0.1');

  const mcpFile = path.join(ctx.globalStorageUri.fsPath, 'mcp.json');
  fs.mkdirSync(path.dirname(mcpFile), { recursive: true });

  const denyAll = () => { for (const f of pending.values()) f('deny'); pending.clear(); };
  const resetConv = () => { sessionId = null; panel.title = 'API Chat'; alwaysAllow.clear(); prefixes = new Set(); subTools.clear(); };
  const busyMsg = () => post({ type: 'sys', text: 'Still running; press Stop first.' });

  panel.webview.onDidReceiveMessage(async (m) => {
    if (m.type === 'answer') { const f = pending.get(m.id); if (f) { pending.delete(m.id); f(m.decision); } return; }
    if (m.type === 'ready') { sendInit(); return; }
    if (m.type === 'stop') { denyAll(); if (proc) proc.kill(); return; }
    if (m.type === 'prefs') { await g.update(PREFS, Object.assign({}, g.get(PREFS, {}), m.prefs)); return; }
    if (m.type === 'getContext') { post({ type: 'context', text: ctxFor(m.cwd) }); return; }
    if (m.type === 'setContext') {
      const all = Object.assign({}, g.get(CTX, {}));
      if (m.text && m.text.trim()) all[m.cwd] = m.text; else delete all[m.cwd];
      await g.update(CTX, all); return;
    }
    if (m.type === 'new') { if (proc) return busyMsg(); resetConv(); post({ type: 'clear' }); post({ type: 'sys', text: 'New conversation.' }); sendConvs(); return; }
    if (m.type === 'pick') {
      if (proc) return busyMsg();
      const c = convs().find((x) => x.id === m.id); if (!c) return;
      resetConv(); sessionId = c.id; prefixes = new Set(c.prefixes || []);
      post({ type: 'clear' });
      const f = findTranscript(c.cwd, c.id);
      if (!f) post({ type: 'sys', text: 'Transcript not found; the conversation will still resume.' });
      else for (const h of readHistory(f)) post(h);
      panel.title = 'API Chat: ' + c.title; post({ type: 'resumed', cwd: c.cwd, model: c.model, context: ctxFor(c.cwd) });
      post({ type: 'sys', text: `Resuming "${c.title}"` + (c.cost ? ` · spent so far $${c.cost.toFixed(3)}` : '') });
      sendConvs(); return;
    }
    if (m.type === 'delete') {
      if (proc && m.id === sessionId) return busyMsg();
      await saveConvs(convs().filter((x) => x.id !== m.id));
      if (m.id === sessionId) { resetConv(); post({ type: 'clear' }); }
      sendConvs(); return;
    }
    if (m.type !== 'send') return;
    if (proc) { busyMsg(); return; }
    const key = await getKey(ctx, false);
    if (!key) { post({ type: 'sys', text: 'No API key set.' }); return; }

    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { apichat: {
      command: process.execPath,
      args: [path.join(ctx.extensionPath, 'permission-mcp.js')],
      env: { ELECTRON_RUN_AS_NODE: '1', API_CHAT_PORT: String(server.address().port), API_CHAT_TOKEN: token },
    } } }));

    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', m.model, '--permission-mode', m.mode,
      '--mcp-config', mcpFile, '--permission-prompt-tool', 'mcp__apichat__approve'];
    if (EFFORTS.has(m.effort)) args.push('--effort', m.effort);
    if (m.autoReads) args.push('--allowedTools', READ_TOOLS.join(','));
    const READ_HINT = 'Reading files is pre-approved only through the Read, Glob and Grep tools. Use them for every '
      + 'look at files or folders (listing, viewing, searching), including in subagents. Do not use Bash or PowerShell '
      + 'for ls, cat, head, find, grep, dir or Get-Content: each shell command needs the person to approve it.';
    const context = [m.autoReads ? READ_HINT : '', ctxFor(m.cwd).trim()].filter(Boolean).join(String.fromCharCode(10, 10));
    if (context) args.push('--append-system-prompt', context);
    for (const d of String(m.extraDirs || '').split(';').map((x) => x.trim()).filter(Boolean)) args.push('--add-dir', d);
    if (sessionId) args.push('--resume', sessionId);
    const env = { ...process.env, ANTHROPIC_API_KEY: key };
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    const firstPrompt = m.text, runCwd = m.cwd, runModel = m.model;
    run = { mode: m.mode, autoReads: !!m.autoReads,
      roots: [m.cwd, ...String(m.extraDirs || '').split(';').map((x) => x.trim()).filter(Boolean)] };
    try { proc = cp.spawn(findClaude(), args, { cwd: runCwd, env, windowsHide: true }); }
    catch (e) { proc = null; post({ type: 'err', text: String(e) }); return; }
    proc.stdin.end(m.ultracode ? 'ultracode: ' + m.text : m.text);
    post({ type: 'busy', on: true });

    const touchConv = (cost) => {
      if (!sessionId) return;
      const list = convs(); let c = list.find((x) => x.id === sessionId);
      if (!c) { c = { id: sessionId, title: firstPrompt.replace(/\s+/g, ' ').trim().slice(0, 60), cwd: runCwd, model: runModel, updated: Date.now(), cost: 0 }; list.push(c); }
      c.updated = Date.now(); c.model = runModel; c.cost = (c.cost || 0) + (cost || 0); c.prefixes = [...prefixes];
      saveConvs(list); sendConvs(); panel.title = 'API Chat: ' + c.title;
    };

    let buf = '', registered = false, runResult = null;
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { post({ type: 'sys', text: line }); continue; }
        if (ev.session_id) { sessionId = ev.session_id; if (!registered) { registered = true; touchConv(0); } }
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
        } else if (ev.type === 'result' && !sub) {
          runResult = ev; // the CLI can emit more than one; the last carries the run's total
        }
      }
    });
    proc.stderr.on('data', (d) => post({ type: 'err', text: d.toString().split(key).join('[redacted]') }));
    proc.on('close', () => {
      proc = null; denyAll();
      if (runResult) {
        const cost = runResult.total_cost_usd || 0;
        spent += cost; touchConv(cost);
        post({ type: 'done', final: typeof runResult.result === 'string' ? runResult.result : '',
          text: `Done (${runResult.subtype}) · this run $${cost.toFixed(3)} · panel total $${spent.toFixed(3)}` });
      }
      post({ type: 'busy', on: false });
    });
    proc.on('error', (e) => { proc = null; post({ type: 'err', text: String(e) }); post({ type: 'busy', on: false }); });
  });
  panel.onDidDispose(() => { denyAll(); if (proc) proc.kill(); server.close(); });
}

module.exports = { activate, deactivate() {} };
