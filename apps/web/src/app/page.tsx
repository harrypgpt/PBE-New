import { checkApiHealth, type ApiHealth } from '../lib/api-health';

// Checked on every request, never at build time, so the build does not need a running API.
export const dynamic = 'force-dynamic';

const STATUS_TEXT: Record<ApiHealth['state'], string> = {
  reachable: 'API reachable',
  'unexpected-response': 'API responded unexpectedly',
  unreachable: 'API not reachable',
};

export default async function HomePage() {
  const health = await checkApiHealth(process.env.PBE_API_BASE_URL ?? 'http://127.0.0.1:4000');

  return (
    <main className="shell">
      <p className="eyebrow">Stage 1 · Repository skeleton</p>
      <h1>PBE — Predictive Bioequivalence Engine</h1>
      <p className="lead">
        Application shell only. No scientific, prediction or business features are available yet.
      </p>
      <p className={`status status-${health.state}`} role="status">
        {STATUS_TEXT[health.state]}
      </p>
      <aside className="disclaimer">
        <strong>Draft disclaimer (wording pending review, OD-019):</strong> PBE outputs are
        decision-support estimates with stated uncertainty and limitations. They do not establish
        bioequivalence and do not replace any required regulatory study.
      </aside>
    </main>
  );
}
