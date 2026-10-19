import {
  accountMfaConfirmRoute,
  accountMfaEnrolRoute,
  accountPasswordRoute,
  loginRoute,
  logoutRoute,
  mfaVerifyRoute,
  sessionRoute,
} from './auth';
import { healthRoute } from './health';
import { PROJECT_ROUTES } from './projects';
import { TENANCY_ROUTES } from './tenancy';
import type { RouteContract } from './route';

/**
 * Registry of every route the API serves. The API refuses to start if a served route is missing
 * here (or declared differently), and the OpenAPI document is generated from this list.
 */
export const API_ROUTES: readonly RouteContract[] = [
  healthRoute,
  loginRoute,
  mfaVerifyRoute,
  logoutRoute,
  sessionRoute,
  accountPasswordRoute,
  accountMfaEnrolRoute,
  accountMfaConfirmRoute,
  ...TENANCY_ROUTES,
  ...PROJECT_ROUTES,
];
