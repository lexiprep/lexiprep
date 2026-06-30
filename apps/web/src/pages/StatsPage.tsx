import { ReviewStats } from "../components/ReviewStats";
import { VocabularyStats } from "../components/VocabularyStats";

/** Top-level Stats page: review (SRS) stats plus vocabulary growth over a date range. */
export function StatsPage() {
  return (
    <section>
      <div className="page-head">
        <h2>Stats</h2>
      </div>

      <h3 style={{ margin: "0 0 12px" }}>Review</h3>
      <ReviewStats />

      <h3 style={{ margin: "28px 0 12px" }}>Vocabulary</h3>
      <VocabularyStats />
    </section>
  );
}
