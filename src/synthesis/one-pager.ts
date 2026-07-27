import type { StoredArtifact } from "./plan-artifact-store.ts";

// One-page plan assembly — build plan §7 Phase 5 / §1 deliverable. This
// produces the content and structure; actual visual layout is
// frontend-ux-engineer + ultimate-web-designer territory (§2.2 also
// requires an original design, never the proprietary one-page layout).
//
// A kind can legitimately hold multiple items (several distinct risks are
// not "versions" of one risk — see plan-artifact-store.ts's SINGULAR_KINDS
// note, a real bug found testing against live Opus, 2026-07-27). Each
// section is a list of items, not a single content string.

const KIND_ORDER = ["purpose", "vision", "value", "strategy", "driver", "assumption", "risk"] as const;

const KIND_LABEL: Record<string, string> = {
  purpose: "Purpose",
  vision: "Vision",
  value: "Values",
  strategy: "Core Strategies",
  driver: "Key Drivers",
  assumption: "Assumptions",
  risk: "Risks",
};

export interface OnePagePlanItem {
  content: string;
  artifactId: string;
  version: number;
}

export interface OnePagePlanSection {
  kind: string;
  label: string;
  items: OnePagePlanItem[];
}

export interface OnePagePlan {
  sessionId: string;
  generatedAt: string;
  sections: OnePagePlanSection[];
}

export function assembleOnePager(sessionId: string, artifacts: StoredArtifact[]): OnePagePlan {
  const byKind = new Map<string, StoredArtifact[]>();
  for (const a of artifacts) {
    const list = byKind.get(a.kind) ?? [];
    list.push(a);
    byKind.set(a.kind, list);
  }

  const sections = KIND_ORDER.filter((kind) => byKind.has(kind)).map((kind) => ({
    kind,
    label: KIND_LABEL[kind],
    items: byKind.get(kind)!.map((a) => ({ content: a.content, artifactId: a.id, version: a.version })),
  }));

  return { sessionId, generatedAt: new Date().toISOString(), sections };
}

export function renderOnePagerMarkdown(plan: OnePagePlan): string {
  const lines = [`# One-Page Plan`, ``, `_Generated ${plan.generatedAt}_`, ``];
  for (const section of plan.sections) {
    lines.push(`## ${section.label}`, ``);
    for (const item of section.items) {
      lines.push(`- ${item.content}`);
    }
    lines.push(``);
  }
  return lines.join("\n");
}
