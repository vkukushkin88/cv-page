# The Scheduling Problem: A Technical Deep Dive, and Where Agentic AI Actually Fits

This is a technical breakdown of a real scheduling system we build: one that jointly assigns aircraft and crews to flights. It's written problem-by-problem, with the math, the search algorithm, a worked toy example, a comparison of the realistic alternative approaches, and — since every roadmap conversation eventually asks — a concrete look at where agentic AI (LLM agents) genuinely helps versus where it doesn't. No customer names, no product names; just the problem and the engineering.

## Problem: what are we actually scheduling?

We're solving three classical operations-research problems at the same time, not one:

**Aircraft routing** — which aircraft flies which flight leg. A vehicle-routing problem.
**Crew pairing** — which pilots fly which chain of duties. Airlines run entire departments on this alone.
**Crew rostering** — multi-day duty-time, rest, and work-life-balance limits layered on top of the pairings.

Each of these has been studied individually as NP-hard since the 1960s–70s. We solve all three jointly, subject to dozens of discrete feasibility rules (duty time, minimum rest, aircraft-crew fit, pairing legality) and a set of weighted objective terms that encode what "good" means as a cost function. The stakes are not cosmetic: get this wrong and the failure mode isn't a UI bug, it's a pilot flying illegal duty hours.

## Problem: the search space is astronomically large

There are two independent ways this blows up, and it's worth stating both precisely because they compound.

**Ordering.** Once you know *which* flights a pilot or aircraft will fly, the order they're flown in still has to be decided, and valid orderings grow as `n!`. Ten events already gives 3,628,800 orderings. Twenty gives roughly 2.4×10¹⁸.

**Selection.** Independent yes/no decisions — assign this pairing or don't, use this connection or don't — grow as `2ⁿ`. Twenty independent binary choices is over a million combinations; a hundred is 1.3×10³⁰.

A real instance has well over a hundred interacting flights, pilots, and aircraft. Neither curve is something you out-hardware your way past — you need an algorithm that never actually visits most of that space.

## Solution: a mathematical model, not a heuristic

