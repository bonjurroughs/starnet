/* node test/claude-cli-provider.test.js — the "Claude · your login" brain (providers/claude-cli.js) against a fake
   `claude` child: argv isolation, transcript rendering, tool-name round trip, stream -> HarnessEvent mapping. */
'use strict';
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const A = require('./_assert.js');
const P = require('../sidecar/providers/claude-cli.js');
const I = P._internals;

// a fake child that replays scripted stream-json lines once stdin closes
function fakeSpawn(script, record) {
  return (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let input = '';
    child.stdin = new PassThrough();
    child.stdin.on('data', c => { input += c; });
    child.killed = false;
    child.kill = () => { child.killed = true; };
    child.stdin.on('finish', () => {
      record.push({ bin, args, cwd: opts.cwd, input, files: readFiles(args) });
      setImmediate(() => {
        for (const line of script.lines) child.stdout.write(JSON.stringify(line) + '\n');
        if (script.stderr) child.stderr.write(script.stderr);
        setImmediate(() => child.emit('close', script.code || 0));
      });
    });
    return child;
  };
}
function readFiles(args) {
  const out = {};
  const at = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  try { out.system = fs.readFileSync(at('--system-prompt-file'), 'utf8'); } catch (_) {}
  try { out.mcp = JSON.parse(fs.readFileSync(at('--mcp-config'), 'utf8')); } catch (_) {}
  try { out.tools = JSON.parse(fs.readFileSync(out.mcp.mcpServers.starnet.env.CLAUDE_CLI_TOOLS_FILE, 'utf8')); } catch (_) {}
  return out;
}
async function collect(provider, req) {
  const evs = [];
  for await (const e of provider.stream(req)) evs.push(e);
  return evs;
}
const se = event => ({ type: 'stream_event', event });
const TOOLS = [{ type: 'function', function: { name: 'fs.read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'shell.exec', description: 'run', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } }];

(async () => {
  // ---- pure helpers ----
  const tm = I.buildToolMap(TOOLS);
  A.eq(tm.list.map(t => t.name), ['fs_read', 'shell_exec'], 'dotted tool names become MCP-safe');
  A.eq(tm.fromMcp.get('fs_read'), 'fs.read', 'MCP name maps back to the StarNet name');
  const long = I.buildToolMap([{ function: { name: 'x'.repeat(80) } }, { function: { name: 'x'.repeat(81) } }]);
  A.ok(long.list.every(t => (I.MCP_PREFIX + t.name).length <= 64), 'prefixed names stay within 64 chars');
  A.ok(long.list[0].name !== long.list[1].name, 'truncation collisions are uniquified');
  const tr = I.renderTranscript([
    { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: {} }] },
    { role: 'assistant', content: 'checking', tool_calls: [{ id: 'c1', function: { name: 'fs.read', arguments: '{"path":"a"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'A-CONTENT' }]);
  A.ok(/<user>\nhi\n\[image omitted/.test(tr), 'user text rendered; images declared, not silently dropped');
  A.ok(/<tool_call name="fs.read" id="c1">\{"path":"a"\}<\/tool_call>/.test(tr), 'prior tool call rendered with its args');
  A.ok(/<tool_result name="fs.read" id="c1">\nA-CONTENT/.test(tr), 'tool result names the tool that produced it');

  // ---- argv isolation + text turn ----
  const rec = [];
  const textScript = { lines: [
    { type: 'system', subtype: 'init' },
    se({ type: 'message_start', message: { id: 'm1' } }),
    se({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'secret' } }),
    se({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } }),
    se({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'there' } }),
    { type: 'result', subtype: 'success', stop_reason: 'end_turn', usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 }, total_cost_usd: 0.02 }] };
  const p1 = P.makeClaudeCliProvider({ spawn: fakeSpawn(textScript, rec), bin: '/x/claude', nodeBin: '/x/node' });
  const ev1 = await collect(p1, { model: 'opus', messages: [{ role: 'system', content: 'You are NOVA.' }, { role: 'user', content: 'hi' }] });
  const a = rec[0].args;
  A.eq(rec[0].bin, '/x/claude', 'runs the configured claude binary');
  A.ok(a.includes('-p') && a.includes('--no-session-persistence') && a.includes('--disable-slash-commands'), 'print mode, nothing persisted');
  A.eq(a[a.indexOf('--tools') + 1], '', 'Claude Code built-in tools disabled');
  A.eq(a[a.indexOf('--setting-sources') + 1], '', 'user/project settings + hooks not loaded');
  A.eq(a[a.indexOf('--model') + 1], 'opus', 'requested model passed through');
  A.ok(!a.includes('--mcp-config'), 'no MCP server when the turn has no tools');
  A.ok(/^You are NOVA\./.test(rec[0].files.system) && /HARNESS NOTES/.test(rec[0].files.system), 'StarNet system prompt replaces the default, plus harness notes');
  A.eq(ev1.filter(e => e.type === 'text').map(e => e.delta).join(''), 'Hello there', 'text deltas streamed; thinking never leaks into text');
  const u1 = ev1.find(e => e.type === 'usage').usage;
  A.eq([u1.prompt_tokens, u1.completion_tokens, u1.cost], [15, 3, 0], 'usage mapped; subscription cost is 0, never the notional API price');
  A.eq(ev1[ev1.length - 1], { type: 'done', finishReason: 'stop' }, 'exactly one done, stop');

  // ---- tool turn: every tool_use of the message is lifted, names mapped back, child ended ----
  const rec2 = [];
  const toolScript = { lines: [
    se({ type: 'message_start', message: { id: 'm2' } }),
    { type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 't1', name: 'mcp__starnet__fs_read', input: { path: 'notes.txt' } }], usage: { input_tokens: 7, output_tokens: 2 } } },
    { type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 't2', name: 'mcp__starnet__shell_exec', input: { cmd: 'ls' } }] } },
    se({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
    se({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'LEAKED second turn' } })] };
  const p2 = P.makeClaudeCliProvider({ spawn: fakeSpawn(toolScript, rec2), bin: 'claude', nodeBin: '/x/node' });
  const ev2 = await collect(p2, { messages: [{ role: 'user', content: 'read it' }], tools: TOOLS });
  const a2 = rec2[0].args;
  A.ok(a2.includes('--strict-mcp-config'), 'only the StarNet catalog MCP server loads');
  A.eq(rec2[0].files.tools.map(t => t.name), ['fs_read', 'shell_exec'], 'tool catalog handed to the MCP server');
  A.eq(rec2[0].files.mcp.mcpServers.starnet.command, '/x/node', 'MCP server runs under the sidecar node');
  const starts = ev2.filter(e => e.type === 'tool_start');
  A.eq(starts.map(e => [e.index, e.id, e.name]), [[0, 't1', 'fs.read'], [1, 't2', 'shell.exec']], 'both parallel tool calls lifted with StarNet names');
  A.eq(ev2.filter(e => e.type === 'tool_args').map(e => e.chunk), ['{"path":"notes.txt"}', '{"cmd":"ls"}'], 'tool arguments passed as JSON');
  A.eq(ev2[ev2.length - 1], { type: 'done', finishReason: 'tool_calls' }, 'turn ends with tool_calls');
  A.ok(!ev2.some(e => e.type === 'text' && /LEAKED/.test(e.delta)), 'nothing after the tool_use stop leaks into the turn');

  // ---- failures are errors or truncation, never a fake success ----
  const errP = P.makeClaudeCliProvider({ spawn: fakeSpawn({ lines: [{ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'usage limit reached' }] }, []) });
  let threw = null; try { await collect(errP, { messages: [{ role: 'user', content: 'x' }] }); } catch (e) { threw = e; }
  A.ok(threw && /usage limit/.test(threw.message), 'CLI error result surfaces as an error');
  const exitP = P.makeClaudeCliProvider({ spawn: fakeSpawn({ lines: [], code: 1, stderr: 'Invalid API key · Please run /login' }, []) });
  threw = null; try { await collect(exitP, { messages: [{ role: 'user', content: 'x' }] }); } catch (e) { threw = e; }
  A.ok(threw && /exited 1.*login/.test(threw.message), 'non-zero exit surfaces with its stderr');
  const truncP = P.makeClaudeCliProvider({ spawn: fakeSpawn({ lines: [se({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'half' } })] }, []) });
  const ev3 = await collect(truncP, { messages: [{ role: 'user', content: 'x' }] });
  A.eq(ev3[ev3.length - 1], { type: 'done', finishReason: null, truncated: true }, 'clean exit with no terminal signal is reported truncated');

  // ---- Phase 3: a subscription-cap exhaustion is classified deterministically, not guessed from wording ----
  const EC = require('../sidecar/providers/errorClass.js');
  const capScript = { lines: [
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1790000000, rateLimitType: 'five_hour' } },
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1790003600, rateLimitType: 'five_hour' } },
    { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'five-hour limit reached' }] };
  const capP = P.makeClaudeCliProvider({ spawn: fakeSpawn(capScript, []) });
  threw = null; try { await collect(capP, { messages: [{ role: 'user', content: 'x' }] }); } catch (e) { threw = e; }
  A.ok(threw && threw.code === 'usage_limit_reached', 'a non-"allowed" rate_limit_info status sets a deterministic error code, not just wording');
  A.eq(EC.classifyApiError(threw, {}).reason, 'quota_exhausted', 'errorClass classifies it as quota_exhausted');
  A.eq(EC.classifyApiError(threw, {}).shouldFallback, true, 'quota_exhausted carries shouldFallback:true — index.js auto-adds an anthropic fallback entry for this');
  // an ordinary in-band error with no cap telemetry at all must NOT be misclassified as exhaustion
  const ordinaryP = P.makeClaudeCliProvider({ spawn: fakeSpawn({ lines: [{ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'invalid tool input' }] }, []) });
  threw = null; try { await collect(ordinaryP, { messages: [{ role: 'user', content: 'x' }] }); } catch (e) { threw = e; }
  A.eq(threw.code, 'claude_cli_error', 'an ordinary error without cap telemetry keeps the generic code');

  // ---- listModels is gated on a real sign-in ----
  const auth = out => P.makeClaudeCliProvider({ execFile: (b, args, o, cb) => cb(null, JSON.stringify(out)) });
  A.eq((await auth({ loggedIn: true }).listModels()).map(m => m.id), ['sonnet', 'opus', 'haiku'], 'signed in -> catalog');
  threw = null; try { await auth({ loggedIn: false }).listModels(); } catch (e) { threw = e; }
  A.ok(threw && /not signed in/.test(threw.message), 'signed out -> honest error, not a catalog');
  const missing = P.makeClaudeCliProvider({ execFile: (b, args, o, cb) => cb(Object.assign(new Error('x'), { code: 'ENOENT' })) });
  threw = null; try { await missing.listModels(); } catch (e) { threw = e; }
  A.ok(threw && /not found/.test(threw.message), 'missing CLI -> honest error');

  A.report('claude-cli-provider.test');
})().catch(e => { console.error(e); process.exit(1); });
