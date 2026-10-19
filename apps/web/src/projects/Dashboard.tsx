import type { UiSession } from '../session/session';
import { hasPermission } from '../session/session';
import { Notice } from '../ui/feedback';
import adminStyles from '../admin/admin.module.css';
import { ProjectsList } from './ProjectsList';
import styles from './projects.module.css';

/**
 * Dashboard (STAGE-08-PLAN.md §5): who you are, where you work, your projects, and what is still
 * to come. Tasks and runs arrive in later stages; the page says so plainly instead of showing
 * invented data.
 */
export function Dashboard({ session }: { readonly session: UiSession }) {
  const canRead = hasPermission(session, 'tenant.projects.read');
  const canCreate = hasPermission(session, 'tenant.projects.create');
  return (
    <>
      <h1>Dashboard</h1>
      <p>{`Welcome, ${session.user.displayName}.`}</p>
      {session.tenant ? (
        <p>
          {`You are working in ${session.tenant.name}. `}
          <a href="/organisation">Switch organisation</a>
        </p>
      ) : (
        <Notice tone="info" title="Choose an organisation">
          <p>
            Projects belong to an organisation. Go to <a href="/organisation">Organisation</a> and
            choose the one you want to work in.
          </p>
        </Notice>
      )}
      {session.tenant && (canRead || canCreate) ? (
        <section className={adminStyles.section} aria-labelledby="quick-actions-heading">
          <h2 id="quick-actions-heading">Quick actions</h2>
          <ul className={adminStyles.list}>
            {canCreate ? (
              <li>
                <a href="/projects/new">Create a project</a>
              </li>
            ) : null}
            {canRead ? (
              <li>
                <a href="/projects">See all projects</a>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}
      {session.tenant && canRead ? (
        <section className={adminStyles.section} aria-labelledby="your-projects-heading">
          <h2 id="your-projects-heading">Your projects</h2>
          <ProjectsList caption="Recently changed active projects" limit={10} />
        </section>
      ) : null}
      <div className={styles.cards}>
        <section className={styles.card} aria-labelledby="tasks-heading">
          <h2 id="tasks-heading">Pending tasks</h2>
          <p>
            You have no pending tasks. Review tasks will appear here once evidence review is
            available.
          </p>
        </section>
        <section className={styles.card} aria-labelledby="runs-heading">
          <h2 id="runs-heading">Recent runs</h2>
          <p>No runs yet. Assessments cannot be run in this version.</p>
        </section>
      </div>
    </>
  );
}
