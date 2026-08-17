import { useState, type FormEvent } from "react";
import { Landmark, ArrowRight, Sparkles } from "lucide-react";
import { api } from "../../lib/api";
import { ErrorBanner } from "./bits";

export interface SetupResult {
  /** Real org id once the API answers; the URL slug when running local-only. */
  orgId: string;
  programId: string;
  orgName: string;
  leaderUserId?: string;
  localOnly?: boolean;
}

interface SetupProps {
  /** Org slug from the URL — the fallback org id when the API is unreachable. */
  orgId: string;
  onComplete: (result: SetupResult) => void;
}

const ORG_TYPES = [
  { value: "church", label: "Church" },
  { value: "parachurch", label: "Parachurch" },
  { value: "nonprofit", label: "Nonprofit" },
  { value: "school", label: "School" },
] as const;

type OrgType = (typeof ORG_TYPES)[number]["value"];

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "team"
  );
}

/**
 * Org setup: name the organization, then create the program it will run.
 * Creates a leader user when a name is given, so consent and step owners
 * can reference a real user. The demo path auto-creates everything with
 * one click (and falls back to local-only state when the API is down).
 */
export default function Setup({ orgId, onComplete }: SetupProps) {
  const [orgName, setOrgName] = useState("");
  const [orgType, setOrgType] = useState<OrgType>("church");
  const [leaderName, setLeaderName] = useState("");
  const [busy, setBusy] = useState<"create" | "demo" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function createOrgAndProgram(name: string, type: OrgType, leader: string): Promise<SetupResult> {
    // The endpoint requires an organization type even though the typed
    // client body only declares `name` — send the full shape it expects.
    const org = await api.createOrg({ name, type });

    let leaderUserId: string | undefined;
    if (leader.trim()) {
      try {
        const user = await api.createUser(org.id, {
          name: leader.trim(),
          email: slugify(leader) + "@" + slugify(name) + ".local",
          role: "leader",
        });
        leaderUserId = user.id;
      } catch {
        /* leader creation is a convenience — proceed without a stored user */
      }
    }

    const program = await api.createProgram(org.id);
    return { orgId: org.id, programId: program.id, orgName: name, leaderUserId };
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!orgName.trim()) {
      setError("Give your organization a name — it will head every page of this workspace.");
      return;
    }
    setBusy("create");
    setError(null);
    try {
      const result = await createOrgAndProgram(orgName.trim(), orgType, leaderName);
      onComplete(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleDemo() {
    setBusy("demo");
    setError(null);
    try {
      const result = await createOrgAndProgram("Demo leadership team", "church", "");
      onComplete(result);
    } catch {
      // API unreachable — keep the screens browsable on local state.
      onComplete({ orgId, programId: crypto.randomUUID(), orgName: "Demo (local)", localOnly: true });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className="w-full max-w-xl">
        <div className="flex items-center gap-2">
          <Landmark className="h-7 w-7 text-brand" aria-hidden />
          <span className="font-display text-xl font-semibold">Groundwork</span>
        </div>

        <div className="card mt-6 p-8">
          <p className="chip bg-accent-soft text-accent">Four labs, one arc</p>
          <h1 className="mt-4 text-3xl">Set up your program</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            A name and one person to lead the room is all you need to start. The
            program runs four full-day labs — Purpose, Vision, Risks, Strategy —
            and everything your team produces lands on this dashboard.
          </p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-5">
            <div>
              <label className="label" htmlFor="org-name">Organization name</label>
              <input
                id="org-name"
                className="input"
                placeholder="e.g. Grace Community Church"
                value={orgName}
                autoComplete="organization"
                onChange={(e) => {
                  setOrgName(e.target.value);
                  setError(null);
                }}
              />
            </div>

            <div>
              <span className="label">What kind of organization?</span>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Organization type">
                {ORG_TYPES.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    role="radio"
                    aria-checked={orgType === t.value}
                    className={"chip justify-center border py-2 " + (orgType === t.value ? "border-brand bg-brand text-white" : "border-line-strong bg-surface text-muted hover:text-ink")}
                    onClick={() => setOrgType(t.value)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="label" htmlFor="leader-name">
                Your name <span className="normal-case text-faint">(optional)</span>
              </label>
              <input
                id="leader-name"
                className="input"
                placeholder="Who is leading this program?"
                value={leaderName}
                autoComplete="name"
                onChange={(e) => setLeaderName(e.target.value)}
              />
              <p className="mt-1.5 text-xs text-muted">
                Used to record consent and own initiative steps. You can skip this and add people later.
              </p>
            </div>

            {error && <ErrorBanner>{error}</ErrorBanner>}

            <button className="btn btn-primary w-full" type="submit" disabled={busy !== null}>
              {busy === "create" ? "Creating your program…" : "Create program"}
              <ArrowRight className="h-4 w-4" aria-hidden />
            </button>
          </form>

          <div className="mt-5 flex items-center gap-3 text-xs text-faint">
            <span className="h-px flex-1 bg-line" aria-hidden />
            or
            <span className="h-px flex-1 bg-line" aria-hidden />
          </div>

          <button className="btn btn-ghost mt-5 w-full" onClick={handleDemo} disabled={busy !== null}>
            <Sparkles className="h-4 w-4" aria-hidden />
            {busy === "demo" ? "Setting up a demo…" : "Use a demo program"}
          </button>
          <p className="mt-3 text-center text-xs text-muted">
            The demo creates a sample program so you can see the dashboard before your first lab.
          </p>
        </div>

        </div>
    </div>
  );
}