import { Dashboard } from '../src/projects/Dashboard';
import { getServerSession } from '../src/session/server-session';
import { Notice } from '../src/ui/feedback';

export default async function HomePage() {
  const session = await getServerSession();
  if (session) return <Dashboard session={session} />;
  return (
    <>
      <h1>Predictive Bioequivalence Engine</h1>
      <p>
        PBE supports pre-pivotal bioequivalence risk assessment. Sign in to see your organisation’s
        projects.
      </p>
      <Notice tone="info" title="Development build">
        <p>
          Check whether the API and database are available on the{' '}
          <a href="/status">system status</a> page.
        </p>
      </Notice>
    </>
  );
}
