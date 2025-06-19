import { Store, permuteDomain, pathMatch, Cookie, Callback, Nullable } from 'tough-cookie'
import fs from 'fs'
import util from 'util'

export type CookiesMap = {
  [key: string]: Cookie;
};

export type CookiesDomainData = {
  [path: string]: CookiesMap;
};

export type CookiesData = {
  [domain: string]: CookiesDomainData;
};

/**
 * Class representing a JSON file store.
 *
 * @augments Store
 */
export default class FileCookieStore extends Store {
  synchronous: boolean
  filePath: string
  idx: CookiesData = {}
  private _readPromise: Promise<CookiesData> | undefined
  private _writePromise: Promise<void> | undefined
  private _nextWritePromise: Promise<void> | undefined

  /**
   * Creates a new JSON file store in the specified file.
   *
   * @param filePath - The file in which the store will be created.
   * @param options - Options for initializing the store.
   * @param options.async - Whether to write the file asynchronously
   * @param options.loadAsync - Whether to read the file asynchronously
   * @param options.onLoadError - Optional callback for async file-load errors
   */
  constructor (
    filePath: string,
    options?: {
      async?: boolean,
      loadAsync?: boolean,
      onLoadError?: (err: Error) => void
    }
  ) {
    super()
    this.synchronous = !options?.async
    this.filePath = filePath
    this.idx = {}
    // istanbul ignore else
    if (util.inspect.custom) {
      this[util.inspect.custom] = this._inspect
    }
    // istanbul ignore else
    if (!filePath) {
      throw new Error('Unknown file for read/write cookies')
    }
    // load from file
    if (options?.loadAsync) {
      const promise = this._loadFromFileAsync(this.filePath)
      this._readPromise = promise
      promise.then(dataJson => {
        delete this._readPromise
        if (dataJson) {
          this.idx = dataJson
        }
      }, err => {
        delete this._readPromise
        if (options?.onLoadError) {
          options.onLoadError(err)
        } else {
          console.error(err)
        }
      })
    } else {
      const dataJson = this._loadFromFileSync(this.filePath)
      if (dataJson) {
        this.idx = dataJson
      }
    }
  }

  /**
   *
   * @param action
   * @param cb
   */
  private _doSyncReadAsAsync<TResult> (action: () => TResult, cb: Callback<TResult> | undefined) {
    if (this._readPromise) {
      // wait for read promise to finish
      const promise = this._readPromise
        .catch(() => {}) // ignore error
      if (cb) {
        // handle with callback
        promise.then(() => {
          try {
            let result: TResult
            try {
              result = action()
            } catch (error) {
              cb(error, undefined)
              return
            }
            cb(null, result)
          } catch (error) {
            console.error(error)
          }
        })
      } else {
        // handle with promise
        return promise.then(() => action())
      }
    } else {
      // do action immediately
      if (cb) {
        let result
        try {
          result = action()
        } catch(error) {
          cb(error, undefined)
          return
        }
        cb(null, result)
      } else {
        return (async () => action())()
      }
    }
  }

  /**
   *
   * @param action
   * @param cb
   */
  _doSyncWriteAsAsync (action: () => boolean, cb: ErrorCallback | undefined): (void | Promise<void>) {
    if (this._readPromise) {
      // wait for read promise to finish
      const promise = this._readPromise
        .catch(() => {}) // ignore error
      if (cb) {
        // handle with callback
        promise.then(() => {
          let done = false
          try {
            // perform write action
            if (action()) {
              // save to file
              this._save((error) => {
                // done
                if (!done) {
                  done = true
                  cb(error)
                } else {
                  console.error(error)
                }
              })
            } else {
              // no need to save to file, so done
              done = true
              cb(null)
            }
          } catch (error) {
            // only pass error to callback if it hasnt been called yet
            if (!done) {
              done = true
              cb(error)
            } else {
              console.error(error)
            }
          }
        })
      } else {
        // handle with promise
        return promise.then(() => {
          if (action()) {
            return this._save()
          }
        })
      }
    } else {
      // do action immediately
      let changed
      try {
        changed = action()
      } catch(error) {
        if(cb) {
          cb(error)
          return
        } else {
          return Promise.reject(error)
        }
      }
      if (changed) {
        return this._save(cb)
      } else {
        if (cb) {
          cb(null)
        } else {
          return Promise.resolve()
        }
      }
    }
  }

