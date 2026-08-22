# OrbitIQ witness log

One line per hourly observation of the public archive-verification
endpoint, recorded by a GitHub Actions run.

Each line carries the archive tip hash as reported by
`https://orbit.mnbresearch.com/api/archive/verify`, plus the id and URL
of the Actions run that observed it. Those runs are timestamped by
GitHub and their logs cannot be edited after the fact by the repository
owner, which is what makes this an external record rather than a
self-attestation.

This branch is append-only by policy: commits have real parents, so a
rewrite is visible in the commit graph. The `data-backup` branch is
force-pushed flat by design and is NOT evidence — do not confuse them.

**Scope of the claim.** This shows a given hash was publicly visible at
a given time, with GitHub as the notary. It is not a signature, does
not attest authorship, and is exactly as trustworthy as GitHub's
timestamps.
