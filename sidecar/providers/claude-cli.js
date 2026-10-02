/* sidecar/providers/claude-cli.js — the Claude Code CLI as a StarNet brain ("Claude · your login").

   WHY. A Claude subscription (claude.ai login) has no API key; the sanctioned way to use it is the user's own
   `claude` CLI. This adapter drives `claude -p` as a pure MODEL: Claude Code's built-in tools are disabled
   (`--tools ""`), its system prompt is REPLACED by StarNet's (`--system-prompt-file`), user/project settings and
   hooks are not loaded (`--setting-sources ""`), and nothing is persisted (`--no-session-persistence`). StarNet
   never reads, copies or forwards a Claude credential — the child authenticates itself exactly as it would in a
   terminal.

   TOOLS. StarNet's tool schemas are advertised to the child through a catalog-only MCP server
   (claude-cli-mcp.js, `--strict-mcp-config` so nothing else loads). When Claude ends a message with
   stop_reason "tool_use", every tool_use block of that message is lifted into tool_start/tool_args/tool_done
   HarnessEvents, the child is ended, and the turn finishes with finishReason 'tool_calls'. StarNet's loop then
   executes the tools through its own consent gates and sends the results back on the next request. The MCP
   server has no implementations, so the child can never run a StarNet tool itself.

   TRANSCRIPT. `claude -p` takes one prompt, not a message array, so each request renders the conversation
   (after the system prompt) as a tagged transcript on stdin — user turns, prior assistant text, the tool calls
   the assistant made and their results — and asks Claude to write the next assistant turn. Stateless per
   request, like every other adapter: nothing depends on a prior child.

   COST. Subscription usage: tokens are reported for the context gauge; cost is 0 (the CLI's total_cost_usd is a
   notional API-price figure, not a bill).

   Node-only (spawns a process); the factory only requires it on the Node side. `spawn`, `fs`, `os`, `path` and
   the CLI binary are injectable for tests. */
'use strict';

const { note } = require('../failopen.js');   // fail-open seams leave a trace (failopen-ratchet)

const MCP_SERVER = 'starnet';
const MCP_PREFIX = 'mcp__' + MCP_SERVER + '__';
const DEFAULT_CONTEXT = 200000;
const STATIC_MODELS = [
  { id: 'sonnet', displayName: 'Claude Sonnet (latest)', description: 'Balanced — the everyday default', context_length: DEFAULT_CONTEXT, max_completion_tokens: 64000, supportsTools: true },
  { id: 'opus', displayName: 'Claude Opus (latest)', description: 'Most capable', context_length: DEFAULT_CONTEXT, max_completion_tokens: 64000, supportsTools: true },
  { id: 'haiku', displayName: 'Claude Haiku (latest)', description: 'Fastest', context_length: DEFAULT_CONTEXT, max_completion_tokens: 64000, supportsTools: true },
];
const DEFAULT_MODEL = 'sonnet';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function textFromContent(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map(p => {
      if (!p) return '';
      if (typeof p === 'string') return p;
      if (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') return String(p.text || '');
      if (p.type === 'image_url' || p.type === 'image' || p.type === 'input_image') return '[image omitted — this brain receives text only]';
      return '';
    }).filter(Boolean).join('\n');
  }
  if (typeof c === 'object' && typeof c.text === 'string') return c.text;
  return String(c);
}

/* MCP tool names allow [A-Za-z0-9_-] and the model-side name (with the mcp__starnet__ prefix) must stay <= 64. */
function buildToolMap(tools) {
  const list = [], toMcp = new Map(), fromMcp = new Map();
  for (const item of tools || []) {
    const fn = (item && item.function) || item || {};
    const name = String(fn.name || '').trim();
    if (!name || toMcp.has(name)) continue;
    let base = name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64 - MCP_PREFIX.length) || 'tool';
    let mcp = base, n = 2;
    while (fromMcp.has(mcp)) { const suf = '_' + (n++); mcp = base.slice(0, 64 - MCP_PREFIX.length - suf.length) + suf; }
    toMcp.set(name, mcp); fromMcp.set(mcp, name);
    const schema = (fn.parameters && typeof fn.parameters === 'object') ? fn.parameters : { type: 'object', properties: {} };
    list.push({ name: mcp, description: String(fn.description || ''), inputSchema: schema.type ? schema : Object.assign({ type: 'object' }, schema) });
  }
  return { list, toMcp, fromMcp };
}

function splitSystem(messages) {
  const sys = [];
  let i = 0;
  for (; i < (messages || []).length; i++) {
    const m = messages[i];
    if (!m || m.role !== 'system') break;
    const t = textFromContent(m.content).trim();
    if (t) sys.push(t);
  }
  return { system: sys.join('\n\n'), rest: (messages || []).slice(i) };
}

