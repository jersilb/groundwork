# Items Needing Jeremy — Groundwork, Phases 0–7 Wrap-Up
**Date**: 2026-07-28
**Prepared by**: Claude (Sonnet 5)
**Context**: All 8 build-plan phases now have a built scaffold (0–7 built and gate-tested to the extent this sandbox allows; Phase 8 is content + pilot, explicitly Jeremy's). This report consolidates every open item that needs your review or something only you can provide, so the project can keep moving. Nothing below is blocking further scaffold work — these block trusting specific gates and starting Phase 8.

---

## Part 1 — Decisions that need your judgment

### 1.1 Phase 2 EVALUATOR gate — and a new finding that changes the picture

**Prior status** (what `docs/decisions.md` told you): precision 0.667 against real `claude-sonnet-5`, genuinely below the 0.8 threshold, root-caused to EVALUATOR over-flagging vague-but-topical answers as `off_track` instead of `thin`.

**New finding while preparing this report**: I re-ran the identical harness against the identical 16 fixtures twice more, with no code or prompt changes. Precision came back **0.750**, then **0.500**. Three runs, same inputs, three different numbers:

| Run | Precision | Recall |
|---|---|---|
| Original (docs/decisions.md) | 0.667 | 0.333 |
| Re-run #1 (today) | 0.750 | 0.500 |
| Re-run #2 (today) | 0.500 | 0.167 |

**Root cause of the instability**: `AnthropicLlmClient` (`src/guide-engine/llm-client.ts`) never sets a `temperature` parameter, so every EVALUATOR call runs at the API's default (1.0) — genuine randomness on every call. **This means the 0.8 gate threshold has been getting compared against a number that isn't reproducible.** That's a bigger problem than any single measurement being 0.667 vs 0.8.

**What's stable across all three runs** (i.e., not noise): cases 02, 03, and 08 — all real, specific "vague corporate-speak" cases — were misclassified as `off_track` in every run I have per-case data for. That's the genuine pattern already diagnosed. One case, **11**, flipped the other direction (expected `off_track`, EVALUATOR said `thin`) — and on inspection I think this fixture's own label is arguable: the submissions are *"Someone should fix the coffee machine"* and *"Parking is annoying sometimes"* — genuinely low-value input, but arguably about the organization rather than fully unrelated to it. Worth your eyes.

**My recommendation, in order**:
1. **Approve setting `temperature: 0` (or similarly low) on EVALUATOR's Anthropic calls before trusting any further precision number.** This is a one-line change to `llm-client.ts`. I'm flagging it as a decision rather than just doing it, because it changes how the gate itself is measured — not neutral, and squarely a "guide agent behavior" change under `AI_CEO_INSTRUCTIONS.md` §4.
2. After that, re-measure once. If precision still sits meaningfully below 0.8, review case-11's label yourself (5 minutes) — if it's a bad fixture, fixing it is a one-line data change, not a model change.
3. If it's still short after both of those, I'd treat this as expected at n=16 rather than push further blind prompt tuning — a 16-case, AI-authored fixture set was never going to be the final word, and Phase 8's real curriculum-scale fixtures are the more trustworthy place to re-litigate this.

**What I need from you**: a yes/no on step 1 (temperature fix), and — only if you have a spare five minutes — your read on case-11.

---

### 1.2 Auth provider — still unpicked

The build plan says "Cloudflare Access or Clerk — do not roll your own" but doesn't choose. This has sat as an open item since Phase 0 (`docs/capability-gaps.md`, 2026-07-26) because it wasn't yet on the critical path. It is now: Phase 6/7's org/user model (`src/program/org.ts`) has no real login flow wired in, and `frontend-ux-engineer` can't build real screens (signup, session join, billing portal access) without knowing which one to integrate against.

**My recommendation**: Cloudflare Access for the leader/admin side (already inside your Cloudflare account, no new vendor, works well for a small number of named users per org) and a simple email-link or Clerk-based flow for the once-per-lab room join code (Access's per-user model doesn't fit "anyone in the room with a code"). Happy to write this up as a full escalation brief if you want the tradeoffs in more detail before deciding.

**What I need from you**: pick one (or ask for the fuller brief) before frontend/auth work starts.

---

### 1.3 GitHub Actions secrets — should Phase 4/7 CI get real credentials?

Right now, Phase 4 (Whisper) and Phase 7 (Stripe) can't be verified from this sandbox — `api.cloudflare.com` and `api.stripe.com` are both blocked by this environment's outbound proxy, independent of the valid credentials sitting in `.dev.vars`. GitHub Actions runners have normal outbound internet access, so adding `ANTHROPIC_API_KEY`, the Workers-AI-scoped Cloudflare token, and the Stripe test key as **repository secrets** (`Settings → Secrets and variables → Actions`) would let CI genuinely exercise both gates on every push.

I have not done this myself — touching repo-level secrets/CI config is exactly the kind of action that should wait for your explicit go-ahead, not get inferred from "keep building."

**What I need from you**: say the word and I'll wire the CI jobs to use them (they're already structured to pick up `secrets.ANTHROPIC_API_KEY` etc. conditionally — see the Phase 5 CI job for the existing pattern), or tell me to leave it for your own machine instead.

