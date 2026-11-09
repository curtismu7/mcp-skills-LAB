export default function Kv({ rows }) {
  return <dl className="kv">{rows.map(([k, v]) => <div className="kv__row" key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}
