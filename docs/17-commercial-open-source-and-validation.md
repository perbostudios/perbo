# Open source and the commercial product

## The line

Everything that runs on one machine is open source. Anything hosted or shared across people is the commercial control plane ([D-075](11-open-decisions.md), [ADR-0032](adr/0032-open-source-the-local-cli-and-the-reviewer.md)). The test for any component is one question: does it remember beyond one machine?

- **Open:**
  - the desktop and every CLI command;
  - the packages: contracts, review with its prompts, workspace, runner, planning and ui;
  - the evaluation harness and scorer;
  - the queue and its endpoint, `perbo agent` and `perbo interview`;
  - once built, phone pairing over the local network.
- **Commercial:** the control plane ([D-016](11-open-decisions.md)).

`tooling/package` builds the release tarball, which carries everything above ([D-075](11-open-decisions.md)).

## Licences

- **Code:** Apache-2.0. A contribution is under the same licence, and there is no contributor licence agreement.
- **The corpus, `plantedbugs`:** the fixture format under Apache-2.0 and the fixtures under CC-BY-4.0. Every fixture is public from the release.
- **Code from other projects** is never copied without reviewing its licence first. Paseo's design is followed, and its code is not copied ([D-102](11-open-decisions.md)). Vendored code keeps its licence and a pinned source.
- **Trademarks and patents:** Apache-2.0's own terms and nothing beyond them. It grants no trademark rights and carries its own patent licence. The Perbo name, logo and artwork are not licensed under Apache-2.0; `NOTICE` says which files ([D-112](11-open-decisions.md)).
- **Still open before the release:** a hosted-service policy and a dependency policy.

This document is product architecture, not legal advice.

## The release

Perbo is developed in `perbostudios/perbo` ([D-076](11-open-decisions.md)) and released from it.

A release will carry a `SHA256SUMS` file, its detached signature, a build provenance attestation and an SBOM, and the desktop will update itself to one whose signature checks ([D-046](11-open-decisions.md)); none of it is built yet. The product-regulation artefacts come with the first binary release ([D-048](11-open-decisions.md)).

## The control plane

It starts with team memory: history across people and machines, a shared queue and board, calibration learned from verdicts, SSO, audit and retention. Operating modules come after, each chosen by paying users before it is built ([D-016](11-open-decisions.md)). Nothing learns from private content without opt-in ([D-030](11-open-decisions.md)).

Its design is recorded, decided and not built, and stays private ([D-076](11-open-decisions.md)).

## Partners

Design partners are chosen by behaviour ([D-002](11-open-decisions.md)). Before a partner's first ticket, four things are in place ([D-084](11-open-decisions.md)):
- the rename;
- their baseline, captured first ([D-038](11-open-decisions.md));
- an installable build;
- the disclosure and the one-page agreement ([D-047](11-open-decisions.md)).

## Evidence

Perbo is judged by real use ([D-099](11-open-decisions.md)):
- `perbo stops` reads precision of stopping live ([D-060](11-open-decisions.md));
- `perbo escapes` reads what merged and was later undone;
- the share of tickets merged unattended is read from the records.

A change to the reviewer carries a regression-suite run ([D-010](11-open-decisions.md)).
