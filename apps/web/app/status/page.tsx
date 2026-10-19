import type { Metadata } from 'next';
import { StatusPanel } from '../../src/status/StatusPanel';

export const metadata: Metadata = { title: 'System status' };

export default function StatusPage() {
  return (
    <>
      <h1>System status</h1>
      <p>This page asks the PBE API whether it and its database are available.</p>
      <StatusPanel />
    </>
  );
}
