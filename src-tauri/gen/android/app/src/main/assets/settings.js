(() => {
  // node_modules/@tauri-apps/api/external/tslib/tslib.es6.js
  function __classPrivateFieldGet(receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
  }
  function __classPrivateFieldSet(receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
  }

  // node_modules/@tauri-apps/api/core.js
  var _Channel_onmessage;
  var _Channel_nextMessageIndex;
  var _Channel_pendingMessages;
  var _Channel_messageEndIndex;
  var _Resource_rid;
  var SERIALIZE_TO_IPC_FN = "__TAURI_TO_IPC_KEY__";
  function transformCallback(callback, once2 = false) {
    return window.__TAURI_INTERNALS__.transformCallback(callback, once2);
  }
  var Channel = class {
    constructor(onmessage) {
      _Channel_onmessage.set(this, void 0);
      _Channel_nextMessageIndex.set(this, 0);
      _Channel_pendingMessages.set(this, []);
      _Channel_messageEndIndex.set(this, void 0);
      __classPrivateFieldSet(this, _Channel_onmessage, onmessage || (() => {
      }), "f");
      this.id = transformCallback((rawMessage) => {
        const index = rawMessage.index;
        if ("end" in rawMessage) {
          if (index == __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")) {
            this.cleanupCallback();
          } else {
            __classPrivateFieldSet(this, _Channel_messageEndIndex, index, "f");
          }
          return;
        }
        const message = rawMessage.message;
        if (index == __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")) {
          __classPrivateFieldGet(this, _Channel_onmessage, "f").call(this, message);
          __classPrivateFieldSet(this, _Channel_nextMessageIndex, __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") + 1, "f");
          while (__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") in __classPrivateFieldGet(this, _Channel_pendingMessages, "f")) {
            const message2 = __classPrivateFieldGet(this, _Channel_pendingMessages, "f")[__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")];
            __classPrivateFieldGet(this, _Channel_onmessage, "f").call(this, message2);
            delete __classPrivateFieldGet(this, _Channel_pendingMessages, "f")[__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f")];
            __classPrivateFieldSet(this, _Channel_nextMessageIndex, __classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") + 1, "f");
          }
          if (__classPrivateFieldGet(this, _Channel_nextMessageIndex, "f") === __classPrivateFieldGet(this, _Channel_messageEndIndex, "f")) {
            this.cleanupCallback();
          }
        } else {
          __classPrivateFieldGet(this, _Channel_pendingMessages, "f")[index] = message;
        }
      });
    }
    cleanupCallback() {
      window.__TAURI_INTERNALS__.unregisterCallback(this.id);
    }
    set onmessage(handler) {
      __classPrivateFieldSet(this, _Channel_onmessage, handler, "f");
    }
    get onmessage() {
      return __classPrivateFieldGet(this, _Channel_onmessage, "f");
    }
    [(_Channel_onmessage = /* @__PURE__ */ new WeakMap(), _Channel_nextMessageIndex = /* @__PURE__ */ new WeakMap(), _Channel_pendingMessages = /* @__PURE__ */ new WeakMap(), _Channel_messageEndIndex = /* @__PURE__ */ new WeakMap(), SERIALIZE_TO_IPC_FN)]() {
      return `__CHANNEL__:${this.id}`;
    }
    toJSON() {
      return this[SERIALIZE_TO_IPC_FN]();
    }
  };
  async function invoke(cmd, args = {}, options) {
    return window.__TAURI_INTERNALS__.invoke(cmd, args, options);
  }
  var Resource = class {
    get rid() {
      return __classPrivateFieldGet(this, _Resource_rid, "f");
    }
    constructor(rid) {
      _Resource_rid.set(this, void 0);
      __classPrivateFieldSet(this, _Resource_rid, rid, "f");
    }
    /**
     * Destroys and cleans up this resource from memory.
     * **You should not call any method on this object anymore and should drop any reference to it.**
     */
    async close() {
      return invoke("plugin:resources|close", {
        rid: this.rid
      });
    }
  };
  _Resource_rid = /* @__PURE__ */ new WeakMap();

  // node_modules/@tauri-apps/api/event.js
  var TauriEvent;
  (function(TauriEvent2) {
    TauriEvent2["WINDOW_RESIZED"] = "tauri://resize";
    TauriEvent2["WINDOW_MOVED"] = "tauri://move";
    TauriEvent2["WINDOW_CLOSE_REQUESTED"] = "tauri://close-requested";
    TauriEvent2["WINDOW_DESTROYED"] = "tauri://destroyed";
    TauriEvent2["WINDOW_FOCUS"] = "tauri://focus";
    TauriEvent2["WINDOW_BLUR"] = "tauri://blur";
    TauriEvent2["WINDOW_SCALE_FACTOR_CHANGED"] = "tauri://scale-change";
    TauriEvent2["WINDOW_THEME_CHANGED"] = "tauri://theme-changed";
    TauriEvent2["WINDOW_CREATED"] = "tauri://window-created";
    TauriEvent2["WINDOW_SUSPENDED"] = "tauri://suspended";
    TauriEvent2["WINDOW_RESUMED"] = "tauri://resumed";
    TauriEvent2["WEBVIEW_CREATED"] = "tauri://webview-created";
    TauriEvent2["DRAG_ENTER"] = "tauri://drag-enter";
    TauriEvent2["DRAG_OVER"] = "tauri://drag-over";
    TauriEvent2["DRAG_DROP"] = "tauri://drag-drop";
    TauriEvent2["DRAG_LEAVE"] = "tauri://drag-leave";
  })(TauriEvent || (TauriEvent = {}));
  async function _unlisten(event, eventId) {
    window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(event, eventId);
    await invoke("plugin:event|unlisten", {
      event,
      eventId
    });
  }
  async function listen(event, handler, options) {
    var _a;
    const target = typeof (options === null || options === void 0 ? void 0 : options.target) === "string" ? { kind: "AnyLabel", label: options.target } : (_a = options === null || options === void 0 ? void 0 : options.target) !== null && _a !== void 0 ? _a : { kind: "Any" };
    return invoke("plugin:event|listen", {
      event,
      target,
      handler: transformCallback(handler)
    }).then((eventId) => {
      return async () => _unlisten(event, eventId);
    });
  }
  async function once(event, handler, options) {
    return listen(event, (eventData) => {
      void _unlisten(event, eventData.id);
      handler(eventData);
    }, options);
  }
  async function emit(event, payload) {
    await invoke("plugin:event|emit", {
      event,
      payload
    });
  }
  async function emitTo(target, event, payload) {
    const eventTarget = typeof target === "string" ? { kind: "AnyLabel", label: target } : target;
    await invoke("plugin:event|emit_to", {
      target: eventTarget,
      event,
      payload
    });
  }

  // node_modules/@tauri-apps/api/dpi.js
  var LogicalSize = class {
    constructor(...args) {
      this.type = "Logical";
      if (args.length === 1) {
        if ("Logical" in args[0]) {
          this.width = args[0].Logical.width;
          this.height = args[0].Logical.height;
        } else {
          this.width = args[0].width;
          this.height = args[0].height;
        }
      } else {
        this.width = args[0];
        this.height = args[1];
      }
    }
    /**
     * Converts the logical size to a physical one.
     * @example
     * ```typescript
     * import { LogicalSize } from '@tauri-apps/api/dpi';
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     *
     * const appWindow = getCurrentWindow();
     * const factor = await appWindow.scaleFactor();
     * const size = new LogicalSize(400, 500);
     * const physical = size.toPhysical(factor);
     * ```
     *
     * @since 2.0.0
     */
    toPhysical(scaleFactor) {
      return new PhysicalSize(this.width * scaleFactor, this.height * scaleFactor);
    }
    [SERIALIZE_TO_IPC_FN]() {
      return {
        width: this.width,
        height: this.height
      };
    }
    toJSON() {
      return this[SERIALIZE_TO_IPC_FN]();
    }
  };
  var PhysicalSize = class {
    constructor(...args) {
      this.type = "Physical";
      if (args.length === 1) {
        if ("Physical" in args[0]) {
          this.width = args[0].Physical.width;
          this.height = args[0].Physical.height;
        } else {
          this.width = args[0].width;
          this.height = args[0].height;
        }
      } else {
        this.width = args[0];
        this.height = args[1];
      }
    }
    /**
     * Converts the physical size to a logical one.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * const appWindow = getCurrentWindow();
     * const factor = await appWindow.scaleFactor();
     * const size = await appWindow.innerSize(); // PhysicalSize
     * const logical = size.toLogical(factor);
     * ```
     */
    toLogical(scaleFactor) {
      return new LogicalSize(this.width / scaleFactor, this.height / scaleFactor);
    }
    [SERIALIZE_TO_IPC_FN]() {
      return {
        width: this.width,
        height: this.height
      };
    }
    toJSON() {
      return this[SERIALIZE_TO_IPC_FN]();
    }
  };
  var Size = class {
    constructor(size) {
      this.size = size;
    }
    toLogical(scaleFactor) {
      return this.size instanceof LogicalSize ? this.size : this.size.toLogical(scaleFactor);
    }
    toPhysical(scaleFactor) {
      return this.size instanceof PhysicalSize ? this.size : this.size.toPhysical(scaleFactor);
    }
    [SERIALIZE_TO_IPC_FN]() {
      return {
        [`${this.size.type}`]: {
          width: this.size.width,
          height: this.size.height
        }
      };
    }
    toJSON() {
      return this[SERIALIZE_TO_IPC_FN]();
    }
  };
  var LogicalPosition = class {
    constructor(...args) {
      this.type = "Logical";
      if (args.length === 1) {
        if ("Logical" in args[0]) {
          this.x = args[0].Logical.x;
          this.y = args[0].Logical.y;
        } else {
          this.x = args[0].x;
          this.y = args[0].y;
        }
      } else {
        this.x = args[0];
        this.y = args[1];
      }
    }
    /**
     * Converts the logical position to a physical one.
     * @example
     * ```typescript
     * import { LogicalPosition } from '@tauri-apps/api/dpi';
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     *
     * const appWindow = getCurrentWindow();
     * const factor = await appWindow.scaleFactor();
     * const position = new LogicalPosition(400, 500);
     * const physical = position.toPhysical(factor);
     * ```
     *
     * @since 2.0.0
     */
    toPhysical(scaleFactor) {
      return new PhysicalPosition(this.x * scaleFactor, this.y * scaleFactor);
    }
    [SERIALIZE_TO_IPC_FN]() {
      return {
        x: this.x,
        y: this.y
      };
    }
    toJSON() {
      return this[SERIALIZE_TO_IPC_FN]();
    }
  };
  var PhysicalPosition = class {
    constructor(...args) {
      this.type = "Physical";
      if (args.length === 1) {
        if ("Physical" in args[0]) {
          this.x = args[0].Physical.x;
          this.y = args[0].Physical.y;
        } else {
          this.x = args[0].x;
          this.y = args[0].y;
        }
      } else {
        this.x = args[0];
        this.y = args[1];
      }
    }
    /**
     * Converts the physical position to a logical one.
     * @example
     * ```typescript
     * import { PhysicalPosition } from '@tauri-apps/api/dpi';
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     *
     * const appWindow = getCurrentWindow();
     * const factor = await appWindow.scaleFactor();
     * const position = new PhysicalPosition(400, 500);
     * const physical = position.toLogical(factor);
     * ```
     *
     * @since 2.0.0
     */
    toLogical(scaleFactor) {
      return new LogicalPosition(this.x / scaleFactor, this.y / scaleFactor);
    }
    [SERIALIZE_TO_IPC_FN]() {
      return {
        x: this.x,
        y: this.y
      };
    }
    toJSON() {
      return this[SERIALIZE_TO_IPC_FN]();
    }
  };
  var Position = class {
    constructor(position) {
      this.position = position;
    }
    toLogical(scaleFactor) {
      return this.position instanceof LogicalPosition ? this.position : this.position.toLogical(scaleFactor);
    }
    toPhysical(scaleFactor) {
      return this.position instanceof PhysicalPosition ? this.position : this.position.toPhysical(scaleFactor);
    }
    [SERIALIZE_TO_IPC_FN]() {
      return {
        [`${this.position.type}`]: {
          x: this.position.x,
          y: this.position.y
        }
      };
    }
    toJSON() {
      return this[SERIALIZE_TO_IPC_FN]();
    }
  };

  // node_modules/@tauri-apps/api/image.js
  var Image = class _Image extends Resource {
    /**
     * Creates an Image from a resource ID. For internal use only.
     *
     * @ignore
     */
    constructor(rid) {
      super(rid);
    }
    /** Creates a new Image using RGBA data, in row-major order from top to bottom, and with specified width and height. */
    static async new(rgba, width, height) {
      return invoke("plugin:image|new", {
        rgba: transformImage(rgba),
        width,
        height
      }).then((rid) => new _Image(rid));
    }
    /**
     * Creates a new image using the provided bytes by inferring the file format.
     * If the format is known, prefer [@link Image.fromPngBytes] or [@link Image.fromIcoBytes].
     *
     * Only `ico` and `png` are supported (based on activated feature flag).
     *
     * Note that you need the `image-ico` or `image-png` Cargo features to use this API.
     * To enable it, change your Cargo.toml file:
     * ```toml
     * [dependencies]
     * tauri = { version = "...", features = ["...", "image-png"] }
     * ```
     */
    static async fromBytes(bytes) {
      return invoke("plugin:image|from_bytes", {
        bytes: transformImage(bytes)
      }).then((rid) => new _Image(rid));
    }
    /**
     * Creates a new image using the provided path.
     *
     * Only `ico` and `png` are supported (based on activated feature flag).
     *
     * Note that you need the `image-ico` or `image-png` Cargo features to use this API.
     * To enable it, change your Cargo.toml file:
     * ```toml
     * [dependencies]
     * tauri = { version = "...", features = ["...", "image-png"] }
     * ```
     */
    static async fromPath(path) {
      return invoke("plugin:image|from_path", { path }).then((rid) => new _Image(rid));
    }
    /** Returns the RGBA data for this image, in row-major order from top to bottom.  */
    async rgba() {
      return invoke("plugin:image|rgba", {
        rid: this.rid
      }).then((buffer) => new Uint8Array(buffer));
    }
    /** Returns the size of this image.  */
    async size() {
      return invoke("plugin:image|size", { rid: this.rid });
    }
  };
  function transformImage(image) {
    const ret = image == null ? null : typeof image === "string" ? image : image instanceof Image ? image.rid : image;
    return ret;
  }

  // node_modules/@tauri-apps/api/window.js
  var UserAttentionType;
  (function(UserAttentionType2) {
    UserAttentionType2[UserAttentionType2["Critical"] = 1] = "Critical";
    UserAttentionType2[UserAttentionType2["Informational"] = 2] = "Informational";
  })(UserAttentionType || (UserAttentionType = {}));
  var CloseRequestedEvent = class {
    constructor(event) {
      this._preventDefault = false;
      this.event = event.event;
      this.id = event.id;
    }
    preventDefault() {
      this._preventDefault = true;
    }
    isPreventDefault() {
      return this._preventDefault;
    }
  };
  var ProgressBarStatus;
  (function(ProgressBarStatus2) {
    ProgressBarStatus2["None"] = "none";
    ProgressBarStatus2["Normal"] = "normal";
    ProgressBarStatus2["Indeterminate"] = "indeterminate";
    ProgressBarStatus2["Paused"] = "paused";
    ProgressBarStatus2["Error"] = "error";
  })(ProgressBarStatus || (ProgressBarStatus = {}));
  function getCurrentWindow() {
    return new Window(window.__TAURI_INTERNALS__.metadata.currentWindow.label, {
      // @ts-expect-error `skip` is not defined in the public API but it is handled by the constructor
      skip: true
    });
  }
  async function getAllWindows() {
    return invoke("plugin:window|get_all_windows").then((windows) => windows.map((w) => new Window(w, {
      // @ts-expect-error `skip` is not defined in the public API but it is handled by the constructor
      skip: true
    })));
  }
  var localTauriEvents = ["tauri://created", "tauri://error"];
  var Window = class {
    /**
     * Creates a new Window.
     * @example
     * ```typescript
     * import { Window } from '@tauri-apps/api/window';
     * const appWindow = new Window('my-label');
     * appWindow.once('tauri://created', function () {
     *  // window successfully created
     * });
     * appWindow.once('tauri://error', function (e) {
     *  // an error happened creating the window
     * });
     * ```
     *
     * @param label The unique window label. Must be alphanumeric: `a-zA-Z-/:_`.
     * @returns The {@link Window} instance to communicate with the window.
     */
    constructor(label, options = {}) {
      var _a;
      this.label = label;
      this.listeners = /* @__PURE__ */ Object.create(null);
      if (!(options === null || options === void 0 ? void 0 : options.skip)) {
        invoke("plugin:window|create", {
          options: {
            ...options,
            parent: typeof options.parent === "string" ? options.parent : (_a = options.parent) === null || _a === void 0 ? void 0 : _a.label,
            label
          }
        }).then(async () => this.emit("tauri://created")).catch(async (e) => this.emit("tauri://error", e));
      }
    }
    /**
     * Gets the Window associated with the given label.
     * @example
     * ```typescript
     * import { Window } from '@tauri-apps/api/window';
     * const mainWindow = Window.getByLabel('main');
     * ```
     *
     * @param label The window label.
     * @returns The Window instance to communicate with the window or null if the window doesn't exist.
     */
    static async getByLabel(label) {
      var _a;
      return (_a = (await getAllWindows()).find((w) => w.label === label)) !== null && _a !== void 0 ? _a : null;
    }
    /**
     * Get an instance of `Window` for the current window.
     */
    static getCurrent() {
      return getCurrentWindow();
    }
    /**
     * Gets a list of instances of `Window` for all available windows.
     */
    static async getAll() {
      return getAllWindows();
    }
    /**
     *  Gets the focused window.
     * @example
     * ```typescript
     * import { Window } from '@tauri-apps/api/window';
     * const focusedWindow = Window.getFocusedWindow();
     * ```
     *
     * @returns The Window instance or `undefined` if there is not any focused window.
     */
    static async getFocusedWindow() {
      for (const w of await getAllWindows()) {
        if (await w.isFocused()) {
          return w;
        }
      }
      return null;
    }
    /**
     * Listen to an emitted event on this window.
     *
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * const unlisten = await getCurrentWindow().listen<string>('state-changed', (event) => {
     *   console.log(`Got error: ${payload}`);
     * });
     *
     * // you need to call unlisten if your handler goes out of scope e.g. the component is unmounted
     * unlisten();
     * ```
     *
     * @param event Event name. Must include only alphanumeric characters, `-`, `/`, `:` and `_`.
     * @param handler Event handler.
     * @returns A promise resolving to a function to unlisten to the event.
     * Note that removing the listener is required if your listener goes out of scope e.g. the component is unmounted.
     */
    async listen(event, handler) {
      if (this._handleTauriEvent(event, handler)) {
        return () => {
          const listeners = this.listeners[event];
          listeners.splice(listeners.indexOf(handler), 1);
        };
      }
      return listen(event, handler, {
        target: { kind: "Window", label: this.label }
      });
    }
    /**
     * Listen to an emitted event on this window only once.
     *
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * const unlisten = await getCurrentWindow().once<null>('initialized', (event) => {
     *   console.log(`Window initialized!`);
     * });
     *
     * // you need to call unlisten if your handler goes out of scope e.g. the component is unmounted
     * unlisten();
     * ```
     *
     * @param event Event name. Must include only alphanumeric characters, `-`, `/`, `:` and `_`.
     * @param handler Event handler.
     * @returns A promise resolving to a function to unlisten to the event.
     * Note that removing the listener is required if your listener goes out of scope e.g. the component is unmounted.
     */
    async once(event, handler) {
      if (this._handleTauriEvent(event, handler)) {
        return () => {
          const listeners = this.listeners[event];
          listeners.splice(listeners.indexOf(handler), 1);
        };
      }
      return once(event, handler, {
        target: { kind: "Window", label: this.label }
      });
    }
    /**
     * Emits an event to all {@link EventTarget|targets}.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().emit('window-loaded', { loggedIn: true, token: 'authToken' });
     * ```
     *
     * @param event Event name. Must include only alphanumeric characters, `-`, `/`, `:` and `_`.
     * @param payload Event payload.
     */
    async emit(event, payload) {
      if (localTauriEvents.includes(event)) {
        for (const handler of this.listeners[event] || []) {
          handler({
            event,
            id: -1,
            payload
          });
        }
        return;
      }
      return emit(event, payload);
    }
    /**
     * Emits an event to all {@link EventTarget|targets} matching the given target.
     *
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().emit('main', 'window-loaded', { loggedIn: true, token: 'authToken' });
     * ```
     * @param target Label of the target Window/Webview/WebviewWindow or raw {@link EventTarget} object.
     * @param event Event name. Must include only alphanumeric characters, `-`, `/`, `:` and `_`.
     * @param payload Event payload.
     */
    async emitTo(target, event, payload) {
      if (localTauriEvents.includes(event)) {
        for (const handler of this.listeners[event] || []) {
          handler({
            event,
            id: -1,
            payload
          });
        }
        return;
      }
      return emitTo(target, event, payload);
    }
    /** @ignore */
    _handleTauriEvent(event, handler) {
      if (localTauriEvents.includes(event)) {
        if (!(event in this.listeners)) {
          this.listeners[event] = [handler];
        } else {
          this.listeners[event].push(handler);
        }
        return true;
      }
      return false;
    }
    // Getters
    /**
     * The scale factor that can be used to map physical pixels to logical pixels.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * const factor = await getCurrentWindow().scaleFactor();
     * ```
     *
     * @returns The window's monitor scale factor.
     */
    async scaleFactor() {
      return invoke("plugin:window|scale_factor", {
        label: this.label
      });
    }
    /**
     * The position of the top-left hand corner of the window's client area relative to the top-left hand corner of the desktop.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * const position = await getCurrentWindow().innerPosition();
     * ```
     *
     * @returns The window's inner position.
     */
    async innerPosition() {
      return invoke("plugin:window|inner_position", {
        label: this.label
      }).then((p) => new PhysicalPosition(p));
    }
    /**
     * The position of the top-left hand corner of the window relative to the top-left hand corner of the desktop.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * const position = await getCurrentWindow().outerPosition();
     * ```
     *
     * @returns The window's outer position.
     */
    async outerPosition() {
      return invoke("plugin:window|outer_position", {
        label: this.label
      }).then((p) => new PhysicalPosition(p));
    }
    /**
     * The physical size of the window's client area.
     * The client area is the content of the window, excluding the title bar and borders.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * const size = await getCurrentWindow().innerSize();
     * ```
     *
     * @returns The window's inner size.
     */
    async innerSize() {
      return invoke("plugin:window|inner_size", {
        label: this.label
      }).then((s) => new PhysicalSize(s));
    }
    /**
     * The physical size of the entire window.
     * These dimensions include the title bar and borders. If you don't want that (and you usually don't), use inner_size instead.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * const size = await getCurrentWindow().outerSize();
     * ```
     *
     * @returns The window's outer size.
     */
    async outerSize() {
      return invoke("plugin:window|outer_size", {
        label: this.label
      }).then((s) => new PhysicalSize(s));
    }
    /**
     * Gets the window's current fullscreen state.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * const fullscreen = await getCurrentWindow().isFullscreen();
     * ```
     *
     * @returns Whether the window is in fullscreen mode or not.
     */
    async isFullscreen() {
      return invoke("plugin:window|is_fullscreen", {
        label: this.label
      });
    }
    /**
     * Gets the window's current minimized state.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * const minimized = await getCurrentWindow().isMinimized();
     * ```
     */
    async isMinimized() {
      return invoke("plugin:window|is_minimized", {
        label: this.label
      });
    }
    /**
     * Gets the window's current maximized state.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * const maximized = await getCurrentWindow().isMaximized();
     * ```
     *
     * @returns Whether the window is maximized or not.
     */
    async isMaximized() {
      return invoke("plugin:window|is_maximized", {
        label: this.label
      });
    }
    /**
     * Gets the window's current focus state.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * const focused = await getCurrentWindow().isFocused();
     * ```
     *
     * @returns Whether the window is focused or not.
     */
    async isFocused() {
      return invoke("plugin:window|is_focused", {
        label: this.label
      });
    }
    /**
     * Gets the window's current decorated state.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * const decorated = await getCurrentWindow().isDecorated();
     * ```
     *
     * @returns Whether the window is decorated or not.
     */
    async isDecorated() {
      return invoke("plugin:window|is_decorated", {
        label: this.label
      });
    }
    /**
     * Gets the window's current resizable state.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * const resizable = await getCurrentWindow().isResizable();
     * ```
     *
     * @returns Whether the window is resizable or not.
     */
    async isResizable() {
      return invoke("plugin:window|is_resizable", {
        label: this.label
      });
    }
    /**
     * Gets the window's native maximize button state.
     *
     * #### Platform-specific
     *
     * - **Linux / iOS / Android:** Unsupported.
     *
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * const maximizable = await getCurrentWindow().isMaximizable();
     * ```
     *
     * @returns Whether the window's native maximize button is enabled or not.
     */
    async isMaximizable() {
      return invoke("plugin:window|is_maximizable", {
        label: this.label
      });
    }
    /**
     * Gets the window's native minimize button state.
     *
     * #### Platform-specific
     *
     * - **Linux / iOS / Android:** Unsupported.
     *
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * const minimizable = await getCurrentWindow().isMinimizable();
     * ```
     *
     * @returns Whether the window's native minimize button is enabled or not.
     */
    async isMinimizable() {
      return invoke("plugin:window|is_minimizable", {
        label: this.label
      });
    }
    /**
     * Gets the window's native close button state.
     *
     * #### Platform-specific
     *
     * - **iOS / Android:** Unsupported.
     *
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * const closable = await getCurrentWindow().isClosable();
     * ```
     *
     * @returns Whether the window's native close button is enabled or not.
     */
    async isClosable() {
      return invoke("plugin:window|is_closable", {
        label: this.label
      });
    }
    /**
     * Gets the window's current visible state.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * const visible = await getCurrentWindow().isVisible();
     * ```
     *
     * @returns Whether the window is visible or not.
     */
    async isVisible() {
      return invoke("plugin:window|is_visible", {
        label: this.label
      });
    }
    /**
     * Gets the window's current title.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * const title = await getCurrentWindow().title();
     * ```
     */
    async title() {
      return invoke("plugin:window|title", {
        label: this.label
      });
    }
    /**
     * Gets the window's current theme.
     *
     * #### Platform-specific
     *
     * - **macOS:** Theme was introduced on macOS 10.14. Returns `light` on macOS 10.13 and below.
     *
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * const theme = await getCurrentWindow().theme();
     * ```
     *
     * @returns The window theme.
     */
    async theme() {
      return invoke("plugin:window|theme", {
        label: this.label
      });
    }
    /**
     * Whether the window is configured to be always on top of other windows or not.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * const alwaysOnTop = await getCurrentWindow().isAlwaysOnTop();
     * ```
     *
     * @returns Whether the window is visible or not.
     */
    async isAlwaysOnTop() {
      return invoke("plugin:window|is_always_on_top", {
        label: this.label
      });
    }
    async activityName() {
      return invoke("plugin:window|activity_name", {
        label: this.label
      });
    }
    async sceneIdentifier() {
      return invoke("plugin:window|scene_identifier", {
        label: this.label
      });
    }
    // Setters
    /**
     * Centers the window.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().center();
     * ```
     *
     * @returns A promise indicating the success or failure of the operation.
     */
    async center() {
      return invoke("plugin:window|center", {
        label: this.label
      });
    }
    /**
     *  Requests user attention to the window, this has no effect if the application
     * is already focused. How requesting for user attention manifests is platform dependent,
     * see `UserAttentionType` for details.
     *
     * Providing `null` will unset the request for user attention. Unsetting the request for
     * user attention might not be done automatically by the WM when the window receives input.
     *
     * #### Platform-specific
     *
     * - **macOS:** `null` has no effect.
     * - **Linux:** Urgency levels have the same effect.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().requestUserAttention();
     * ```
     *
     * @returns A promise indicating the success or failure of the operation.
     */
    async requestUserAttention(requestType) {
      let requestType_ = null;
      if (requestType) {
        if (requestType === UserAttentionType.Critical) {
          requestType_ = { type: "Critical" };
        } else {
          requestType_ = { type: "Informational" };
        }
      }
      return invoke("plugin:window|request_user_attention", {
        label: this.label,
        value: requestType_
      });
    }
    /**
     * Updates the window resizable flag.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().setResizable(false);
     * ```
     *
     * @returns A promise indicating the success or failure of the operation.
     */
    async setResizable(resizable) {
      return invoke("plugin:window|set_resizable", {
        label: this.label,
        value: resizable
      });
    }
    /**
     * Enable or disable the window.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().setEnabled(false);
     * ```
     *
     * @returns A promise indicating the success or failure of the operation.
     *
     * @since 2.0.0
     */
    async setEnabled(enabled) {
      return invoke("plugin:window|set_enabled", {
        label: this.label,
        value: enabled
      });
    }
    /**
     * Whether the window is enabled or disabled.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().setEnabled(false);
     * ```
     *
     * @returns A promise indicating the success or failure of the operation.
     *
     * @since 2.0.0
     */
    async isEnabled() {
      return invoke("plugin:window|is_enabled", {
        label: this.label
      });
    }
    /**
     * Sets whether the window's native maximize button is enabled or not.
     * If resizable is set to false, this setting is ignored.
     *
     * #### Platform-specific
     *
     * - **macOS:** Disables the "zoom" button in the window titlebar, which is also used to enter fullscreen mode.
     * - **Linux / iOS / Android:** Unsupported.
     *
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().setMaximizable(false);
     * ```
     *
     * @returns A promise indicating the success or failure of the operation.
     */
    async setMaximizable(maximizable) {
      return invoke("plugin:window|set_maximizable", {
        label: this.label,
        value: maximizable
      });
    }
    /**
     * Sets whether the window's native minimize button is enabled or not.
     *
     * #### Platform-specific
     *
     * - **Linux / iOS / Android:** Unsupported.
     *
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().setMinimizable(false);
     * ```
     *
     * @returns A promise indicating the success or failure of the operation.
     */
    async setMinimizable(minimizable) {
      return invoke("plugin:window|set_minimizable", {
        label: this.label,
        value: minimizable
      });
    }
    /**
     * Sets whether the window's native close button is enabled or not.
     *
     * #### Platform-specific
     *
     * - **Linux:** GTK+ will do its best to convince the window manager not to show a close button. Depending on the system, this function may not have any effect when called on a window that is already visible
     * - **iOS / Android:** Unsupported.
     *
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().setClosable(false);
     * ```
     *
     * @returns A promise indicating the success or failure of the operation.
     */
    async setClosable(closable) {
      return invoke("plugin:window|set_closable", {
        label: this.label,
        value: closable
      });
    }
    /**
     * Sets the window title.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().setTitle('Tauri');
     * ```
     *
     * @param title The new title
     * @returns A promise indicating the success or failure of the operation.
     */
    async setTitle(title) {
      return invoke("plugin:window|set_title", {
        label: this.label,
        value: title
      });
    }
    /**
     * Maximizes the window.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().maximize();
     * ```
     *
     * @returns A promise indicating the success or failure of the operation.
     */
    async maximize() {
      return invoke("plugin:window|maximize", {
        label: this.label
      });
    }
    /**
     * Unmaximizes the window.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().unmaximize();
     * ```
     *
     * @returns A promise indicating the success or failure of the operation.
     */
    async unmaximize() {
      return invoke("plugin:window|unmaximize", {
        label: this.label
      });
    }
    /**
     * Toggles the window maximized state.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().toggleMaximize();
     * ```
     *
     * @returns A promise indicating the success or failure of the operation.
     */
    async toggleMaximize() {
      return invoke("plugin:window|toggle_maximize", {
        label: this.label
      });
    }
    /**
     * Minimizes the window.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().minimize();
     * ```
     *
     * @returns A promise indicating the success or failure of the operation.
     */
    async minimize() {
      return invoke("plugin:window|minimize", {
        label: this.label
      });
    }
    /**
     * Unminimizes the window.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().unminimize();
     * ```
     *
     * @returns A promise indicating the success or failure of the operation.
     */
    async unminimize() {
      return invoke("plugin:window|unminimize", {
        label: this.label
      });
    }
    /**
     * Sets the window visibility to true.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().show();
     * ```
     *
     * @returns A promise indicating the success or failure of the operation.
     */
    async show() {
      return invoke("plugin:window|show", {
        label: this.label
      });
    }
    /**
     * Sets the window visibility to false.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().hide();
     * ```
     *
     * @returns A promise indicating the success or failure of the operation.
     */
    async hide() {
      return invoke("plugin:window|hide", {
        label: this.label
      });
    }
    /**
     * Closes the window.
     *
     * Note this emits a closeRequested event so you can intercept it. To force window close, use {@link Window.destroy}.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().close();
     * ```
     *
     * @returns A promise indicating the success or failure of the operation.
     */
    async close() {
      return invoke("plugin:window|close", {
        label: this.label
      });
    }
    /**
     * Destroys the window. Behaves like {@link Window.close} but forces the window close instead of emitting a closeRequested event.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().destroy();
     * ```
     *
     * @returns A promise indicating the success or failure of the operation.
     */
    async destroy() {
      return invoke("plugin:window|destroy", {
        label: this.label
      });
    }
    /**
     * Whether the window should have borders and bars.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().setDecorations(false);
     * ```
     *
     * @param decorations Whether the window should have borders and bars.
     * @returns A promise indicating the success or failure of the operation.
     */
    async setDecorations(decorations) {
      return invoke("plugin:window|set_decorations", {
        label: this.label,
        value: decorations
      });
    }
    /**
     * Whether or not the window should have shadow.
     *
     * #### Platform-specific
     *
     * - **Windows:**
     *   - `false` has no effect on decorated window, shadows are always ON.
     *   - `true` will make undecorated window have a 1px white border,
     * and on Windows 11, it will have a rounded corners.
     * - **Linux:** Unsupported.
     *
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().setShadow(false);
     * ```
     *
     * @returns A promise indicating the success or failure of the operation.
     */
    async setShadow(enable) {
      return invoke("plugin:window|set_shadow", {
        label: this.label,
        value: enable
      });
    }
    /**
     * Set window effects.
     */
    async setEffects(effects) {
      return invoke("plugin:window|set_effects", {
        label: this.label,
        value: effects
      });
    }
    /**
     * Clear any applied effects if possible.
     */
    async clearEffects() {
      return invoke("plugin:window|set_effects", {
        label: this.label,
        value: null
      });
    }
    /**
     * Whether the window should always be on top of other windows.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().setAlwaysOnTop(true);
     * ```
     *
     * @param alwaysOnTop Whether the window should always be on top of other windows or not.
     * @returns A promise indicating the success or failure of the operation.
     */
    async setAlwaysOnTop(alwaysOnTop) {
      return invoke("plugin:window|set_always_on_top", {
        label: this.label,
        value: alwaysOnTop
      });
    }
    /**
     * Whether the window should always be below other windows.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().setAlwaysOnBottom(true);
     * ```
     *
     * @param alwaysOnBottom Whether the window should always be below other windows or not.
     * @returns A promise indicating the success or failure of the operation.
     */
    async setAlwaysOnBottom(alwaysOnBottom) {
      return invoke("plugin:window|set_always_on_bottom", {
        label: this.label,
        value: alwaysOnBottom
      });
    }
    /**
     * Prevents the window contents from being captured by other apps.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().setContentProtected(true);
     * ```
     *
     * @returns A promise indicating the success or failure of the operation.
     */
    async setContentProtected(protected_) {
      return invoke("plugin:window|set_content_protected", {
        label: this.label,
        value: protected_
      });
    }
    /**
     * Resizes the window with a new inner size.
     * @example
     * ```typescript
     * import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
     * await getCurrentWindow().setSize(new LogicalSize(600, 500));
     * ```
     *
     * @param size The logical or physical inner size.
     * @returns A promise indicating the success or failure of the operation.
     */
    async setSize(size) {
      return invoke("plugin:window|set_size", {
        label: this.label,
        value: size instanceof Size ? size : new Size(size)
      });
    }
    /**
     * Sets the window minimum inner size. If the `size` argument is not provided, the constraint is unset.
     * @example
     * ```typescript
     * import { getCurrentWindow, PhysicalSize } from '@tauri-apps/api/window';
     * await getCurrentWindow().setMinSize(new PhysicalSize(600, 500));
     * ```
     *
     * @param size The logical or physical inner size, or `null` to unset the constraint.
     * @returns A promise indicating the success or failure of the operation.
     */
    async setMinSize(size) {
      return invoke("plugin:window|set_min_size", {
        label: this.label,
        value: size instanceof Size ? size : size ? new Size(size) : null
      });
    }
    /**
     * Sets the window maximum inner size. If the `size` argument is undefined, the constraint is unset.
     * @example
     * ```typescript
     * import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
     * await getCurrentWindow().setMaxSize(new LogicalSize(600, 500));
     * ```
     *
     * @param size The logical or physical inner size, or `null` to unset the constraint.
     * @returns A promise indicating the success or failure of the operation.
     */
    async setMaxSize(size) {
      return invoke("plugin:window|set_max_size", {
        label: this.label,
        value: size instanceof Size ? size : size ? new Size(size) : null
      });
    }
    /**
     * Sets the window inner size constraints.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().setSizeConstraints({ minWidth: 300 });
     * ```
     *
     * @param constraints The logical or physical inner size, or `null` to unset the constraint.
     * @returns A promise indicating the success or failure of the operation.
     */
    async setSizeConstraints(constraints) {
      function logical(pixel) {
        return pixel ? { Logical: pixel } : null;
      }
      return invoke("plugin:window|set_size_constraints", {
        label: this.label,
        value: {
          minWidth: logical(constraints === null || constraints === void 0 ? void 0 : constraints.minWidth),
          minHeight: logical(constraints === null || constraints === void 0 ? void 0 : constraints.minHeight),
          maxWidth: logical(constraints === null || constraints === void 0 ? void 0 : constraints.maxWidth),
          maxHeight: logical(constraints === null || constraints === void 0 ? void 0 : constraints.maxHeight)
        }
      });
    }
    /**
     * Sets the window outer position.
     * @example
     * ```typescript
     * import { getCurrentWindow, LogicalPosition } from '@tauri-apps/api/window';
     * await getCurrentWindow().setPosition(new LogicalPosition(600, 500));
     * ```
     *
     * @param position The new position, in logical or physical pixels.
     * @returns A promise indicating the success or failure of the operation.
     */
    async setPosition(position) {
      return invoke("plugin:window|set_position", {
        label: this.label,
        value: position instanceof Position ? position : new Position(position)
      });
    }
    /**
     * Sets the window fullscreen state.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().setFullscreen(true);
     * ```
     *
     * @param fullscreen Whether the window should go to fullscreen or not.
     * @returns A promise indicating the success or failure of the operation.
     */
    async setFullscreen(fullscreen) {
      return invoke("plugin:window|set_fullscreen", {
        label: this.label,
        value: fullscreen
      });
    }
    /**
     * On macOS, Toggles a fullscreen mode that doesn’t require a new macOS space. Returns a boolean indicating whether the transition was successful (this won’t work if the window was already in the native fullscreen).
     * This is how fullscreen used to work on macOS in versions before Lion. And allows the user to have a fullscreen window without using another space or taking control over the entire monitor.
     *
     * On other platforms, this is the same as {@link Window.setFullscreen}.
     *
     * @param fullscreen Whether the window should go to simple fullscreen or not.
     * @returns A promise indicating the success or failure of the operation.
     */
    async setSimpleFullscreen(fullscreen) {
      return invoke("plugin:window|set_simple_fullscreen", {
        label: this.label,
        value: fullscreen
      });
    }
    /**
     * Bring the window to front and focus.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().setFocus();
     * ```
     *
     * @returns A promise indicating the success or failure of the operation.
     */
    async setFocus() {
      return invoke("plugin:window|set_focus", {
        label: this.label
      });
    }
    /**
     * Sets whether the window can be focused.
     *
     * #### Platform-specific
     *
     * - **macOS**: If the window is already focused, it is not possible to unfocus it after calling `set_focusable(false)`.
     *   In this case, you might consider calling {@link Window.setFocus} but it will move the window to the back i.e. at the bottom in terms of z-order.
     *
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().setFocusable(true);
     * ```
     *
     * @param focusable Whether the window can be focused.
     * @returns A promise indicating the success or failure of the operation.
     */
    async setFocusable(focusable) {
      return invoke("plugin:window|set_focusable", {
        label: this.label,
        value: focusable
      });
    }
    /**
     * Sets the window icon.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().setIcon('/tauri/awesome.png');
     * ```
     *
     * Note that you may need the `image-ico` or `image-png` Cargo features to use this API.
     * To enable it, change your Cargo.toml file:
     * ```toml
     * [dependencies]
     * tauri = { version = "...", features = ["...", "image-png"] }
     * ```
     *
     * @param icon Icon bytes or path to the icon file.
     * @returns A promise indicating the success or failure of the operation.
     */
    async setIcon(icon) {
      return invoke("plugin:window|set_icon", {
        label: this.label,
        value: transformImage(icon)
      });
    }
    /**
     * Whether the window icon should be hidden from the taskbar or not.
     *
     * #### Platform-specific
     *
     * - **macOS:** Unsupported.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().setSkipTaskbar(true);
     * ```
     *
     * @param skip true to hide window icon, false to show it.
     * @returns A promise indicating the success or failure of the operation.
     */
    async setSkipTaskbar(skip) {
      return invoke("plugin:window|set_skip_taskbar", {
        label: this.label,
        value: skip
      });
    }
    /**
     * Grabs the cursor, preventing it from leaving the window.
     *
     * There's no guarantee that the cursor will be hidden. You should
     * hide it by yourself if you want so.
     *
     * #### Platform-specific
     *
     * - **Linux:** Unsupported.
     * - **macOS:** This locks the cursor in a fixed location, which looks visually awkward.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().setCursorGrab(true);
     * ```
     *
     * @param grab `true` to grab the cursor icon, `false` to release it.
     * @returns A promise indicating the success or failure of the operation.
     */
    async setCursorGrab(grab) {
      return invoke("plugin:window|set_cursor_grab", {
        label: this.label,
        value: grab
      });
    }
    /**
     * Modifies the cursor's visibility.
     *
     * #### Platform-specific
     *
     * - **Windows:** The cursor is only hidden within the confines of the window.
     * - **macOS:** The cursor is hidden as long as the window has input focus, even if the cursor is
     *   outside of the window.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().setCursorVisible(false);
     * ```
     *
     * @param visible If `false`, this will hide the cursor. If `true`, this will show the cursor.
     * @returns A promise indicating the success or failure of the operation.
     */
    async setCursorVisible(visible) {
      return invoke("plugin:window|set_cursor_visible", {
        label: this.label,
        value: visible
      });
    }
    /**
     * Modifies the cursor icon of the window.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().setCursorIcon('help');
     * ```
     *
     * @param icon The new cursor icon.
     * @returns A promise indicating the success or failure of the operation.
     */
    async setCursorIcon(icon) {
      return invoke("plugin:window|set_cursor_icon", {
        label: this.label,
        value: icon
      });
    }
    /**
     * Sets the window background color.
     *
     * #### Platform-specific:
     *
     * - **Windows:** alpha channel is ignored.
     * - **iOS / Android:** Unsupported.
     *
     * @returns A promise indicating the success or failure of the operation.
     *
     * @since 2.1.0
     */
    async setBackgroundColor(color) {
      return invoke("plugin:window|set_background_color", { color });
    }
    /**
     * Changes the position of the cursor in window coordinates.
     * @example
     * ```typescript
     * import { getCurrentWindow, LogicalPosition } from '@tauri-apps/api/window';
     * await getCurrentWindow().setCursorPosition(new LogicalPosition(600, 300));
     * ```
     *
     * @param position The new cursor position.
     * @returns A promise indicating the success or failure of the operation.
     */
    async setCursorPosition(position) {
      return invoke("plugin:window|set_cursor_position", {
        label: this.label,
        value: position instanceof Position ? position : new Position(position)
      });
    }
    /**
     * Changes the cursor events behavior.
     *
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().setIgnoreCursorEvents(true);
     * ```
     *
     * @param ignore `true` to ignore the cursor events; `false` to process them as usual.
     * @returns A promise indicating the success or failure of the operation.
     */
    async setIgnoreCursorEvents(ignore) {
      return invoke("plugin:window|set_ignore_cursor_events", {
        label: this.label,
        value: ignore
      });
    }
    /**
     * Starts dragging the window.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().startDragging();
     * ```
     *
     * @return A promise indicating the success or failure of the operation.
     */
    async startDragging() {
      return invoke("plugin:window|start_dragging", {
        label: this.label
      });
    }
    /**
     * Starts resize-dragging the window.
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().startResizeDragging();
     * ```
     *
     * @return A promise indicating the success or failure of the operation.
     */
    async startResizeDragging(direction) {
      return invoke("plugin:window|start_resize_dragging", {
        label: this.label,
        value: direction
      });
    }
    /**
     * Sets the badge count. It is app wide and not specific to this window.
     *
     * #### Platform-specific
     *
     * - **Windows**: Unsupported. Use @{linkcode Window.setOverlayIcon} instead.
     *
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().setBadgeCount(5);
     * ```
     *
     * @param count The badge count. Use `undefined` to remove the badge.
     * @return A promise indicating the success or failure of the operation.
     */
    async setBadgeCount(count) {
      return invoke("plugin:window|set_badge_count", {
        label: this.label,
        value: count
      });
    }
    /**
     * Sets the badge cont **macOS only**.
     *
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().setBadgeLabel("Hello");
     * ```
     *
     * @param label The badge label. Use `undefined` to remove the badge.
     * @return A promise indicating the success or failure of the operation.
     */
    async setBadgeLabel(label) {
      return invoke("plugin:window|set_badge_label", {
        label: this.label,
        value: label
      });
    }
    /**
     * Sets the overlay icon. **Windows only**
     * The overlay icon can be set for every window.
     *
     *
     * Note that you may need the `image-ico` or `image-png` Cargo features to use this API.
     * To enable it, change your Cargo.toml file:
     *
     * ```toml
     * [dependencies]
     * tauri = { version = "...", features = ["...", "image-png"] }
     * ```
     *
     * @example
     * ```typescript
     * import { getCurrentWindow } from '@tauri-apps/api/window';
     * await getCurrentWindow().setOverlayIcon("/tauri/awesome.png");
     * ```
     *
     * @param icon Icon bytes or path to the icon file. Use `undefined` to remove the overlay icon.
     * @return A promise indicating the success or failure of the operation.
     */
    async setOverlayIcon(icon) {
      return invoke("plugin:window|set_overlay_icon", {
        label: this.label,
        value: icon ? transformImage(icon) : void 0
      });
    }
    /**
     * Sets the taskbar progress state.
     *
     * #### Platform-specific
     *
     * - **Linux / macOS**: Progress bar is app-wide and not specific to this window.
     * - **Linux**: Only supported desktop environments with `libunity` (e.g. GNOME).
     *
     * @example
     * ```typescript
     * import { getCurrentWindow, ProgressBarStatus } from '@tauri-apps/api/window';
     * await getCurrentWindow().setProgressBar({
     *   status: ProgressBarStatus.Normal,
     *   progress: 50,
     * });
     * ```
     *
     * @return A promise indicating the success or failure of the operation.
     */
    async setProgressBar(state) {
      return invoke("plugin:window|set_progress_bar", {
        label: this.label,
        value: state
      });
    }
    /**
     * Sets whether the window should be visible on all workspaces or virtual desktops.
     *
     * #### Platform-specific
     *
     * - **Windows / iOS / Android:** Unsupported.
     *
     * @since 2.0.0
     */
    async setVisibleOnAllWorkspaces(visible) {
      return invoke("plugin:window|set_visible_on_all_workspaces", {
        label: this.label,
        value: visible
      });
    }
    /**
     * Sets the title bar style. **macOS only**.
     *
     * @since 2.0.0
     */
    async setTitleBarStyle(style) {
      return invoke("plugin:window|set_title_bar_style", {
        label: this.label,
        value: style
      });
    }
    /**
     * Set window theme, pass in `null` or `undefined` to follow system theme
     *
     * #### Platform-specific
     *
     * - **Linux / macOS**: Theme is app-wide and not specific to this window.
     * - **iOS / Android:** Unsupported.
     *
     * @since 2.0.0
     */
    async setTheme(theme) {
      return invoke("plugin:window|set_theme", {
        label: this.label,
        value: theme
      });
    }
    // Listeners
    /**
     * Listen to window resize.
     *
     * @example
     * ```typescript
     * import { getCurrentWindow } from "@tauri-apps/api/window";
     * const unlisten = await getCurrentWindow().onResized(({ payload: size }) => {
     *  console.log('Window resized', size);
     * });
     *
     * // you need to call unlisten if your handler goes out of scope e.g. the component is unmounted
     * unlisten();
     * ```
     *
     * @returns A promise resolving to a function to unlisten to the event.
     * Note that removing the listener is required if your listener goes out of scope e.g. the component is unmounted.
     */
    async onResized(handler) {
      return this.listen(TauriEvent.WINDOW_RESIZED, (e) => {
        e.payload = new PhysicalSize(e.payload);
        handler(e);
      });
    }
    /**
     * Listen to window move.
     *
     * @example
     * ```typescript
     * import { getCurrentWindow } from "@tauri-apps/api/window";
     * const unlisten = await getCurrentWindow().onMoved(({ payload: position }) => {
     *  console.log('Window moved', position);
     * });
     *
     * // you need to call unlisten if your handler goes out of scope e.g. the component is unmounted
     * unlisten();
     * ```
     *
     * @returns A promise resolving to a function to unlisten to the event.
     * Note that removing the listener is required if your listener goes out of scope e.g. the component is unmounted.
     */
    async onMoved(handler) {
      return this.listen(TauriEvent.WINDOW_MOVED, (e) => {
        e.payload = new PhysicalPosition(e.payload);
        handler(e);
      });
    }
    /**
     * Listen to window close requested. Emitted when the user requests to closes the window.
     *
     * @example
     * ```typescript
     * import { getCurrentWindow } from "@tauri-apps/api/window";
     * import { confirm } from '@tauri-apps/api/dialog';
     * const unlisten = await getCurrentWindow().onCloseRequested(async (event) => {
     *   const confirmed = await confirm('Are you sure?');
     *   if (!confirmed) {
     *     // user did not confirm closing the window; let's prevent it
     *     event.preventDefault();
     *   }
     * });
     *
     * // you need to call unlisten if your handler goes out of scope e.g. the component is unmounted
     * unlisten();
     * ```
     *
     * @returns A promise resolving to a function to unlisten to the event.
     * Note that removing the listener is required if your listener goes out of scope e.g. the component is unmounted.
     */
    async onCloseRequested(handler) {
      return this.listen(TauriEvent.WINDOW_CLOSE_REQUESTED, async (event) => {
        const evt = new CloseRequestedEvent(event);
        await handler(evt);
        if (!evt.isPreventDefault()) {
          await this.destroy();
        }
      });
    }
    /**
     * Listen to a file drop event.
     * The listener is triggered when the user hovers the selected files on the webview,
     * drops the files or cancels the operation.
     *
     * @example
     * ```typescript
     * import { getCurrentWindow } from "@tauri-apps/api/webview";
     * const unlisten = await getCurrentWindow().onDragDropEvent((event) => {
     *  if (event.payload.type === 'over') {
     *    console.log('User hovering', event.payload.position);
     *  } else if (event.payload.type === 'drop') {
     *    console.log('User dropped', event.payload.paths);
     *  } else {
     *    console.log('File drop cancelled');
     *  }
     * });
     *
     * // you need to call unlisten if your handler goes out of scope e.g. the component is unmounted
     * unlisten();
     * ```
     *
     * @returns A promise resolving to a function to unlisten to the event.
     * Note that removing the listener is required if your listener goes out of scope e.g. the component is unmounted.
     */
    async onDragDropEvent(handler) {
      const unlistenDrag = await this.listen(TauriEvent.DRAG_ENTER, (event) => {
        handler({
          ...event,
          payload: {
            type: "enter",
            paths: event.payload.paths,
            position: new PhysicalPosition(event.payload.position)
          }
        });
      });
      const unlistenDragOver = await this.listen(TauriEvent.DRAG_OVER, (event) => {
        handler({
          ...event,
          payload: {
            type: "over",
            position: new PhysicalPosition(event.payload.position)
          }
        });
      });
      const unlistenDrop = await this.listen(TauriEvent.DRAG_DROP, (event) => {
        handler({
          ...event,
          payload: {
            type: "drop",
            paths: event.payload.paths,
            position: new PhysicalPosition(event.payload.position)
          }
        });
      });
      const unlistenCancel = await this.listen(TauriEvent.DRAG_LEAVE, (event) => {
        handler({ ...event, payload: { type: "leave" } });
      });
      return () => {
        unlistenDrag();
        unlistenDrop();
        unlistenDragOver();
        unlistenCancel();
      };
    }
    /**
     * Listen to window focus change.
     *
     * @example
     * ```typescript
     * import { getCurrentWindow } from "@tauri-apps/api/window";
     * const unlisten = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
     *  console.log('Focus changed, window is focused? ' + focused);
     * });
     *
     * // you need to call unlisten if your handler goes out of scope e.g. the component is unmounted
     * unlisten();
     * ```
     *
     * @returns A promise resolving to a function to unlisten to the event.
     * Note that removing the listener is required if your listener goes out of scope e.g. the component is unmounted.
     */
    async onFocusChanged(handler) {
      const unlistenFocus = await this.listen(TauriEvent.WINDOW_FOCUS, (event) => {
        handler({ ...event, payload: true });
      });
      const unlistenBlur = await this.listen(TauriEvent.WINDOW_BLUR, (event) => {
        handler({ ...event, payload: false });
      });
      return () => {
        unlistenFocus();
        unlistenBlur();
      };
    }
    /**
     * Listen to window scale change. Emitted when the window's scale factor has changed.
     * The following user actions can cause DPI changes:
     * - Changing the display's resolution.
     * - Changing the display's scale factor (e.g. in Control Panel on Windows).
     * - Moving the window to a display with a different scale factor.
     *
     * @example
     * ```typescript
     * import { getCurrentWindow } from "@tauri-apps/api/window";
     * const unlisten = await getCurrentWindow().onScaleChanged(({ payload }) => {
     *  console.log('Scale changed', payload.scaleFactor, payload.size);
     * });
     *
     * // you need to call unlisten if your handler goes out of scope e.g. the component is unmounted
     * unlisten();
     * ```
     *
     * @returns A promise resolving to a function to unlisten to the event.
     * Note that removing the listener is required if your listener goes out of scope e.g. the component is unmounted.
     */
    async onScaleChanged(handler) {
      return this.listen(TauriEvent.WINDOW_SCALE_FACTOR_CHANGED, handler);
    }
    /**
     * Listen to the system theme change.
     *
     * @example
     * ```typescript
     * import { getCurrentWindow } from "@tauri-apps/api/window";
     * const unlisten = await getCurrentWindow().onThemeChanged(({ payload: theme }) => {
     *  console.log('New theme: ' + theme);
     * });
     *
     * // you need to call unlisten if your handler goes out of scope e.g. the component is unmounted
     * unlisten();
     * ```
     *
     * @returns A promise resolving to a function to unlisten to the event.
     * Note that removing the listener is required if your listener goes out of scope e.g. the component is unmounted.
     */
    async onThemeChanged(handler) {
      return this.listen(TauriEvent.WINDOW_THEME_CHANGED, handler);
    }
  };
  var BackgroundThrottlingPolicy;
  (function(BackgroundThrottlingPolicy2) {
    BackgroundThrottlingPolicy2["Disabled"] = "disabled";
    BackgroundThrottlingPolicy2["Throttle"] = "throttle";
    BackgroundThrottlingPolicy2["Suspend"] = "suspend";
  })(BackgroundThrottlingPolicy || (BackgroundThrottlingPolicy = {}));
  var ScrollBarStyle;
  (function(ScrollBarStyle2) {
    ScrollBarStyle2["Default"] = "default";
    ScrollBarStyle2["FluentOverlay"] = "fluentOverlay";
  })(ScrollBarStyle || (ScrollBarStyle = {}));
  var Effect;
  (function(Effect2) {
    Effect2["AppearanceBased"] = "appearanceBased";
    Effect2["Light"] = "light";
    Effect2["Dark"] = "dark";
    Effect2["MediumLight"] = "mediumLight";
    Effect2["UltraDark"] = "ultraDark";
    Effect2["Titlebar"] = "titlebar";
    Effect2["Selection"] = "selection";
    Effect2["Menu"] = "menu";
    Effect2["Popover"] = "popover";
    Effect2["Sidebar"] = "sidebar";
    Effect2["HeaderView"] = "headerView";
    Effect2["Sheet"] = "sheet";
    Effect2["WindowBackground"] = "windowBackground";
    Effect2["HudWindow"] = "hudWindow";
    Effect2["FullScreenUI"] = "fullScreenUI";
    Effect2["Tooltip"] = "tooltip";
    Effect2["ContentBackground"] = "contentBackground";
    Effect2["UnderWindowBackground"] = "underWindowBackground";
    Effect2["UnderPageBackground"] = "underPageBackground";
    Effect2["Mica"] = "mica";
    Effect2["Blur"] = "blur";
    Effect2["Acrylic"] = "acrylic";
    Effect2["Tabbed"] = "tabbed";
    Effect2["TabbedDark"] = "tabbedDark";
    Effect2["TabbedLight"] = "tabbedLight";
  })(Effect || (Effect = {}));
  var EffectState;
  (function(EffectState2) {
    EffectState2["FollowsWindowActiveState"] = "followsWindowActiveState";
    EffectState2["Active"] = "active";
    EffectState2["Inactive"] = "inactive";
  })(EffectState || (EffectState = {}));

  // web/src/bridge.js
  async function on(channel, callback) {
    return listen(channel, (event) => callback(event.payload));
  }
  var bridge = {
    // platform info from Rust (mobile hides the desktop-only chrome)
    appInfo: () => invoke("app_info"),
    // status-bar inset in CSS px (mobile)
    statusBarHeight: () => invoke("status_bar_height"),
    // embedded local instance
    startLocal: () => invoke("local_start"),
    stopLocal: () => invoke("local_stop"),
    status: () => invoke("local_status"),
    logs: () => invoke("local_logs").then((text) => text ? text.split("\n") : []),
    // embedded dsh self-update
    dshVersion: () => invoke("dsh_version"),
    checkUpdate: () => invoke("dsh_check_update"),
    update: (target) => invoke("dsh_update", { target }),
    onUpdateLog: (callback) => on("dsh:update-log", callback),
    // launcher self-update (GitHub Releases)
    checkLauncherUpdate: () => invoke("check_launcher_update"),
    launcherUpdate: (url) => invoke("launcher_update", { url }),
    onExited: (callback) => on("local:exited", callback),
    onBacked: (callback) => on("shell:backed", callback),
    // view switching (launcher <-> connected dsh web)
    connect: (url) => invoke("shell_connect", { url }),
    back: () => invoke("shell_back"),
    newWindow: () => invoke("shell_new_window"),
    shellReady: () => invoke("shell_ready"),
    reload: () => invoke("view_reload"),
    openDevTools: () => invoke("open_devtools"),
    onConnectionChanged: (callback) => on("connection:changed", callback),
    // remote node registry
    remote: {
      connect: (id) => invoke("remote_connect", { id }),
      disconnect: () => invoke("remote_disconnect"),
      list: () => invoke("remote_list"),
      save: (input) => invoke("remote_save", { input }),
      remove: (id) => invoke("remote_remove", { id }),
      health: (id) => invoke("remote_health", { id })
    },
    // settings dialog + shell behavior
    settings: {
      open: () => invoke("settings_open"),
      close: () => invoke("settings_close"),
      current: () => invoke("settings_current"),
      getLoginItem: () => invoke("settings_get_login_item"),
      setLoginItem: (enabled) => invoke("settings_set_login_item", { enabled }),
      getRestore: () => invoke("settings_get_restore"),
      setRestore: (enabled) => invoke("settings_set_restore", { enabled }),
      getAutoLocal: () => invoke("settings_get_auto_local"),
      setAutoLocal: (enabled) => invoke("settings_set_auto_local", { enabled })
    },
    // emitted when the (cached) settings overlay becomes visible — re-read state
    onSettingsRefresh: (callback) => on("settings:refresh", callback),
    // live theme sync from the connected dsh page
    onThemeSync: (callback) => on("theme:sync", callback),
    // custom title bar window controls
    window: {
      minimize: () => getCurrentWindow().minimize(),
      toggleMaximize: async () => {
        const win = getCurrentWindow();
        if (await win.isMaximized()) await win.unmaximize();
        else await win.maximize();
      },
      close: () => getCurrentWindow().close(),
      isMaximized: () => getCurrentWindow().isMaximized(),
      onMaximizedChanged: (callback) => {
        const win = getCurrentWindow();
        const update = async () => callback(await win.isMaximized());
        const unlisten = win.onResized(update);
        update();
        return unlisten;
      }
    }
  };

  // web/src/settings.js
  var TOKEN_MAP = {
    "--dsw-alias-bg-base": "--shell-bg",
    "--dsw-alias-bg-layer-1": "--shell-layer",
    "--dsw-alias-bg-layer-2": "--shell-layer-2",
    "--dsw-alias-label-primary": "--shell-fg",
    "--dsw-alias-label-primary-foreground": "--shell-fg-foreground",
    "--dsw-alias-label-secondary": "--shell-fg-secondary",
    "--dsw-alias-label-tertiary": "--shell-fg-tertiary",
    "--dsw-alias-border-l2": "--shell-border",
    "--dsw-alias-interactive-bg-hover": "--shell-hover",
    "--dsw-alias-button-primary-fill": "--shell-brand",
    "--dsw-alias-button-primary-hover": "--shell-brand-hover",
    "--dsw-alias-state-error-primary": "--shell-danger",
    "--dsw-alias-state-success-primary": "--shell-success"
  };
  bridge.onThemeSync((tokens) => {
    const root = document.documentElement;
    for (const [alias, value] of Object.entries(tokens)) {
      const target = TOKEN_MAP[alias];
      if (target && value) root.style.setProperty(target, value);
    }
  });
  var closeBtn = document.getElementById("close");
  var curName = document.getElementById("cur-name");
  var curUrl = document.getElementById("cur-url");
  var disconnectBtn = document.getElementById("disconnect");
  var toLauncherBtn = document.getElementById("to-launcher");
  var instancesEl = document.getElementById("instances");
  var dlgError = document.getElementById("dlg-error");
  var localDot = document.getElementById("local-dot");
  var localUrl = document.getElementById("local-url");
  var localToggle = document.getElementById("local-toggle");
  var localEnter = document.getElementById("local-enter");
  async function renderLocal() {
    const s = await bridge.status();
    if (s.starting) {
      localDot.className = "dot chase";
      localDot.textContent = "";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 10 10");
      svg.setAttribute("shape-rendering", "crispEdges");
      const cells = [[0, 0], [4, 0], [8, 0], [8, 4], [8, 8], [4, 8], [0, 8], [0, 4]];
      cells.forEach(([x, y], index) => {
        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("x", x);
        rect.setAttribute("y", y);
        rect.setAttribute("width", 2);
        rect.setAttribute("height", 2);
        rect.style.animationDelay = `${(index - cells.length) * 125}ms`;
        svg.appendChild(rect);
      });
      localDot.appendChild(svg);
      localUrl.textContent = "\u6B63\u5728\u542F\u52A8\u2026";
      localToggle.textContent = "\u542F\u52A8\u4E2D";
      localToggle.className = "btn primary";
      localToggle.disabled = true;
      localEnter.disabled = true;
      return;
    }
    localDot.className = s.running ? "dot done" : "dot";
    localDot.textContent = "";
    localUrl.textContent = s.running ? s.url : "\u672A\u542F\u52A8";
    localToggle.textContent = s.running ? "\u505C\u6B62" : "\u542F\u52A8";
    localToggle.className = `btn ${s.running ? "outline" : "primary"}`;
    localToggle.disabled = false;
    localEnter.disabled = !s.running;
  }
  localToggle.addEventListener("click", async () => {
    dlgError.textContent = "";
    const s = await bridge.status();
    if (s.running) await bridge.stopLocal();
    else {
      try {
        await bridge.startLocal();
      } catch (e) {
        dlgError.textContent = e || "\u542F\u52A8\u5931\u8D25";
      }
    }
    renderLocal();
  });
  localEnter.addEventListener("click", async () => {
    dlgError.textContent = "";
    const s = await bridge.status();
    if (s.running) {
      try {
        await bridge.connect(s.url);
        await bridge.settings.close();
      } catch (e) {
        dlgError.textContent = e || "\u8FDE\u63A5\u5931\u8D25";
      }
    }
  });
  closeBtn.addEventListener("click", () => bridge.settings.close());
  var currentId = null;
  async function renderCurrent() {
    const cur = await bridge.settings.current();
    currentId = cur.id ?? null;
    if (cur.type === null) {
      curName.textContent = "\u672A\u8FDE\u63A5";
      curUrl.textContent = "";
      disconnectBtn.disabled = true;
      return;
    }
    curName.textContent = cur.type === "local" ? "\u672C\u673A\u5B9E\u4F8B" : cur.name;
    curUrl.textContent = cur.url;
    disconnectBtn.disabled = false;
  }
  var instanceQuery = "";
  var instSearch = document.getElementById("inst-search");
  var scrollZone = document.querySelector(".dialog-scroll");
  var scrollHideTimer = null;
  scrollZone.addEventListener("scroll", () => {
    scrollZone.classList.add("scrolling");
    clearTimeout(scrollHideTimer);
    scrollHideTimer = setTimeout(() => scrollZone.classList.remove("scrolling"), 500);
  });
  async function renderInstances() {
    const query = instanceQuery;
    const instances = await bridge.remote.list();
    const matches = query ? instances.filter((inst) => inst.name.toLowerCase().includes(query) || inst.url.toLowerCase().includes(query)) : instances;
    instancesEl.textContent = "";
    for (const inst of matches) {
      const row = document.createElement("div");
      row.className = "instance-row";
      const meta = document.createElement("div");
      meta.className = "meta";
      const name = document.createElement("div");
      name.className = "name";
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.title = "\u68C0\u6D4B\u4E2D";
      name.appendChild(dot);
      name.appendChild(document.createTextNode(inst.name));
      if (currentId === inst.id) {
        const pill = document.createElement("span");
        pill.className = "pill on";
        pill.textContent = "\u5F53\u524D";
        name.appendChild(pill);
      }
      const url = document.createElement("div");
      url.className = "url";
      url.textContent = inst.url;
      meta.append(name, url);
      const connect = document.createElement("button");
      connect.className = "btn primary";
      connect.textContent = "\u8FDE\u63A5";
      connect.addEventListener("click", async () => {
        dlgError.textContent = "";
        try {
          const r = await bridge.remote.connect(inst.id);
          if (r && r.ok) await bridge.settings.close();
          else dlgError.textContent = r && r.error || "\u8FDE\u63A5\u5931\u8D25";
        } catch (e) {
          dlgError.textContent = e || "\u8FDE\u63A5\u5931\u8D25";
        }
      });
      row.append(meta, connect);
      instancesEl.appendChild(row);
      bridge.remote.health(inst.id).then((h) => {
        dot.className = h.status === "online" ? "dot done" : h.status === "unauthorized" ? "dot danger" : "dot";
        dot.title = h.status === "online" ? "\u5728\u7EBF" : h.status === "unauthorized" ? "\u5BC6\u94A5\u65E0\u6548" : "\u79BB\u7EBF";
      });
    }
    if (matches.length === 0) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = query ? "\u6CA1\u6709\u5339\u914D\u7684\u5B9E\u4F8B" : "\u8FD8\u6CA1\u6709\u8FDC\u7A0B\u5B9E\u4F8B\uFF0C\u53EF\u5728\u542F\u52A8\u9875\u6DFB\u52A0\u3002";
      instancesEl.appendChild(hint);
    }
  }
  instSearch.addEventListener("input", (event) => {
    instanceQuery = event.target.value.trim().toLowerCase();
    renderInstances();
  });
  disconnectBtn.addEventListener("click", async () => {
    await bridge.remote.disconnect();
    await bridge.settings.close();
  });
  toLauncherBtn.addEventListener("click", async () => {
    await bridge.back();
    await bridge.settings.close();
  });
  renderCurrent();
  renderLocal();
  renderInstances();
  bridge.onSettingsRefresh(() => {
    renderCurrent();
    renderLocal();
    renderInstances();
  });
  setInterval(renderLocal, 1e3);
  setInterval(renderCurrent, 2e3);
})();