function safeArgs(a) {
  if (a == null) return '{}';
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch (_) { return '{}'; }
}

/* renderTranscript(rest) — the conversation after the system prompt, as tagged turns Claude continues. */
function renderTranscript(rest) {
  const parts = [];
  const names = new Map();   // tool_call id -> tool name, so a result can say which tool produced it
  for (const m of rest || []) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'user') { parts.push('<user>\n' + textFromContent(m.content) + '\n</user>'); continue; }
    if (m.role === 'assistant') {
      const bits = [];
      const t = textFromContent(m.content).trim();
      if (t) bits.push(t);
      for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        const fn = (tc && tc.function) || {};
        const id = String((tc && tc.id) || '');
        if (id) names.set(id, String(fn.name || ''));
        bits.push('<tool_call name="' + String(fn.name || '') + '" id="' + id + '">' + safeArgs(fn.arguments) + '</tool_call>');
      }
      parts.push('<assistant>\n' + bits.join('\n') + '\n</assistant>');
      continue;
    }
    if (m.role === 'tool') {
      const id = String(m.tool_call_id || m.call_id || '');
      const nm = String(m.name || names.get(id) || '');
      parts.push('<tool_result name="' + nm + '" id="' + id + '">\n' + textFromContent(m.content) + '\n</tool_result>');
    }
  }
  return parts.join('\n\n');
}

function systemAppendix(toolMap) {
  const lines = [
    '',
    '---',
    'HARNESS NOTES (StarNet runs you through the Claude Code CLI):',
    '- The conversation so far arrives as a transcript of <user>, <assistant>, <tool_call> and <tool_result> blocks. ' +
      'Write ONLY the next assistant turn. Do not echo the tags. <tool_result> blocks are the real outputs of tools you already called.',
  ];
  if (toolMap.list.length) {
    lines.push('- Your tools are exposed with an "' + MCP_PREFIX + '" prefix. When these instructions name a tool, use its exposed form:');
    for (const [orig, mcp] of toolMap.toMcp) if (orig !== mcp) lines.push('  ' + orig + ' -> ' + MCP_PREFIX + mcp);
    lines.push('- Call tools natively (not in prose). StarNet executes them and returns the results on the next turn.');
  } else {
    lines.push('- No tools are available this turn; answer in text.');
  }
  return lines.join('\n');
}

function normalizeUsage(u) {
  u = u || {};
  const cached = (u.cache_read_input_tokens || 0);
  const prompt = (u.input_tokens || 0) + cached + (u.cache_creation_input_tokens || 0);
  const out = u.output_tokens || 0;
  return { prompt_tokens: prompt, completion_tokens: out, total_tokens: prompt + out,
    prompt_tokens_details: { cached_tokens: cached }, cost: 0 };
}

function buildArgs(o) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--setting-sources', '', '--tools', '', '--no-session-persistence', '--disable-slash-commands',
    '--system-prompt-file', o.systemFile, '--model', o.model || DEFAULT_MODEL];
  if (o.mcpFile) args.push('--strict-mcp-config', '--mcp-config', o.mcpFile);
  if (o.effort && EFFORTS.indexOf(o.effort) >= 0) args.push('--effort', o.effort);
  return args;
}

