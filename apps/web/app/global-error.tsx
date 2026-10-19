'use client';

/**
 * Last-resort page when the root layout itself fails. Fixed plain-language text only; the error
 * object is never displayed.
 */
export default function GlobalError() {
  return (
    <html lang="en">
      <body>
        <main>
          <h1>Something went wrong</h1>
          <p>PBE could not show this page. Please reload, or contact your administrator.</p>
        </main>
      </body>
    </html>
  );
}
