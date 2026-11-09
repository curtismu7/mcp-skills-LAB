// Rule 19: the Mock / Real toggle, in the header of every page. Pressed = the server's current source. Real that is not configured keeps its border and
// focus (aria-disabled, not disabled), carries the how-to as its tooltip, and the server answers 409 with the same reason when it is pressed.
export default function ModeToggle({ info, onSelect }) {
  const source = info?.source;
  const realOff = !info || info.realAvailable !== true;
  const how = realOff && info ? `${info.realReason || "Real is not configured"}. Mount a skills folder read-only and set SKILLS_DIR (see the Source tab).` : undefined;
  return (
    <div className="mode-toggle" role="group" aria-label="Source: Mock or Real" data-testid="mode">
      <button type="button" aria-pressed={source === "mock"} onClick={() => source !== "mock" && onSelect("mock")} data-testid="mode-mock">Mock</button>
      <button type="button" aria-pressed={source === "real"} aria-disabled={realOff ? "true" : undefined} title={how} onClick={() => source !== "real" && onSelect("real")} data-testid="mode-real">Real</button>
    </div>
  );
}
