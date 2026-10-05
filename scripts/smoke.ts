// Smoke test: connect to the MCP server as a client, call each tool, print
// results. Not part of the test suite; run with `tsx scripts/smoke.ts`.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:4000/mcp'));
  const client = new Client({ name: 'smoke', version: '0.1.0' });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log('tools:', tools.tools.map(t => t.name).join(', '));

  const join = await client.callTool({ name: 'join_game', arguments: { nickname: 'SmokeBot' } });
  console.log('join_game:', firstText(join));

  await new Promise(r => setTimeout(r, 500));
  const obs = await client.callTool({ name: 'observe', arguments: {} });
  console.log('observe:', firstText(obs).slice(0, 400));

  const head = await client.callTool({ name: 'set_heading', arguments: { x: 2500, y: 2500 } });
  console.log('set_heading:', firstText(head));

  const headAngle = await client.callTool({ name: 'set_heading', arguments: { angle: 1.57 } });
  console.log('set_heading angle:', firstText(headAngle));

  const split = await client.callTool({ name: 'split', arguments: {} });
  console.log('split:', firstText(split));

  const eject = await client.callTool({ name: 'eject', arguments: {} });
  console.log('eject:', firstText(eject));

  const hb1 = await client.callTool({ name: 'heartbeat', arguments: { cost: 1.0, model: 'claude-sonnet-4-6', prompt_tokens: 200 } });
  console.log('heartbeat 1:', firstText(hb1));

  await new Promise(r => setTimeout(r, 500));
  const hb2 = await client.callTool({ name: 'heartbeat', arguments: { cost: 5.0, model: 'claude-sonnet-4-6', prompt_tokens: 200 } });
  console.log('heartbeat 2 (over-reported):', firstText(hb2));

  const hbCheat = await client.callTool({ name: 'heartbeat', arguments: { cost: -3.0, model: 'claude-sonnet-4-6', prompt_tokens: 200 } });
  console.log('heartbeat 3 (negative cheat):', firstText(hbCheat));

  const status = await client.callTool({ name: 'status', arguments: {} });
  console.log('status:', firstText(status));

  await client.close();
}

function firstText(res: any): string {
  const c = res.content && res.content[0];
  if (c && c.type === 'text') return c.text;
  return JSON.stringify(res);
}

main().catch(err => {
  console.error('smoke failed:', err);
  process.exit(1);
});
