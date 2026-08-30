# portless-home

Read CONTRIBUTING.md before changing code — it defines the design principles (zero dependencies, single-file server, pure functions, escape everything user-influenced).

## Branch names (enforced by GitHub at push, no bypass)

Name every branch `type/short-kebab-description`, optional issue number first: `feature/12-linux-systemd`, `fix/dead-pid-filter`. Allowed types: `feature/`, `fix/`, `docs/`, `chore/`, `ci/`. Pushing any other name (including `feat/*`) fails with GH013 after the work is already committed — pick the name correctly before starting.
