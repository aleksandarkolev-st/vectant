class SynthiException extends Error {
  constructor(title, description) {
    // Pass a combined message to the parent Error class
    super(`${title}: ${description}`);

    // Set the error name to the class name (good practice for debugging)
    this.name = 'SynthiException';
    
    this.title = title;
    this.description = description;

    // Maintains proper stack trace for where our error was thrown (Node.js/V8 specific)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SynthiException);
    }
  }
}

export default SynthiException;