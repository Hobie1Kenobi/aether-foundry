/**
 * W7 autonomic treasury split. Xahau Hooks only.
 *
 * Incoming native payment to the hook account is emitted as five payments:
 *   40% MARKET, 25% ATELIER, 20% RESEARCH, 10% GRANTS, remainder SINK.
 * Integer division dust lands on SINK, so the five amounts sum to the
 * incoming drops whenever a split runs.
 *
 * Destinations are HookParameters (20-byte AccountIDs), not literals:
 *   MARKET, ATELIER, RESEARCH, GRANTS, SINK
 *
 * Failure modes (also machines/xahau-split-treasury/THREAT.md):
 *   - outgoing / self Account: accept, do not emit (reentrancy)
 *   - not a payment, or Destination is not the hook account: accept
 *   - IOU amount: accept, leave the token on W7 (this hook splits native only)
 *   - tfPartialPayment: rollback (Amount would not be what arrived)
 *   - drops below 100000 (0.1 XAH): accept and keep on W7 (fee-float / dust)
 *   - missing, short, duplicate, or self destination parameter: rollback
 *   - prepare or emit failure: rollback, so the incoming payment does not land
 *   - an emit that later tec-fails is not retried in cbak (a retry could
 *     double-pay the shares that already applied). That share stays on W7.
 *
 * No loops. The guard checker rejects an unguarded loop, and -O2 can turn a
 * byte copy into one. Comparisons and copies are unrolled. _g is imported
 * because every hook must import it.
 */

#include "hookapi.h"

#ifndef tfPartialPayment
#define tfPartialPayment 0x00020000UL
#endif

extern int64_t prepare(
    uint32_t write_ptr,
    uint32_t write_len,
    uint32_t read_ptr,
    uint32_t read_len);

#define MIN_SPLIT_DROPS 100000LL
#define BPS_DENOM 10000LL
#define BPS_MARKET 4000LL
#define BPS_ATELIER 2500LL
#define BPS_RESEARCH 2000LL
#define BPS_GRANTS 1000LL

#define TAG_MARKET 740
#define TAG_ATELIER 725
#define TAG_RESEARCH 720
#define TAG_GRANTS 710
#define TAG_SINK 705

#define BEQ(A, B, I) ((A)[(I)] == (B)[(I)])
#define ACC_EQ(A, B)                                                      \
    (BEQ(A, B, 0) && BEQ(A, B, 1) && BEQ(A, B, 2) && BEQ(A, B, 3) &&     \
     BEQ(A, B, 4) && BEQ(A, B, 5) && BEQ(A, B, 6) && BEQ(A, B, 7) &&     \
     BEQ(A, B, 8) && BEQ(A, B, 9) && BEQ(A, B, 10) && BEQ(A, B, 11) &&   \
     BEQ(A, B, 12) && BEQ(A, B, 13) && BEQ(A, B, 14) && BEQ(A, B, 15) && \
     BEQ(A, B, 16) && BEQ(A, B, 17) && BEQ(A, B, 18) && BEQ(A, B, 19))

#define COPY20(DST, SRC)        \
    do                          \
    {                           \
        (DST)[0] = (SRC)[0];    \
        (DST)[1] = (SRC)[1];    \
        (DST)[2] = (SRC)[2];    \
        (DST)[3] = (SRC)[3];    \
        (DST)[4] = (SRC)[4];    \
        (DST)[5] = (SRC)[5];    \
        (DST)[6] = (SRC)[6];    \
        (DST)[7] = (SRC)[7];    \
        (DST)[8] = (SRC)[8];    \
        (DST)[9] = (SRC)[9];    \
        (DST)[10] = (SRC)[10];  \
        (DST)[11] = (SRC)[11];  \
        (DST)[12] = (SRC)[12];  \
        (DST)[13] = (SRC)[13];  \
        (DST)[14] = (SRC)[14];  \
        (DST)[15] = (SRC)[15];  \
        (DST)[16] = (SRC)[16];  \
        (DST)[17] = (SRC)[17];  \
        (DST)[18] = (SRC)[18];  \
        (DST)[19] = (SRC)[19];  \
    } while (0)

#define SHARE(DROPS, BPS) \
    (((DROPS) / BPS_DENOM) * (BPS) + (((DROPS) % BPS_DENOM) * (BPS)) / BPS_DENOM)

