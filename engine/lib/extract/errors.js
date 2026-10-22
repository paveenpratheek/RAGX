/* Why a document could not be read, as a code the engine can act on and a
 * sentence a person can read. */
export class ExtractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExtractError';
    this.code = code; // unsupported | empty | scanned | encrypted | corrupt | too-large
  }
}
