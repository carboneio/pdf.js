/* Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/** @typedef {import("./interfaces.js").IL10n} IL10n */
// eslint-disable-next-line max-len
/** @typedef {import("../src/display/api.js").PDFDocumentProxy} PDFDocumentProxy */
// eslint-disable-next-line max-len
/** @typedef {import("../src/display/api.js").PDFDocumentLoadingTask} PDFDocumentLoadingTask */

import {
  animationStarted,
  apiPageLayoutToViewerModes,
  DEFAULT_SCALE_VALUE,
  getActiveOrFocusedElement,
  isValidRotation,
  isValidScrollMode,
  isValidSpreadMode,
  normalizeWheelEventDirection,
  ScrollMode,
  SpreadMode,
} from "./ui_utils.js";
import {
  build,
  FeatureTest,
  getDocument,
  getPdfFilenameFromUrl,
  GlobalWorkerOptions,
  InvalidPDFException,
  MissingPDFException,
  shadow,
  UnexpectedResponseException,
  version,
} from "pdfjs-lib";
import { AppOptions, OptionKind } from "./app_options.js";
import { LinkTarget, PDFLinkService } from "./pdf_link_service.js";
import { CaretBrowsingMode } from "./caret_browsing.js";
import { EventBus } from "./event_utils.js";
import { GlobalDocumentBody } from "../src/display/global_document_body.js";
import { OverlayManager } from "./overlay_manager.js";
import { PDFFindBar } from "web-pdf_find_bar";
import { PDFFindController } from "./pdf_find_controller.js";
import { PDFRenderingQueue } from "./pdf_rendering_queue.js";
import { PDFViewer } from "./pdf_viewer.js";

const FORCE_PAGES_LOADED_TIMEOUT = 10000; // ms

