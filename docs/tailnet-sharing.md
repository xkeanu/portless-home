# One portless-home directory across tailnets

Research for [#13](https://github.com/xkeanu/portless-home/issues/13),
dated 2026-09-26. Scope: documentation research only; no live
tailnet or browser testing was performed. Tailscale behavior below is sourced
from current official documentation. Statements marked **Inference** combine
that documentation with the current repository implementation.

## Short answer

One installed `portless-home` instance belongs to whichever tailnet is active
on its host. It cannot be simultaneously reachable through two ordinary
tailnets by switching accounts: Tailscale permits one active client account and
does not transmit on multiple tailnets at once. [Fast user
switching](https://tailscale.com/docs/features/client/fast-user-switching)

It can be *accessed* from outside its owner tailnet by sharing that host with
individual external Tailscale users, subject to the owner tailnet's policy; or,
for a trusted multi-tailnet organization, by the alpha declarative node-sharing
feature. Funnel can make it public, which needs application-level protection.
Other public reverse proxies are outside this research. Sources and constraints
are in the matrix below.

**Inference:** one directory can aggregate peers from different tailnets if
sharing makes each peer reachable to the directory host. Account switching does
not provide that connectivity. Browser access to each linked app must be granted
separately; this topology has not been tested here.

## Current product boundary (repository observation)

[server.mjs](../server.mjs) listens only on `127.0.0.1`;
[installation](../install.sh) exposes it through
`tailscale serve --https=443`. The directory reads its own routes and asks
configured peers server-to-server for `GET /api/routes`. Browser card links go
directly to each app's Tailscale URL. `/api/routes` contains only the local
machine's routes, and peer cards are read-only.

There is no application authentication, requester-aware peer filtering, or
per-viewer filtering in `server.mjs`/`peers.mjs`; `/rename` and `/layout` rely
on network reachability. [fetchPeer()](../peers.mjs) sends only an `Accept` header, so it
does not forward the browser viewer's identity to peer instances. **Inference:**
every principal allowed to reach this Serve endpoint can read the complete
rendered directory and its available peer summaries, even where that viewer
cannot open a displayed peer-app link directly, and can invoke those local write
endpoints. Tailscale Serve does forward authenticated identity headers for
tailnet traffic, including accepted node shares, but this implementation does
not inspect them. [Serve identity
headers](https://tailscale.com/docs/features/tailscale-serve#identity-headers)

## Decision matrix

| Need | Feasible route | What it means for this directory | Limits / caveats |
| --- | --- | --- | --- |
| Several people/devices in one tailnet | Keep one owner tailnet; use groups/tags and grants to allow TCP 443 and required app ports. | Matches the existing Serve address and peer model. | Policy must cover the directory and each linked app port. Audit existing broad permissions before adding narrower rules: grants are additive. [Grant syntax](https://tailscale.com/docs/reference/syntax/grants) |
| Give a person on another tailnet access to one host | Link/email node sharing from the host tailnet. | The recipient can reach the shared host and its Serve directory. App links on that host require permission for their ports; links to other peer hosts require separate access. | Per-user scope; port permissions and recipient identity restrictions apply. [Node sharing](https://tailscale.com/docs/features/sharing) |
| Ongoing access between two trusted organizations/tailnets | Declarative node sharing, if accepted into its alpha. | Potential policy-managed cross-tailnet resource access; consider it only after defining directory/app authorization. | Double opt-in; alpha/waitlisted; currently up to 3 external tailnets and each involved tailnet must stay below 100 nodes. [Declarative node sharing](https://tailscale.com/docs/features/declarative-node-sharing) |
| Same computer, alternate personal/work tailnets at different times | Fast user switching. | The directory's active Serve URL and reachable peers change with the active account/tailnet. | It is not a multi-tailnet directory: one active account and no simultaneous packet transmission. [Fast user switching](https://tailscale.com/docs/features/client/fast-user-switching) |
| Same computer, simultaneous independent network contexts | Not provided by the normal client/account model. | Do not promise a single process or one `peers.json` spans tailnets. **Inference:** separate hosts/isolated Tailscale instances might be an operational experiment, but are outside documented normal-client behavior and untested here. | Requires a separately designed, tested deployment and clear state/port ownership; no recommendation from this research. |
| Visitors without Tailscale | Tailscale Funnel. | Makes the directory internet reachable via a Funnel URL. | Funnel is beta, needs HTTPS and a permitted Funnel node attribute; Funnel requests carry no Tailscale identity headers. Existing unauthenticated read/write routes make it unsuitable without product changes. [Funnel](https://tailscale.com/docs/features/tailscale-funnel) [Serve/Funnel identity distinction](https://tailscale.com/docs/features/tailscale-serve#identity-headers) |

## Operational facts that affect the choice

- Serve routes tailnet devices to a local service and applies tailnet access
  control rules. It needs HTTPS certificates enabled. [Tailscale
  Serve](https://tailscale.com/docs/features/tailscale-serve)
- A shared machine is visible only to the invited user, not the recipient's
  whole tailnet. The owner tailnet's policy can further limit that user's
  access, including via `autogroup:shared`; tags do not carry across. [Sharing and access-control
  policies](https://tailscale.com/docs/features/sharing#sharing-and-access-control-policies)
- Individual shares cannot be accessed from tagged devices in the recipient
  tailnet. A tagged directory host therefore cannot fetch those shared peers.
  Use full MagicDNS names, not short hostnames. [Sharing
  restrictions](https://tailscale.com/docs/features/sharing)
- Sharing the directory host does not itself grant the recipient network access
  to its other peers. **Inference:** the host server can still fetch any peers
  it is authorized to reach and display their snapshots; a shared viewer can
  therefore receive peer metadata even when their browser cannot follow those
  peer-app links. Sharing expands directory visibility, not transitively the
  recipient's peer connectivity, unless application filtering is added.
- A shared host cannot normally initiate connections into the recipient's
  tailnet because of quarantine. This does not prevent the recipient from
  opening the shared host's directory, but it makes a cross-tailnet peer graph
  unsuitable to assume without a manual test. [Node sharing
  quarantine](https://tailscale.com/docs/features/sharing#quarantine)
- Grants can limit network access by protocol/port, but application capabilities
  take effect only when the application implements them. **Inference:** grants
  alone cannot create per-viewer directory visibility with this code. [Grant
  limitations](https://tailscale.com/docs/features/access-control/grants#limitations-and-considerations)
- Serve may supply `Tailscale-User-Login` and related headers, and removes
  incoming spoofed versions before proxying; the backend should remain
  loopback-only when it trusts them. Tagged callers have no user identity
  headers. [Serve identity
  headers](https://tailscale.com/docs/features/tailscale-serve#identity-headers)
- Funnel accepts only ports 443, 8443, and 10000. Enabling it on a Serve port
  makes that port public. **Inference:** publishing the directory does not
  publish its linked apps; this project's 8444-and-up links cannot all become
  Funnel endpoints without changing their URLs or routing. [Funnel
  limits](https://tailscale.com/docs/features/tailscale-funnel#requirements-and-limitations)

## Product decisions still required

1. Is the intended model a private directory for one tailnet, a host shared to
   named external users, or organization-to-organization access? These have
   different access policies and support requirements.
2. If any external viewer can reach the directory, which peer sections and app
   URLs may they see? The existing aggregate peer fetch cannot answer that.
3. Should viewers be read-only? If yes, add an authorization rule before
   recommending node sharing or Funnel; current `POST /rename` and `/layout`
   are network-authorized only.
4. Is public access actually needed? If yes, define real application auth and
   CSRF/write policy before Funnel; Tailnet identity is unavailable there.

## Compact manual verification checklist

Run this only in a disposable/non-sensitive test setup; it is a checklist, not
evidence that the proposed configuration works.

1. Create two test tailnets and one directory host; confirm the host's
   `tailscale serve status` and its loopback process are healthy.
2. In the owner policy, permit a test user only TCP 443, then test the directory
   URL and each expected app port from an owner-tailnet client.
3. Share the host to a test external user; accept the invite; use the host's
   full `<host>.<owner-tailnet>.ts.net` name and test permitted/denied ports.
4. Confirm the external user sees no unintended peer summaries or app links,
   and verify whether `POST /rename` and `POST /layout` are acceptable.
5. Switch the host to a second saved account and confirm the first directory
   URL/peer set is no longer assumed reachable; switch back and recheck.
6. If evaluating declarative sharing, validate both policies, limits, and
   revocation with two test tailnets before relying on alpha behavior.
7. If evaluating Funnel, verify unauthenticated public read and write behavior
   explicitly; do not expose real project routes until application auth exists.

## Recommendation for this issue

Keep the current deployment model. Treat individual sharing as an option for
trusted viewers who may see the full inventory and modify local names/pins.
Design viewer authorization before offering isolated organization views or
public access. These are follow-up product decisions, not implementation work
or acceptance requirements for this research issue.
