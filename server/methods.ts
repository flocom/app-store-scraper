/**
 * Shared method registry.
 *
 * A single source of truth describing every scraper method exposed by the
 * library, with a Zod input shape, human-readable metadata and a handler.
 * Both the REST API and the MCP server are generated from this list so the
 * two surfaces never drift apart.
 */
import { z } from 'zod';
import {
  app,
  list,
  search,
  developer,
  reviews,
  ratings,
  similar,
  suggest,
  privacy,
  versionHistory,
  collection,
  sort,
} from '../src/index.js';

const country = z
  .string()
  .length(2)
  .optional()
  .describe('Two-letter country/store code (default: "us")');
const lang = z.string().optional().describe('Language code, e.g. "en-us" or "fr-fr"');

const collectionEnum = z
  .enum(Object.values(collection) as [string, ...string[]])
  .describe('App Store collection, e.g. "topfreeapplications"');

const sortEnum = z
  .enum(Object.values(sort) as [string, ...string[]])
  .describe('Review sort order: "mostRecent" or "mostHelpful"');

/** A Zod raw shape (object of field schemas), reused by MCP + REST. */
export type Shape = Record<string, z.ZodTypeAny>;

export interface MethodDef {
  /** Stable identifier — REST path segment and MCP tool name. */
  name: string;
  /** Short human title. */
  title: string;
  /** Longer description used in MCP tool listings and the GUI. */
  description: string;
  /** Zod raw shape describing accepted arguments. */
  shape: Shape;
  /** Executes the underlying library call. */
  handler: (args: any) => Promise<unknown>;
}

export const methods: MethodDef[] = [
  {
    name: 'app',
    title: 'App details',
    description:
      'Fetch full metadata for a single app by numeric track id or bundle id (appId). Optionally include the ratings histogram.',
    shape: {
      id: z.number().int().optional().describe('Numeric track id (provide id OR appId)'),
      appId: z.string().optional().describe('Bundle id, e.g. com.example.app (provide id OR appId)'),
      ratings: z.boolean().optional().describe('Include the rating histogram'),
      country,
      lang,
    },
    handler: (a) => app(a),
  },
  {
    name: 'list',
    title: 'Top charts list',
    description:
      'List apps from an App Store collection (top free, top paid, top grossing, new, etc.), optionally filtered by category.',
    shape: {
      collection: collectionEnum.optional(),
      category: z.number().int().optional().describe('Category/genre id (e.g. 6007 = Productivity)'),
      num: z.number().int().min(1).max(200).optional().describe('Number of results (max 200)'),
      fullDetail: z.boolean().optional().describe('Fetch full details for each app'),
      country,
      lang,
    },
    handler: (a) => list(a),
  },
  {
    name: 'search',
    title: 'Search',
    description: 'Search the App Store for apps matching a term.',
    shape: {
      term: z.string().min(1).describe('Search term (required)'),
      num: z.number().int().min(1).max(200).optional().describe('Results per page (default 50)'),
      page: z.number().int().min(1).optional().describe('Page number (default 1)'),
      idsOnly: z.boolean().optional().describe('Return only numeric app ids'),
      country,
      lang,
    },
    handler: (a) => search(a),
  },
  {
    name: 'developer',
    title: 'Developer apps',
    description: 'List all apps published by a developer (artist) id.',
    shape: {
      devId: z.number().int().describe('Developer / artist id (required)'),
      country,
      lang,
    },
    handler: (a) => developer(a),
  },
  {
    name: 'reviews',
    title: 'Reviews',
    description: 'Fetch user reviews for an app (by id or appId). Paginated 1-10.',
    shape: {
      id: z.number().int().optional().describe('Numeric track id (provide id OR appId)'),
      appId: z.string().optional().describe('Bundle id (provide id OR appId)'),
      page: z.number().int().min(1).max(10).optional().describe('Page number 1-10 (default 1)'),
      sort: sortEnum.optional(),
      country,
      lang,
    },
    handler: (a) => reviews(a),
  },
  {
    name: 'ratings',
    title: 'Ratings',
    description: 'Fetch the rating count and histogram for an app by numeric id.',
    shape: {
      id: z.number().int().describe('Numeric track id (required)'),
      country,
    },
    handler: (a) => ratings(a),
  },
  {
    name: 'similar',
    title: 'Similar apps',
    description: 'List apps that Apple considers similar to a given app (by id or appId).',
    shape: {
      id: z.number().int().optional().describe('Numeric track id (provide id OR appId)'),
      appId: z.string().optional().describe('Bundle id (provide id OR appId)'),
      country,
      lang,
    },
    handler: (a) => similar(a),
  },
  {
    name: 'suggest',
    title: 'Search suggestions',
    description: 'Autocomplete search-term suggestions for a partial term.',
    shape: {
      term: z.string().min(1).describe('Partial search term (required)'),
      country,
    },
    handler: (a) => suggest(a),
  },
  {
    name: 'privacy',
    title: 'Privacy details',
    description: 'Fetch the App Privacy ("nutrition label") data types for an app by numeric id.',
    shape: {
      id: z.number().int().describe('Numeric track id (required)'),
      country,
    },
    handler: (a) => privacy(a),
  },
  {
    name: 'versionHistory',
    title: 'Version history',
    description: 'Fetch the version release history for an app by numeric id.',
    shape: {
      id: z.number().int().describe('Numeric track id (required)'),
      country,
    },
    handler: (a) => versionHistory(a),
  },
];

/** Look up a method by name. */
export function getMethod(name: string): MethodDef | undefined {
  return methods.find((m) => m.name === name);
}

/** Build a Zod object from a method's raw shape for validation. */
export function schemaFor(def: MethodDef): z.ZodObject<any> {
  return z.object(def.shape);
}
