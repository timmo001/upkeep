/**
 * What the dashboard and the server agree on to keep a page from another
 * version out: the header the dashboard says its version in, and the status
 * the server refuses a different one with.
 */

/** The header a page sends its version in. */
export const versionHeader = "x-upkeep-version";

/** The status for a page that's from another version than the server. */
export const versionMismatchStatus = 426;