#define PUT_DROPS(P, DROPS)                                      \
    do                                                           \
    {                                                            \
        uint64_t _enc = (uint64_t)(DROPS) | 0x4000000000000000ULL; \
        (P)[0] = (uint8_t)(_enc >> 56);                          \
        (P)[1] = (uint8_t)(_enc >> 48);                          \
        (P)[2] = (uint8_t)(_enc >> 40);                          \
        (P)[3] = (uint8_t)(_enc >> 32);                          \
        (P)[4] = (uint8_t)(_enc >> 24);                          \
        (P)[5] = (uint8_t)(_enc >> 16);                          \
        (P)[6] = (uint8_t)(_enc >> 8);                           \
        (P)[7] = (uint8_t)(_enc);                                \
    } while (0)

#define EMIT_SHARE(DEST20, DROPS, TAG)                                         \
    do                                                                         \
    {                                                                          \
        if ((DROPS) > 0)                                                       \
        {                                                                      \
            uint8_t raw[40];                                                   \
            uint8_t* q = raw;                                                  \
            *q++ = 0x12;                                                       \
            *q++ = 0x00;                                                       \
            *q++ = 0x00;                                                       \
            *q++ = 0x23;                                                       \
            *q++ = (uint8_t)(((uint32_t)(TAG) >> 24) & 0xFFU);                 \
            *q++ = (uint8_t)(((uint32_t)(TAG) >> 16) & 0xFFU);                 \
            *q++ = (uint8_t)(((uint32_t)(TAG) >> 8) & 0xFFU);                  \
            *q++ = (uint8_t)((uint32_t)(TAG) & 0xFFU);                         \
            *q++ = 0x61;                                                       \
            PUT_DROPS(q, (DROPS));                                             \
            q += 8;                                                            \
            *q++ = 0x83;                                                       \
            *q++ = 20;                                                         \
            COPY20(q, DEST20);                                                 \
            q += 20;                                                           \
            uint32_t raw_len = (uint32_t)(q - raw);                            \
            uint8_t prepared[512];                                             \
            int64_t plen =                                                     \
                prepare((uint32_t)prepared, 512, (uint32_t)raw, raw_len);      \
            if (plen < 0)                                                      \
                return rollback(SBUF("w7split: prepare"), plen);               \
            uint8_t hid[32];                                                   \
            int64_t elen =                                                     \
                emit((uint32_t)hid, 32, (uint32_t)prepared, (uint32_t)plen);   \
            if (elen != 32)                                                    \
                return rollback(SBUF("w7split: emit"), elen);                  \
        }                                                                      \
    } while (0)

#define LOAD_DEST(BUF, NAME, NAMELEN, LABEL)                          \
    if (hook_param((uint32_t)(BUF), 20, (uint32_t)(NAME), (NAMELEN)) != \
        20)                                                           \
        return rollback(SBUF(LABEL), 1);

#define REJECT_SELF(BUF, LABEL)                           \
    if (ACC_EQ((BUF), hook_acc))                          \
        return rollback(SBUF(LABEL), 1);

#define REJECT_DUP(A, B, LABEL)                           \
    if (ACC_EQ((A), (B)))                                 \
        return rollback(SBUF(LABEL), 1);

int64_t cbak(uint32_t reserved)
{
    (void)reserved;
    _g(1, 1);
    accept(SBUF("w7split: cbak"), 0);
    return 0;
}

