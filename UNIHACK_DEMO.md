# UniHack Demo Runbook — Student Wallet

## Blockchain architecture
- Avalanche Fuji C-Chain (chain ID 43113) is the demo network.
- Supabase stores app identity, group expense rows, item details, reports, and each member's wallet address.
- StudentGroupVaultV3 stores group wallet membership, AVAX contributions, payout requests, approvals, execution results, and receipt hashes.
- A payout request references one app expense with `expenseKey = keccak256(expense UUID)`. The contract rejects reuse of that key inside the same group.
- The group owner signs the initial member list. Fuji transactions remain visible and independently verifiable in the Avalanche explorer.

## Demo sequence
1. Show an existing group and an expense in its history. Explain that the expense row is the accounting source of truth.
2. Open Group Fund and connect the owner's saved wallet on Fuji.
3. Register/sync the group member wallet addresses on-chain. Show that the owner signature authorizes that roster.
4. Have two members contribute test AVAX and show each contribution and the group balance.
5. From one existing expense, submit a reimbursement request to the buyer's saved wallet. Show the receipt hash and request transaction.
6. Connect the other contributor and approve. Show the vote count and payout transfer transaction.
7. Re-open the original expense. Show its status as paid back; the app does not add a second expense row.
8. Attempt to request reimbursement for the same expense again. The contract should reject the reused expense key.
9. Change one receipt field and verify that the stored receipt hash no longer matches the current record.

## Questions and honest answers
- Why blockchain? Shared group funds need a transparent balance and an approval rule that app administrators cannot silently override; receipt hashes give an independently verifiable tamper-evidence record.
- What stays off-chain? Personal details, itemized receipts, group membership identifiers, and reports. Only wallet membership, test-token contributions, payout approvals/transfers, and hashes are on-chain.
- Who can propose a payout? A registered group member whose cumulative contribution reaches 0.01 AVAX.
- Who can approve? A contributor. The threshold is a majority of contributors when the request is created; the requester may also approve under the current rule.
- What if a request has votes but not enough funds? After the group contributes more, any caller can execute the already-approved request.
- Is this production-ready? No. It is a Fuji testnet prototype. It has not been audited; conversion from VND to AVAX is an app-side estimate, not an oracle-backed price; and membership changes require an owner-signed/owner-authorized on-chain action.

## Before presenting
- Deploy `StudentGroupVaultV3.sol` with Solidity 0.8.20 or newer to Fuji.
- The Fuji deployment address is `0xfcCc67Dd8642640F4b17981aF349b4C092252F21`; it is now set in `CONTRACT_ADDRESS_V3`. Publish this updated app build.
- Run `schema_groups_secure.sql` in Supabase and make sure every demo member has saved a Fuji C-Chain wallet address.
- Prepare Fuji test AVAX in at least two member wallets.
- Run the whole sequence once and save the explorer URLs for registration, deposits, reimbursement creation, approval, payout, and receipt sealing.
- Do not claim a transaction has succeeded until it appears on the Fuji explorer.

> Remix displayed a successful compile and one deployed contract, and the user supplied its Fuji address. This verifies the deployment step visually, but the app-to-contract demo transactions and source verification still need to be completed.
