import type { StartRequestInbox } from './startRequest';

export const IOS_REQUEST_FILE = 'patpat-start-request.txt';

/** The browser preview has no side button or device shortcuts. */
export function attachStartRequestSources(_inbox: StartRequestInbox): () => void {
  return () => {};
}
