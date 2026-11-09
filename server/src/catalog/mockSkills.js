// Synthetic skills for Mock mode. Generic, customer-neutral text written for this lab only; nothing is copied from any other project.
// Keys are paths under the skills root: <skill-name>/SKILL.md, <skill-name>/references/..., <skill-name>/scripts/...
// Scripts are inert text. Nothing in this app ever executes a skill file.
export const MOCK_PREFIX = 'demo';

export const MOCK_FILES = {
  // Tiny: one file.
  'meeting-notes/SKILL.md': `---
name: meeting-notes
description: Turn rough meeting notes into a short summary with decisions and action items.
---
# Meeting notes

Read the notes the user pasted. Write three sections: Summary (3 lines at most), Decisions, Action items (owner and date when given).
Do not invent names or dates.
`,

  // With references/: loaded only when a task needs them.
  'release-checklist/SKILL.md': `---
name: release-checklist
description: Walk a release through a pre-flight checklist and a rollback plan. Use when the user asks to prepare or review a release.
license: MIT
metadata:
  version: "1.0"
  audience: engineering
---
# Release checklist

1. Read references/CHECKLIST.md and confirm each item with the user.
2. Read references/ROLLBACK.md and make sure a rollback owner is named.
3. Write the result as a table: item, status, owner.

Terms are in references/GLOSSARY.md.
`,
  'release-checklist/references/CHECKLIST.md': `# Pre-flight checklist

- [ ] Change list reviewed
- [ ] Tests green on the release commit
- [ ] Migration dry run done
- [ ] Monitoring dashboards open
- [ ] Support team told
`,
  'release-checklist/references/ROLLBACK.md': `# Rollback plan

Name one rollback owner. Decide the signal that triggers a rollback (error rate, latency, a failed smoke check) before the release starts.
Keep the previous artifact available until the release is declared stable.
`,
  'release-checklist/references/GLOSSARY.md': `# Glossary

- Smoke check: a short test of the most important path.
- Rollback: returning to the previous version.
`,

  // With scripts/: shows files that a host must never run without per-skill approval.
  'log-summarizer/SKILL.md': `---
name: log-summarizer
description: Summarise an application log file into error groups. Includes a helper script that counts lines by level.
compatibility: Needs a shell with awk.
---
# Log summarizer

Ask the user for the log text. Group errors by message. The helper script scripts/count-levels.sh counts lines per level;
it only prints counts. A host must ask the user before running any script from this skill.
`,
  'log-summarizer/scripts/count-levels.sh': `#!/bin/sh
# Counts lines per level (INFO, WARN, ERROR) in the file given as $1. Prints counts only.
awk '/ERROR/{e++} /WARN/{w++} /INFO/{i++} END{print "INFO", i+0; print "WARN", w+0; print "ERROR", e+0}' "$1"
`,

  // Nested folder: exercises resources/directory/read below the first level.
  'style-guide/SKILL.md': `---
name: style-guide
description: Apply a plain-language writing style to a draft. Use for emails, release notes and short documents.
---
# Style guide

Prefer short sentences and concrete words. See references/examples/ for before and after samples.
`,
  'style-guide/references/examples/email.md': `# Email

Before: We are writing to inform you that the maintenance window has been rescheduled.
After: The maintenance window moved to Friday.
`,
  'style-guide/references/examples/release-note.md': `# Release note

Before: Various improvements were made.
After: Search results now load in half the time.
`,
};
