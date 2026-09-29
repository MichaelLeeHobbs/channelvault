# Source

Mirth 3.0–3.4 channels (Database Writer, File Reader/Writer, large scripts), a 40-template library and a global scripts export.

- Upstream: `OpenHDS/Mirth-Channels` at commit `b0d7b6fb5784842051842231af98ee7d60a7438e`
- License: BSD-3-Clause, in [LICENSE](LICENSE). These files stay under their license; they are test data only and not part of the npm package.
- Not modified: each file is checked against its hash below (`test/third-party-corpus.test.ts`). A file named `channel.xml` upstream is saved under its folder's name.

| File | Root and version | SHA-256 |
| --- | --- | --- |
| `Baseline.xml` | channel 3.3.1 | `811a22102f2109a74d6ffbba76022c885471f24f797b2f14fbd976d24156e8db` |
| `Code Template Library.xml` | codeTemplateLibrary 3.4.0 | `a7187f5ac8c77aae54bdee6bc01463f19c88ae1d4edbb3962151f48848003f53` |
| `Database Error Writer.xml` | channel 3.0.3 | `86584ffc90d0a3ad4ab36d2fc2595b345b02804c90471b2332be988b2c21a4c3` |
| `File Error CreateSend.xml` | channel 3.0.3 | `259906354425dc1446be56c1f535bce9b7533617135b1ada5f3891813cd961cc` |
| `Global Scripts.xml` | map unversioned | `a4cb6beb6540d7398909685a09aa27bc4b2e95a022d6a3e4f8d4a89baa1c8ac5` |
| `MigrationChannel.xml` | channel 3.4.0 | `75b8c28d2d095c8f12f01976e01df93039a7598a90364021a4f6ac074e3793db` |
