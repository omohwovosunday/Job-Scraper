import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: 'job-scraper', description: 'Sourcing and application pipeline' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="wrap">{children}</div>
      </body>
    </html>
  );
}
