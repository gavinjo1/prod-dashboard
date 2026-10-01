/**
 * Small number helpers.
 */

/** A part of a whole as a percentage, or null when there is no whole. */
export const share = (part, total) => (total ? (part / total) * 100 : null);