  /**
   * The findCookie callback.
   *
   * @callback FileCookieStore~findCookieCallback
   * @param {Error} error - The error if any.
   * @param {Cookie} cookie - The cookie found.
   */

  /**
   * Retrieve a cookie with the given domain, path and key.
   *
   * @param {string} domain - The cookie domain.
   * @param {string} path - The cookie path.
   * @param {string} key - The cookie key.
   * @param {FileCookieStore~findCookieCallback} cb - The callback.
   */
  findCookie(domain: Nullable<string>, path: Nullable<string>, key: Nullable<string>, cb: Callback<Cookie | null | undefined>): void;
  /**
   *
   */
  findCookie(domain: Nullable<string>, path: Nullable<string>, key: Nullable<string>): Promise<Cookie | null | undefined>;
  /**
   *
   * @param domain
   * @param path
   * @param key
   * @param cb
   */
  findCookie (domain: Nullable<string>, path: Nullable<string>, key: Nullable<string>, cb?: Callback<Cookie | null | undefined>): (void | Promise<Cookie | null | undefined>) {
    if (this.synchronous) {
      if (cb) {
        let cookie
        try {
          cookie = this._findCookieSync(domain, path, key)
        } catch(error) {
          cb(error, undefined)
          return
        }
        cb(null, cookie)
      } else {
        return (async () => this._findCookieSync(domain, path, key))()
      }
    } else {
      return this._findCookieAsync(domain, path, key, cb)
    }
  }

  /**
   *
   * @param domain
   * @param path
   * @param key
   * @param cb
   */
  private _findCookieAsync (domain: Nullable<string>, path: Nullable<string>, key: Nullable<string>, cb: Callback<Cookie | null | undefined>) {
    return this._doSyncReadAsAsync(() => this._findCookieSync(domain, path, key), cb)
  }

  /**
   *
   * @param domain
   * @param path
   * @param key
   */
  private _findCookieSync (domain: Nullable<string>, path: Nullable<string>, key: Nullable<string>): (Cookie | null | undefined) {
    const cookiesMap = this.idx[domain]?.[path]
    if (!cookiesMap) {
      return undefined
    }
    return cookiesMap[key] || null
  }

  /**
   * The findCookies callback.
   *
   * @callback FileCookieStore~allowSpecialUseDomainCallback
   * @param {Error} error - The error if any.
   * @param {Cookie[]} cookies - Array of cookies.
   */

  /**
   * The findCookies callback.
   *
   * @callback FileCookieStore~findCookiesCallback
   * @param {Error} error - The error if any.
   * @param {Cookie[]} cookies - Array of cookies.
   */

  /**
   * Locates cookies matching the given domain and path.
   *
   * @param {string} domain - The cookie domain.
   * @param {string} path - The cookie path.
   * @param {FileCookieStore~allowSpecialUseDomainCallback} allowSpecialUseDomain - The callback.
   * @param {FileCookieStore~findCookiesCallback} cb - The callback.
   */
  findCookies(domain: Nullable<string>, path: Nullable<string>, allowSpecialUseDomain?: boolean, cb?: Callback<Cookie[]>): void;
  /**
   *
   */
  findCookies(domain: Nullable<string>, path: Nullable<string>, allowSpecialUseDomain?: boolean): Promise<Cookie[]>;
  /**
   *
   * @param domain
   * @param path
   * @param allowSpecialUseDomain
   * @param cb
   */
  findCookies (domain: Nullable<string>, path: Nullable<string>, allowSpecialUseDomain?: boolean, cb?: Callback<Cookie[]>): (Cookie[] | Promise<Cookie[]>) {
    if (typeof allowSpecialUseDomain === 'function') {
      cb = allowSpecialUseDomain
      allowSpecialUseDomain = false
    }
    if (this.synchronous) {
      if (cb) {
        let cookies
        try {
          cookies = this._findCookiesSync(domain, path, allowSpecialUseDomain)
        } catch(error) {
          cb(error, undefined)
          return
        }
        cb(null, cookies)
      } else {
        return (async () => this._findCookiesSync(domain, path, allowSpecialUseDomain))()
      }
    } else {
      return this._findCookiesAsync(domain, path, allowSpecialUseDomain, cb)
    }
  }

