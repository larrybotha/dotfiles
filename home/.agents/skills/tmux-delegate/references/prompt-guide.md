# Prompt Guide

## Writing good task prompts

### Do

- Be specific about what files to write
- Include context the delegated pi needs (file paths, patterns, constraints)
- Tell it to exit when done

```
task="Read src/auth.py and refactor all callback-based functions to async/await.
Write the refactored code back to src/auth.py.
Write a summary of changes to /tmp/auth-refactor-summary.txt.
Exit when done."
```

### Don't

- Vague instructions with no expected output
- Tasks that require interactive decision-making
- "Figure it out" without specifying deliverables
