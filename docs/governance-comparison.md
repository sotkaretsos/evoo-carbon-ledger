# Comparison with a signed central log

The permissioned ledger is compared with a central log that uses the same authenticated actors, signed records, method manifests, calculation engine, authorization rules, append-only correction history, evidence stores and retention policies. The comparison is analytical and follows the threat categories of [NISTIR 8202](https://doi.org/10.6028/NIST.IR.8202), sections 3.5 and 7.1–7.8; it is summarized in Table 9 of the article.

| Threat or property | Signed central log | Permissioned ledger | Prototype control or test |
|---|---|---|---|
| A contributor submits false but correctly signed data | Attribution is retained; the claim can remain false. | Same as the central log. | Source classes, device signatures and policy checks attribute every record. |
| Signed content is altered after submission | A retained receipt or digest exposes the change. | Signature and digest checks expose the change. | The controlled experiment includes altered file bytes. |
| A correction leaves a stale carbon result | Dependency and version checks can invalidate the result. | The same rule is enforced by shared contract execution. | Revision and snapshot regression tests. |
| The ordering party presents divergent histories | Witnessed checkpoints can expose equivocation; one operator admits and orders events. | Independently administered validators agree on ordering under the consensus fault assumptions. | QBFT network configuration in `besu/`. |
| A participant changes the declared limitations of an approved result | A signed manifest, version policy and approval rule expose or reject the change. | Factor-set policy, assessment commitment and approval rules. | Methodological status and flags remain on the certificate after approval. |
| An evidence repository deletes or withholds files | Hashes do not restore missing files; backups and recovery are needed. | Same as the central log for off-chain evidence. | Retention, replica and retrieval checks; the checker detects missing or altered evidence. |
| One organization controls administrators and validators | The central trust dependency is explicit. | Separate accounts do not remove the dependency. | Deployment requirement: validator and administrator keys held by different organizations. |
| Commercial records must be hidden from participants | Access can be restricted per record. | Full nodes see on-chain records unless privacy mechanisms are added. | Raw evidence stays off-chain; on-chain quantities are visible to members. |

A permissioned ledger is preferable when several organizations share the administration of accepted state and do not delegate this authority to a single log operator; this requires independently operated validators and administrative keys.
