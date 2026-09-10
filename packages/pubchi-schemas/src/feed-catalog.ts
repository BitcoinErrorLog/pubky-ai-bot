import {
  APP_FEED_CONTENT,
  APP_FEED_REACH,
  APP_SUPPORTED_LAYOUT,
  APP_SUPPORTED_SORT,
} from "./feed.js";

export type FeedCatalogField = {
  name: "name" | "icon" | "tags" | "domain_tags" | "reach" | "sort" | "layout" | "content";
  values: readonly string[];
  meaning: string;
  authoring: string;
};

const catalogFields: readonly FeedCatalogField[] = [
  {
    name: "name",
    values: [],
    meaning: "The user-facing name of the feed.",
    authoring: "Required; one to 100 characters.",
  },
  {
    name: "icon",
    values: [],
    meaning: "The feed icon identifier.",
    authoring: "Optional in the installed feed; the proposal draft accepts at most 50 characters.",
  },
  {
    name: "tags",
    values: [],
    meaning: "Post tags to include.",
    authoring: "Optional; at most five non-empty tags, each at most 20 characters.",
  },
  {
    name: "domain_tags",
    values: [],
    meaning: "Profile or domain tags to include.",
    authoring: "Optional; at most five non-empty tags, each at most 20 characters.",
  },
  {
    name: "reach",
    values: APP_FEED_REACH,
    meaning: "Which relationship audience supplies posts.",
    authoring: "Followers exists in the specs but is not authorable by this App; use following, friends, all, wot, or me.",
  },
  {
    name: "sort",
    values: APP_SUPPORTED_SORT,
    meaning: "How matching posts are ordered.",
    authoring: "Use recent or popularity; likes are not a supported sort.",
  },
  {
    name: "layout",
    values: APP_SUPPORTED_LAYOUT,
    meaning: "How matching posts are displayed.",
    authoring: "Use columns, wide, visual, or list.",
  },
  {
    name: "content",
    values: APP_FEED_CONTENT,
    meaning: "Which content kinds are included.",
    authoring: "Omit the field for all content; unknown is a specs value but is not authorable by this App.",
  },
];

export const FEED_CATALOG = Object.freeze({
  schema: "pubchi-feed-catalog",
  version: 2,
  fields: Object.freeze(catalogFields.map((field) => Object.freeze({ ...field, values: Object.freeze([...field.values]) }))),
});

export type FeedCatalog = typeof FEED_CATALOG;