function makeClaudeCliProvider(opts) {
  opts = opts || {};
  const spawn = opts.spawn || require('node:child_process').spawn;
  const fs = opts.fs || require('node:fs');
  const os = opts.os || require('node:os');
  const path = opts.path || require('node:path');
  const bin = opts.bin || (typeof process !== 'undefined' && process.env && (process.env.STARNET_CLAUDE_BIN || process.env.SKYNET_CLAUDE_BIN)) || 'claude';
  const nodeBin = opts.nodeBin || process.execPath;
  const mcpScript = opts.mcpScript || path.join(__dirname, 'claude-cli-mcp.js');
  const effort = opts.reasoningEffort && opts.reasoningEffort !== 'none' ? String(opts.reasoningEffort) : '';

  function findModel(id) { return STATIC_MODELS.find(m => m.id === id) || null; }

  async function* stream(req) {
    req = req || {};
    const signal = req.signal;
    if (signal && signal.aborted) return;
    const split = splitSystem(req.messages);
    const toolMap = buildToolMap(req.tools);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-claude-'));
    const systemFile = path.join(dir, 'system.txt');
    fs.writeFileSync(systemFile, (split.system || 'You are a helpful assistant.') + '\n' + systemAppendix(toolMap), 'utf8');
    let mcpFile = null;
    if (toolMap.list.length) {
      const toolsFile = path.join(dir, 'tools.json');
      fs.writeFileSync(toolsFile, JSON.stringify(toolMap.list), 'utf8');
      mcpFile = path.join(dir, 'mcp.json');
      fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { [MCP_SERVER]: { command: nodeBin, args: [mcpScript], env: { CLAUDE_CLI_TOOLS_FILE: toolsFile } } } }), 'utf8');
    }
    const args = buildArgs({ systemFile, mcpFile, model: req.model || DEFAULT_MODEL, effort: req.reasoningEffort || effort });

    // a small push/pull queue bridging the child's callbacks to this async generator
    const queue = []; let wake = null, ended = false, failure = null;
    const push = ev => { queue.push(ev); if (wake) { wake(); wake = null; } };
    const finish = err => { if (ended) return; ended = true; failure = err || null; if (wake) { wake(); wake = null; } };

    let child;
    try {
      child = spawn(bin, args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: process.env });
    } catch (e) { cleanup(); throw e; }
    let stderr = '', buf = '', done = false, sawResult = false;
    const msgTools = new Map();   // message id -> [tool_use blocks]
    let lastUsage = null, curMsg = null, lastRateLimitInfo = null;
    // ending the child is best-effort (it may already have exited); a failure is traced, never thrown
    const killChild = () => { try { child.kill('SIGTERM'); } catch (e) { note('claude-cli.kill', e); } };
    const onAbort = () => { killChild(); finish(null); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    function endWith(finishReason, usage) {
      if (done) return;
      done = true;
      if (usage) push({ type: 'usage', usage: normalizeUsage(usage) });
      push({ type: 'done', finishReason });
      killChild();
      finish(null);
    }
    function onLine(line) {
      let j; try { j = JSON.parse(line); } catch (_) { return; }
      if (done || !j || typeof j !== 'object') return;
      if (j.type === 'stream_event' && j.event) {
        const e = j.event;
        if (e.type === 'message_start' && e.message) curMsg = e.message.id || curMsg;
        if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta' && e.delta.text) push({ type: 'text', delta: e.delta.text });
        if (e.type === 'message_delta' && e.delta && e.delta.stop_reason === 'tool_use') {
          const blocks = msgTools.get(curMsg) || [];
          if (!blocks.length) return;                        // defensive: wait for the assistant snapshot
          blocks.forEach((b, i) => {
            const orig = toolMap.fromMcp.get(String(b.name || '').replace(MCP_PREFIX, '')) || String(b.name || '');
            push({ type: 'tool_start', index: i, id: String(b.id || ('call_' + i)), name: orig });
            push({ type: 'tool_args', index: i, chunk: safeArgs(b.input || {}) });
            push({ type: 'tool_done', index: i });
          });
          endWith('tool_calls', lastUsage);
        }
        return;
      }
      if (j.type === 'assistant' && j.message) {
        const id = j.message.id || curMsg;
        curMsg = id;
        if (j.message.usage) lastUsage = j.message.usage;
        for (const c of j.message.content || []) {
          if (c && c.type === 'tool_use' && String(c.name || '').indexOf(MCP_PREFIX) === 0) {
            const arr = msgTools.get(id) || [];
            if (!arr.some(x => x.id === c.id)) arr.push(c);
            msgTools.set(id, arr);
          }
        }
        return;
      }
      // The subscription's own usage-cap telemetry (five_hour / seven_day windows). Not itself a
      // HarnessEvent — just remembered so a failing `result` right after can be classified deterministically
      // rather than guessed at from the CLI's raw English wording. Only field confirmed live: `status`
      // ('allowed' on every successful turn observed); any other value is treated as exhaustion.
      if (j.type === 'rate_limit_event' && j.rate_limit_info) { lastRateLimitInfo = j.rate_limit_info; return; }
      if (j.type === 'result') {
        sawResult = true;
        if (j.is_error || (j.subtype && j.subtype !== 'success')) {
          const capped = !!(lastRateLimitInfo && lastRateLimitInfo.status && lastRateLimitInfo.status !== 'allowed');
          const resetHint = capped && lastRateLimitInfo.resetsAt
            ? ' (resets ' + new Date(lastRateLimitInfo.resetsAt * 1000).toLocaleString() + ')' : '';
          const err = new Error((capped ? 'Claude subscription usage limit reached' : 'claude CLI') + ': ' + String(j.result || j.subtype || 'error').slice(0, 400) + resetHint);
          // usage_limit_reached matches errorClass.js's structured-code quota_exhausted path (shouldFallback:true),
          // the same seam Codex's weekly-quota exhaustion already uses — see index.js's auto-fallback wiring.
          err.code = capped ? 'usage_limit_reached' : 'claude_cli_error';
          done = true; killChild();
          return finish(err);
        }
        endWith(j.stop_reason === 'max_tokens' ? 'length' : 'stop', j.usage || lastUsage);
      }
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) onLine(line); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', c => { if (stderr.length < 8000) stderr += c; });
    child.on('error', e => {
      const err = (e && e.code === 'ENOENT')
        ? Object.assign(new Error('claude CLI not found — install Claude Code and sign in (`claude`), or set STARNET_CLAUDE_BIN'), { code: 'provider_not_configured' })
        : e;
      finish(err);
    });
    child.on('close', code => {
      if (done || ended) return finish(null);
      if (signal && signal.aborted) return finish(null);
      if (!sawResult && code !== 0) {
        const tail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
        return finish(Object.assign(new Error('claude CLI exited ' + code + (tail ? ': ' + tail : '')), { code: 'claude_cli_error' }));
      }
      // exited cleanly with no terminal signal: say so (truncated), never pass a fragment off as complete
      done = true; push({ type: 'done', finishReason: null, truncated: true }); finish(null);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(renderTranscript(split.rest) || '<user>\n(continue)\n</user>');

    function cleanup() {
      if (signal) signal.removeEventListener('abort', onAbort);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { note('claude-cli.tmp-cleanup', e); }
    }
    try {
      while (true) {
        if (queue.length) { yield queue.shift(); continue; }
        if (ended) break;
        await new Promise(r => { wake = r; });
      }
      while (queue.length) yield queue.shift();
      if (failure) throw failure;
    } finally {
      if (!ended || !done) killChild();
      cleanup();
    }
  }

  /* The catalog is static (the CLI takes aliases), so listModels' real job is HONESTY: it proves the CLI exists and
     is signed in (`claude auth status`) before Settings / the setup screen may call this brain ready. */
  function authStatus() {
    const execFile = opts.execFile || require('node:child_process').execFile;
    return new Promise((resolve, reject) => {
      execFile(bin, ['auth', 'status'], { timeout: 20000, windowsHide: true }, (err, stdout) => {
        if (err && err.code === 'ENOENT') return reject(Object.assign(new Error('claude CLI not found — install Claude Code and sign in, or set STARNET_CLAUDE_BIN'), { code: 'provider_not_configured' }));
        let j = null; try { j = JSON.parse(String(stdout || '')); } catch (_) { j = null; }   // unparseable = reported below
        if (!j) return reject(Object.assign(new Error('could not read `claude auth status`' + (err ? ': ' + err.message : '')), { code: 'provider_not_configured' }));
        if (!j.loggedIn) return reject(Object.assign(new Error('claude CLI is not signed in — run `claude` once and sign in with your Claude account'), { code: 'provider_not_configured' }));
        resolve(j);
      });
    });
  }
  async function listModels() {
    await authStatus();
    return STATIC_MODELS.map(m => Object.assign({}, m, { pricing: null, reasoningEfforts: EFFORTS.slice() }));
  }
  function contextLimit(id) { const m = findModel(id); return (m && m.context_length) || DEFAULT_CONTEXT; }
  function priceOf() { return null; }                   // subscription: no per-token price
  function supportsTools() { return true; }
  function reasoningEfforts() { return EFFORTS.slice(); }
  return { stream, listModels, contextLimit, priceOf, supportsTools, reasoningEfforts };
}

// The Claude subscription is capped (5-hour / weekly windows). When it is the primary, no fallback chain is
// configured, and a metered Anthropic key is on file, return the single { provider, model } entry that lets a
// cap exhaustion (err.code 'usage_limit_reached' -> errorClass 'quota_exhausted') fail over instead of
// stalling. Returns [] otherwise. claudecode model ids are aliases; map them to Anthropic's real ids and pass
// anything already exact through unchanged.
const CLAUDECODE_MODEL_TO_ANTHROPIC = { sonnet: 'claude-sonnet-5', opus: 'claude-opus-5-5', haiku: 'claude-haiku-4-5-20251001' };
function autoAnthropicFallback({ providerId, model, hasExplicitChain, hasAnthropicKey }) {
  if (providerId !== 'claudecode' || hasExplicitChain || !hasAnthropicKey) return [];
  return [{ provider: 'anthropic', model: CLAUDECODE_MODEL_TO_ANTHROPIC[model] || model }];
}

module.exports = { makeClaudeCliProvider, STATIC_MODELS, DEFAULT_MODEL, autoAnthropicFallback,
  _internals: { buildToolMap, renderTranscript, splitSystem, normalizeUsage, buildArgs, textFromContent, MCP_PREFIX } };
