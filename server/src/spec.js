// Identity and sources. Every spec statement in this app comes from the pages listed here; see README "What is verified".
export const DEMO = { id: 'mcp-skills-lab', name: 'MCP Skills LAB', version: '0.1.0' };
export const SPEC_SOURCES = {
  extensionId: 'io.modelcontextprotocol/skills',
  sep: 'SEP-2640',
  protocolRevision: '2026-07-28',
  overview: 'https://modelcontextprotocol.io/extensions/skills/overview',
  sepPage: 'https://modelcontextprotocol.io/seps/2640-skills-extension.md',
  specification: 'https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/beta/skills.mdx',
  readNote: 'The specification page was read through a page summariser, not verbatim. Field names and MUST/SHOULD statements below match that summary and the 2.4.0 SDK types; wording is paraphrased. UNVERIFIED against a vendor gateway.',
};
export const PORT_NOTE = 'Port 7807 (packed range 7800-7999).';

// Shown by the page on every tab (also in presenter mode). The web app keeps the same words in web/src/banner.js; a test compares them.
export const MEASURED = 'MEASURED 2026-11-09 on the hosted Privilege gateway (privilege-aigw v1.261106): its aggregate endpoint answered server/discover, skills/list, skills/get and resources/directory/read with JSON-RPC -32601 unknown method, so it does not carry the Skills extension there. A non-aggregate endpoint (hostile-mcp) passed skills/list through to its backend, which answered Method not found (-32601). This lab itself was not reached through the gateway: a test endpoint for it returned 403 for every request.';
export const TABS = ['overview', 'skills', 'verifier', 'approvals', 'source', 'diagram'];
