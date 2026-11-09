// Rule 14: the raw request and response of every hop, with its traceparent. Text only (React text nodes): nothing from the server is ever interpreted.
export default function WireView({ wire, empty = "No requests yet." }) {
  if (!wire?.length) return <p className="muted" data-testid="wire-empty">{empty}</p>;
  return (
    <ol className="wire" data-testid="wire">
      {wire.map((w) => (
        <li key={w.seq}>
          <details>
            <summary>
              <span className="mono">#{w.seq}</span> <strong className="mono">{w.method ?? w.http}</strong> <span className="muted">{w.http} {w.url} HTTP {w.status} {w.ms} ms</span>
            </summary>
            <p className="muted mono">traceparent {w.traceparent ?? "none"}</p>
            <p className="section-label">Request</p>
            <pre className="code" data-testid="wire-request">{w.request || "(no body)"}</pre>
            <p className="section-label">Response ({w.responseType || "no body"})</p>
            <pre className="code" data-testid="wire-response">{w.response || "(no body)"}</pre>
          </details>
        </li>
      ))}
    </ol>
  );
}