int64_t hook(uint32_t reserved)
{
    (void)reserved;
    _g(1, 1);

    uint8_t hook_acc[20];
    if (hook_account((uint32_t)hook_acc, 20) != 20)
        return rollback(SBUF("w7split: hook account"), 1);

    uint8_t otxn_acc[20];
    if (otxn_field((uint32_t)otxn_acc, 20, sfAccount) != 20)
        accept(SBUF("w7split: no account"), 0);
    else if (ACC_EQ(hook_acc, otxn_acc))
        accept(SBUF("w7split: outgoing"), 0);
    else if (otxn_type() != ttPAYMENT)
        accept(SBUF("w7split: not payment"), 0);
    else
    {
        uint8_t pay_dest[20];
        if (otxn_field((uint32_t)pay_dest, 20, sfDestination) != 20)
            accept(SBUF("w7split: no destination"), 0);
        else if (!ACC_EQ(pay_dest, hook_acc))
            accept(SBUF("w7split: not destined here"), 0);
        else
        {
            uint8_t flags_buf[4];
            int64_t flags_len = otxn_field((uint32_t)flags_buf, 4, sfFlags);
            if (flags_len == 4)
            {
                uint32_t flags = (uint32_t)UINT32_FROM_BUF(flags_buf);
                if (flags & tfPartialPayment)
                    return rollback(SBUF("w7split: partial"), 1);
            }

            uint8_t amt[48];
            int64_t amt_len = otxn_field((uint32_t)amt, 48, sfAmount);
            if (amt_len == 48 || (amt_len == 8 && (amt[0] & 0x80U) != 0))
                accept(SBUF("w7split: iou kept"), 0);
            else if (amt_len != 8)
                return rollback(SBUF("w7split: amount"), amt_len);
            else if ((amt[0] & 0x40U) == 0)
                return rollback(SBUF("w7split: negative"), 1);
            else
            {
                int64_t drops =
                    (int64_t)((((uint64_t)(amt[0] & 0x3FU)) << 56) +
                              (((uint64_t)amt[1]) << 48) +
                              (((uint64_t)amt[2]) << 40) +
                              (((uint64_t)amt[3]) << 32) +
                              (((uint64_t)amt[4]) << 24) +
                              (((uint64_t)amt[5]) << 16) +
                              (((uint64_t)amt[6]) << 8) +
                              ((uint64_t)amt[7]));
                trace_num(SBUF("drops"), drops);
                if (drops < MIN_SPLIT_DROPS)
                    accept(SBUF("w7split: dust kept"), 0);
                else
                {
                    uint8_t market[20];
                    uint8_t atelier[20];
                    uint8_t research[20];
                    uint8_t grants[20];
                    uint8_t sink[20];
                    LOAD_DEST(market, "MARKET", 6, "w7split: MARKET");
                    LOAD_DEST(atelier, "ATELIER", 7, "w7split: ATELIER");
                    LOAD_DEST(research, "RESEARCH", 8, "w7split: RESEARCH");
                    LOAD_DEST(grants, "GRANTS", 6, "w7split: GRANTS");
                    LOAD_DEST(sink, "SINK", 4, "w7split: SINK");
                    REJECT_SELF(market, "w7split: MARKET is self");
                    REJECT_SELF(atelier, "w7split: ATELIER is self");
                    REJECT_SELF(research, "w7split: RESEARCH is self");
                    REJECT_SELF(grants, "w7split: GRANTS is self");
                    REJECT_SELF(sink, "w7split: SINK is self");
                    REJECT_DUP(market, atelier, "w7split: dup dest");
                    REJECT_DUP(market, research, "w7split: dup dest");
                    REJECT_DUP(market, grants, "w7split: dup dest");
                    REJECT_DUP(market, sink, "w7split: dup dest");
                    REJECT_DUP(atelier, research, "w7split: dup dest");
                    REJECT_DUP(atelier, grants, "w7split: dup dest");
                    REJECT_DUP(atelier, sink, "w7split: dup dest");
                    REJECT_DUP(research, grants, "w7split: dup dest");
                    REJECT_DUP(research, sink, "w7split: dup dest");
                    REJECT_DUP(grants, sink, "w7split: dup dest");

                    int64_t reserved_emits = etxn_reserve(5);
                    if (reserved_emits < 0)
                        return rollback(SBUF("w7split: reserve"), reserved_emits);

                    int64_t market_drops = SHARE(drops, BPS_MARKET);
                    int64_t atelier_drops = SHARE(drops, BPS_ATELIER);
                    int64_t research_drops = SHARE(drops, BPS_RESEARCH);
                    int64_t grants_drops = SHARE(drops, BPS_GRANTS);
                    int64_t sink_drops = drops - market_drops - atelier_drops -
                        research_drops - grants_drops;

                    EMIT_SHARE(market, market_drops, TAG_MARKET);
                    EMIT_SHARE(atelier, atelier_drops, TAG_ATELIER);
                    EMIT_SHARE(research, research_drops, TAG_RESEARCH);
                    EMIT_SHARE(grants, grants_drops, TAG_GRANTS);
                    EMIT_SHARE(sink, sink_drops, TAG_SINK);
                    accept(SBUF("w7split: split"), 0);
                }
            }
        }
    }
    return 0;
}
