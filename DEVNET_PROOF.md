# DEVNET_PROOF.md — Éphémère Protocol, full death-cycle on devnet

Every signature below is a real devnet transaction, verifiable on the explorer.

| | |
|---|---|
| Program | [`4UxnYz4N5b5MnvMeGNqYGyvcu3izQYC7m6df9RhYTygo`](https://explorer.solana.com/address/4UxnYz4N5b5MnvMeGNqYGyvcu3izQYC7m6df9RhYTygo?cluster=devnet) |
| Deployer / oracle / demo treasury | [`3fVzGJqN5EHKLCzXehHTeTv7PNAgL1Sa7yYbtxuWxBW8`](https://explorer.solana.com/address/3fVzGJqN5EHKLCzXehHTeTv7PNAgL1Sa7yYbtxuWxBW8?cluster=devnet) |
| Event | `DEMO-MQ9H69R2` → [`HgPiq9pSFwvbU5YPTtUDR69NVSyx6ye5uafY8Bv4y7i7`](https://explorer.solana.com/address/HgPiq9pSFwvbU5YPTtUDR69NVSyx6ye5uafY8Bv4y7i7?cluster=devnet) |
| Prize vault | [`GTS3NKVoNmAezJJnZTGFjH1rbzFJqV1QYaWFydaHs5JP`](https://explorer.solana.com/address/GTS3NKVoNmAezJJnZTGFjH1rbzFJqV1QYaWFydaHs5JP?cluster=devnet) |
| Outcomes | ALPHA [`J3LGGjKx…`](https://explorer.solana.com/address/J3LGGjKxqKD6rWw4FHXujLpUTDiCy8PuzTq1WbVx1Rm9?cluster=devnet) · BRAVO [`B97GDmvC…`](https://explorer.solana.com/address/B97GDmvCC72waED1SrUFWYA4gjBfRBQfBuv3wekhkY1G?cluster=devnet) · CHARLIE [`373KfMoT…`](https://explorer.solana.com/address/373KfMoT62McdULkkngCgB1EmZ5gMXJ17rEzPErRUaVM?cluster=devnet) · DELTA [`6HQAM1Sq…`](https://explorer.solana.com/address/6HQAM1SqwCD6vgASjTGUAAz5Q4h4V5UMjcyhc7JgCMHH?cluster=devnet) |

Event parameters (immutable since creation): 3 rounds, sell tax 1/5/10%, sequestration 0/2/3%, protocol fee 5%, claim window 7 days, curve 1 SOL × 1M tokens virtual.

## Transaction log

- initialize_event (3 rounds, tax 1/5/10%, seq 0/2/3%, fee 5%, window 7d)\
  [`4roGk7QnApWjijdj3PU886YApqny1NXTsBKn6Vp8aVyUVZpcTF4ufkR8byi8q13FoiAfn64y9eDx45t8yNoeKXtb`](https://explorer.solana.com/tx/4roGk7QnApWjijdj3PU886YApqny1NXTsBKn6Vp8aVyUVZpcTF4ufkR8byi8q13FoiAfn64y9eDx45t8yNoeKXtb?cluster=devnet)
- create_outcome ALPHA (mint J3LGGjKx…, PermanentDelegate = delegate PDA)\
  [`4KJv5zLXQXDCaLCKEZRvedFQnk3ykUNqAqUbvpEghbN9qyjmJy1WKdnooEQhqP6d5AoAVkvjhnot38YN3Rz9oaYD`](https://explorer.solana.com/tx/4KJv5zLXQXDCaLCKEZRvedFQnk3ykUNqAqUbvpEghbN9qyjmJy1WKdnooEQhqP6d5AoAVkvjhnot38YN3Rz9oaYD?cluster=devnet)
- create_outcome BRAVO (mint B97GDmvC…, PermanentDelegate = delegate PDA)\
  [`4EMNDWxdsYymJVLNTNE4RdabvLqxzrjobiTVj189mZ34bqQn53F4wx6EzVyYQRR5ttk2NxAcX8gYHEyaFdcf4EZy`](https://explorer.solana.com/tx/4EMNDWxdsYymJVLNTNE4RdabvLqxzrjobiTVj189mZ34bqQn53F4wx6EzVyYQRR5ttk2NxAcX8gYHEyaFdcf4EZy?cluster=devnet)
- create_outcome CHARLIE (mint 373KfMoT…, PermanentDelegate = delegate PDA)\
  [`2JVsPFzKoYAkuh9utNgmAo3UQHn6WjdpaZGxEQnH9nj5UU4RQWPKXp9roJMnKwr7KWcZoFWkUMg9y8AMbfT2u29i`](https://explorer.solana.com/tx/2JVsPFzKoYAkuh9utNgmAo3UQHn6WjdpaZGxEQnH9nj5UU4RQWPKXp9roJMnKwr7KWcZoFWkUMg9y8AMbfT2u29i?cluster=devnet)
- create_outcome DELTA (mint 6HQAM1Sq…, PermanentDelegate = delegate PDA)\
  [`2P6xmnLuhmfcKgB9JojH9J7L6YN1bibaUgFuHngFxE438W6FpTA7YYsNPLDcTNYCNqp9QJRpexECxuyCyf2ap1By`](https://explorer.solana.com/tx/2P6xmnLuhmfcKgB9JojH9J7L6YN1bibaUgFuHngFxE438W6FpTA7YYsNPLDcTNYCNqp9QJRpexECxuyCyf2ap1By?cluster=devnet)
- buy 0.05 SOL of ALPHA → 47619047619048 units\
  [`4iLoncdRkabCqi2Xt2eaXAJqL2Wwm5NTAKPse1MF7kzRSmapZSi9NBkvZNK1Ce4rCAAiwPLA7auWbRSSLddV4XW9`](https://explorer.solana.com/tx/4iLoncdRkabCqi2Xt2eaXAJqL2Wwm5NTAKPse1MF7kzRSmapZSi9NBkvZNK1Ce4rCAAiwPLA7auWbRSSLddV4XW9?cluster=devnet)
- buy 0.03 SOL of BRAVO → 29126213592234 units\
  [`2QWzNX1nwV1ALGGkjeH6EyfD9Z5J3D5ec27rX2BtoX4aexmB6Y68GpiLpLNCg598yZoefDxiFG4izpmC5th5d9w9`](https://explorer.solana.com/tx/2QWzNX1nwV1ALGGkjeH6EyfD9Z5J3D5ec27rX2BtoX4aexmB6Y68GpiLpLNCg598yZoefDxiFG4izpmC5th5d9w9?cluster=devnet)
- buy 0.02 SOL of CHARLIE → 19607843137255 units\
  [`4MqXZAy1TnjL3VeP4x5233XQWDJKcTjc2jyU41tvnNHgV1HcthUHTEbgdoWExUoRYLriRkXhzRYLtQnSApKrkMgV`](https://explorer.solana.com/tx/4MqXZAy1TnjL3VeP4x5233XQWDJKcTjc2jyU41tvnNHgV1HcthUHTEbgdoWExUoRYLriRkXhzRYLtQnSApKrkMgV?cluster=devnet)
- sell half of BRAVO position (round-0 tax 1% → prize vault)\
  [`5fKjEnK1CHejWpC871W8A9Xnn4Zq1BGqR1qxoaJa89Twkxk358XmR3bvJyL8dqfEyde6JK3j97AGr2GCMSsGbrBe`](https://explorer.solana.com/tx/5fKjEnK1CHejWpC871W8A9Xnn4Zq1BGqR1qxoaJa89Twkxk358XmR3bvJyL8dqfEyde6JK3j97AGr2GCMSsGbrBe?cluster=devnet)
- set_freeze CHARLIE = true\
  [`5vTeicGPi7xB2rNnSo8HyuDAq3UG7VdddBkUk9KyYmv2Wn8SFofvHCzhcWT7Gxe8DRkLWCKQ4JdMUeiqTY77gpsT`](https://explorer.solana.com/tx/5vTeicGPi7xB2rNnSo8HyuDAq3UG7VdddBkUk9KyYmv2Wn8SFofvHCzhcWT7Gxe8DRkLWCKQ4JdMUeiqTY77gpsT?cluster=devnet)
- buy on frozen CHARLIE → rejected with OutcomeNotTradable — *gate holds; preflight rejection, no on-chain tx*
- set_freeze CHARLIE = false\
  [`rZcYVAEgm77oB5UipEJTGXKqaVALvjX9DhFuFBYzG7uhpgJpRVY3c1RJaW3Qo1AAqVuSJACv3p7J65uzH475HG1`](https://explorer.solana.com/tx/rZcYVAEgm77oB5UipEJTGXKqaVALvjX9DhFuFBYzG7uhpgJpRVY3c1RJaW3Qo1AAqVuSJACv3p7J65uzH475HG1?cluster=devnet)
- advance_round → round 1 (sequester 2%, sell tax 5%)\
  [`4DwuDxpBvWSXeFMqZiuLrozmZvx73ExbTNfMMbTQ7WRTTq3kEeXjzU8xzV7iSECRGdiYyxWYU3Cs7k7FmNQ2xxS`](https://explorer.solana.com/tx/4DwuDxpBvWSXeFMqZiuLrozmZvx73ExbTNfMMbTQ7WRTTq3kEeXjzU8xzV7iSECRGdiYyxWYU3Cs7k7FmNQ2xxS?cluster=devnet)
- sequester ALPHA (permissionless crank, 2% of reserve → pot, curve marked down)\
  [`2N4BkNeD1GrZwCyjZib2ZDDeQJHjPaiMzveQXXiLkL4cs1gLq6Wh1ttLRziY7Sm7YhcT2qhSSeaGF2qqrRKhkPTQ`](https://explorer.solana.com/tx/2N4BkNeD1GrZwCyjZib2ZDDeQJHjPaiMzveQXXiLkL4cs1gLq6Wh1ttLRziY7Sm7YhcT2qhSSeaGF2qqrRKhkPTQ?cluster=devnet)
- sequester BRAVO (permissionless crank, 2% of reserve → pot, curve marked down)\
  [`4ajijADBoRdKQiY3XTkEWhg8mYUKnU6JKu9Xx5n7hZyiEbWge9frW68rej1xYzcRrLZhvXCjNcLBp6NamMXZaNvb`](https://explorer.solana.com/tx/4ajijADBoRdKQiY3XTkEWhg8mYUKnU6JKu9Xx5n7hZyiEbWge9frW68rej1xYzcRrLZhvXCjNcLBp6NamMXZaNvb?cluster=devnet)
- sequester CHARLIE (permissionless crank, 2% of reserve → pot, curve marked down)\
  [`4dyA9z2GTFbqYUtqiFmHyQ9dq7aNms7M7wVymoTYRkrfo4q8G7dB1AskLAVSQ9NBTbHnawyEKuiGCkFswCxQKUuR`](https://explorer.solana.com/tx/4dyA9z2GTFbqYUtqiFmHyQ9dq7aNms7M7wVymoTYRkrfo4q8G7dB1AskLAVSQ9NBTbHnawyEKuiGCkFswCxQKUuR?cluster=devnet)
- sequester DELTA (permissionless crank, 2% of reserve → pot, curve marked down)\
  [`oWkwmnHneFwgj9uP7eLchf5NaskPFpiXade1DzUvW9pdMxBv1v8yn5d6XeYdbDvLAgfeVgXh7FBinxm4MEcsPFg`](https://explorer.solana.com/tx/oWkwmnHneFwgj9uP7eLchf5NaskPFpiXade1DzUvW9pdMxBv1v8yn5d6XeYdbDvLAgfeVgXh7FBinxm4MEcsPFg?cluster=devnet)
- eliminate DELTA — 0 lamports of reserve swept to the pot\
  [`53e58fByk9wbs8WAMvFvnnfcf283xpJ6kYTJD4ipkLnmXUMkUTe8NPV5Vh6hpaWRBBa4ymL8dPJJJYDpjTAJv9ie`](https://explorer.solana.com/tx/53e58fByk9wbs8WAMvFvnnfcf283xpJ6kYTJD4ipkLnmXUMkUTe8NPV5Vh6hpaWRBBa4ymL8dPJJJYDpjTAJv9ie?cluster=devnet)
- eliminate CHARLIE — 19600000 lamports of reserve swept to the pot\
  [`4t6iokKY1NsWHRVwFsGK4XYqWy59QaAdu9muP6xXmmaNYpdcYUB1NHmD7zoB6QJNjwh2ZWpVVPHQrtqxqHiGHyPS`](https://explorer.solana.com/tx/4t6iokKY1NsWHRVwFsGK4XYqWy59QaAdu9muP6xXmmaNYpdcYUB1NHmD7zoB6QJNjwh2ZWpVVPHQrtqxqHiGHyPS?cluster=devnet)
- eliminate BRAVO — 14482760 lamports of reserve swept to the pot\
  [`3khrjVruyksBzac1UoGBuNw9xkGE6GMWD48HV8vnXtBiGVBajXq8nPF12fDsH4nH4s46cfAru7WTt4ZY6t56gMTk`](https://explorer.solana.com/tx/3khrjVruyksBzac1UoGBuNw9xkGE6GMWD48HV8vnXtBiGVBajXq8nPF12fDsH4nH4s46cfAru7WTt4ZY6t56gMTk?cluster=devnet)
- burn_residual BRAVO — dead supply erased via keyless permanent-delegate PDA, supply now 0\
  [`3oWRxJZcZzj3QNhM3jpFqHkUHhEjdkubuibRVk9ikKmyGzqAEcMUJLPagXE9h2AS5Robpp2EDkLwVigQaEHUjxnK`](https://explorer.solana.com/tx/3oWRxJZcZzj3QNhM3jpFqHkUHhEjdkubuibRVk9ikKmyGzqAEcMUJLPagXE9h2AS5Robpp2EDkLwVigQaEHUjxnK?cluster=devnet)
- burn_residual CHARLIE — dead supply erased via keyless permanent-delegate PDA, supply now 0\
  [`4prPkBCvQ7cP11APAM6eph3KUv5mEVWoZzE62uJ2XaXCqRiNGnwsYbWGCeV5p4H5uPTCe1eHGApYiJn5rwPTZEya`](https://explorer.solana.com/tx/4prPkBCvQ7cP11APAM6eph3KUv5mEVWoZzE62uJ2XaXCqRiNGnwsYbWGCeV5p4H5uPTCe1eHGApYiJn5rwPTZEya?cluster=devnet)
- buy on eliminated CHARLIE → rejected with OutcomeNotTradable — *gate holds; preflight rejection, no on-chain tx*
- resolve → ALPHA wins. Pot snapshot 80684015 lamports, winner supply snapshot 47619047619048, fee 5% → treasury\
  [`o2MB3TnUptAu2vrVuCepXcXYiAYXNr5mgYxyXMp38aGhTfFpb92Xs3PNXBBrZTTvViBzavcba4XenD9G4RTRWrt`](https://explorer.solana.com/tx/o2MB3TnUptAu2vrVuCepXcXYiAYXNr5mgYxyXMp38aGhTfFpb92Xs3PNXBBrZTTvViBzavcba4XenD9G4RTRWrt?cluster=devnet)
- redeem 23809523809524 ALPHA units → 40342007 lamports (burn-for-SOL at the frozen pro-rata rate)\
  [`4jV8NZxbhLFfiAmS52XcK8d2tNp41yuCVWxw94diSVTi3hKfYrzadzwdwcd95PAqB6YQwsDzGmob2Eunj9hWikHb`](https://explorer.solana.com/tx/4jV8NZxbhLFfiAmS52XcK8d2tNp41yuCVWxw94diSVTi3hKfYrzadzwdwcd95PAqB6YQwsDzGmob2Eunj9hWikHb?cluster=devnet)
- sweep_unclaimed before the window closes → rejected with ClaimWindowStillOpen — *gate holds; preflight rejection, no on-chain tx*
- burn_residual on the WINNER during the claim window → rejected with TokenStillAlive — *gate holds; preflight rejection, no on-chain tx*

## Final state

- Event status: `resolved` (Resolved — claim window open for 7 days)
- Residual supplies: ALPHA = 23809523809524, BRAVO = 0, CHARLIE = 0, DELTA = 0
  - BRAVO/CHARLIE were erased by `burn_residual` (anyone can bury a dead token); DELTA never minted; ALPHA keeps the unredeemed half until the window closes.

## What the 7-day claim window intentionally defers

The contract enforces `claim_window_secs ≥ 7 days` at creation (BadConfig guard —
the trust promise cannot be configured away, even for demos). Therefore two final
steps can only be executed ≥ 7 days after `resolve`, and their gates were instead
proven to hold above (clean preflight rejections):

1. `burn_residual` on the WINNER (rejected with `TokenStillAlive` during the window)
2. `sweep_unclaimed` (rejected with `ClaimWindowStillOpen`)

Both rejections are also covered by the bankrun test suites with full clock control
(34 green tests: lifecycle, adversarial, curve fuzz — see `tests/`).
