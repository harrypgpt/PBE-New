import { z } from 'zod';

/**
 * Zod probes whether `eval` is allowed (to speed up validation). Under PBE's strict Content
 * Security Policy the browser reports that probe as a violation, so the web app switches the
 * speed-up off. Import this module before anything that loads @pbe/contracts.
 */
z.config({ jitless: true });
