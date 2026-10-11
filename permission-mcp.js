// Stdio MCP server the CLI calls for every permission decision (--permission-prompt-tool).
// It forwards the request to the API Chat panel over localhost and waits for the person's answer.
const http = require('http');
const PORT = process.env.API_CHAT_PORT, TOKEN = process.env.API_CHAT_TOKEN;

function ask(args) {
  return new Promise((resolve) => {
    const body = JSON.stringify(args);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/ask', method: 'POST',
      headers: { 'content-type': 'application/json', 'x-token': TOKEN, 'content-length': Buffer.byteLength(body) } }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve(s));
    });
    req.on('error', (e) => resolve(JSON.stringify({ behavior: 'deny', message: 'Permission panel unreachable: ' + e.message })));
    req.end(body);
  });
}

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
let buf = '';
process.stdin.on('data', async (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue; // notifications
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'apichat', version: '0.0.1' } } });
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'approve', description: 'Ask the person to approve a tool call',
        inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] } }] } });
    } else if (msg.method === 'tools/call') {
      const text = await ask(msg.params.arguments || {});
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
});