const PDFViewerApplication = {
  initialBookmark: document.location.hash.substring(1),
  _initializedCapability: {
    ...Promise.withResolvers(),
    settled: false,
  },
  appConfig: null,
  /** @type {PDFDocumentProxy} */
  pdfDocument: null,
  /** @type {PDFDocumentLoadingTask} */
  pdfLoadingTask: null,
  /** @type {PDFViewer} */
  pdfViewer: null,
  /** @type {PDFRenderingQueue} */
  pdfRenderingQueue: null,
  /** @type {PDFLinkService} */
  pdfLinkService: null,
  /** @type {OverlayManager} */
  overlayManager: null,
  /** @type {EventBus} */
  eventBus: null,
  isInitialViewSet: false,
  url: "",
  baseUrl: "",
  _eventBusAbortController: null,
  _windowAbortController: null,
  _globalAbortController: new AbortController(),
  documentInfo: null,
  metadata: null,
  _contentDispositionFilename: null,
  _contentLength: null,
  _wheelUnusedTicks: 0,
  _wheelUnusedFactor: 1,
  _touchUnusedTicks: 0,
  _touchUnusedFactor: 1,
  _PDFBug: null,
  _touchInfo: null,
  _isCtrlKeyDown: false,
  _caretBrowsing: null,
  _isScrolling: false,

  // Called once when the document is loaded.
  async initialize(appConfig) {
    this.appConfig = appConfig;
    // When PDF.js is used in a shadow dom, we don't want
    // that it inserts nodes in the global document.body of the webpage
    GlobalDocumentBody.node = appConfig.rootNode || document.body;

    // Prevent external links from "replacing" the viewer, open in a new windows
    AppOptions.set("externalLinkTarget", LinkTarget.BLANK);
    await this._initializeViewerComponents();

    // Bind the various event handlers *after* the viewer has been
    // initialized, to prevent errors if an event arrives too soon.
    this.bindEvents();
    this.bindWindowEvents();

    this._initializedCapability.settled = true;
    this._initializedCapability.resolve();
  },

  /**
   * @private
   */
  async _initializeViewerComponents() {
    const { appConfig } = this;

    const eventBus =  new EventBus();
    this.eventBus = AppOptions.eventBus = eventBus;

    this.overlayManager = new OverlayManager();

    const pdfRenderingQueue = new PDFRenderingQueue();
    pdfRenderingQueue.onIdle = this._cleanup.bind(this);
    this.pdfRenderingQueue = pdfRenderingQueue;

    const pdfLinkService = new PDFLinkService({
      eventBus,
      externalLinkTarget: AppOptions.get("externalLinkTarget"),
      externalLinkRel: AppOptions.get("externalLinkRel"),
      ignoreDestinationZoom: AppOptions.get("ignoreDestinationZoom"),
    });
    this.pdfLinkService = pdfLinkService;

    const findController = new PDFFindController({
      linkService: pdfLinkService,
      eventBus,
      updateMatchesCountOnProgress:
        typeof PDFJSDev === "undefined"
          ? !window.isGECKOVIEW
          : !PDFJSDev.test("GECKOVIEW"),
    });
    this.findController = findController;

    const container = appConfig.mainContainer,
      viewer = appConfig.viewerContainer;

    const enableHWA = AppOptions.get("enableHWA");
    const pdfViewer = new PDFViewer({
      container,
      viewer,
      eventBus,
      renderingQueue: pdfRenderingQueue,
      linkService: pdfLinkService,
      findController,
      textLayerMode: AppOptions.get("textLayerMode"),
      enableHighlightFloatingButton: AppOptions.get(
        "enableHighlightFloatingButton"
      ),
      imageResourcesPath: AppOptions.get("imageResourcesPath"),
      maxCanvasPixels: AppOptions.get("maxCanvasPixels"),
      // enablePermissions: AppOptions.get("enablePermissions"),
      abortSignal: this._globalAbortController.signal,
      enableHWA,
    });
    this.pdfViewer = pdfViewer;

    pdfRenderingQueue.setViewer(pdfViewer);
    pdfLinkService.setViewer(pdfViewer);

    if (!this.supportsIntegratedFind && appConfig.findBar) {
      // TODO remove
      this.findBar = new PDFFindBar(
        appConfig.findBar,
        appConfig.principalContainer,
        eventBus
      );
    }
  },

  async run(config) {
    await this.initialize(config);
  },

  get initialized() {
    return this._initializedCapability.settled;
  },

  get initializedPromise() {
    return this._initializedCapability.promise;
  },

  updateZoom(steps, scaleFactor, origin) {
    this.pdfViewer.updateScale({
      drawingDelay: AppOptions.get("defaultZoomDelay"),
      steps,
      scaleFactor,
      origin,
    });
  },

  zoomIn() {
    this.updateZoom(1);
  },

  zoomOut() {
    this.updateZoom(-1);
  },

  zoomReset() {
    if (this.pdfViewer.isInPresentationMode) {
      return;
    }
    this.pdfViewer.currentScaleValue = DEFAULT_SCALE_VALUE;
  },

  get pagesCount() {
    return this.pdfDocument ? this.pdfDocument.numPages : 0;
  },

  get page() {
    return this.pdfViewer.currentPageNumber;
  },

  set page(val) {
    this.pdfViewer.currentPageNumber = val;
  },

  get supportsPinchToZoom() {
    return shadow(
      this,
      "supportsPinchToZoom",
      AppOptions.get("supportsPinchToZoom")
    );
  },

  get supportsIntegratedFind() {
    return shadow(
      this,
      "supportsIntegratedFind",
      AppOptions.get("supportsIntegratedFind")
    );
  },

  get supportsMouseWheelZoomCtrlKey() {
    return shadow(
      this,
      "supportsMouseWheelZoomCtrlKey",
      AppOptions.get("supportsMouseWheelZoomCtrlKey")
    );
  },

  get supportsMouseWheelZoomMetaKey() {
    return shadow(
      this,
      "supportsMouseWheelZoomMetaKey",
      AppOptions.get("supportsMouseWheelZoomMetaKey")
    );
  },

  get supportsCaretBrowsingMode() {
    return AppOptions.get("supportsCaretBrowsingMode");
  },

  moveCaret(isUp, select) {
    this._caretBrowsing ||= new CaretBrowsingMode(
      this._globalAbortController.signal,
      this.appConfig.mainContainer,
      this.appConfig.viewerContainer
    );
    this._caretBrowsing.moveCaret(isUp, select);
  },

  get _docFilename() {
    // Use `this.url` instead of `this.baseUrl` to perform filename detection
    // based on the reference fragment as ultimate fallback if needed.
    return this._contentDispositionFilename || getPdfFilenameFromUrl(this.url);
  },

  /**
   * Closes opened PDF document.
   * @returns {Promise} - Returns the promise, which is resolved when all
   *                      destruction is completed.
   */
  async close() {
    this._unblockDocumentLoadEvent();

    if (!this.pdfLoadingTask) {
      return;
    }

    const promises = [];

    promises.push(this.pdfLoadingTask.destroy());
    this.pdfLoadingTask = null;

    if (this.pdfDocument) {
      this.pdfDocument = null;
      this.pdfViewer.setDocument(null);
      this.pdfLinkService.setDocument(null);
    }
    this.pdfLinkService.externalLinkEnabled = true;
    this.isInitialViewSet = false;
    this.url = "";
    this.baseUrl = "";
    this.documentInfo = null;
    this.metadata = null;
    this._contentDispositionFilename = null;
    this._contentLength = null;
    this._PDFBug?.cleanup();

    await Promise.all(promises);
  },

  /**
   * Opens a new PDF document.
   * @param {Object} args - Accepts any/all of the properties from
   *   {@link DocumentInitParameters}, and also a `originalUrl` string.
   * @returns {Promise} - Promise that is resolved when the document is opened.
   */
  async open(args) {
    if (this.pdfLoadingTask) {
      // We need to destroy already opened document.
      await this.close();
    }
    // Set the necessary global worker parameters, using the available options.
    // IGNORED BECAUSE WE INJECT THE WORKER CODE DIRECTLY IN THE CODE
    const workerParams = AppOptions.getAll(OptionKind.WORKER);
    Object.assign(GlobalWorkerOptions, workerParams);

    // Set the necessary API parameters, using all the available options.
    const apiParams = AppOptions.getAll(OptionKind.API);
    const loadingTask = getDocument({
      ...apiParams,
      ...args,
    });
    this.pdfLoadingTask = loadingTask;

    // Could be used for a loading bar
    // loadingTask.onProgress = ({ loaded, total }) => {
    //   this.progress(loaded / total);
    // };

    return loadingTask.promise.then(
      pdfDocument => {
        this.load(pdfDocument, args.initHashView);
      },
      reason => {
        if (loadingTask !== this.pdfLoadingTask) {
          return undefined; // Ignore errors for previously opened PDF files.
        }

        let key = "pdfjs-loading-error";
        if (reason instanceof InvalidPDFException) {
          key = "pdfjs-invalid-file-error";
        } else if (reason instanceof MissingPDFException) {
          key = "pdfjs-missing-file-error";
        } else if (reason instanceof UnexpectedResponseException) {
          key = "pdfjs-unexpected-response-error";
        }
        return this._documentError(key, { message: reason.message }).then(
          () => {
            throw reason;
          }
        );
      }
    );
  },

  /**
   * Report the error; used for errors affecting loading and/or parsing of
   * the entire PDF document.
   */
  async _documentError(key, moreInfo = null) {
    this._unblockDocumentLoadEvent();

    const message = await this._otherError(
      key || "pdfjs-loading-error",
      moreInfo
    );

    this.eventBus.dispatch("documenterror", {
      source: this,
      message,
      reason: moreInfo?.message ?? null,
    });
  },

  /**
   * Report the error; used for errors affecting e.g. only a single page.
   * @param {string} key - The localization key for the error.
   * @param {Object} [moreInfo] - Further information about the error that is
   *                              more technical. Should have a 'message' and
   *                              optionally a 'stack' property.
   * @returns {string} A (localized) error message that is human readable.
   */
  async _otherError(key, moreInfo = null) {
    const moreInfoText = [`PDF.js v${version || "?"} (build: ${build || "?"})`];
    if (moreInfo) {
      moreInfoText.push(`Message: ${moreInfo.message}`);

      if (moreInfo.stack) {
        moreInfoText.push(`Stack: ${moreInfo.stack}`);
      } else {
        if (moreInfo.filename) {
          moreInfoText.push(`File: ${moreInfo.filename}`);
        }
        if (moreInfo.lineNumber) {
          moreInfoText.push(`Line: ${moreInfo.lineNumber}`);
        }
      }
    }

    console.error(`${key}\n\n${moreInfoText.join("\n")}`);
    return key;
  },

  load(pdfDocument, initHashView) {
    this.pdfDocument = pdfDocument;

    pdfDocument.getDownloadInfo().then(({ length }) => {
      this._contentLength = length; // Ensure that the correct length is used.

      firstPagePromise.then(() => {
        this.eventBus.dispatch("documentloaded", { source: this });
      });
    });

    // Since the `setInitialView` call below depends on this being resolved,
    // fetch it early to avoid delaying initial rendering of the PDF document.
    const pageLayoutPromise = pdfDocument.getPageLayout().catch(() => {
      /* Avoid breaking initial rendering; ignoring errors. */
    });
    const pageModePromise = pdfDocument.getPageMode().catch(() => {
      /* Avoid breaking initial rendering; ignoring errors. */
    });
    const openActionPromise = pdfDocument.getOpenAction().catch(() => {
      /* Avoid breaking initial rendering; ignoring errors. */
    });

    this.pdfLinkService.setDocument(pdfDocument);

    const pdfViewer = this.pdfViewer;
    pdfViewer.setDocument(pdfDocument);
    const { firstPagePromise, onePageRendered, pagesPromise } = pdfViewer;

    firstPagePromise.then(pdfPage => {

      Promise.all([
        animationStarted,
        pageLayoutPromise,
        pageModePromise,
        openActionPromise,
      ])
        .then(async ([timeStamp, pageLayout, pageMode, openAction]) => {
          const initialBookmark = this.initialBookmark;

          // Initialize the default values, from user preferences.
          const hash = initHashView ?? null;

          const rotation = null;
          const scrollMode = AppOptions.get("scrollModeOnLoad");
          let spreadMode = AppOptions.get("spreadModeOnLoad");

          // Always let the user preference/view history take precedence.
          if (
            pageLayout &&
            scrollMode === ScrollMode.UNKNOWN &&
            spreadMode === SpreadMode.UNKNOWN
          ) {
            const modes = apiPageLayoutToViewerModes(pageLayout);
            // TODO: Try to improve page-switching when using the mouse-wheel
            // and/or arrow-keys before allowing the document to control this.
            // scrollMode = modes.scrollMode;
            spreadMode = modes.spreadMode;
          }

          this.setInitialView(hash, {
            rotation,
            scrollMode,
            spreadMode,
          });
          this.eventBus.dispatch("documentinit", { source: this });

          // For documents with different page sizes, once all pages are
          // resolved, ensure that the correct location becomes visible on load.
          // (To reduce the risk, in very large and/or slow loading documents,
          //  that the location changes *after* the user has started interacting
          //  with the viewer, wait for either `pagesPromise` or a timeout.)
          await Promise.race([
            pagesPromise,
            new Promise(resolve => {
              setTimeout(resolve, FORCE_PAGES_LOADED_TIMEOUT);
            }),
          ]);
          if (!initialBookmark && !hash) {
            return;
          }
          if (pdfViewer.hasEqualPageSizes) {
            return;
          }
          this.initialBookmark = initialBookmark;

          // eslint-disable-next-line no-self-assign
          pdfViewer.currentScaleValue = pdfViewer.currentScaleValue;
          // Re-apply the initial document location.
          this.setInitialView(hash);
        })
        .catch(() => {
          // Ensure that the document is always completely initialized,
          // even if there are any errors thrown above.
          this.setInitialView();
        })
        .then(function () {
          // At this point, rendering of the initial page(s) should always have
          // started (and may even have completed).
          // To prevent any future issues, e.g. the document being completely
          // blank on load, always trigger rendering here.
          pdfViewer.update();
        });
    });

    pagesPromise.then(
      () => {
        this._unblockDocumentLoadEvent();
      },
      reason => {
        this._documentError("pdfjs-loading-error", { message: reason.message });
      }
    );

    this._initializeMetadata(pdfDocument);
  },

  /**
   * @private
   */
  async _initializeMetadata(pdfDocument) {
    const { info, metadata, contentDispositionFilename, contentLength } =
      await pdfDocument.getMetadata();

    if (pdfDocument !== this.pdfDocument) {
      return; // The document was closed while the metadata resolved.
    }
    this.documentInfo = info;
    this.metadata = metadata;
    this._contentDispositionFilename ??= contentDispositionFilename;
    this._contentLength ??= contentLength; // See `getDownloadInfo`-call above.

    if (
      info.IsXFAPresent &&
      !info.IsAcroFormPresent &&
      !pdfDocument.isPureXfa
    ) {
      if (pdfDocument.loadingParams.enableXfa) {
        console.warn("Warning: XFA Foreground documents are not supported");
      } else {
        console.warn("Warning: XFA support is not enabled");
      }
    } else if (
      (info.IsAcroFormPresent || info.IsXFAPresent) &&
      !this.pdfViewer.renderForms
    ) {
      console.warn("Warning: Interactive form support is not enabled");
    }

    if (info.IsSignaturesPresent) {
      console.warn("Warning: Digital signatures validation is not supported");
    }

    this.eventBus.dispatch("metadataloaded", { source: this });
  },

  setInitialView(
    storedHash,
    { rotation, sidebarView, scrollMode, spreadMode } = {}
  ) {
    const setRotation = angle => {
      if (isValidRotation(angle)) {
        this.pdfViewer.pagesRotation = angle;
      }
    };
    const setViewerModes = (scroll, spread) => {
      if (isValidScrollMode(scroll)) {
        this.pdfViewer.scrollMode = scroll;
      }
      if (isValidSpreadMode(spread)) {
        this.pdfViewer.spreadMode = spread;
      }
    };
    this.isInitialViewSet = true;

    setViewerModes(scrollMode, spreadMode);

    if (storedHash) {
      setRotation(rotation);
      this.pdfLinkService.setHash(storedHash);
    }

    if (!this.pdfViewer.currentScaleValue) {
      // Scale was not initialized: invalid bookmark or scale was not specified.
      // Setting the default one.
      this.pdfViewer.currentScaleValue = DEFAULT_SCALE_VALUE;
    }
  },

  /**
   * @private
   */
  _cleanup() {
    if (!this.pdfDocument) {
      return; // run cleanup when document is loaded
    }
    this.pdfViewer.cleanup();

    this.pdfDocument.cleanup(
      /* keepLoadedFonts = */ AppOptions.get("fontExtraProperties")
    );
  },

  rotatePages(delta) {
    this.pdfViewer.pagesRotation += delta;
    // Note that the thumbnail viewer is updated, and rendering is triggered,
    // in the 'rotationchanging' event handler.
  },

  bindEvents() {
    if (this._eventBusAbortController) {
      return;
    }
    this._eventBusAbortController = new AbortController();

    const {
      eventBus,
      pdfViewer,
      _eventBusAbortController: { signal },
    } = this;

    eventBus._on("resize", onResize.bind(this), { signal });
    eventBus._on("pagerendered", onPageRendered.bind(this), { signal });
    // eventBus._on("pagechanging", onPageChanging.bind(this), { signal });
    eventBus._on("scalechanging", onScaleChanging.bind(this), { signal });
    eventBus._on("rotationchanging", onRotationChanging.bind(this), { signal });

    eventBus._on(
      "scalechanged",
      evt => (pdfViewer.currentScaleValue = evt.value),
      { signal }
    );
    eventBus._on("switchscrollmode", evt => (pdfViewer.scrollMode = evt.mode), {
      signal,
    });
    eventBus._on("switchspreadmode", evt => (pdfViewer.spreadMode = evt.mode), {
      signal,
    });

    eventBus._on(
      "updatefindmatchescount",
      onUpdateFindMatchesCount.bind(this),
      { signal }
    );
    eventBus._on(
      "updatefindcontrolstate",
      onUpdateFindControlState.bind(this),
      { signal }
    );
  },

  bindWindowEvents() {
    if (this._windowAbortController) {
      return;
    }
    this._windowAbortController = new AbortController();

    const {
      eventBus,
      appConfig: { mainContainer },
      pdfViewer,
      _windowAbortController: { signal },
    } = this;

    function addWindowResolutionChange(evt = null) {
      if (evt) {
        pdfViewer.refresh();
      }
      const mediaQueryList = window.matchMedia(
        `(resolution: ${window.devicePixelRatio || 1}dppx)`
      );
      mediaQueryList.addEventListener("change", addWindowResolutionChange, {
        once: true,
        signal,
      });
    }
    addWindowResolutionChange();

    window.addEventListener("wheel", onWheel.bind(this), {
      passive: false,
      signal,
    });

    window.addEventListener("keydown", onKeyDown.bind(this), { signal });
    window.addEventListener("keyup", onKeyUp.bind(this), { signal });
    window.addEventListener(
      "resize",
      () => eventBus.dispatch("resize", { source: window }),
      { signal }
    );

    window.addEventListener(
      "updatefromsandbox",
      evt => {
        eventBus.dispatch("updatefromsandbox", {
          source: window,
          detail: evt.detail,
        });
      },
      { signal }
    );

    // Using the values lastScrollTop and lastScrollLeft is a workaround to
    // https://bugzilla.mozilla.org/show_bug.cgi?id=1881974.
    // TODO: remove them once the bug is fixed.
    ({ scrollTop: this._lastScrollTop, scrollLeft: this._lastScrollLeft } =
      mainContainer);

    const scrollend = () => {
      ({ scrollTop: this._lastScrollTop, scrollLeft: this._lastScrollLeft } =
        mainContainer);

      this._isScrolling = false;
      mainContainer.addEventListener("scroll", scroll, {
        passive: true,
        signal,
      });
      mainContainer.removeEventListener("scrollend", scrollend);
      mainContainer.removeEventListener("blur", scrollend);
    };
    const scroll = () => {
      if (this._isCtrlKeyDown) {
        return;
      }
      if (
        this._lastScrollTop === mainContainer.scrollTop &&
        this._lastScrollLeft === mainContainer.scrollLeft
      ) {
        return;
      }

      mainContainer.removeEventListener("scroll", scroll, { passive: true });
      this._isScrolling = true;
      mainContainer.addEventListener("scrollend", scrollend, { signal });
      mainContainer.addEventListener("blur", scrollend, { signal });
    };
    mainContainer.addEventListener("scroll", scroll, {
      passive: true,
      signal,
    });
  },

  unbindEvents() {
    this._eventBusAbortController?.abort();
    this._eventBusAbortController = null;
  },

  unbindWindowEvents() {
    this._windowAbortController?.abort();
    this._windowAbortController = null;
  },

  _accumulateTicks(ticks, prop) {
    // If the direction changed, reset the accumulated ticks.
    if ((this[prop] > 0 && ticks < 0) || (this[prop] < 0 && ticks > 0)) {
      this[prop] = 0;
    }
    this[prop] += ticks;
    const wholeTicks = Math.trunc(this[prop]);
    this[prop] -= wholeTicks;
    return wholeTicks;
  },

  _accumulateFactor(previousScale, factor, prop) {
    if (factor === 1) {
      return 1;
    }
    // If the direction changed, reset the accumulated factor.
    if ((this[prop] > 1 && factor < 1) || (this[prop] < 1 && factor > 1)) {
      this[prop] = 1;
    }

    const newFactor =
      Math.floor(previousScale * factor * this[prop] * 100) /
      (100 * previousScale);
    this[prop] = factor / newFactor;

    return newFactor;
  },

  /**
   * Should be called *after* all pages have loaded, or if an error occurred,
   * to unblock the "load" event; see https://bugzilla.mozilla.org/show_bug.cgi?id=1618553
   * @private
   */
  _unblockDocumentLoadEvent() {
    document.blockUnblockOnload?.(false);

    // Ensure that this method is only ever run once.
    this._unblockDocumentLoadEvent = () => {};
  },
};

