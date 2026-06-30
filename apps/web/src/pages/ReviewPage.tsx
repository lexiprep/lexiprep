import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  getReviewSession,
  getReviewStats,
  getReviewWords,
  getSettings,
  gradeCard,
  listBooks,
  updateSettings,
  type GradePreview,
  type ReviewCard,
  type ReviewSession,
  type ReviewWord,
  type UserSettings,
  type WordSense,
} from "../lib/api";
import { usePersistentState } from "../lib/usePersistentState";
import { formSetOf, highlightForms } from "../lib/highlight";
import { HelpTip } from "../components/HelpTip";
import { WordMeaning } from "../components/WordMeaning";
import { LevelBadge } from "../components/badges";
import { LevelRange } from "../components/LevelRange";

const LANG = "en";

// When an Again/Hard card "stays" in the session, slot it back this many cards behind the
// head so a couple of other cards show before it returns (sub-day reshow without an
// immediate repeat).
const REINSERT_OFFSET = 3;

// IANA zones for the timezone select. Feature-detected so the build doesn't depend on the
// `Intl.supportedValuesOf` lib typing being present; falls back to a free-text field.
const TIMEZONES: string[] = (() => {
  const fn = (Intl as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;
  try {
    return fn ? fn("timeZone") : [];
  } catch {
    return [];
  }
})();

type Phase = "menu" | "review" | "done" | "practice";

/**
 * The minimal card shape the review surface renders. Both a daily {@link ReviewCard} (rich:
 * definition + interval preview) and a free-practice {@link ReviewWord} (no preview yet) map
 * onto it; `preview` is null until a grade response supplies fresh interval labels.
 */
interface DisplayCard {
  lemma: string;
  word: string;
  example: string | null;
  level: string | null;
  definition: WordSense[] | null;
  /** Representative book — lets the back show a per-book note editor. */
  bookId: string | null;
  bookTitle: string | null;
  /** The user's own note (custom meaning) for that book, or null. */
  note: string | null;
  /** Surface forms to bold in the context sentence. */
  forms: string[];
  preview: GradePreview | null;
}

const fromCard = (c: ReviewCard): DisplayCard => ({
  lemma: c.lemma,
  word: c.word,
  example: c.example,
  level: c.level,
  definition: c.definition,
  bookId: c.bookId,
  bookTitle: c.bookTitle,
  note: c.note,
  forms: c.forms,
  preview: c.preview,
});

const fromWord = (w: ReviewWord): DisplayCard => ({
  lemma: w.word, // ReviewWord.word is the base form (lemma) — what grading keys on.
  word: w.word,
  example: w.example,
  level: w.level,
  definition: null,
  bookId: w.bookId,
  bookTitle: w.bookTitle,
  note: null,
  forms: [w.word],
  preview: null,
});

/** Fisher–Yates shuffle (UI-only randomness) so each session presents cards in a fresh order. */
function shuffle<T>(items: T[]): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

type Grade = 1 | 2 | 3 | 4;
const GRADES: { grade: Grade; key: keyof GradePreview; label: string; cls: string }[] = [
  { grade: 1, key: "again", label: "Again", cls: "again" },
  { grade: 2, key: "hard", label: "Hard", cls: "hard" },
  { grade: 3, key: "good", label: "Good", cls: "good" },
  { grade: 4, key: "easy", label: "Easy", cls: "easy" },
];

/**
 * The spaced-repetition review game. One page, three phases driven by local state:
 *  - **menu** — streak + assembled due/new counts, the new-card filter (book + CEFR range),
 *    and Start. The filter scopes only *new* cards; due reviews are always global.
 *  - **review** / **practice** — an in-memory queue showing one card at a time: front (just the
 *    word) → flip → back (context + definition + your note) → grade Again/Hard/Good/Easy.
 *    Again/Hard reshow the card a few positions back this session; Good/Easy write it out.
 *    `practice` is the
 *    uncapped "keep going" mode pulled from the Learning list.
 *  - **done** — "done for today" + keep-practicing.
 * Plus a collapsible settings panel.
 */
export function ReviewPage() {
  const qc = useQueryClient();

  const [phase, setPhase] = useState<Phase>("menu");
  const [queue, setQueue] = useState<DisplayCard[]>([]);
  // The answer is revealed per *card* (keyed by lemma), so any change of the top card — a new
  // session, a re-entry, a reshuffle, the next card after a grade — resets back to the front.
  const [revealedLemma, setRevealedLemma] = useState<string | null>(null);
  // Counts captured at Start (new/due/totalDue) — the header's denominators. Null in practice.
  const [counts, setCounts] = useState<ReviewSession["counts"] | null>(null);

  // New-card filter — persisted across visits (its own keyspace, distinct from book/vocab).
  const [bookId, setBookId] = usePersistentState("lexiprep.review.bookId", "");
  const [minLevel, setMinLevel] = usePersistentState("lexiprep.review.minLevel", "");
  const [maxLevel, setMaxLevel] = usePersistentState("lexiprep.review.maxLevel", "");

  const booksQ = useQuery({ queryKey: ["books"], queryFn: listBooks });
  const readyBooks = (booksQ.data ?? []).filter((b) => b.status === "ready");

  // Always-on so the streak refreshes after each grade (invalidated under ["review"]).
  const statsQ = useQuery({ queryKey: ["review", "stats"], queryFn: getReviewStats });

  // Assembled session — only fetched while the menu is showing, so grading never pulls a
  // fresh deck out from under the in-memory queue.
  const sessionQ = useQuery({
    queryKey: ["review", "session", { bookId, minLevel, maxLevel }],
    queryFn: () =>
      getReviewSession({
        bookId: bookId || undefined,
        minLevel: minLevel || undefined,
        maxLevel: maxLevel || undefined,
      }),
    enabled: phase === "menu",
    placeholderData: keepPreviousData,
  });

  const streak = statsQ.data?.dayStreak ?? sessionQ.data?.streak ?? 0;
  const head = queue[0];
  const revealed = !!head && revealedLemma === head.lemma;

  // ── Session lifecycle ──────────────────────────────────────────────────────

  function startSession() {
    const data = sessionQ.data;
    if (!data || data.cards.length === 0) return;
    setQueue(shuffle(data.cards.map(fromCard)));
    setCounts(data.counts);
    setRevealedLemma(null);
    setPhase("review");
  }

  function endSession() {
    setQueue([]);
    setRevealedLemma(null);
    setCounts(null);
    setPhase("menu");
    qc.invalidateQueries({ queryKey: ["review"] });
  }

  // Free practice: pull learning words under the current filter into the same card UI. Does
  // not move the daily counters (no `counts`). Grading still schedules normally.
  const practice = useMutation({
    mutationFn: () =>
      getReviewWords({
        status: "learning",
        limit: 100,
        offset: 0,
        bookId: bookId || undefined,
        minLevel: minLevel || undefined,
        maxLevel: maxLevel || undefined,
        sort: "count:desc",
      }),
    onSuccess: (res) => {
      if (res.words.length === 0) {
        toast("No learning words to practice under this filter.");
        return;
      }
      setQueue(shuffle(res.words.map(fromWord)));
      setCounts(null);
      setRevealedLemma(null);
      setPhase("practice");
    },
    onError: (err) =>
      toast.error(
        err instanceof Error && err.message ? err.message : "Couldn't load practice words.",
      ),
  });

  // When the queue drains, the session/practice run is over.
  useEffect(() => {
    if ((phase === "review" || phase === "practice") && queue.length === 0) {
      setPhase("done");
    }
  }, [phase, queue.length]);

  // ── Grading ────────────────────────────────────────────────────────────────

  const grade = useMutation({
    mutationFn: (v: { lemma: string; grade: Grade }) => gradeCard(v.lemma, v.grade),
    onSuccess: (res, v) => {
      setQueue((prev) => {
        const idx = prev.findIndex((c) => c.lemma === v.lemma);
        if (idx === -1) return prev; // gone already — nothing to do
        const next = prev.slice();
        const [card] = next.splice(idx, 1);
        // stays → sub-day learning/relearning step: reshow a few cards later with fresh
        // interval labels. Otherwise it's scheduled days out and leaves the queue.
        if (res.stays && card) {
          const pos = Math.min(idx + REINSERT_OFFSET, next.length);
          next.splice(pos, 0, { ...card, preview: res.card.preview });
        }
        return next;
      });
      // Counts/streak (and vocabulary, if a card auto-graduated to known) may have moved.
      qc.invalidateQueries({ queryKey: ["review"] });
      qc.invalidateQueries({ queryKey: ["vocab-counts"] });
      qc.invalidateQueries({ queryKey: ["words"] });
    },
    onError: (err, v) => {
      // A card whose lemma was marked known/ignored elsewhere is no longer gradable — drop
      // it and move on rather than block the session.
      setQueue((prev) => prev.filter((c) => c.lemma !== v.lemma));
      toast.error(
        err instanceof Error && err.message ? err.message : `Couldn't grade “${v.lemma}”.`,
      );
    },
    onSettled: () => setRevealedLemma(null),
  });

  // Persist a saved/removed note back onto the queued card so its "my definition" view stays
  // consistent if the card reshows later this session.
  const setCardNote = (lemma: string, note: string | null) =>
    setQueue((prev) => prev.map((c) => (c.lemma === lemma ? { ...c, note } : c)));

  function submitGrade(g: Grade) {
    if (!head || !revealed || grade.isPending) return;
    grade.mutate({ lemma: head.lemma, grade: g });
  }

  // Keyboard: Space flips to the answer; 1–4 grade once flipped. Ignored while typing in the
  // settings panel.
  const gradePending = grade.isPending;
  useEffect(() => {
    if (phase !== "review" && phase !== "practice") return;
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === " ") {
        e.preventDefault();
        if (head && !revealed) setRevealedLemma(head.lemma);
        return;
      }
      if (!revealed || !head || gradePending) return;
      if (e.key >= "1" && e.key <= "4") {
        e.preventDefault();
        grade.mutate({ lemma: head.lemma, grade: Number(e.key) as Grade });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, revealed, head, gradePending]);

  // ── Render ───────────────────────────────────────────────────────────────────

  if (phase === "review" || phase === "practice") {
    return (
      <section>
        <ReviewSurface
          head={head}
          revealed={revealed}
          counts={phase === "practice" ? null : counts}
          remaining={queue.length}
          streak={streak}
          practiceMode={phase === "practice"}
          bookScoped={!!bookId}
          gradePending={gradePending}
          onReveal={() => head && setRevealedLemma(head.lemma)}
          onGrade={submitGrade}
          onNoteSaved={setCardNote}
          onExit={endSession}
        />
      </section>
    );
  }

  if (phase === "done") {
    return (
      <section>
        <div className="page-head">
          <h2>Review</h2>
        </div>
        <div className="card done-card">
          <div className="done-emoji">🎉</div>
          <h2>Done for today</h2>
          <p className="muted">
            🔥 {streak}-day streak
            {statsQ.data ? ` · ${statsQ.data.reviewedToday} reviewed today` : ""}
          </p>
          <div className="done-actions">
            <button
              className="btn primary"
              disabled={practice.isPending}
              onClick={() => practice.mutate()}
            >
              {practice.isPending ? "Loading…" : "Keep practicing"}
            </button>
            <button className="btn ghost" onClick={() => setPhase("menu")}>
              Back to menu
            </button>
          </div>
          <p className="muted small">
            Practice pulls extra learning words under your filter — it doesn't move today's
            counts.
          </p>
        </div>
      </section>
    );
  }

  // phase === "menu"
  const session = sessionQ.data;
  const canStart =
    !sessionQ.isFetching && !!session && session.cards.length > 0;

  return (
    <section>
      <div className="page-head">
        <h2>Review</h2>
      </div>

      <div className="card streak-card">
        <span className="streak-flame">🔥</span>
        <div>
          <div className="streak-num num">{streak}</div>
          <div className="muted small">day streak</div>
        </div>
        {statsQ.data && (
          <div className="streak-side muted small">
            {statsQ.data.reviewedToday.toLocaleString()} reviewed today ·{" "}
            {statsQ.data.reviewedAllTime.toLocaleString()} all-time
          </div>
        )}
      </div>

      <div className="card review-menu">
        <div className="rm-head">
          <h3>Today's session</h3>
          <HelpTip
            content={
              <span>
                The book and level filter scopes only the <strong>new</strong> cards
                introduced this session. Due reviews are always included, whatever book
                they came from.
              </span>
            }
          />
        </div>

        <div className="toolbar">
          <label className="ctl">
            Book
            <select value={bookId} onChange={(e) => setBookId(e.target.value)}>
              <option value="">All books</option>
              {readyBooks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.title}
                </option>
              ))}
            </select>
          </label>

          <LevelRange
            from={minLevel}
            to={maxLevel}
            onChange={({ from, to }) => {
              setMinLevel(from);
              setMaxLevel(to);
            }}
          />
        </div>

        {sessionQ.isLoading ? (
          <p className="muted">Assembling session…</p>
        ) : sessionQ.isError ? (
          <p className="error">Couldn't assemble a session. Try again.</p>
        ) : session ? (
          <p className="stats-line muted small">
            <strong>{session.counts.due.toLocaleString()}</strong> due ·{" "}
            <strong>{session.counts.new.toLocaleString()}</strong> new
            {session.counts.totalDue > session.counts.due &&
              ` · ${(session.counts.totalDue - session.counts.due).toLocaleString()} more due beyond today's cap`}
          </p>
        ) : null}

        <button className="btn primary rm-start" disabled={!canStart} onClick={startSession}>
          Start review
        </button>
        {session && session.cards.length === 0 && (
          <p className="muted small">
            Nothing to review right now. Mark some words as Learning, or widen the new-card
            filter.
          </p>
        )}
      </div>

      <SettingsPanel />
    </section>
  );
}

