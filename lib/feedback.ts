export const FEEDBACK_BODY_MAX = 1000;
export const FEEDBACK_CONTACT_MAX = 100;

/** Trim only the ends; internal spaces and newlines count as code points. */
export function feedbackLength(s: string): number {
  return Array.from(s.trim()).length;
}