function onPageRendered({ pageNumber, error }) {
  if (error) {
    this._otherError("pdfjs-rendering-error", error);
  }
}

function onResize() {
  const { pdfDocument, pdfViewer, pdfRenderingQueue } = this;

  if (pdfRenderingQueue.printing && window.matchMedia("print").matches) {
    // Work-around issue 15324 by ignoring "resize" events during printing.
    return;
  }

  if (!pdfDocument) {
    return;
  }
  const currentScaleValue = pdfViewer.currentScaleValue;
  if (
    currentScaleValue === "auto" ||
    currentScaleValue === "page-fit" ||
    currentScaleValue === "page-width"
  ) {
    // Note: the scale is constant for 'page-actual'.
    pdfViewer.currentScaleValue = currentScaleValue;
  }
  pdfViewer.update();
}

function onUpdateFindMatchesCount({ matchesCount }) {
  this.findBar?.updateResultsCount(matchesCount);
}

function onUpdateFindControlState({
  state,
  previous,
  entireWord,
  matchesCount,
  rawQuery,
}) {
  this.findBar?.updateUIState(state, previous, matchesCount);
}

function onScaleChanging(evt) {
  this.pdfViewer.update();
}

function onRotationChanging(evt) {
  // Ensure that the active page doesn't change during rotation.
  this.pdfViewer.currentPageNumber = evt.pageNumber;
}