// ── Review surface ─────────────────────────────────────────────────────────────

function ReviewSurface({
  head,
  revealed,
  counts,
  remaining,
  streak,
  practiceMode,
  bookScoped,
  gradePending,
  onReveal,
  onGrade,
  onNoteSaved,
  onExit,
}: {
  head: DisplayCard | undefined;
  revealed: boolean;
  counts: ReviewSession["counts"] | null;
  remaining: number;
  streak: number;
  practiceMode: boolean;
  bookScoped: boolean;
  gradePending: boolean;
  onReveal: () => void;
  onGrade: (g: Grade) => void;
  onNoteSaved: (lemma: string, note: string | null) => void;
  onExit: () => void;
}) {
  return (
    <>
      <div className="review-head card">
        <div className="rev-counts">
          {practiceMode ? (
            <span className="pill blue">Practice</span>
          ) : (
            counts && (
              <>
                <span className="rev-stat">
                  <strong>{counts.new}</strong> new
                </span>
                <span className="rev-stat">
                  <strong>{counts.due}</strong> due
                </span>
              </>
            )
          )}
          <span className="rev-stat">
            <strong>{remaining}</strong> left
          </span>
          {counts && counts.totalDue > counts.due && (
            <span className="muted small">+{counts.totalDue - counts.due} more due</span>
          )}
        </div>
        <span className="grow" />
        <span className="streak-mini">🔥 {streak}</span>
        <button className="btn ghost slim" onClick={onExit}>
          Exit
        </button>
      </div>

      {!head ? (
        <p className="muted empty center">No card to show.</p>
      ) : (
        <div className="card review-card">
          <div className="rc-front">
            <div className="rc-word-row">
              <h2 className="rc-word">{head.word}</h2>
              {head.level && <LevelBadge level={head.level} />}
            </div>
          </div>

          {!revealed ? (
            <div className="rc-reveal">
              <button className="btn primary rc-show" onClick={onReveal}>
                Show answer
              </button>
              <p className="muted small">
                Press <kbd>Space</kbd>
              </p>
            </div>
          ) : (
            <>
              <div className="rc-back">
                {head.example && (
                  <p className="example rc-context">
                    “{highlightForms(head.example, formSetOf(head.lemma, ...head.forms))}”
                  </p>
                )}
                <WordMeaning
                  bookId={head.bookId}
                  word={head.lemma}
                  definition={head.definition}
                  note={head.note}
                  bookScoped={bookScoped}
                  maxSenses={5}
                  onNoteSaved={(note) => onNoteSaved(head.lemma, note)}
                />
              </div>

              <div className="grade-row">
                {GRADES.map((g) => (
                  <button
                    key={g.grade}
                    className={`grade-btn ${g.cls}`}
                    disabled={gradePending}
                    onClick={() => onGrade(g.grade)}
                  >
                    <span className="grade-label">{g.label}</span>
                    {head.preview && (
                      <span className="grade-when">({head.preview[g.key]})</span>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

// ── Settings panel ─────────────────────────────────────────────────────────────

function SettingsPanel() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<UserSettings | null>(null);

  const settingsQ = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  useEffect(() => {
    if (settingsQ.data) setForm(settingsQ.data);
  }, [settingsQ.data]);

  const save = useMutation({
    mutationFn: (patch: Partial<UserSettings>) => updateSettings(patch),
    onSuccess: (data) => {
      qc.setQueryData(["settings"], data);
      setForm(data);
      // new/max-per-day reshape future sessions; refresh the menu's assembled counts.
      qc.invalidateQueries({ queryKey: ["review"] });
      toast.success("Settings saved.");
    },
    onError: (err) =>
      toast.error(
        err instanceof Error && err.message ? err.message : "Couldn't save settings.",
      ),
  });

  const update = (patch: Partial<UserSettings>) =>
    setForm((f) => (f ? { ...f, ...patch } : f));

  const dirty =
    !!form && !!settingsQ.data && JSON.stringify(form) !== JSON.stringify(settingsQ.data);

  return (
    <div className="card settings-panel">
      <button
        className="settings-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span>Review settings</span>
        <span className="chev">{open ? "▲" : "▼"}</span>
      </button>

      {open &&
        (form ? (
          <div className="settings-body">
            <label className="setting-row">
              <span className="setting-label">
                New cards / day
                <HelpTip content="How many brand-new words to introduce each day. Reshows of cards you're still learning don't count against this." />
              </span>
              <input
                type="number"
                min={0}
                value={form.newPerDay}
                onChange={(e) => update({ newPerDay: Number(e.target.value) || 0 })}
              />
            </label>

            <label className="setting-row">
              <span className="setting-label">
                Max cards / day
                <HelpTip content="Upper bound on the whole session (due + new). Protects you from a huge backlog when you've skipped a few days." />
              </span>
              <input
                type="number"
                min={0}
                value={form.maxPerDay}
                onChange={(e) => update({ maxPerDay: Number(e.target.value) || 0 })}
              />
            </label>

            <label className="setting-row checkbox">
              <input
                type="checkbox"
                checked={form.autoGraduateKnown}
                onChange={(e) => update({ autoGraduateKnown: e.target.checked })}
              />
              <span className="setting-label">
                Auto-graduate to Known
                <HelpTip content="When a word reaches roughly a year-long interval with a recall streak, mark it Known automatically so it leaves review. Off by default." />
              </span>
            </label>

            <label className="setting-row">
              <span className="setting-label">
                Timezone
                <HelpTip content="Sets the day boundary used for your streak and daily counts. Defaults to UTC." />
              </span>
              {TIMEZONES.length > 0 ? (
                <select
                  value={form.timezone ?? ""}
                  onChange={(e) => update({ timezone: e.target.value || null })}
                >
                  <option value="">UTC (default)</option>
                  {TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  placeholder="e.g. Europe/Zurich"
                  value={form.timezone ?? ""}
                  onChange={(e) => update({ timezone: e.target.value || null })}
                />
              )}
            </label>

            <div className="settings-actions">
              <button
                className="btn primary"
                disabled={!dirty || save.isPending}
                onClick={() => form && save.mutate(form)}
              >
                {save.isPending ? "Saving…" : "Save settings"}
              </button>
            </div>
          </div>
        ) : (
          <div className="settings-body">
            <p className="muted small">Loading settings…</p>
          </div>
        ))}
    </div>
  );
}
