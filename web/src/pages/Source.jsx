import { useEffect, useState } from "react";
import Chip from "../components/Chip.jsx";
import Kv from "../components/Kv.jsx";
import { getCatalog } from "../api.js";

const OVERRIDE = (path) => `# docker-compose.override.yml, next to docker-compose.yml. The folder is mounted read-only and never copied.
services:
  mcp-skills-lab:
    environment:
      SKILLS_DIR: /skills
    volumes:
      - ${path}:/skills:ro`;
const MOUNTS = [
  ["AI-DEMO2 claudSkills/pingone", "<path-to>/claudSkills/pingone", "A folder of skill folders, each with a SKILL.md. Replace <path-to> with where your checkout of that folder lives. It is mounted read-only; nothing from it is copied into this repository."],
  ["~/.claude/skills", "~/.claude/skills", "Your own Claude skills. Many of them are symlinks, and Real mode never follows a symlink, so those are listed below as refused."],
];

export default function Source({ info, dataKey, resetKey }) {
  const [cat, setCat] = useState(null);
  useEffect(() => { setCat(null); getCatalog().then(setCat).catch(() => {}); }, [dataKey, resetKey]);
  const real = info?.source === "real";
  return (
    <>
      <div className="page-head"><h1>Source: Mock or Real</h1></div>
      <p className="muted">The Mock / Real toggle in the header switches the whole lab without a restart. Mock serves four synthetic skills written for this lab. Real serves the folder in <code>SKILLS_DIR</code>.</p>
      <div className="card-grid">
        <div className="card">
          <h3>Now</h3>
          <Kv rows={[
            ["Source", <Chip key="s" tone={real ? "info" : "ok"} testid="source-now">{info?.source ?? "..."}</Chip>],
            ["Real available", <Chip key="a" tone={info?.realAvailable ? "ok" : "warn"} testid="real-available">{info ? (info.realAvailable ? "yes" : "no") : "..."}</Chip>],
            ["SKILLS_DIR", <span key="d" data-testid="skills-dir">{info?.realAvailable ? `readable (folder "${info.directory}")` : info?.realReason ?? "..."}</span>],
            ["Skills served", String(info?.skillCount ?? "...")],
            ["Catalog problems", String(info?.problemCount ?? "...")],
          ]} />
        </div>
        <div className="card card--neutral">
          <h3>Limits Real mode applies</h3>
          <p>Symlinks are never followed. A skill over 512 files or 16 MiB is refused. A SKILL.md that is not UTF-8, or whose <code>name</code> differs from its folder, is skipped. Each is listed below as a catalog problem, never a crash.</p>
        </div>
      </div>
      <h2>Catalog problems <Chip tone={cat?.problems?.length ? "warn" : "ok"} testid="problem-count">{cat ? cat.problems.length : "..."}</Chip></h2>
      {cat && cat.problems.length === 0 && <p className="muted" data-testid="no-problems">{real ? "No problems: every skill in the folder loaded." : "Mock has no problems to report. Switch to Real to see what the mounted folder produces."}</p>}
      {cat && cat.problems.length > 0 && (
        <ul className="findings" data-testid="problems">{cat.problems.map((p, i) => <li key={i}><Chip tone={p.level === "info" ? "info" : p.level === "refused" ? "danger" : "warn"}>{p.level}</Chip> <code>{p.path}</code> <span className="muted">{p.message}</span></li>)}</ul>
      )}
      <h2>Mount a folder (read-only)</h2>
      <p className="muted">Real needs a folder mounted into the container and <code>SKILLS_DIR</code> pointing at it. Create the override file, then run <code>docker compose up -d</code>. Two examples:</p>
      <div className="card-grid">
        {MOUNTS.map(([title, path, note]) => (
          <div className="card card--neutral" key={title} data-testid="mount-example">
            <h3>{title}</h3>
            <p>{note}</p>
            <pre className="code">{OVERRIDE(path)}</pre>
          </div>
        ))}
      </div>
      {cat && (
        <>
          <h2>Skills served right now</h2>
          <ul className="findings" data-testid="catalog-skills">{cat.skills.map((s) => <li key={s.uri}><code>{s.uri}</code> <span className="muted">{s.frontmatter.description}</span></li>)}</ul>
        </>
      )}
    </>
  );
}