function onWheel(evt) {
  const {
    pdfViewer,
    supportsMouseWheelZoomCtrlKey,
    supportsMouseWheelZoomMetaKey,
    supportsPinchToZoom,
  } = this;

  if (pdfViewer.isInPresentationMode) {
    return;
  }

  // Pinch-to-zoom on a trackpad maps to a wheel event with ctrlKey set to true
  // https://developer.mozilla.org/en-US/docs/Web/API/WheelEvent#browser_compatibility
  // Hence if ctrlKey is true but ctrl key hasn't been pressed then we can
  // infer that we have a pinch-to-zoom.
  // But the ctrlKey could have been pressed outside of the browser window,
  // hence we try to do some magic to guess if the scaleFactor is likely coming
  // from a pinch-to-zoom or not.

  // It is important that we query deltaMode before delta{X,Y}, so that
  // Firefox doesn't switch to DOM_DELTA_PIXEL mode for compat with other
  // browsers, see https://bugzilla.mozilla.org/show_bug.cgi?id=1392460.
  const deltaMode = evt.deltaMode;

  // The following formula is a bit strange but it comes from:
  // https://searchfox.org/mozilla-central/rev/d62c4c4d5547064487006a1506287da394b64724/widget/InputData.cpp#618-626
  let scaleFactor = Math.exp(-evt.deltaY / 100);

  const isBuiltInMac =
    typeof PDFJSDev !== "undefined" &&
    PDFJSDev.test("MOZCENTRAL") &&
    FeatureTest.platform.isMac;
  const isPinchToZoom =
    evt.ctrlKey &&
    !this._isCtrlKeyDown &&
    deltaMode === WheelEvent.DOM_DELTA_PIXEL &&
    evt.deltaX === 0 &&
    (Math.abs(scaleFactor - 1) < 0.05 || isBuiltInMac) &&
    evt.deltaZ === 0;
  const origin = [evt.clientX, evt.clientY];

  if (
    isPinchToZoom ||
    (evt.ctrlKey && supportsMouseWheelZoomCtrlKey) ||
    (evt.metaKey && supportsMouseWheelZoomMetaKey)
  ) {
    // Only zoom the pages, not the entire viewer.
    evt.preventDefault();
    // NOTE: this check must be placed *after* preventDefault.
    if (
      this._isScrolling ||
      document.visibilityState === "hidden" ||
      this.overlayManager.active
    ) {
      return;
    }

    if (isPinchToZoom && supportsPinchToZoom) {
      scaleFactor = this._accumulateFactor(
        pdfViewer.currentScale,
        scaleFactor,
        "_wheelUnusedFactor"
      );
      this.updateZoom(null, scaleFactor, origin);
    } else {
      const delta = normalizeWheelEventDirection(evt);

      let ticks = 0;
      if (
        deltaMode === WheelEvent.DOM_DELTA_LINE ||
        deltaMode === WheelEvent.DOM_DELTA_PAGE
      ) {
        // For line-based devices, use one tick per event, because different
        // OSs have different defaults for the number lines. But we generally
        // want one "clicky" roll of the wheel (which produces one event) to
        // adjust the zoom by one step.
        //
        // If we're getting fractional lines (I can't think of a scenario
        // this might actually happen), be safe and use the accumulator.
        ticks =
          Math.abs(delta) >= 1
            ? Math.sign(delta)
            : this._accumulateTicks(delta, "_wheelUnusedTicks");
      } else {
        // pixel-based devices
        const PIXELS_PER_LINE_SCALE = 30;
        ticks = this._accumulateTicks(
          delta / PIXELS_PER_LINE_SCALE,
          "_wheelUnusedTicks"
        );
      }

      this.updateZoom(ticks, null, origin);
    }
  }
}

