# Source

Mirth backup exports from [mirthsync](https://github.com/SagaHealthcareIT/mirthsync)'s test data, used to run channelvault's round-trip tests against more engine versions. They are synthetic: localhost HTTP and JavaScript channels with `test`/`test` credentials.

- Upstream: `SagaHealthcareIT/mirthsync` at commit `205a5cacf398315baa4cc7ac53b8e6f0b42a290b` (2025-09-11)
- Archive: `dev-resources/test-data.tar.gz`, files under `test-data/`
- License: Eclipse Public License 1.0, in [LICENSE](LICENSE). These files stay under the EPL; they are test data only and not part of the npm package.
- Not modified. `test/third-party-fixtures.test.ts` checks each file against the hashes below, so a real export can't be dropped in here.

| File | Engine | SHA-256 |
| --- | --- | --- |
| `mirth-backup-3-08.xml` | Mirth 3.8.0 | `c61a67e7d8ce5179fd3b311fe361691271d738b7cef1d49daa39ab1aed100ba0` |
| `mirth-backup-4-01.xml` | Mirth 4.0.1 | `78884bf1b38c9f33e93994d1aaf74d6fc4425640ac78b8250bf90778eb9979be` |
| `mirth-backup-oie-4-52.xml` | OIE 4.5.2 | `4500732984799a8ef75492f0f9784a26cd40c0dae03df0ab6f2e2b40528c22ad` |

To update: take the files from a newer upstream commit, replace them here, and update the commit and hashes above.
