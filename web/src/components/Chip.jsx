// A status chip: semantic colour AND a word, never colour alone.
const TONE = { PASS: "ok", FAIL: "danger", MUST: "danger", SHOULD: "warn", MAY: "info", lab: "info", info: "info", ok: "ok", refused: "danger", warning: "warn" };
export default function Chip({ children, tone, testid, title }) {
  const t = tone ?? TONE[children] ?? "info";
  return <span className={`chip chip--${t}`} data-testid={testid} title={title}><span className="dot" aria-hidden="true" />{children}</span>;
}
