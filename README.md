# waves branch — pick-wave state (do not merge into main)

Written by `picks.html` through the GitHub API; never by the sync Action.

- `waves/index.json` — plaintext wave register: id, created, zone, filters, order numbers, bin reservations. No customer data.
- `waves/W-YYMMDD-NN.enc` — frozen slip payload for one wave, AES-GCM encrypted (key = FS_PICK_KEY passphrase).

Plan: `Fulfillment Dashboard - Port/Pick Waves/PLAN.md` (local).
