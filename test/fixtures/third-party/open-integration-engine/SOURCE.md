# Source

Open Integration Engine's CI test channels (raw, HL7 strict parser with CDATA, delimited and XML batch, an XSLT step) and a server configuration from its unit tests.

- Upstream: `OpenIntegrationEngine/engine` at commit `70b627dffe2d458137ad5a9ad1374c1e9e4991d7`
- License: MPL-2.0, in [LICENSE](LICENSE). These files stay under their license; they are test data only and not part of the npm package.
- Not modified: each file is checked against its hash below (`test/third-party-corpus.test.ts`). A file named `channel.xml` upstream is saved under its folder's name.

| File | Root and version | SHA-256 |
| --- | --- | --- |
| `01-csv.xml` | channel 4.6.0 | `cac0efefc43cdec56f5d997aeb3f4534350bd35a71389a862cbce8d23141ad65` |
| `01-hl7-no-op.xml` | channel 4.5.2 | `3af55b76253c59a57ca99347fc947f032682152fb3e1384a852e431dec4ca321` |
| `01-hl7-strict-xml-cdata.xml` | channel 4.5.2 | `adc5bf9ce348a645d090bbbfb9459a937a75a7d99344f3a34838ae1a199efd40` |
| `01-raw-no-op.xml` | channel 4.5.2 | `6c0ff8ea013d771f6c07a9948c75e9b9abadadbc58712f614a94e85f528524b3` |
| `01-xml-batch-xxe.xml` | channel 4.6.0 | `337abfe735c90c97efa81059c519716df6d0f2a5471078beb0435b968425415e` |
| `01-xslt-xxe.xml` | channel 4.6.0 | `9ba4918867a3e6f619aaed47969d88068721d00ddffcd6e451e092904113580b` |
| `Config 1.xml` | serverConfiguration 3.6.0 | `90bc4ab2b966216e37d5b6ca52810e06d5edc82422efe62c128a7dce8da6ae3f` |
