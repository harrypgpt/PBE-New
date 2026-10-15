import { z } from 'zod';

/**
 * Schemas published as named OpenAPI components. Registering a schema here (with its component
 * id) is what makes it appear under `components.schemas` in openapi/openapi.json.
 */
export const contractSchemas = z.registry<{ id: string }>();
