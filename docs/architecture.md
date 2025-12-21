# Cognitive Filter Architecture

## Philosophy

Tolerance is a **cognitive prosthesis** for navigating memetically adversarial environments. As the information environment becomes increasingly memetically potent, human cognition alone cannot reliably protect from manipulation. The system acts as an external cognitive filter that processes stimuli before they reach unaugmented perception.

Reference: Batou's cyberbrain verification systems in Ghost in the Shell 2: Innocence - external validation becomes necessary when internal perception cannot be trusted.

---

## System Architecture

```
                              FILTER PIPELINE
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  Content → [PRE-FILTER] → [MEMBRANE] → [POST-FILTER] → [TRANSFORM]     │
│             identity       scoring      distribution     blur, dim,     │
│             pass/block     analysis     over scores      reorder, etc.  │
│                               │                                         │
└───────────────────────────────│─────────────────────────────────────────┘
                                │
                                ▼
                        ┌──────────────┐
                        │  REPUTATION  │
                        │    SYSTEM    │
                        └──────────────┘
                                │
                    (informs user decisions about
                     filter configuration over time)
```

---

## Pre-Filter (Identity Layer)

**Purpose**: Binary gate based on source identity, independent of content.

**Characteristics**:
- Deterministic, or probabilistic
- User-sovereign decisions about trust relationships
- Bypass means content skips post-filter→transform path

**Examples**:
- Whitelist: "Always pass @trustedfriend regardless of content"
- Blacklist: "Always block @knownmanipulator regardless of content"
- Platform-level: "Pass all posts from accounts I follow"

**Key principle**: Pre-filter represents *decisions*, not *analysis*. The user (or trusted external authority) has already judged this source.

**Current implementation**: `WhitelistEntry[]` in Settings

---

## Intelligence Membrane (Scoring Layer)

**Purpose**: Probabilistic content analysis for manipulation patterns.

**Characteristics**:
- Always runs, even for pre-filter passes (feeds reputation system)
- Heuristic + LLM-based pattern recognition
- Produces scores (0-100) and reasons
- Can be wrong - provides signal, not truth

**Current implementation**: `scorer.ts`, `openrouter.ts`

---

## Post-Filter (Distribution Layer)

**Purpose**: Maps score distribution to transform decisions.

**Characteristics**:
- Contextual modulation of score→decision mapping
- Phase-aware (normal, reduced, wind-down, minimal)
- Quality mode shifts threshold aggressively
- Category-specific adjustments possible

**Examples**:
- "During wind-down, blur anything >40 instead of >55"
- "In quality mode, blur anything >20"
- "For political content, apply stricter thresholds"

**Current implementation**: `currentBlurThreshold`, `shouldBlurScore()`

---

## Transform Layer

**Purpose**: Apply actual modifications to content presentation.

**Characteristics**:
- Blur is one transform among many
- Transforms are composable
- User can configure which transforms apply

**Transform types** (current and future):

| Transform | Description | Status |
|-----------|-------------|--------|
| **Blur** | Visual obscuring with hover-to-reveal | Implemented |
| **Dim** | Reduced opacity/prominence | Future |
| **Delay** | Temporal friction before display | Future |
| **Summarize** | Replace with AI summary | Future |
| **Annotate** | Add context/warnings | Future |
| **Reorder** | Push to bottom of feed | Implemented |
| **Hide metrics** | Remove engagement numbers | Future |
| **Block** | Complete removal | Future |

---

## Reputation System (Parallel Accumulator)

**Purpose**: Crystallize membrane outputs over time into source-level patterns.

**Characteristics**:
- Not in the filter pipeline itself
- Aggregates scores per-source over time
- Informs user decisions about pre-filter updates
- Could eventually feed distributed consensus

**Future data model**:
```typescript
interface SourceReputation {
  sourceId: string;           // @username, r/subreddit, domain
  platform: string;
  scoreHistory: number[];     // Recent scores
  averageScore: number;
  scoreCount: number;
  lastSeen: number;
  userTrustDecision?: 'whitelist' | 'blacklist' | null;
}
```

**Current status**: Not yet implemented. Score cache exists but doesn't aggregate by source.

---

## Dialectics of Sovereignty

The user retains the ability to rebel against consensus (override network reputation with personal pre-filter decisions), but is also shaped by observing consensus signals. This tension is productive:

- **Prevents collective tyranny**: User can trust sources the network distrusts
- **Prevents atomization**: User benefits from collective intelligence
- **Preserves agency**: Pre-filter decisions are always user-sovereign
- **Enables growth**: User's perception evolves through dialectic with collective

---

## Future: Distributed Consensus

When individual prostheses share data:
- Individual membrane outputs aggregate into network reputation
- Pre-filter decisions aggregate into web-of-trust
- Consensus reality emerges from intersubjective agreement
- User retains sovereignty over their pre-filter regardless of consensus

**Risks**: Capture, manipulation, majority tyranny
**Promise**: Collective cognitive immune system

---

## Implementation Status

| Component | Status | Files |
|-----------|--------|-------|
| Pre-Filter | v1 (whitelist only) | `types.ts`, `scorer.ts` |
| Membrane | Complete | `scorer.ts`, `openrouter.ts` |
| Post-Filter | Complete | `*/index.ts` (content scripts) |
| Transform | Partial (blur, reorder) | `*/index.ts` (content scripts) |
| Reputation | Not started | - |
| Distributed | Not started | - |