---

## Part 2 — Things only you can provide

### 2.1 `docs/source-principles.md` — blocks all of Phase 8

Still empty by design — no AI session has seen or will see the Paterson manual, and none should. Phase 8 (the church-pack Lab 1 curriculum) cannot start until you populate this file with the actual ministry reasoning/source principles in your own words. This is a hard Tier 3 gate (`CLAUDE.md`'s IP firewall section) — I will not draft placeholder content here even provisionally.

### 2.2 Pilot churches

Standing action item from `docs/roadmap.md`: line up two or three willing pilot churches now, not when Phase 8 is imminent. Nothing else in the build depends on this yet, but it's the one item on this whole list with a long human lead time, so it's worth starting in parallel rather than after curriculum is written.

### 2.3 Trademark check on "Groundwork"

The name is flagged everywhere in this repo (README, manifest, `CLAUDE.md`) as a placeholder pending your trademark check, per build plan §2.4. Not urgent while nothing is public, but it should resolve before any marketing, domain registration, or App Store/Play Store listing happens — those are all Tier 3 actions I won't take on an unconfirmed name regardless.

### 2.4 A pre-pilot verification day (bundle these — they're cheap together)

Four separate gates all reduce to "someone needs to physically use this for real," and they're all satisfiable in one sitting with a laptop and two phones:
- **Phase 1**: 3 real devices in one room, confirm no state divergence (the automated test proves the mechanism; not real device/network diversity).
- **Phase 3**: a real 10-minute, 6-client offline drill (automated test ran ~1 second, 1 client, by design — nothing in the mechanism is time- or count-sensitive, but the literal gate hasn't been run).
- **Phase 5**: read an actual generated one-pager from a real simulated lab and count how many edits you'd make — this is a human-judgment number no automation can produce honestly.
- **Phase 7**: install the deployed PWA on one real iOS phone and one real Android phone from your own home screen.

None of these block continued building. All of them should happen before the first real pilot lab trusts these gates.

### 2.5 Live Cloudflare resource provisioning

Whenever you're ready to move past local `wrangler dev` emulation to a real staging deployment (real D1/R2/KV, not local), that requires your Cloudflare account access or you running the provisioning commands yourself — a billed, account-scoped action I won't take without you present.

---

## Summary — what I actually need a reply on

1. **Yes/no**: set EVALUATOR's temperature to 0 and re-measure Phase 2? (§1.1)
2. **Pick one**: auth provider — my Cloudflare Access + email-link recommendation, or want the full brief first? (§1.2)
3. **Yes/no**: wire Anthropic/Cloudflare/Stripe credentials into GitHub Actions secrets so CI can genuinely verify Phases 4 and 7? (§1.3)
4. Whenever convenient, not blocking: `docs/source-principles.md`, pilot church outreach, trademark check, and the pre-pilot device day (§2.1–2.4).

Everything else in this repo is documented, tested to the limit this sandbox allows, and waiting on the above rather than on more autonomous building.
