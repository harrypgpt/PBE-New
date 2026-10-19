import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <>
      <h1>Page not found</h1>
      <p>The page you asked for does not exist.</p>
      <p>
        <a href="/">Go to the home page</a>
      </p>
    </>
  );
}
