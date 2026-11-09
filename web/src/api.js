import { workspaceFetch, workspaceId } from "./workspace.js";

async function j(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message || body.error || `HTTP ${res.status}`), { code: body.error, status: res.status, body });
  return body;
}
const get = (url) => workspaceFetch(url, { method: "GET" }).then(j);
const post = (url, body) => workspaceFetch(url, { method: "POST", body: JSON.stringify(body ?? {}) }).then(j);

export const getInfo = () => get("/api/info");
export const postMode = (source) => post("/api/mode", { source });
export const getCatalog = () => get("/api/catalog");
export const getSpec = () => get("/api/spec");
export const getHostile = () => get("/api/hostile");
export const getDiagram = (name) => get(`/api/diagram?name=${encodeURIComponent(name)}`);
export const getTalkTrack = () => get("/api/talk-track");
export const resetServer = () => post("/api/reset", {});
export const verify = (body) => post("/api/verify", body);

// A browse session is server side, one per workspace. The Approvals tab uses its own (suffix "ap") so it never clobbers the Skills tab's session.
export function createBrowse(suffix = "") {
  const ws = suffix ? { "x-workspace": `${workspaceId()}-${suffix}` } : {};
  const g = (url) => workspaceFetch(url, { method: "GET", headers: ws }).then(j);
  const p = (url, body) => workspaceFetch(url, { method: "POST", headers: ws, body: JSON.stringify(body ?? {}) }).then(j);
  return {
    connect: (target, era) => p("/api/browse/connect", { target, era }),
    list: () => p("/api/browse/list"),
    get: (uri) => p("/api/browse/get", { uri }),
    file: (uri, ref) => p("/api/browse/file", { uri, ref }),
    dir: (uri, skillUri) => p("/api/browse/dir", { uri, skillUri }),
    activate: (uri) => p("/api/browse/activate", { uri }),
    approve: (uri, flags) => p("/api/browse/approve", { uri, ...flags }),
    script: (uri, ref) => p("/api/browse/script", { uri, ref }),
    wire: (since = 0) => g(`/api/browse/wire?since=${since}`),
    state: () => g("/api/browse/state"),
  };
}
