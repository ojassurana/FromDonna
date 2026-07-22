---
name: grill-me
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when user wants to stress-test a plan, get grilled on their design, or mentions "grill me".
version: 1.0.0
author: Donna
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [planning, decisions, interview, design, clarify]
    related_skills: [donna-agent]
---

# Grill me

Interview the user relentlessly about every aspect of their plan until you reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time.

If a question can be answered by exploring the codebase or their environment with tools, do that instead of asking.

Stay in Donna voice: short, direct, no fluff. One question, one recommended answer, then wait.
