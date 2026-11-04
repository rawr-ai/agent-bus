// Plain constants keep browser controls aligned without importing server-side schemas.
export const DEFAULT_HISTORY_LIMIT = 200;
export const MAX_HISTORY_LIMIT = 200;
export const MAX_QUERY_LENGTH = 256;
export const MAX_PARTICIPANT_LENGTH = 512;
export const MAX_ID_LENGTH = 512;
/** The most current peers one observation shows, read in pages of MAX_PEERS_PAGE. */
export const MAX_PEERS = 1000;
export const MAX_PEERS_PAGE = 500;
/** The most entries of one reply tree a conversation reads. */
export const MAX_THREAD_MESSAGES = 200;
/** The most saved-query pages one observation follows at one commit. */
export const MAX_PAGES = 8;
/** The page size every pinned-investigation page asks for, bound into each cursor. */
export const INVESTIGATION_PAGE_SIZE = 200;
/** The most entries one pinned investigation keeps. */
export const MAX_INVESTIGATION_ENTRIES = 200;
/** The longest continuation an investigation sends: the bus decodes no longer cursor. */
export const MAX_CONTINUATION_LENGTH = 1024;
/** The largest RPC request body the viewer host reads. */
export const MAX_REQUEST_BYTES = 4096;