function onKeyUp(evt) {
  // evt.ctrlKey is false hence we use evt.key.
  if (evt.key === "Control") {
    this._isCtrlKeyDown = false;
  }
}

function onKeyDown(evt) {
  this._isCtrlKeyDown = evt.key === "Control";

  if (this.overlayManager.active) {
    return;
  }
  const { eventBus, pdfViewer } = this;
  const isViewerInPresentationMode = pdfViewer.isInPresentationMode;

  let handled = false,
    ensureViewerFocused = false;
  const cmd =
    (evt.ctrlKey ? 1 : 0) |
    (evt.altKey ? 2 : 0) |
    (evt.shiftKey ? 4 : 0) |
    (evt.metaKey ? 8 : 0);

  // First, handle the key bindings that are independent whether an input
  // control is selected or not.
  if (cmd === 1 || cmd === 8 || cmd === 5 || cmd === 12) {
    // either CTRL or META key with optional SHIFT.
    switch (evt.keyCode) {
      case 70: // f
        if (!this.supportsIntegratedFind && !evt.shiftKey) {
          this.findBar?.open();
          handled = true;
        }
        break;
      case 71: // g
        if (!this.supportsIntegratedFind) {
          const { state } = this.findController;
          if (state) {
            const newState = {
              source: window,
              type: "again",
              findPrevious: cmd === 5 || cmd === 12,
            };
            eventBus.dispatch("find", { ...state, ...newState });
          }
          handled = true;
        }
        break;
      case 61: // FF/Mac '='
      case 107: // FF '+' and '='
      case 187: // Chrome '+'
      case 171: // FF with German keyboard
        this.zoomIn();
        handled = true;
        break;
      case 173: // FF/Mac '-'
      case 109: // FF '-'
      case 189: // Chrome '-'
        this.zoomOut();
        handled = true;
        break;
      case 48: // '0'
      case 96: // '0' on Numpad of Swedish keyboard
        if (!isViewerInPresentationMode) {
          // keeping it unhandled (to restore page zoom to 100%)
          setTimeout(() => {
            // ... and resetting the scale after browser adjusts its scale
            this.zoomReset();
          });
          handled = false;
        }
        break;

      case 38: // up arrow
        if (isViewerInPresentationMode || this.page > 1) {
          this.page = 1;
          handled = true;
          ensureViewerFocused = true;
        }
        break;
      case 40: // down arrow
        if (isViewerInPresentationMode || this.page < this.pagesCount) {
          this.page = this.pagesCount;
          handled = true;
          ensureViewerFocused = true;
        }
        break;
    }
  }


  if (handled) {
    if (ensureViewerFocused && !isViewerInPresentationMode) {
      pdfViewer.focus();
    }
    evt.preventDefault();
    return;
  }

  // Some shortcuts should not get handled if a control/input element
  // is selected.
  const curElement = getActiveOrFocusedElement();
  const curElementTagName = curElement?.tagName.toUpperCase();
  if (
    curElementTagName === "INPUT" ||
    curElementTagName === "TEXTAREA" ||
    curElementTagName === "SELECT" ||
    (curElementTagName === "BUTTON" &&
      (evt.keyCode === /* Enter = */ 13 || evt.keyCode === /* Space = */ 32)) ||
    curElement?.isContentEditable
  ) {
    // Make sure that the secondary toolbar is closed when Escape is pressed.
    if (evt.keyCode !== /* Esc = */ 27) {
      return;
    }
  }

  // No control key pressed at all.
  if (cmd === 0) {
    let turnPage = 0,
      turnOnlyIfPageFit = false;
    switch (evt.keyCode) {
      case 38: // up arrow
        if (this.supportsCaretBrowsingMode) {
          this.moveCaret(/* isUp = */ true, /* select = */ false);
          handled = true;
          break;
        }
      /* falls through */
      case 33: // pg up
        // vertical scrolling using arrow/pg keys
        if (pdfViewer.isVerticalScrollbarEnabled) {
          turnOnlyIfPageFit = true;
        }
        turnPage = -1;
        break;
      case 8: // backspace
        if (!isViewerInPresentationMode) {
          turnOnlyIfPageFit = true;
        }
        turnPage = -1;
        break;
      case 37: // left arrow
        if (this.supportsCaretBrowsingMode) {
          return;
        }
        // horizontal scrolling using arrow keys
        if (pdfViewer.isHorizontalScrollbarEnabled) {
          turnOnlyIfPageFit = true;
        }
      /* falls through */
      case 75: // 'k'
      case 80: // 'p'
        turnPage = -1;
        break;
      case 27: // esc key
        if (!this.supportsIntegratedFind && this.findBar?.opened) {
          this.findBar.close();
          handled = true;
        }
        break;
      case 40: // down arrow
        if (this.supportsCaretBrowsingMode) {
          this.moveCaret(/* isUp = */ false, /* select = */ false);
          handled = true;
          break;
        }
      /* falls through */
      case 34: // pg down
        // vertical scrolling using arrow/pg keys
        if (pdfViewer.isVerticalScrollbarEnabled) {
          turnOnlyIfPageFit = true;
        }
        turnPage = 1;
        break;
      case 13: // enter key
      case 32: // spacebar
        if (!isViewerInPresentationMode) {
          turnOnlyIfPageFit = true;
        }
        turnPage = 1;
        break;
      case 39: // right arrow
        if (this.supportsCaretBrowsingMode) {
          return;
        }
        // horizontal scrolling using arrow keys
        if (pdfViewer.isHorizontalScrollbarEnabled) {
          turnOnlyIfPageFit = true;
        }
      /* falls through */
      case 74: // 'j'
      case 78: // 'n'
        turnPage = 1;
        break;

      case 36: // home
        if (isViewerInPresentationMode || this.page > 1) {
          this.page = 1;
          handled = true;
          ensureViewerFocused = true;
        }
        break;
      case 35: // end
        if (isViewerInPresentationMode || this.page < this.pagesCount) {
          this.page = this.pagesCount;
          handled = true;
          ensureViewerFocused = true;
        }
        break;

      case 82: // 'r'
        this.rotatePages(90);
        break;
    }

    if (
      turnPage !== 0 &&
      (!turnOnlyIfPageFit || pdfViewer.currentScaleValue === "page-fit")
    ) {
      if (turnPage > 0) {
        pdfViewer.nextPage();
      } else {
        pdfViewer.previousPage();
      }
      handled = true;
    }
  }

  // shift-key
  if (cmd === 4) {
    switch (evt.keyCode) {
      case 13: // enter key
      case 32: // spacebar
        if (
          !isViewerInPresentationMode &&
          pdfViewer.currentScaleValue !== "page-fit"
        ) {
          break;
        }
        pdfViewer.previousPage();

        handled = true;
        break;

      case 38: // up arrow
        this.moveCaret(/* isUp = */ true, /* select = */ true);
        handled = true;
        break;
      case 40: // down arrow
        this.moveCaret(/* isUp = */ false, /* select = */ true);
        handled = true;
        break;
      case 82: // 'r'
        this.rotatePages(-90);
        break;
    }
  }

  if (!handled && !isViewerInPresentationMode) {
    // 33=Page Up  34=Page Down  35=End    36=Home
    // 37=Left     38=Up         39=Right  40=Down
    // 32=Spacebar
    if (
      (evt.keyCode >= 33 && evt.keyCode <= 40) ||
      (evt.keyCode === 32 && curElementTagName !== "BUTTON")
    ) {
      ensureViewerFocused = true;
    }
  }

  if (ensureViewerFocused && !pdfViewer.containsElement(curElement)) {
    // The page container is not focused, but a page navigation key has been
    // pressed. Change the focus to the viewer container to make sure that
    // navigation by keyboard works as expected.
    pdfViewer.focus();
  }

  if (handled) {
    evt.preventDefault();
  }
}

export { PDFViewerApplication };