  /**
   *
   * @param domain
   * @param path
   * @param allowSpecialUseDomain
   * @param cb
   */
  private _findCookiesAsync (domain: Nullable<string>, path: Nullable<string>, allowSpecialUseDomain: boolean, cb?: Callback<Cookie[]>): (Cookie[] | Promise<Cookie[]>) {
    return this._doSyncReadAsAsync(() => this._findCookiesSync(domain, path, allowSpecialUseDomain), cb)
  }

  /**
   *
   * @param domain
   * @param path
   * @param allowSpecialUseDomain
   */
  private _findCookiesSync (domain: Nullable<string>, path: Nullable<string>, allowSpecialUseDomain: boolean): Cookie[] {
    const results = []

    if (!domain) {
      return results
    }

    let pathMatcher: (domainIndex: CookiesDomainData) => void
    if (!path) {
      pathMatcher = function matchAll (domainIndex: CookiesDomainData) {
        for (const curPath in domainIndex) {
          const pathIndex = domainIndex[curPath]
          for (const key in pathIndex) {
            results.push(pathIndex[key])
          }
        }
      }
    } else {
      pathMatcher = function matchRFC (domainIndex: CookiesDomainData) {
        for (const cookiePath in domainIndex) {
          if (pathMatch(path, cookiePath)) {
            const pathIndex = domainIndex[cookiePath]
            for (const key in pathIndex) {
              results.push(pathIndex[key])
            }
          }
        }
      }
    }

    const domains = permuteDomain(domain, allowSpecialUseDomain) || [domain]
    const idx = this.idx
    for (const curDomain of domains) {
      const domainIndex = idx[curDomain]
      if (!domainIndex) {
        continue
      }
      pathMatcher(domainIndex)
    }

    return results
  }

  /**
   * The putCookie callback.
   *
   * @callback FileCookieStore~putCookieCallback
   * @param {Error} error - The error if any.
   */

  /**
   * Adds a new cookie to the store.
   *
   * @param {Cookie} cookie - The cookie.
   * @param {FileCookieStore~putCookieCallback} cb - The callback.
   */
  putCookie(cookie: Cookie, cb: ErrorCallback): void;
  /**
   *
   */
  putCookie(cookie: Cookie): Promise<void>;
  /**
   *
   * @param cookie
   * @param cb
   */
  putCookie (cookie: Cookie, cb?: ErrorCallback): (void | Promise<void>) {
    if (this.synchronous) {
      if (cb) {
        try {
          this._putCookieSync(cookie)
        } catch(error) {
          cb(error)
          return
        }
        cb(null)
      } else {
        return (async () => this._putCookieSync(cookie))()
      }
    } else {
      return this._putCookieAsync(cookie, cb)
    }
  }

  /**
   *
   * @param cookie
   * @param cb
   */
  private _putCookieAsync (cookie: Cookie, cb?: ErrorCallback): (void | Promise<void>) {
    return this._doSyncWriteAsAsync(() => {
      this._putCookieSyncInternal(cookie)
      return true
    }, cb)
  }

  /**
   *
   * @param cookie
   */
  private _putCookieSyncInternal (cookie: Cookie) {
    let domainVal = this.idx[cookie.domain]
    if (!domainVal) {
      domainVal = {}
      this.idx[cookie.domain] = domainVal
    }
    let pathVal = domainVal[cookie.path]
    if (!pathVal) {
      pathVal = {}
      domainVal[cookie.path] = pathVal
    }
    pathVal[cookie.key] = cookie
  }

  /**
   *
   * @param cookie
   */
  private _putCookieSync (cookie: Cookie) {
    this._putCookieSyncInternal(cookie)
    this._saveSync()
  }

  /**
   * The updateCookie callback.
   *
   * @callback FileCookieStore~updateCookieCallback
   * @param {Error} error - The error if any.
   */

