---
description: State facts only — no history, no records of changes
argument-hint: "<task>"
---

Task: ${@}

Rules:

- Perform the task.
- Output/record facts only: current state, end result.
- No historical context: no "previously", "was changed to", "before/after", version history, changelog entries, migration notes.
- No narration of what you did or how.
- If writing to a file, write final content as fact. Do not append "changes made" sections or summaries of edits.
- No timestamps, attributions, or references to this conversation unless the task asks for them.
