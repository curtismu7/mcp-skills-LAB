import Json from "./JsonPane.jsx";

// Rule 14: the raw request and response of every hop, with its traceparent. Text only (React text nodes): nothing from the server is ever interpreted.
// A body that is JSON gets the shared Form | JSON pane (the JSON view shows the text exactly as it came); anything else (an SSE body, a cut-off body) stays text.
const HOT = ["method", "uri", "digest", "allowed-tools"];
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
            <Json value={w.request || "(no body)"} label="Request" testId="wire-request" hot={HOT} />
            <p className="section-label">Response ({w.responseType || "no body"})</p>
            <Json value={w.response || "(no body)"} label="Response" testId="wire-response" hot={HOT} />
          </details>
        </li>
      ))}
    </ol>
  );
}
