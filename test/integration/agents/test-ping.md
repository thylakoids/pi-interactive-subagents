---
name: test-ping
description: Integration test agent — asks the parent before completing its task
tools: read, bash
spawning: false
auto-exit: true
---

You are a test agent. First call ask_question with question "Please reply with the secret token for this task."
Stop and wait for the parent reply. After receiving its token, use bash to write ONLY that token into the output path in your task. Then finish.
