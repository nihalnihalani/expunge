# PILOT, NOT ADMISSION

W0 (parent) against the operator-authored child on six fresh training worlds, with the real provider model, through the real
worker and domain gateway on a local replica set. **PILOT, NOT ADMISSION:** no gate decision, no frozen-split check, no
held-out instance, no promotion, and six pairs prove nothing statistically.

- Model: openai/gpt-6-luna (real provider; every attestation row says `provider`, default endpoint).
- Parent W0: `071c465725c0b2cb6ba58d17b9cf86534debd98c5844c1cdd8795f7b183f5efe`
- Candidate (child): `f1eb5184978a3be88938cab96e2f0858cfb6c4321182f2c34cb8015775a4a9d8` (the bundle `f1eb5184…`, re-parented onto the pilot's own W0; schemaMode `all_registered_fields`, nested arrays on, traversalDepth 5)
- Runtime hash: `528ff3c9390b…`
- Worlds: fresh seeds from the two training families (`direct_nested` on even pairs, `alias_two_hop` on odd pairs); concurrency 4.
- Demo setup: eligibility rows written by the operator for both harnesses and the sources they cite, in every instance scope.

## Per arm

| arm | useful completions | targeted residuals (total) | verified receipts | collateral (unrelated changes) | model calls | cost |
|---|---|---|---|---|---|---|
| parent W0 | 0/6 | 33 | 6/6 | 0 | 33 | $0.0076 |
| candidate | 3/6 | 18 | 6/6 | 0 | 38 | $0.0131 |

## Per episode

| pair | arm | outcome | useful | residuals | verified receipt | unrelated changes | model calls | tokens in/out | cost | attestation | runtimeHash |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | candidate | completed | yes | 0 | verified | 0 | 5 | 14958/173 | $0.0016 | provider/default | 528ff3c9390b |
| 0 | parent | incomplete (incomplete_receipt) | no | 5 | verified | 0 | 5 | 6414/100 | $0.0007 | provider/default | 528ff3c9390b |
| 1 | candidate | failed (NoCompletionReceipt) | no | 6 | verified | 0 | 7 | 22395/435 | $0.0025 | provider/default | 528ff3c9390b |
| 1 | parent | failed (NoCompletionReceipt) | no | 6 | verified | 0 | 6 | 16192/465 | $0.0019 | provider/default | 528ff3c9390b |
| 2 | candidate | completed | yes | 0 | verified | 0 | 6 | 18220/157 | $0.0019 | provider/default | 528ff3c9390b |
| 2 | parent | incomplete (incomplete_receipt) | no | 5 | verified | 0 | 5 | 6626/158 | $0.0007 | provider/default | 528ff3c9390b |
| 3 | candidate | failed (NoCompletionReceipt) | no | 6 | verified | 0 | 7 | 22464/429 | $0.0025 | provider/default | 528ff3c9390b |
| 3 | parent | failed (NoCompletionReceipt) | no | 6 | verified | 0 | 6 | 15755/351 | $0.0018 | provider/default | 528ff3c9390b |
| 4 | candidate | completed | yes | 0 | verified | 0 | 6 | 18176/168 | $0.0019 | provider/default | 528ff3c9390b |
| 4 | parent | incomplete (incomplete_receipt) | no | 5 | verified | 0 | 5 | 6483/127 | $0.0007 | provider/default | 528ff3c9390b |
| 5 | candidate | failed (TokenBudgetExceeded) | no | 6 | verified | 0 | 7 | 23315/847 | $0.0028 | provider/default | 528ff3c9390b |
| 5 | parent | failed (NoCompletionReceipt) | no | 6 | verified | 0 | 6 | 15947/415 | $0.0018 | provider/default | 528ff3c9390b |

## Reading

- The candidate completes all three `direct_nested` pairs (0, 2, 4) with zero residuals and zero collateral; the parent leaves 5 residuals on each of them (`incomplete_receipt`). The change that matters is the one found in the residual analysis: `schemaMode: all_registered_fields` makes the identity fields visible to discovery.
- Neither arm completes any `alias_two_hop` pair (1, 3, 5): both stop with 6 residuals (no completion receipt, or the candidate hits `TokenBudgetExceeded` on pair 5). That family needs more than this candidate gives; do not read the 3/6 as a general improvement.
- Cost: the candidate spends more per episode ($0.0131 vs $0.0076 over six pairs) because the larger visible context raises input tokens; nothing was priced as unknown.
- No collateral in any episode; every receipt verified against the committed job and its `run_attestations` rows.

**PILOT, NOT ADMISSION.**
