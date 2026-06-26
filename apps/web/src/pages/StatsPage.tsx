import { VocabularyStats } from "../components/VocabularyStats";

/** Top-level Stats page: vocabulary growth charts over a selectable date range. */
export function StatsPage() {
  return (
    <section>
      <div className="page-head">
        <h2>Stats</h2>
      </div>
      <VocabularyStats />
    </section>
  );
}
