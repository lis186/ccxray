# Reason loop lineage — ccxray auth design

| Phase | Artifact | Cold-start context | Outcome |
|---|---|---|---|
| 1 Setup | `task.md` | — | Brief written: convergent, 3 judges, iterations cap 3, 6-threat model |
| 2 Generate-A | `candidate-A.md` (420 lines) | task brief only | Stance: bearer-for-machines + HttpOnly cookie via `/_auth?token=` + Origin/Host pinning |
| 3 Critic | `critique-A.md` | candidate A only | 4 FATAL, 4 MAJOR, 2 MINOR; verdict: CSRF/rebind collapses on upstream-proxy + cookie lifetime contradicted by hub idle |
| 4 Generate-B | `candidate-B.md` (703 lines) | task + A + critique | Departs structurally: path-segregated domains, stateless HMAC cookies via HKDF, fragment bootstrap, Unix-socket hub IPC, `X-Ccxray-Auth` for upstream |
| 5 Synthesize-AB | `candidate-AB.md` (658 lines) | task + A + B (no critique) | Takes B's structural separation + HKDF cookies + fragment bootstrap; keeps A's permanent `Authorization: Bearer` on dashboard for CLI back-compat; explicit two-domain asymmetric resolution |
| 6 Judge (blind, X=AB Y=A Z=B) | `judge-transcripts.md` | task + 3 candidates, no provenance | 3–0 for X (AB synthesis). All judges flagged Y's in-memory session set + hub idle incompatibility; all flagged Z's CLI ergonomics regression as a real but lesser cost. |

## Convergence status

- Iterations cap: 3
- Convergence rule: 3 consecutive wins for same approach
- Rounds completed: 1
- Round 1 winner: AB (synthesis), unanimous (3–0)
- Convergence: **not yet reached** — only 1 round; needs 3 consecutive synthesis wins

## Recommendation

The Round 1 sweep is a strong signal, but the convergence rule is not satisfied. Two paths forward:

1. **Continue to Round 2:** Treat AB as incumbent, run Critic-on-AB → Generate-C → Synthesize-AB+C → blind judges. If AB-line wins again, continue Round 3 for full convergence.
2. **Stop here and implement AB:** The 3–0 sweep with concrete, non-correlated rationales from three different judge personas (architect / threat auditor / ops) is materially stronger evidence than a contested vote across more rounds would be. AB's design space is also already well-explored — A and B span the two natural extremes (in-memory session vs stateless HMAC; query-string vs fragment bootstrap; single-classifier vs path-segregated domains). Round 2 risks chasing diminishing returns.

User decision pending.
