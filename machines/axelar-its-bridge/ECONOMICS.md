# ECONOMICS — Axelar ITS testnet bridge

Testnet XRP only. No treasury movement.

A forward plan sends one XRPL Payment to the testnet gateway. Axelar treats `Amount` as transfer plus gas, both in the same asset:

`transfer_drops = amount_drops - gas_drops`

The destination chain does not receive `amount_drops`. This pack does not print a destination amount, because hub scaling between XRPL's 6-decimal XRP and XRPL EVM's 18-decimal native XRP is not applied here.

Caps, per isolated source wallet:

| Cap | Value |
| --- | --- |
| Per plan, including gas | 2 XRP (`2000000` drops, or `2e18` wei on the blocked return leg) |
| Gas | greater than 0 and at most 0.5 XRP, and strictly less than the XRPL amount |
| UTC day | 5 XRP of non-error plans in that direction |
| In flight | 1 plan that is not `error` or `final` |

The XRPL fee and the reserve are not autofilled. A later signer, if one is ever approved, still has to leave the account above reserve. This pack does not estimate that fee.

There is no fee share, no treasury skim, and no W0 issuer path. AETH is not a bridge asset.

Mission spend, when a mission is the caller, is capped again at 1 XRP per mission and 5 XRP per America/Chicago day, including this payment, its network fee, bridge gas, and gateway custody. That mission ceiling is not raised by the 2 XRP planning cap in this pack. Destination-chain gas is not part of either figure. The mission runtime still does not sign.
