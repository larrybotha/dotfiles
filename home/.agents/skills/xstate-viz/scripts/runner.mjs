// Runs an XState machine under the Stately inspector.
// Usage: tsx runner.mjs <abs-machine-path> [port] [open(1|0)]
import { createInspectorServer } from '@statelyai/inspect/server';
import { createWebSocketInspector } from '@statelyai/inspect';
import { createActor, createMachine } from 'xstate';
import { pathToFileURL } from 'node:url';

const [machinePath, portArg, openArg] = process.argv.slice(2);
const port = Number(portArg) || 8080;
const autoOpen = openArg !== '0';

const mod = await import(pathToFileURL(machinePath).href);

const isMachine = (v) => v && typeof v === 'object' && typeof v.transition === 'function';
const isConfig = (v) => isMachine(v) === false && !!v && typeof v === 'object'
  && 'states' in v && ('initial' in v || 'id' in v);

const named = Object.entries(mod).filter(([k]) => k !== 'default' && k !== '__esModule');

const machines = named.filter(([, v]) => isMachine(v));
const configs = named.filter(([, v]) => isConfig(v));

let machine =
  named.find(([k]) => k === 'machine')?.[1] ??
  machines[0]?.[1] ??
  (isMachine(mod.default) ? mod.default : undefined);

if (!machine) {
  const config =
    configs[0]?.[1] ??
    (isConfig(mod.default) ? mod.default : null);
  if (config) machine = createMachine(config);
}

if (!machine) {
  const keys = named.map(([k]) => k).join(', ') || '(none)';
  console.error(`[xstate-viz] no machine export found in ${machinePath}; exports: ${keys}`);
  process.exit(1);
}
if (machines.length + configs.length > 1) {
  console.warn(`[xstate-viz] multiple machine exports found, using the first; all exports: ${named.map(([k]) => k).join(', ')}`);
}

const server = createInspectorServer({ port, autoOpen });
const inspector = createWebSocketInspector({ url: `ws://localhost:${port}` });
const actor = createActor(machine, { inspect: inspector.inspect });
actor.start();

console.log(`[xstate-viz] running ${machinePath}`);
console.log(`[xstate-viz] inspector at http://localhost:${port}`);

// Optional event injection: JSON per line, or bare event type.
process.stdin.on('data', (d) => {
  for (const line of d.toString().split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      actor.send(JSON.parse(t));
    } catch {
      actor.send({ type: t });
    }
  }
});
