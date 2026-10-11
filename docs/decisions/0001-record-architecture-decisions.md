# 1. Record architecture decisions

Date: 2026-10-11

## Status

Accepted

## Context

DESIGN.md is the source of truth for Storbild's architecture and scope. Implementation will
refine it: details it leaves open get decided, and some of its choices will turn out to need
changing. Much of the work is done by coding agents, which start without memory of earlier
discussions. Without a record, the reasons behind a decision get lost, and later work either
repeats the discussion or quietly undoes the decision.

## Decision

We record every decision that changes or refines DESIGN.md as an Architecture Decision Record
in `docs/decisions/NNNN-title.md`, numbered sequentially, using Michael Nygard's format:
title, date, status, context, decision, consequences.

In the same change, DESIGN.md is updated to match, so it stays the single current description
of the system. ADRs explain *why* it reads the way it does.

An ADR that is replaced is not deleted. Its status becomes "Superseded by NNNN".

## Consequences

- Contributors and agents can find the reasoning behind a design choice without asking.
- Small refinements still cost an ADR. Keep them short; a few paragraphs is enough.
- DESIGN.md and the ADRs must be kept consistent. Reviews should check both.
