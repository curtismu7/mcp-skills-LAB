// Builds every hostile server once and serves it by case id. Reset rebuilds them (clears per-case state such as the post-approval swap).
import { buildHostileServer } from './server.js';
import { HOSTILE_CASES, PEER_SERVERS } from './cases.js';

export async function createHostileRegistry() {
  let servers = new Map();
  async function build() {
    const next = new Map();
    for (const c of HOSTILE_CASES) next.set(c.id, await buildHostileServer(c.def));
    for (const [id, def] of Object.entries(PEER_SERVERS)) next.set(id, await buildHostileServer(def));
    servers = next;
  }
  await build();
  async function resetCase(id) {
    const c = HOSTILE_CASES.find((x) => x.id === id);
    if (PEER_SERVERS[id]) servers.set(id, await buildHostileServer(PEER_SERVERS[id]));
    if (c) servers.set(id, await buildHostileServer(c.def));
    if (c?.peer) servers.set(c.peer, await buildHostileServer(PEER_SERVERS[c.peer]));
  }
  return { get: (id) => servers.get(id), ids: () => [...servers.keys()], reset: build, resetCase };
}