  /**
   * Update an existing cookie.
   *
   * @param {Cookie} oldCookie - The old cookie.
   * @param {Cookie} newCookie - The new cookie.
   * @param {FileCookieStore~updateCookieCallback} cb - The callback.
   */
  updateCookie(oldCookie: Cookie, newCookie: Cookie, cb: ErrorCallback): void;
  /**
   *
   */
  updateCookie(oldCookie: Cookie, newCookie: Cookie): Promise<void>;
  /**
   *
   * @param oldCookie
   * @param newCookie
   * @param cb
   */
  updateCookie (oldCookie: Cookie, newCookie: Cookie, cb?: ErrorCallback): (void | Promise<void>) {
    // TODO delete old cookie?
    return this.putCookie(newCookie, cb)
  }

  /**
   * The removeCookie callback.
   *
   * @callback FileCookieStore~removeCookieCallback
   * @param {Error} error - The error if any.
   */

  /**
   * Remove a cookie from the store.
   *
   * @param {string} domain - The cookie domain.
   * @param {string} path - The cookie path.
   * @param {string} key - The cookie key.
   * @param {FileCookieStore~removeCookieCallback} cb - The callback.
   */
  removeCookie(domain: string, path: string, key: string, cb: ErrorCallback): void;
  /**
   *
   */
  removeCookie(domain: string, path: string, key: string): Promise<void>;
  /**
   *
   * @param domain
   * @param path
   * @param key
   * @param cb
   */
  removeCookie (domain: string, path: string, key: string, cb?: ErrorCallback): (void | Promise<void>) {
    if (this.synchronous) {
      if (cb) {
        try {
          this._removeCookieSync(domain, path, key)
        } catch(error) {
          cb(error)
          return
        }
        cb(null)
      } else {
        return (async () => this._removeCookieSync(domain, path, key))()
      }
    } else {
      return this._removeCookieAsync(domain, path, key, cb)
    }
  }

  /**
   *
   * @param domain
   * @param path
   * @param key
   * @param cb
   */
  private _removeCookieAsync (domain: string, path: string, key: string, cb?: ErrorCallback): (void | Promise<void>) {
    return this._doSyncWriteAsAsync(() => {
      return this._removeCookieSyncInternal(domain, path, key)
    }, cb)
  }

  /**
   *
   * @param domain
   * @param path
   * @param key
   */
  private _removeCookieSyncInternal (domain: string, path: string, key: string): boolean {
    const pathVal = this.idx[domain]?.[path]
    if (!pathVal) {
      return false
    }
    const deleted = (delete pathVal[key])
    return deleted
  }

  /**
   *
   * @param domain
   * @param path
   * @param key
   */
  private _removeCookieSync (domain: string, path: string, key: string) {
    if (this._removeCookieSyncInternal(domain, path, key)) {
      this._saveSync()
    }
  }

  /**
   * The removeCookies callback.
   *
   * @callback FileCookieStore~removeCookiesCallback
   * @param {Error} error - The error if any.
   */

  /**
   * Removes matching cookies from the store.
   *
   * @param {string} domain - The cookie domain.
   * @param {string} path - The cookie path.
   * @param {FileCookieStore~removeCookiesCallback} cb - The callback.
   */
  removeCookies(domain: string, path: Nullable<string>, cb: ErrorCallback): void;
  /**
   *
   */
  removeCookies(domain: string, path: Nullable<string>): Promise<void>;
  /**
   *
   * @param domain
   * @param path
   * @param cb
   */
  removeCookies (domain: string, path: Nullable<string>, cb?: ErrorCallback): (void | Promise<void>) {
    if (this.synchronous) {
      if (cb) {
        try {
          this._removeCookiesSync(domain, path)
        } catch(error) {
          cb(error)
          return
        }
        cb(null)
      } else {
        return (async () => this._removeCookiesSync(domain, path))()
      }
    } else {
      return this._removeCookiesAsync(domain, path, cb)
    }
  }

  /**
   *
   * @param domain
   * @param path
   * @param cb
   */
  private _removeCookiesAsync (domain: string, path: string, cb?: ErrorCallback): (void | Promise<void>) {
    return this._doSyncWriteAsAsync(() => {
      return this._removeCookiesSyncInternal(domain, path)
    }, cb)
  }

