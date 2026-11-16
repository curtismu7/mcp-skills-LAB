import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import App from "./App.jsx";
import { forgetWorkspace, workspaceId } from "./workspace.js";

// The header shows this lab's own Verified / In progress mark, read from the same /api/shelf call the Shelf link makes (through the lab-proxy that
// call reaches the shelf, whose payload lists every demo with its mark). The lab's own /api/shelf has no demos, so there is no mark then.
const INFO = { mode: "mock", source: "mock", realAvailable: false, realReason: "no skills directory", modes: ["mock", "real"], skillCount: 0, problemCount: 0, directory: null };
const mark = (status, label, extra = {}) => ({ status, label, note: "", updatedAt: "2026-11-15", source: "shipped", ...extra });
let shelfCalls;
function withShelf(payload) {
  shelfCalls = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    const clean = url.split("?")[0];
    if (clean === "/api/shelf") shelfCalls.push(init);
    const out = clean === "/api/shelf" ? payload : clean === "/api/info" ? INFO : clean === "/api/talk-track" ? { talkTrack: [] } : {};
    return { ok: true, status: 200, json: async () => out };
  });
}
beforeEach(() => { forgetWorkspace(); window.location.hash = ""; });
afterEach(() => { cleanup(); try { localStorage.clear(); } catch { /* */ } });

describe("verification mark in the header", () => {
  it("shows this lab's own mark beside the Shelf link, and no other lab's", async () => {
    withShelf({ shelfUrl: "http://shelf.example", demos: [{ id: "other-lab", verification: mark("in-progress", "In progress") }, { id: "mcp-skills-lab", verification: mark("verified", "Verified", { note: "Every hostile case run on the mock" }) }] });
    const { container } = render(<App />);
    const bar = within(await screen.findByTestId("top-menu"));
    expect(await bar.findByText("Verified")).toBeInTheDocument();
    expect(await bar.findByRole("link", { name: "Shelf" })).toBeInTheDocument();
    expect(bar.queryByText("In progress")).toBeNull();
    expect(container.querySelectorAll(".verify")).toHaveLength(1);
    expect(bar.getByText("Verified").closest(".verify")).toHaveAttribute("title", expect.stringContaining("Every hostile case run on the mock"));
  });

  it("sends the same x-workspace header on the shelf call as the lab's other requests", async () => {
    withShelf({ shelfUrl: "http://shelf.example", demos: [{ id: "mcp-skills-lab", verification: mark("verified", "Verified") }] });
    render(<App />);
    await screen.findByText("Verified");
    expect(shelfCalls.length).toBeGreaterThanOrEqual(2); // ShelfLink and VerifyMark
    for (const init of shelfCalls) { expect(init.headers["x-workspace"]).toBe(workspaceId()); expect(init.credentials).toBe("omit"); }
  });

  it("shows nothing when the lab is opened on its own port (its /api/shelf has no demos) or the shelf has no mark for it", async () => {
    for (const payload of [{ shelfUrl: "http://shelf.example" }, { shelfUrl: "http://shelf.example", demos: [{ id: "mcp-skills-lab", verification: null }] }, { shelfUrl: "http://shelf.example", demos: [{ id: "mcp-skills-lab", verification: mark("none", "") }] }]) {
      withShelf(payload);
      const { container, unmount } = render(<App />);
      const bar = within(await screen.findByTestId("top-menu"));
      expect(await bar.findByRole("link", { name: "Shelf" })).toBeInTheDocument(); // the shelf answered, and still no badge
      expect(container.querySelector(".verify")).toBeNull();
      unmount();
    }
  });

  it("App.jsx renders the badge with this lab's shelf id (removing the line fails the first test above)", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src", "App.jsx"), "utf8");
    expect(src.match(/<VerifyMark\b/g)).toHaveLength(1);
    expect(src).toContain('<VerifyMark id="mcp-skills-lab"');
    const shelf = JSON.parse(fs.readFileSync(path.join(process.cwd(), "..", "docs", "shelf-entry.json"), "utf8"));
    expect(shelf.demos.map((d) => d.id)).toContain("mcp-skills-lab");
  });
});
