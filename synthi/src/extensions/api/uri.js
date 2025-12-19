/**
 * Synthi Extension System - URI Implementation
 * VS Code compatible URI class
 */

/**
 * Create the URI class
 * @returns {typeof URI}
 */
export function createURI() {
  return class URI {
    constructor(scheme, authority, path, query, fragment) {
      this.scheme = scheme || '';
      this.authority = authority || '';
      this.path = path || '';
      this.query = query || '';
      this.fragment = fragment || '';
    }

    /**
     * Get the file system path
     * @returns {string}
     */
    get fsPath() {
      if (this.scheme === 'file') {
        // Windows path handling
        if (this.path.match(/^\/[a-zA-Z]:/)) {
          return this.path.slice(1).replace(/\//g, '\\');
        }
        return this.path;
      }
      return this.path;
    }

    /**
     * Create URI from file path
     * @param {string} path
     * @returns {URI}
     */
    static file(path) {
      // Normalize Windows paths
      let normalized = path.replace(/\\/g, '/');
      if (!normalized.startsWith('/')) {
        normalized = '/' + normalized;
      }
      return new URI('file', '', normalized, '', '');
    }

    /**
     * Parse URI string
     * @param {string} value
     * @returns {URI}
     */
    static parse(value) {
      const match = value.match(/^([^:/?#]+):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/);
      if (!match) {
        throw new Error(`Invalid URI: ${value}`);
      }
      return new URI(
        match[1] || '',
        match[2] || '',
        match[3] || '',
        match[4] || '',
        match[5] || ''
      );
    }

    /**
     * Create URI from components
     * @param {object} components
     * @returns {URI}
     */
    static from(components) {
      return new URI(
        components.scheme,
        components.authority,
        components.path,
        components.query,
        components.fragment
      );
    }

    /**
     * Join path segments
     * @param {URI} base
     * @param {...string} pathSegments
     * @returns {URI}
     */
    static joinPath(base, ...pathSegments) {
      let path = base.path;
      for (const segment of pathSegments) {
        if (path.endsWith('/')) {
          path = path + segment;
        } else {
          path = path + '/' + segment;
        }
      }
      return base.with({ path });
    }

    /**
     * Create new URI with replaced components
     * @param {object} change
     * @returns {URI}
     */
    with(change) {
      return new URI(
        change.scheme ?? this.scheme,
        change.authority ?? this.authority,
        change.path ?? this.path,
        change.query ?? this.query,
        change.fragment ?? this.fragment
      );
    }

    /**
     * Convert to string
     * @param {boolean} [skipEncoding]
     * @returns {string}
     */
    toString(skipEncoding = false) {
      let result = '';
      
      if (this.scheme) {
        result += this.scheme + ':';
      }
      
      if (this.authority || this.scheme === 'file') {
        result += '//';
      }
      
      if (this.authority) {
        result += skipEncoding ? this.authority : encodeURIComponent(this.authority).replace(/%3A/g, ':').replace(/%40/g, '@');
      }
      
      if (this.path) {
        result += skipEncoding ? this.path : this.path.split('/').map(s => encodeURIComponent(s)).join('/');
      }
      
      if (this.query) {
        result += '?' + (skipEncoding ? this.query : encodeURIComponent(this.query));
      }
      
      if (this.fragment) {
        result += '#' + (skipEncoding ? this.fragment : encodeURIComponent(this.fragment));
      }
      
      return result;
    }

    /**
     * Convert to JSON
     * @returns {object}
     */
    toJSON() {
      return {
        scheme: this.scheme,
        authority: this.authority,
        path: this.path,
        query: this.query,
        fragment: this.fragment,
        fsPath: this.fsPath
      };
    }
  };
}