  /**
   *
   * @param domain
   * @param path
   */
  private _removeCookiesSyncInternal (domain: string, path: string): boolean {
    // istanbul ignore else
    if (path) {
      const domainVal = this.idx[domain]
      if (domainVal) {
        const deleted = (delete domainVal[path])
        return deleted
      }
      return false
    } else {
      const deleted = (delete this.idx[domain])
      return deleted
    }
  }

  /**
   *
   * @param domain
   * @param path
   */
  private _removeCookiesSync (domain: string, path: string) {
    if (this._removeCookiesSyncInternal(domain, path)) {
      this._saveSync()
    }
  }

  /**
   * The removeAllCookies callback.
   *
   * @callback FileCookieStore~removeAllCookiesCallback
   * @param {Error} error - The error if any.
   */

  /**
   * Removes all cookies from the store.
   *
   * @param {FileCookieStore~removeAllCookiesCallback} cb - The callback.
   */
  removeAllCookies(cb: ErrorCallback): void;
  /**
   *
   */
  removeAllCookies(): Promise<void>;
  /**
   *
   * @param cb
   */
  removeAllCookies (cb?: ErrorCallback): (void | Promise<void>) {
    if (this.synchronous) {
      if (cb) {
        try {
          this._removeAllCookiesSync()
        } catch(error) {
          cb(error)
          return
        }
        cb(null)
      } else {
        return (async () => this._removeAllCookiesSync())()
      }
    } else {
      return this._removeAllCookiesAsync(cb)
    }
  }

  /**
   *
   * @param cb
   */
  private _removeAllCookiesAsync (cb?: ErrorCallback): (void | Promise<void>) {
    return this._doSyncWriteAsAsync(() => {
      return this._removeAllCookiesSyncInternal()
    }, cb)
  }

  /**
   *
   */
  private _removeAllCookiesSyncInternal (): boolean {
    this.idx = {}
    return true
  }

  /**
   *
   */
  private _removeAllCookiesSync () {
    if (this._removeAllCookiesSyncInternal()) {
      this._saveSync()
    }
  }

  /**
   * The getAllCookies callback.
   *
   * @callback FileCookieStore~getAllCookiesCallback
   * @param {Error} error - The error if any.
   * @param {Array} cookies - An array of cookies.
   */

  /**
   * Produces an Array of all cookies from the store.
   *
   * @param {FileCookieStore~getAllCookiesCallback} cb - The callback.
   */
  getAllCookies(cb: Callback<Cookie[]>): void;
  /**
   *
   */
  getAllCookies(): Promise<Cookie[]>;
  /**
   *
   * @param cb
   */
  getAllCookies (cb?: Callback<Cookie[]>): (void | Promise<Cookie[]>) {
    if (this.synchronous) {
      if (cb) {
        let cookies
        try {
          cookies = this._getAllCookiesSync()
        } catch(error) {
          cb(error, undefined)
          return
        }
        cb(null, cookies)
      } else {
        return (async () => this._getAllCookiesSync())()
      }
    } else {
      return this._getAllCookiesAsync(cb)
    }
  }

  /**
   *
   * @param cb
   */
  private _getAllCookiesAsync (cb?: Callback<Cookie[]>): (void | Promise<Cookie[]>) {
    return this._doSyncReadAsAsync(() => this._getAllCookiesSync(), cb)
  }

  /**
   *
   */
  private _getAllCookiesSync (): Cookie[] {
    const cookies: Cookie[] = []
    for (const domain in this.idx) {
      const domainVal = this.idx[domain]
      for (const p in domainVal) {
        const pVal = domainVal[p]
        for (const key in pVal) {
          const cookie = pVal[key]
          if (key != null) {
            cookies.push(cookie)
          }
        }
      }
    }

    cookies.sort((a, b) => {
      return (a.creationIndex || 0) - (b.creationIndex || 0)
    })

    return cookies
  }

  /**
   * Returns a string representation of the store object for debugging purposes.
   *
   * @returns {string} - The string representation of the store.
   */
  private _inspect () {
    return `{ idx: ${util.inspect(this.idx, false, 2)} }`
  }

  /**
   * The loadFromFile callback.
   *
   * @callback FileCookieStore~loadFromFileCallback
   * @param {object} dataJson - The content of the store.
   */