The system is a constraint solver (Google OR-Tools' CP-SAT), not a machine-learning model, and it does not guess. Below is a simplified version of the actual formulation — the real one has more index dimensions and roughly sixty feasibility rules, but this captures the structure.

**Sets**

```
F  = flight legs, each with origin o(f), destination d(f),
     departure dep(f), arrival arr(f)
A  = aircraft, each compatible with a subset of flights C(a, f) ∈ {0,1}
P  = pilots
τ  = minimum turn time between two flights on the same aircraft
R  = minimum rest time between two duties for the same pilot
D  = maximum duty length (hours)
```

**Decision variables**

```
x[f,a]     ∈ {0,1}   flight f is flown by aircraft a
z[f,f',a]  ∈ {0,1}   aircraft a flies f immediately before f'
y[f,p]     ∈ {0,1}   pilot p crews flight f
w[f,f',p]  ∈ {0,1}   pilot p flies f then f' within the same duty
```

**Constraints (hard)**

```
Coverage:     Σ_a x[f,a] = 1                     for every flight f
Type fit:     x[f,a] ≤ C(a,f)                     for every f, a
Continuity:   z[f,f',a] = 1  ⇒  d(f) = o(f')  and  dep(f') ≥ arr(f) + τ
Duty length:  Σ_{f in duty} dur(f) + sit-time ≤ D  for every duty chain
Rest:         start(next duty) − end(prior duty) ≥ R   for every pilot
```

**Objective (soft, weighted)**

```
minimize   Σ_i  w_i · penalty_i(schedule)
```

where the `penalty_i` terms cover things like deadhead cost, crew idle time, work-life-balance violations, and aircraft swaps — around eighteen independently tunable weights in the production model, because "optimal" is a design choice, not a fact.

In CP-SAT terms, the continuity constraints above are exactly what the `AddCircuit` / `AddMultipleCircuit` global constraint is built for — treat each aircraft's assigned flights plus a depot node as a graph, and let the solver find a circuit through it. Duty-time and rest constraints map onto `AddCumulative` and interval variables (`NewOptionalIntervalVar` + `AddNoOverlap`), which is what lets the solver reason about "a pilot is a resource with capacity 1 over time" natively instead of us hand-rolling that logic.

## Solution: how the solver actually searches

CP-SAT is a hybrid of SAT-style clause learning, linear-programming bounds, and constraint propagation, explored via branch-and-bound. The mechanism that matters most in practice is propagation: every time a variable is fixed, the solver immediately narrows the domains of everything connected to it, often eliminating whole branches before they're ever opened.

Here's a small, fully worked instance. Two aircraft, five flights, 45-minute minimum turn time:

```
F1  JFK→ORD  08:00–10:00
F2  ORD→JFK  11:00–13:00
F3  JFK→ATL  09:30–11:30
F4  ATL→ORD  12:30–14:00
F5  ORD→ATL  15:00–16:30
```

A flight `f` can feasibly precede flight `f'` on the same aircraft only if `d(f) = o(f')` and `dep(f') ≥ arr(f) + 45min`. Checking all pairs gives exactly four feasible connections: `F1→F2`, `F1→F5`, `F3→F4`, `F4→F5`. No other pair lines up in time and place. That's the entire "event-dependency graph" for this instance — a schedule is a path through it, not the whole thing.

Now watch the search. Say the solver branches first on `z[F1,F2]`, trying `true`:

1. `z[F1,F2] = 1` is fixed. Propagation immediately sets `z[F1,F5] = 0` — F1 can only feed into one next flight, and that slot is taken.
2. `F3` has no feasible incoming edge in this graph, so it must start a chain on its own. Its only outgoing option is `F4`, so `z[F3,F4]` gets forced to `1` by propagation, not by branching.
3. `F5` now has exactly one remaining feasible predecessor left (`F1` is excluded, so it must be `F4`), so `z[F4,F5] = 1` is also forced.

Every remaining decision fell out of propagation — the solver found `{F1→F2}` and `{F3→F4→F5}`, exactly two chains for exactly two aircraft, with zero backtracking. Now consider the branch the solver *didn't* take: `z[F1,F2] = 0`. That forces `F2` to become its own standalone chain (nothing else can reach it), which combined with the rest of the graph requires three separate aircraft routes to cover five flights — but only two aircraft exist. A global cardinality check (path count ≤ available aircraft) catches that immediately and the branch is pruned without ever assigning another variable. That's the entire reason a search over a space of billions of theoretical combinations resolves in milliseconds for an instance this size, and in minutes for a real one: constraint propagation prunes the graph before the solver ever walks it.

The solver terminates in one of two states, and both are reported honestly: `OPTIMAL` means branch-and-bound exhausted the tree and proved nothing scores better; `FEASIBLE` means it hit a time cap first and is returning the best schedule found, with a computable (if not always surfaced) bound on how far that could still be from optimal.

## Problem: the schedule isn't stable across runs

Re-run the exact same instance twice and you can get two different — but equally valid — schedules. This surprises people the first time it happens, and it's a real operational cost: a dispatcher who published a schedule doesn't want it silently reshuffled overnight because a re-run happened to explore the tree in a different order.

There are three independent causes. First, **symmetry** — if two pilots are interchangeable for a given duty, swapping them produces a different assignment with an identical objective value, and the solver has no reason to prefer one over the other. Second, **portfolio search** — CP-SAT by default runs several search strategies in parallel across worker threads and returns whichever finds the best result first; which one wins is a function of thread scheduling, not just the model. Third, **time-limited runs** — if the solver is cut off before proving optimality, the `FEASIBLE` solution it happens to be holding at that moment depends on the exact path the search took, which can vary run to run even with identical input.

**Fixes, in order of how much they cost:**

Determinism knobs — pin `num_search_workers = 1` and a fixed `random_seed`. This alone removes thread-scheduling nondeterminism, at the cost of losing the speed benefit of parallel search.

Symmetry-breaking constraints — add a cheap tie-breaking rule (e.g., among interchangeable pilots, prefer the lower ID) so the solver converges on one canonical member of each equivalence class instead of an arbitrary one.

Warm-starting — feed the previous run's solution in via `AddHint`, biasing the search toward reproducing it rather than discovering an equally-good alternative from scratch.

Make stability an explicit objective term, rather than an accident. If `y*[f,p]` is last run's assignment, add:

```
minimize  Σ_i w_i · penalty_i(schedule)  +  λ · Σ_{f,p} |y[f,p] − y*[f,p]|
```

which linearizes cleanly for binaries (penalize `1 − y[f,p]` where `y*[f,p]=1`, and `y[f,p]` where `y*[f,p]=0`). This is the honest fix: it converts "the schedule happened not to change" from a coincidence of search order into a tunable, visible trade-off against pure optimality — you're explicitly telling the solver that a schedule close to what's already published is worth something, and saying how much.

## Deep dive: comparing the realistic alternatives

CP-SAT isn't the only way to attack this class of problem, and it's worth being explicit about what the alternatives actually trade away.

| Approach | Mechanism | Optimality guarantee | Determinism | Where it actually fits |
|---|---|---|---|---|
| Exact CP / MILP (what we use) | Branch-and-bound + constraint propagation / cutting planes | Proven optimal, or a computable gap | Yes, if single-threaded with a fixed seed | Correctness-critical, moderate scale, when a certificate matters |
| Column generation / branch-and-price | Generates candidate duty "columns" via a pricing subproblem instead of enumerating all pairings upfront | Proven optimal in principle; run to a practical gap at scale | Usually yes | Massive-scale crew pairing (thousands of pilots) — the actual industry-standard approach at major-airline scale, at the cost of being close to its own research project to implement well |
| Metaheuristics (genetic algorithms, simulated annealing, large neighborhood search) | Start from a feasible schedule, repeatedly perturb and accept improving moves | None — no certificate, no bound | No, even with a fixed seed in practice | When "good fast" beats "provably optimal," or the constraints are too messy to formulate cleanly. (LNS is, notably, also one of CP-SAT's own internal portfolio strategies for large instances.) |
| Constructive / greedy heuristics | One-pass rule, e.g. "assign the next available resource" | None, often far from optimal | Yes | Operations with almost no combinatorial freedom left, where a human already gets the answer right by inspection — using anything heavier here is pure overhead |
| Reinforcement learning | Learn an assignment policy from a reward signal | None | Deterministic at inference, unstable to train | Research-stage for this problem class; promising for narrow, fixed rule sets, not something to trust for duty-time correctness today |
| LLM / agentic | Next-token generation, optionally with tool calls | None — cannot verify its own output against the rule set | No, even at temperature zero, because there's no search process at all | Front-end and scaffolding around the solver — the subject of the next section |

The pattern across every non-exact row is the same: you gain scale or flexibility by giving up the certificate. Column generation is the only approach on this list that both scales past what plain CP-SAT/MILP can handle *and* keeps an optimality proof — which is also why it's a much bigger engineering investment than a single monolithic model.

## Problem: can an agent just generate the schedule?

Verifying a completed schedule against the constraint set is cheap. Finding one from a space of `2ⁿ` or `n!` candidates is expensive. That asymmetry between cheap-to-verify and expensive-to-find is the informal definition of NP-hard, and it's exactly the shape of this problem. An LLM has no search process behind its output — it can produce a schedule that reads perfectly plausible and still double-books a pilot, and it has no built-in mechanism to check that against dozens of simultaneous hard rules, let alone search toward a fix when a check fails. Bolting a verifier on top just re-derives the validator layer the solver already has, minus the ability to improve toward a corrected answer.

## Solution: use agents at the edges, where verification is cheap and the stakes are lower

The honest role for agentic AI here is not "replace the solver," it's "make small, checkable pieces of this workflow faster." Three concrete examples, using the same five-flight toy instance from earlier.

**a) Generating a flight-connection graph for a small instance.** This is pure enumeration of feasible pairs, not optimization — cheap to verify, so an agent is a reasonable fit for producing it quickly, e.g. for documentation, test fixtures, or training material.

```
Prompt:
"Given this list of flights (origin, destination, scheduled departure,
scheduled arrival) and a minimum turn time of 45 minutes, output a
directed graph as JSON. Nodes are flights. Add edge A→B only if the
same aircraft could feasibly fly B immediately after A: same airport,
and dep(B) ≥ arr(A) + turn time. Do not choose a routing — enumerate
every feasible connection, nothing else."

Flights:
F1 JFK→ORD 08:00–10:00   F2 ORD→JFK 11:00–13:00
F3 JFK→ATL 09:30–11:30   F4 ATL→ORD 12:30–14:00
F5 ORD→ATL 15:00–16:30
```

```json
{
  "nodes": ["F1", "F2", "F3", "F4", "F5"],
  "edges": [
    {"from": "F1", "to": "F2"},
    {"from": "F1", "to": "F5"},
    {"from": "F3", "to": "F4"},
    {"from": "F4", "to": "F5"}
  ]
}
```

That output is trivial for a human to check by hand against the four rules above — which is exactly why it's a safe task to hand to an agent.

**b) Drafting candidate crew pairings from a chosen routing.** Once an actual routing is picked — say, aircraft 1 flies `F1→F2` and aircraft 2 flies `F3→F4→F5` — an agent can draft candidate duty chains and compute their block time and duty span, flagging anything that looks like it needs a closer look:

