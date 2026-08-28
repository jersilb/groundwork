import { Link } from "react-router-dom";
import {
  CalendarDays,
  Check,
  ClipboardList,
  Landmark,
  Monitor,
  RefreshCw,
  ScrollText,
  Smartphone,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import InstallPrompt from "../install/InstallPrompt";

/**
 * Landing page. Owned by the frontend UX agent: marketing copy for church
 * leadership teams, the four-session arc, and the two-screen room
 * experience. CTAs: start a program, join a session by code.
 */

interface Step {
  num: string;
  icon: LucideIcon;
  title: string;
  body: string;
}

const SESSIONS: Step[] = [
  {
    num: "01",
    icon: CalendarDays,
    title: "Book four sessions",
    body: "Pick four dates your whole team can keep. The facilitator runs the room; you bring the leadership.",
  },
  {
    num: "02",
    icon: Smartphone,
    title: "Every voice contributes",
    body: "Everyone responds from their phone — ideas, votes, honest input, with no one playing to the room.",
  },
  {
    num: "03",
    icon: ScrollText,
    title: "The room converges",
    body: "After each session the facilitator synthesizes what was said into decisions, and the one-page plan takes shape.",
  },
  {
    num: "04",
    icon: RefreshCw,
    title: "Keep it alive",
    body: "A sustain rhythm — the dashboard, quarterly reviews, a yearly renewal lab — keeps the plan running long after.",
  },
];

export default function Landing() {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2">
          <Landmark className="h-7 w-7 text-brand" aria-hidden />
          <span className="font-display text-xl font-semibold">Groundwork</span>
        </div>
        <nav className="flex items-center gap-3">
          <a href="#how" className="hidden text-sm font-semibold text-brand sm:inline">
            How it works
          </a>
          <Link to="/join" className="btn btn-ghost">
            Join a session
          </Link>
          <Link to="/org/demo" className="btn btn-primary">
            Start your plan
          </Link>
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-6">
        {/* Hero */}
        <section className="pb-16 pt-16 text-center sm:pt-20">
          <p className="chip bg-accent-soft text-accent">
            Strategic planning for church leadership teams
          </p>
          <h1 className="mx-auto mt-5 max-w-3xl text-4xl leading-tight sm:text-5xl">
            A plan your leadership team actually runs.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-muted">
            Four full-day sessions, guided start to finish. Every voice in the room is heard —
            from the front row to the back — and each session ends with decisions on paper
            you can act on the next day.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link to="/org/demo" className="btn btn-accent text-base">
              Start your program
            </Link>
            <Link to="/join" className="btn btn-ghost text-base">
              I have a session code
            </Link>
          </div>
          <p className="mt-5 text-sm text-muted">
            Start with your first segments free — no card, no countdown.
          </p>
        </section>

        {/* Value props */}
        <section className="grid gap-5 pb-20 sm:grid-cols-3">
          {[
            {
              icon: Users,
              title: "Every voice counted",
              body: "Phones in hand, everyone contributes and votes. The quietest person in the room gets heard — not just the loudest.",
            },
            {
              icon: CalendarDays,
              title: "Four sessions, one arc",
              body: "Purpose, vision, risks, and strategy build on each other across four full-day sessions your whole team keeps.",
            },
            {
              icon: ClipboardList,
              title: "A plan, not a binder",
              body: "Synthesis turns the room's work into a one-page plan your team can edit, own, and actually use.",
            },
          ].map((f) => (
            <div key={f.title} className="card p-6">
              <f.icon className="h-8 w-8 text-brand" aria-hidden />
              <h3 className="mt-3 text-xl">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{f.body}</p>
            </div>
          ))}
        </section>

        {/* How it works */}
        <section id="how" className="pb-20">
          <div className="mx-auto max-w-2xl text-center">
            <p className="label">How it runs</p>
            <h2 className="mt-1 text-3xl sm:text-4xl">Four sessions. Every voice. One plan.</h2>
            <p className="mt-3 leading-relaxed text-muted">
              A Groundwork program is a rhythm for your leadership year — not a workshop that
              ends in the parking lot.
            </p>
          </div>
          <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {SESSIONS.map((s) => (
              <div key={s.num} className="card relative p-6">
                <span
                  className="absolute right-5 top-4 font-display text-4xl font-semibold text-line-strong"
                  aria-hidden
                >
                  {s.num}
                </span>
                <s.icon className="h-7 w-7 text-accent" aria-hidden />
                <h3 className="mt-3 text-lg">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{s.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Two screens, one room */}
        <section className="pb-20">
          <div className="mx-auto max-w-2xl text-center">
            <p className="label">In the room</p>
            <h2 className="mt-1 text-3xl sm:text-4xl">Two screens, one room</h2>
            <p className="mt-3 leading-relaxed text-muted">
              The shared screen runs the session and keeps everyone together. Phones put the
              same questions in every hand — and make sure every answer is counted.
            </p>
          </div>

          <div className="mt-10 grid gap-6 lg:grid-cols-[1.35fr_1fr]">
            {/* Shared screen */}
            <div className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-line bg-brand px-5 py-3">
                <span className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Monitor className="h-4 w-4" aria-hidden /> Shared screen
                </span>
                <span className="chip border border-inverse-border bg-inverse-fill-weak text-inverse">
                  Room ABC-123
                </span>
              </div>
              <div className="space-y-3 bg-surface p-5">
                <div className="rounded-lg border border-line bg-paper p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold">What are we here for?</p>
                    <span className="chip bg-ok-soft text-ok">6 replies</span>
                  </div>
                  <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-line">
                    <div className="h-full w-3/4 rounded-full bg-ok" />
                  </div>
                  <p className="mt-2 text-xs text-muted">
                    Segment 1 of 2 · everyone has responded
                  </p>
                </div>
                <div className="rounded-lg border border-line bg-paper p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold">What does a win look like in a year?</p>
                    <span className="chip bg-accent-soft text-accent">Vote open</span>
                  </div>
                  <div className="mt-3 flex h-9 gap-1.5">
                    <div className="flex-1 rounded-md bg-brand-alpha-15" />
                    <div className="flex-[0.65] rounded-md bg-brand-alpha-25" />
                    <div className="flex-[0.4] rounded-md bg-brand-alpha-40" />
                  </div>
                  <p className="mt-2 text-xs text-muted">
                    Live results on the screen, where everyone can see them
                  </p>
                </div>
              </div>
            </div>

            {/* Phone */}
            <div className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-line px-5 py-3">
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <Smartphone className="h-4 w-4 text-brand" aria-hidden /> Your phone
                </span>
                <span className="chip bg-ok-soft text-ok">
                  <Check className="h-3.5 w-3.5" aria-hidden /> Counted
                </span>
              </div>
              <div className="bg-surface p-5">
                <p className="label">Your answer</p>
                <p className="text-sm leading-relaxed text-ink">
                  What would it take for this to be a year you're proud of?
                </p>
                <div className="mt-3 rounded-lg border border-line-strong bg-white px-4 py-3 text-sm text-faint">
                  Type your answer — it lands on the shared screen with everyone else's.
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <span className="btn btn-primary text-sm">Submit</span>
                  <span className="text-xs leading-snug text-muted">
                    No account needed — just the room code.
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <span className="chip bg-ok-soft text-ok">
              <Check className="h-3.5 w-3.5" aria-hidden /> No accounts for participants
            </span>
            <span className="chip bg-brand-soft text-brand">
              <Smartphone className="h-3.5 w-3.5" aria-hidden /> Works in any mobile browser
            </span>
            <span className="chip bg-accent-soft text-accent">
              <ScrollText className="h-3.5 w-3.5" aria-hidden /> Everything lands in the plan
            </span>
          </div>
        </section>

        {/* Final CTA */}
        <section className="pb-20">
          <div className="rounded-card bg-brand px-8 py-12 text-center sm:px-14">
            <h2 className="text-3xl text-white">Your first segments are free.</h2>
            <p className="mx-auto mt-3 max-w-xl leading-relaxed text-inverse-muted">
              Try the real process with your real team before a dollar is due. No card, no
              countdown.
            </p>
            <div className="mt-7 flex flex-wrap justify-center gap-3">
              <Link to="/org/demo" className="btn btn-accent text-base">
                Start your program
              </Link>
              <Link
                to="/join"
                className="btn btn-inverse text-base"
              >
                I have a session code
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-8 gap-y-4 px-6 py-6">
          <div className="flex items-center gap-2">
            <Landmark className="h-5 w-5 text-brand" aria-hidden />
            <span className="font-display text-base font-semibold">Groundwork</span>
          </div>
          <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <a href="#how" className="font-semibold text-brand">
              How it works
            </a>
            <Link to="/install" className="font-semibold text-brand">
              Install on your phone
            </Link>
            <Link to="/join" className="font-semibold text-brand">
              Join a session
            </Link>
          </nav>
          <p className="text-xs text-muted">Strategic planning for church leadership teams.</p>
        </div>
      </footer>

      <InstallPrompt />
    </div>
  );
}
