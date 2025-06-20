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
   * @param {string} filePath - The file in which the store will be created.
   * @param {object} options - Options for initializing the store.
   * @param {boolean} options.async - Whether to write the file asynchronously.
   * @param {boolean} options.loadAsync - Whether to read the file asynchronously.
   * @param {Function} options.onLoadError - Optional callback for any async file-load error. Unused if `loadAsync` is false.
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
      }).catch((error) => {
        console.error(error)
      })
    } else {
      const dataJson = this._loadFromFileSync(this.filePath)
      if (dataJson) {
        this.idx = dataJson
      }
    }
  }

  /**
   * Waits for the initial load to finish if unfinished, and then performs the given synchronous action.
   * Afterwards, the callback will be called with an error or a result. If no callback is passed, a promise
   * will be returned instead.
   * @param {Function} action The synchronous read action to execute
   * @param {Function} cb The callback to call with the error or result
   * @returns {Promise} a promise if no callback was passed.
   */
  private _doSyncReadAsAsync<TResult> (action: () => TResult, cb: Callback<TResult> | undefined): (void | Promise<TResult>) {
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
        } catch (error) {
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
   * Waits for the initial load to finish if unfinished, and then performs a synchronous write action.
   * Afterwards, if the store has changed, then changes to the store will be saved to its file, and then
   * the callback will be called with an error if any, or `null` if no error. If no callback is passed, a
   * promise will be returned instead.
   * @param {Function} action
   * @param {Function} cb
   * @returns {Promise} a promise if no callback was passed.
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
      } catch (error) {
        if (cb) {
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

  /** @inheritdoc */
  findCookie(domain: Nullable<string>, path: Nullable<string>, key: Nullable<string>, cb: Callback<Cookie | null | undefined>): void;
  /** @inheritdoc */
  findCookie(domain: Nullable<string>, path: Nullable<string>, key: Nullable<string>): Promise<Cookie | null | undefined>;
  /** @inheritdoc */
  findCookie (domain: Nullable<string>, path: Nullable<string>, key: Nullable<string>, cb?: Callback<Cookie | undefined>): (void | Promise<Cookie | null | undefined>) {
    if (this.synchronous) {
      if (cb) {
        let cookie
        try {
          cookie = this._findCookieSync(domain, path, key)
        } catch (error) {
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
   * Searches for a cookie after waiting for the initial read to finish.
   * @see _doSyncReadAsAsync
   * @param {string} domain - The cookie domain.
   * @param {string} path - The cookie path.
   * @param {string} key - The cookie key.
   * @param {Function} cb - The callback that will be called with the result.
   * @returns {Promise<Cookie>} a promise if no callback was passed.
   */
  private _findCookieAsync (domain: Nullable<string>, path: Nullable<string>, key: Nullable<string>, cb: Callback<Cookie | null | undefined>): (void | Promise<Cookie>) {
    return this._doSyncReadAsAsync(() => this._findCookieSync(domain, path, key), cb)
  }

  /**
   * Searches for a cookie and returns it or null.
   * @param {string} domain - The cookie domain.
   * @param {string} path - The cookie path.
   * @param {string} key - The cookie key.
   * @returns {Cookie} the matching cookie if found.
   */
  private _findCookieSync (domain: Nullable<string>, path: Nullable<string>, key: Nullable<string>): (Cookie | null | undefined) {
    const cookiesMap = this.idx[domain]?.[path]
    if (!cookiesMap) {
      return undefined
    }
    return cookiesMap[key] || null
  }

  /** @inheritdoc */
  findCookies(domain: Nullable<string>, path: Nullable<string>, allowSpecialUseDomain?: boolean, cb?: Callback<Cookie[]>): void;
  /** @inheritdoc */
  findCookies(domain: Nullable<string>, path: Nullable<string>, allowSpecialUseDomain?: boolean): Promise<Cookie[]>;
  /** @inheritdoc */
  findCookies (domain: Nullable<string>, path: Nullable<string>, allowSpecialUseDomain?: boolean, cb?: Callback<Cookie[]>): (void | Promise<Cookie[]>) {
    if (typeof allowSpecialUseDomain === 'function') {
      cb = allowSpecialUseDomain
      allowSpecialUseDomain = false
    }
    if (this.synchronous) {
      if (cb) {
        let cookies
        try {
          cookies = this._findCookiesSync(domain, path, allowSpecialUseDomain)
        } catch (error) {
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
   * Searches for cookies after waiting for the initial read to finish
   * @see _doSyncReadAsAsync
   * @param {string} domain - The cookies domain.
   * @param {string} path - The cookies path.
   * @param {boolean} allowSpecialUseDomain - If `true` then special-use domain suffixes will be allowed in matches. Defaults to `false`.
   * @param {Function} cb - The callback that will be called with the result.
   * @returns {Promise<Cookie[]>} a promise if no callback was passed.
   */
  private _findCookiesAsync (domain: Nullable<string>, path: Nullable<string>, allowSpecialUseDomain: boolean, cb?: Callback<Cookie[]>): (void | Promise<Cookie[]>) {
    return this._doSyncReadAsAsync(() => this._findCookiesSync(domain, path, allowSpecialUseDomain), cb)
  }

  /**
   * Searches for matching cookies and returns them.
   * @param {string} domain - The cookies domain.
   * @param {string} path - The cookies path.
   * @param {boolean} allowSpecialUseDomain - If `true` then special-use domain suffixes will be allowed in matches. Defaults to `false`.
   * @returns {Cookie[]} the matching cookies if any were found.
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

  /** @inheritdoc */
  putCookie(cookie: Cookie, cb: ErrorCallback): void;
  /** @inheritdoc */
  putCookie(cookie: Cookie): Promise<void>;
  /** @inheritdoc */
  putCookie (cookie: Cookie, cb?: ErrorCallback): (void | Promise<void>) {
    if (this.synchronous) {
      if (cb) {
        try {
          this._putCookieSync(cookie)
        } catch (error) {
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
   * Puts a cookie in the store after waiting for the initial read to finish, then saves the store to its file.
   * @see _doSyncReadAsAsync
   * @param {Cookie} cookie - The cookie to add to the store.
   * @param {Function} cb - The callback to be called when finished.
   * @returns {Promise} a promise if no callback was passed.
   */
  private _putCookieAsync (cookie: Cookie, cb?: ErrorCallback): (void | Promise<void>) {
    return this._doSyncWriteAsAsync(() => {
      this._putCookieSyncInternal(cookie)
      return true
    }, cb)
  }

  /**
   * Puts a cookie in the store without saving to a file.
   * @param {Cookie} cookie - The cookie to add to the store.
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
   * Puts a cookie in the store, then saves synchronously.
   * @param {Cookie} cookie - The cookie to add to the store.
   */
  private _putCookieSync (cookie: Cookie) {
    this._putCookieSyncInternal(cookie)
    this._saveSync()
  }

  /** @inheritdoc */
  updateCookie(oldCookie: Cookie, newCookie: Cookie, cb: ErrorCallback): void;
  /** @inheritdoc */
  updateCookie(oldCookie: Cookie, newCookie: Cookie): Promise<void>;
  /** @inheritdoc */
  updateCookie (oldCookie: Cookie, newCookie: Cookie, cb?: ErrorCallback): (void | Promise<void>) {
    // TODO delete old cookie?
    return this.putCookie(newCookie, cb)
  }

  /** @inheritdoc */
  removeCookie(domain: string, path: string, key: string, cb: ErrorCallback): void;
  /** @inheritdoc */
  removeCookie(domain: string, path: string, key: string): Promise<void>;
  /** @inheritdoc */
  removeCookie (domain: string, path: string, key: string, cb?: ErrorCallback): (void | Promise<void>) {
    if (this.synchronous) {
      if (cb) {
        try {
          this._removeCookieSync(domain, path, key)
        } catch (error) {
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
   * Removes a cookie from the store after waiting for the initial read to finish, then saves the store to its file if removed.
   * @see _doSyncReadAsAsync
   * @param {string} domain - The domain of the cookie to remove.
   * @param {string} path - The path of the cookie to remove.
   * @param {string} key - The key of the cookie to remove.
   * @param {Function} cb - The callback to be called when finished.
   * @returns {Promise} a promise if no callback was passed.
   */
  private _removeCookieAsync (domain: string, path: string, key: string, cb?: ErrorCallback): (void | Promise<void>) {
    return this._doSyncWriteAsAsync(() => {
      return this._removeCookieSyncInternal(domain, path, key)
    }, cb)
  }

  /**
   * Removes a cookie from the store without saving to a file.
   * @param {string} domain - The domain of the cookie to remove.
   * @param {string} path - The path of the cookie to remove.
   * @param {string} key - The key of the cookie to remove.
   * @returns {boolean} true if a cookie was removed, or false if no change occured.
   */
  private _removeCookieSyncInternal (domain: string, path: string, key: string): boolean {
    const domainVal = this.idx[domain]
    if (!domainVal) {
      return false
    }
    const pathVal = domainVal[path]
    if (!pathVal) {
      return false
    }
    const deleted = (delete pathVal[key])
    // clean up entries if empty
    if (deleted && !objectHasAnyKeys(pathVal)) {
      delete domainVal[path]
      if (!objectHasAnyKeys(domainVal)) {
        delete this.idx[domain]
      }
    }
    return deleted
  }

  /**
   * Removes a cookie from the store, then saves synchronously if removed.
   * @param {string} domain - The domain of the cookie to remove.
   * @param {string} path - The path of the cookie to remove.
   * @param {string} key - The key of the cookie to remove.
   */
  private _removeCookieSync (domain: string, path: string, key: string) {
    if (this._removeCookieSyncInternal(domain, path, key)) {
      this._saveSync()
    }
  }

  /** @inheritdoc */
  removeCookies(domain: string, path: Nullable<string>, cb: ErrorCallback): void;
  /** @inheritdoc */
  removeCookies(domain: string, path: Nullable<string>): Promise<void>;
  /** @inheritdoc */
  removeCookies (domain: string, path: Nullable<string>, cb?: ErrorCallback): (void | Promise<void>) {
    if (this.synchronous) {
      if (cb) {
        try {
          this._removeCookiesSync(domain, path)
        } catch (error) {
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
   * Removes cookies from the store after waiting for the initial read to finish, then saves the store to its file if any were removed.
   * @see _doSyncReadAsAsync
   * @param {string} domain - The domain of the cookies to remove.
   * @param {string} path - The path of the cookies to remove.
   * @param {Function} cb - The callback to be called when finished.
   * @returns {Promise} a promise if no callback was passed.
   */
  private _removeCookiesAsync (domain: string, path: string, cb?: ErrorCallback): (void | Promise<void>) {
    return this._doSyncWriteAsAsync(() => {
      return this._removeCookiesSyncInternal(domain, path)
    }, cb)
  }

  /**
   * Removes cookies from the store without saving to a file.
   * @param {string} domain - The domain of the cookies to remove.
   * @param {string} path - The path of the cookies to remove.
   * @returns {boolean} true if any cookies were removed, or false if no change occured
   */
  private _removeCookiesSyncInternal (domain: string, path: string): boolean {
    // istanbul ignore else
    if (path) {
      const domainVal = this.idx[domain]
      if (domainVal) {
        const deleted = (delete domainVal[path])
        // clean up entries if empty
        if (deleted && !objectHasAnyKeys(domainVal)) {
          delete this.idx[domain]
        }
        return deleted
      }
      return false
    } else {
      const deleted = (delete this.idx[domain])
      return deleted
    }
  }

  /**
   * Removes cookies from the store, then saves synchronously if any were removed.
   * @param {string} domain - The domain of the cookies to remove.
   * @param {string} path - The path of the cookies to remove.
   */
  private _removeCookiesSync (domain: string, path: string) {
    if (this._removeCookiesSyncInternal(domain, path)) {
      this._saveSync()
    }
  }

  /** @inheritdoc */
  removeAllCookies(cb: ErrorCallback): void;
  /** @inheritdoc */
  removeAllCookies(): Promise<void>;
  /** @inheritdoc */
  removeAllCookies (cb?: ErrorCallback): (void | Promise<void>) {
    if (this.synchronous) {
      if (cb) {
        try {
          this._removeAllCookiesSync()
        } catch (error) {
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
   * Removes all cookies after waiting for the initial read to finish, then saves the store to its file if any were removed.
   * @param {Function} cb - The callback to be called when finished.
   * @returns {Promise} a promise if no callback was passed.
   */
  private _removeAllCookiesAsync (cb?: ErrorCallback): (void | Promise<void>) {
    return this._doSyncWriteAsAsync(() => {
      return this._removeAllCookiesSyncInternal()
    }, cb)
  }

  /**
   * Removes all cookies from the store without saving to a file.
   * @returns {boolean} true if any cookies were removed, or false if no change occured
   */
  private _removeAllCookiesSyncInternal (): boolean {
    if (!objectHasAnyKeys(this.idx)) {
      return false
    }
    this.idx = {}
    return true
  }

  /**
   * Removes all cookies from the store, then saves synchronously if any were removed.
   */
  private _removeAllCookiesSync () {
    if (this._removeAllCookiesSyncInternal()) {
      this._saveSync()
    }
  }

  /** @inheritdoc */
  getAllCookies(cb: Callback<Cookie[]>): void;
  /** @inheritdoc */
  getAllCookies(): Promise<Cookie[]>;
  /** @inheritdoc */
  getAllCookies (cb?: Callback<Cookie[]>): (void | Promise<Cookie[]>) {
    if (this.synchronous) {
      if (cb) {
        let cookies
        try {
          cookies = this._getAllCookiesSync()
        } catch (error) {
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
   * Gets all the cookies after waiting for the initial read to finish.
   * @param {Function} cb - The callback to be called with the results.
   * @returns {Promise<Cookie[]>} a promise if no callback was passed.
   */
  private _getAllCookiesAsync (cb?: Callback<Cookie[]>): (void | Promise<Cookie[]>) {
    return this._doSyncReadAsAsync(() => this._getAllCookiesSync(), cb)
  }

  /**
   * Gets all the cookies in the store and returns them.
   * @returns {Cookie[]} an array of all the cookies in the store.
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
   * Load the store from a file asynchronously.
   *
   * @param {string} filePath - The file to load the store from.
   * @returns {Promise<CookiesData>} a promise that resolves with the parsed data from the file.
   */
  private async _loadFromFileAsync (filePath: string): Promise<CookiesData> {
    await fs.promises.access(filePath)
    const data = await fs.promises.readFile(filePath, 'utf8')
    return this._loadFromStringSync(data, filePath)
  }

  /**
   * Load the store from a file synchronously.
   *
   * @param {string} filePath - The file to load the store from.
   * @returns {CookiesData} the parsed data from the file
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
   * Loads the store from a json string.
   * @param {string} data - The string data that was loaded from a file.
   * @param {string} filePath - The path of the file that the string data was loaded from.
   * @returns {CookiesData} the parsed data
   */
  private _loadFromStringSync (data: string | null, filePath: string): CookiesData {
    // istanbul ignore else
    let dataJson = null
    try {
      dataJson = JSON.parse(data)
    } catch {
      throw new Error(`Could not parse cookie file ${filePath}. Please ensure it is not corrupted.`)
    }

    // create Cookie instances of all entries
    for (const d in dataJson) {
      const dVal = dataJson[d]
      for (const p in dVal) {
        const pVal = dVal[p]
        for (const k in pVal) {
          // since Cookie is a class, we need to create an instance of it
          pVal[k] = Cookie.fromJSON(JSON.stringify(pVal[k]))
        }
      }
    }
    return dataJson
  }

  /**
   * Saves the store to its file.
   * @param {Function} cb - The callback to be called when finished.
   * @returns {Promise} a promise if no callback was passed.
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
   * Saves the store to its file asynchronously.
   * @param {Function} cb - The callback to be called when finished.
   * @returns {Promise} a promise if no callback was passed.
   */
  private _saveAsync (cb?: ErrorCallback): (void | Promise<void>) {
    if (!this._nextWritePromise) {
      // create next write promise
      this._nextWritePromise = (async () => {
        let async = false
        // wait for active write to finish if any
        if (this._writePromise) {
          async = true
          // wait for write to finish
          try {
            await this._writePromise
          } catch {
            // ignore error
          }
        }
        // delay one frame, in case of multiple writes
        if (!async) {
          await Promise.resolve();
        }
        // this is now the active write, so update the write promises
        this._writePromise = this._nextWritePromise
        this._nextWritePromise = undefined
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
   * Saves the store to its file synchronously.
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
   * Saves the store to a file asynchronously.
   * @param {string} filePath - The file path to save the store to.
   * @param {CookiesData} data - The cookies to save to the file.
   * @param {Function} cb - The callback to be called when finished.
   * @returns {Promise} a promise if no callback was passed.
   */
  private _saveToFileAsync (filePath: string, data: CookiesData, cb?: (error: Error) => void): (void | Promise<void>) {
    const dataString = JSON.stringify(data)
    if (cb) {
      fs.writeFile(filePath, dataString, cb)
    } else {
      return util.promisify(fs.writeFile)(filePath, dataString)
    }
  }

  /**
   * Saves the store to a file synchronously.
   * @param {string} filePath - The file path to save the store to.
   * @param {CookiesData} data - The cookies to save to the file.
   */
  private _saveToFileSync (filePath: string, data: CookiesData): void {
    const dataString = JSON.stringify(data)
    fs.writeFileSync(filePath, dataString)
  }
}

/**
 * Tells if the given object has any keys
 * @param {object} obj - The object to check for any keys
 * @returns {boolean} true if the object has a key, or false if the object has no keys.
 */
function objectHasAnyKeys (obj: object) {
  // eslint-disable-next-line no-unreachable-loop
  for (const key in obj) {
    return true
  }
  return false
}