  /**
   * Load the store from file asynchronously.
   *
   * @param {string} filePath - The file in which the store will be created.
   */
  private async _loadFromFileAsync (filePath: string): Promise<CookiesData> {
    await fs.promises.access(filePath)
    const data = await fs.promises.readFile(filePath, 'utf8')
    return this._loadFromStringSync(data, filePath)
  }

  /**
   * Load the store from file synchronously.
   *
   * @param {string} filePath - The file in which the store will be created.
   */
  private _loadFromFileSync (filePath: string): CookiesData {
    let data: string | null = null
    // istanbul ignore else
    if (fs.existsSync(this.filePath)) {
      data = fs.readFileSync(filePath, 'utf8')
    }
    return this._loadFromStringSync(data, filePath)
  }

  /**
   *
   * @param data
   * @param filePath
   */
  private _loadFromStringSync (data: string | null, filePath: string): CookiesData {
    // istanbul ignore else
    let dataJson = null
    try {
      dataJson = JSON.parse(data)
    } catch {
      throw new Error(`Could not parse cookie file ${filePath}. Please ensure it is not corrupted.`)
    }

    for (const d of Object.keys(dataJson)) {
      for (const p of Object.keys(dataJson[d])) {
        for (const k of Object.keys(dataJson[d][p])) {
          dataJson[d][p][k] = Cookie.fromJSON(JSON.stringify(dataJson[d][p][k]))
        }
      }
    }
    return dataJson
  }

  /**
   * Saves the store to its file.
   * @param cb
   */
  private _save (cb?: ErrorCallback): (void | Promise<void>) {
    if (this.synchronous) {
      this._saveSync()
      cb?.(null)
    } else {
      return this._saveAsync(cb)
    }
  }

  /**
   *
   * @param cb
   */
  private _saveAsync (cb?: ErrorCallback): (void | Promise<void>) {
    if (!this._nextWritePromise) {
      // create next write promise
      this._nextWritePromise = (async () => {
        let async = false
        // wait for active write to finish if any
        if (this._writePromise) {
          // check if write is already done
          let writeDone = false
          const writePromise = this._writePromise.finally(() => {
            writeDone = true
          })
          if (!writeDone) {
            async = true
          }
          // wait for write to finish
          try {
            await writePromise
          } catch {
            // ignore error
          }
        }
        // delay one frame, in case of multiple writes
        if (!async) {
          await new Promise<void>((resolve) => {
            if (typeof setImmediate !== 'undefined') {
              setImmediate(() => {
                // this is now the active write, so update the write promises
                this._writePromise = this._nextWritePromise
                this._nextWritePromise = undefined
                resolve()
              })
            } else {
              setTimeout(() => {
                // this is now the active write, so update the write promises
                this._writePromise = this._nextWritePromise
                this._nextWritePromise = undefined
                resolve()
              }, 0)
            }
          })
        } else {
          // this is now the active write, so update the write promises
          this._writePromise = this._nextWritePromise
          this._nextWritePromise = undefined
        }
        // save to the file
        try {
          await this._saveToFileAsync(this.filePath, this.idx)
        } finally {
          // clear write promise
          this._writePromise = undefined
        }
      })()
    }
    // wait for next write promise
    if (cb) {
      this._nextWritePromise
        .then(() => {
          cb(null)
        }, (error) => {
          cb(error)
        })
        .catch((error) => {
          console.error(error)
        })
    } else {
      return this._nextWritePromise
    }
  }

  /**
   *
   */
  private _saveSync () {
    this._saveToFileSync(this.filePath, this.idx)
    if (this._writePromise) {
      // since we're actively writing, also save async to ensure file gets written correctly
      this._saveAsync((error) => {
        if (error) {
          console.error(error)
        }
      })
    }
  }

  /**
   *
   * @param filePath
   * @param data
   * @param cb
   */
  private _saveToFileAsync (filePath: string, data: CookiesData, cb?: (error: Error) => void) {
    const dataString = JSON.stringify(data)
    if (cb) {
      fs.writeFile(filePath, dataString, cb)
    } else {
      return util.promisify(fs.writeFile)(filePath, dataString)
    }
  }

  /**
   *
   * @param filePath
   * @param data
   */
  private _saveToFileSync (filePath: string, data: CookiesData): void {
    const dataString = JSON.stringify(data)
    fs.writeFileSync(filePath, dataString)
  }
}