```
Prompt:
"Given these two aircraft routes and a max duty length of 10 hours,
propose one crew duty per route. For each duty, report total block
time, duty span (report-in to release), and whether the duty ends
at the crew's base (JFK) or away from it."
```

```
Duty 1 (aircraft 1, route F1→F2): block time 4h00m, span 08:00–13:00,
  ends at JFK (base) — no relocation needed.
Duty 2 (aircraft 2, route F3→F4→F5): block time 5h00m, span 09:30–16:30,
  ends at ATL — away from base, relocation required before next duty.
```

Duty 2 ending away from base is a real, common situation, and exactly the reason for the third prompt.

**c) Checking relocation options against rest rules.** This is the case where an agent is most useful precisely *because* it's checking arithmetic against a hard constraint, not inventing a schedule:

```
Prompt:
"Pilot's duty just ended at ATL at 16:30. Their next duty starts at
JFK at 07:00 the next day. Minimum rest is 10 hours. Evaluate these
two relocation options and flag any that violate minimum rest:
(1) deadhead flight ATL→JFK departing 18:00, arriving 20:00.
(2) drive ATL→JFK, approximately 10.5 hours, departing right after
    the duty ends at 17:00."
```

```
Option 1 (deadhead): arrives 20:00, rest before 07:00 report = 11h00m.
  Meets 10h minimum. FEASIBLE.
Option 2 (drive): arrives approx. 03:30, rest before 07:00 report = 3h30m.
  Violates 10h minimum rest. NOT FEASIBLE — do not offer this option.
```

That's the pattern worth generalizing: every one of these three prompts asks the agent to produce something a human (or the actual validator layer) can check in seconds, never to search the combinatorial space or commit to a final production schedule. The moment a prompt asks an agent to *choose* the optimal routing or *guarantee* legality across a full multi-day roster, it's back on the wrong side of the verify/search asymmetry — and that's where the certificate-carrying solver still has to do the work.

## Bottom line

This is a decades-old, well-studied class of NP-hard problem, and the honest solution to it is still a constraint solver with a provable (or boundable) answer — not a heuristic, not a learned policy, and not a language model. Agentic AI's genuine, defensible role is narrow and sits around that solver: generating small checkable structures, drafting candidates for a human or validator to confirm, and checking arithmetic against fixed rules. It's a smaller claim than "AI schedules your fleet," but it's the one that survives contact with a real duty-time rule and a real branch-and-bound tree.
