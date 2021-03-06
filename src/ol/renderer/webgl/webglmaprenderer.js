// FIXME check against gl.getParameter(webgl.MAX_TEXTURE_SIZE)

goog.provide('ol.renderer.webgl.Map');

goog.require('goog.array');
goog.require('goog.debug.Logger');
goog.require('goog.dom');
goog.require('goog.dom.TagName');
goog.require('goog.events');
goog.require('goog.events.Event');
goog.require('goog.style');
goog.require('goog.webgl');
goog.require('ol');
goog.require('ol.FrameState');
goog.require('ol.Size');
goog.require('ol.Tile');
goog.require('ol.layer.ImageLayer');
goog.require('ol.layer.TileLayer');
goog.require('ol.renderer.Map');
goog.require('ol.renderer.webgl.ImageLayer');
goog.require('ol.renderer.webgl.TileLayer');
goog.require('ol.renderer.webgl.map.shader');
goog.require('ol.structs.Buffer');
goog.require('ol.structs.IntegerSet');
goog.require('ol.structs.LRUCache');
goog.require('ol.webgl');
goog.require('ol.webgl.WebGLContextEventType');
goog.require('ol.webgl.shader');


/**
 * @define {number} Texture cache high water mark.
 */
ol.WEBGL_TEXTURE_CACHE_HIGH_WATER_MARK = 1024;


/**
 * @typedef {{buf: ol.structs.Buffer,
 *            buffer: WebGLBuffer,
 *            dirtySet: ol.structs.IntegerSet}}
 */
ol.renderer.webgl.BufferCacheEntry;


/**
 * @typedef {{magFilter: number, minFilter: number, texture: WebGLTexture}}
 */
ol.renderer.webgl.TextureCacheEntry;



/**
 * @constructor
 * @extends {ol.renderer.Map}
 * @param {Element} container Container.
 * @param {ol.Map} map Map.
 */
ol.renderer.webgl.Map = function(container, map) {

  goog.base(this, container, map);

  if (goog.DEBUG) {
    /**
     * @inheritDoc
     */
    this.logger = goog.debug.Logger.getLogger(
        'ol.renderer.webgl.maprenderer.' + goog.getUid(this));
  }

  /**
   * @private
   * @type {Element}
   */
  this.canvas_ = goog.dom.createElement(goog.dom.TagName.CANVAS);
  this.canvas_.height = container.clientHeight;
  this.canvas_.width = container.clientWidth;
  this.canvas_.className = ol.CSS_CLASS_UNSELECTABLE;
  goog.dom.insertChildAt(container, this.canvas_, 0);

  /**
   * @private
   * @type {boolean}
   */
  this.renderedVisible_ = true;

  /**
   * @private
   * @type {ol.Size}
   */
  this.canvasSize_ = new ol.Size(container.clientHeight, container.clientWidth);

  /**
   * @private
   * @type {WebGLRenderingContext}
   */
  this.gl_ = ol.webgl.getContext(this.canvas_, {
    alpha: false,
    antialias: true,
    depth: false,
    preserveDrawingBuffer: false,
    stencil: false
  });
  goog.asserts.assert(!goog.isNull(this.gl_));

  goog.events.listen(this.canvas_, ol.webgl.WebGLContextEventType.LOST,
      this.handleWebGLContextLost, false, this);
  goog.events.listen(this.canvas_, ol.webgl.WebGLContextEventType.RESTORED,
      this.handleWebGLContextRestored, false, this);

  /**
   * @private
   * @type {{a_position: number,
   *         a_texCoord: number,
   *         u_colorMatrix: WebGLUniformLocation,
   *         u_opacity: WebGLUniformLocation,
   *         u_texture: WebGLUniformLocation,
   *         u_texCoordMatrix: WebGLUniformLocation,
   *         u_projectionMatrix: WebGLUniformLocation}|null}
   */
  this.locations_ = null;

  /**
   * @private
   * @type {ol.structs.Buffer}
   */
  this.arrayBuffer_ = new ol.structs.Buffer([
    -1, -1, 0, 0,
    1, -1, 1, 0,
    -1, 1, 0, 1,
    1, 1, 1, 1
  ]);

  /**
   * @private
   * @type {Object.<number, ol.renderer.webgl.BufferCacheEntry>}
   */
  this.bufferCache_ = {};

  /**
   * @private
   * @type {Object.<number, WebGLShader>}
   */
  this.shaderCache_ = {};

  /**
   * @private
   * @type {Object.<string, WebGLProgram>}
   */
  this.programCache_ = {};

  /**
   * @private
   * @type {ol.structs.LRUCache}
   */
  this.textureCache_ = new ol.structs.LRUCache();

  /**
   * @private
   * @type {number}
   */
  this.textureCacheFrameMarkerCount_ = 0;

  /**
   * @private
   * @type {ol.webgl.shader.Fragment}
   */
  this.fragmentShader_ = ol.renderer.webgl.map.shader.Fragment.getInstance();

  /**
   * @private
   * @type {ol.webgl.shader.Vertex}
   */
  this.vertexShader_ = ol.renderer.webgl.map.shader.Vertex.getInstance();

  this.initializeGL_();

};
goog.inherits(ol.renderer.webgl.Map, ol.renderer.Map);


/**
 * @param {number} target Target.
 * @param {ol.structs.Buffer} buf Buffer.
 */
ol.renderer.webgl.Map.prototype.bindBuffer = function(target, buf) {
  var gl = this.getGL();
  var arr = buf.getArray();
  var bufferKey = goog.getUid(buf);
  if (bufferKey in this.bufferCache_) {
    var bufferCacheEntry = this.bufferCache_[bufferKey];
    gl.bindBuffer(target, bufferCacheEntry.buffer);
    bufferCacheEntry.dirtySet.forEachRange(function(start, stop) {
      // FIXME check if slice is really efficient here
      var slice = arr.slice(start, stop);
      gl.bufferSubData(
          target,
          start,
          target == goog.webgl.ARRAY_BUFFER ?
          new Float32Array(slice) :
          new Uint16Array(slice));
    });
    bufferCacheEntry.dirtySet.clear();
  } else {
    var buffer = gl.createBuffer();
    gl.bindBuffer(target, buffer);
    gl.bufferData(
        target,
        target == goog.webgl.ARRAY_BUFFER ?
        new Float32Array(arr) : new Uint16Array(arr),
        buf.getUsage());
    var dirtySet = new ol.structs.IntegerSet();
    buf.addDirtySet(dirtySet);
    this.bufferCache_[bufferKey] = {
      buf: buf,
      buffer: buffer,
      dirtySet: dirtySet
    };
  }
};


/**
 * @param {ol.Tile} tile Tile.
 * @param {number} magFilter Mag filter.
 * @param {number} minFilter Min filter.
 */
ol.renderer.webgl.Map.prototype.bindTileTexture =
    function(tile, magFilter, minFilter) {
  var gl = this.getGL();
  var tileKey = tile.getKey();
  if (this.textureCache_.containsKey(tileKey)) {
    var textureCacheEntry = this.textureCache_.get(tileKey);
    gl.bindTexture(goog.webgl.TEXTURE_2D, textureCacheEntry.texture);
    if (textureCacheEntry.magFilter != magFilter) {
      gl.texParameteri(
          goog.webgl.TEXTURE_2D, goog.webgl.TEXTURE_MAG_FILTER, magFilter);
      textureCacheEntry.magFilter = magFilter;
    }
    if (textureCacheEntry.minFilter != minFilter) {
      gl.texParameteri(
          goog.webgl.TEXTURE_2D, goog.webgl.TEXTURE_MAG_FILTER, minFilter);
      textureCacheEntry.minFilter = minFilter;
    }
  } else {
    var texture = gl.createTexture();
    gl.bindTexture(goog.webgl.TEXTURE_2D, texture);
    gl.texImage2D(goog.webgl.TEXTURE_2D, 0, goog.webgl.RGBA, goog.webgl.RGBA,
        goog.webgl.UNSIGNED_BYTE, tile.getImage());
    gl.texParameteri(
        goog.webgl.TEXTURE_2D, goog.webgl.TEXTURE_MAG_FILTER, magFilter);
    gl.texParameteri(
        goog.webgl.TEXTURE_2D, goog.webgl.TEXTURE_MIN_FILTER, minFilter);
    gl.texParameteri(goog.webgl.TEXTURE_2D, goog.webgl.TEXTURE_WRAP_S,
        goog.webgl.CLAMP_TO_EDGE);
    gl.texParameteri(goog.webgl.TEXTURE_2D, goog.webgl.TEXTURE_WRAP_T,
        goog.webgl.CLAMP_TO_EDGE);
    this.textureCache_.set(tileKey, {
      texture: texture,
      magFilter: magFilter,
      minFilter: minFilter
    });
  }
};


/**
 * @inheritDoc
 */
ol.renderer.webgl.Map.prototype.createLayerRenderer = function(layer) {
  var layerRenderer = null;
  if (layer instanceof ol.layer.TileLayer) {
    layerRenderer = new ol.renderer.webgl.TileLayer(this, layer);
  } else if (layer instanceof ol.layer.ImageLayer) {
    layerRenderer = new ol.renderer.webgl.ImageLayer(this, layer);
  } else {
    goog.asserts.assert(false);
  }
  return layerRenderer;
};


/**
 * @param {ol.structs.Buffer} buf Buffer.
 */
ol.renderer.webgl.Map.prototype.deleteBuffer = function(buf) {
  var gl = this.getGL();
  var arr = buf.getArray();
  var bufferKey = goog.getUid(buf);
  goog.asserts.assert(bufferKey in this.bufferCache_);
  var bufferCacheEntry = this.bufferCache_[bufferKey];
  bufferCacheEntry.buf.removeDirtySet(bufferCacheEntry.dirtySet);
  if (!gl.isContextLost()) {
    gl.deleteBuffer(bufferCacheEntry.buffer);
  }
  delete this.bufferCache_[bufferKey];
};


/**
 * @inheritDoc
 */
ol.renderer.webgl.Map.prototype.disposeInternal = function() {
  var gl = this.getGL();
  goog.object.forEach(this.bufferCache_, function(bufferCacheEntry) {
    bufferCacheEntry.buf.removeDirtySet(bufferCacheEntry.dirtySet);
  });
  if (!gl.isContextLost()) {
    goog.object.forEach(this.bufferCache_, function(bufferCacheEntry) {
      gl.deleteBuffer(bufferCacheEntry.buffer);
    });
    goog.object.forEach(this.programCache_, function(program) {
      gl.deleteProgram(program);
    });
    goog.object.forEach(this.shaderCache_, function(shader) {
      gl.deleteShader(shader);
    });
    this.textureCache_.forEach(function(textureCacheEntry) {
      if (!goog.isNull(textureCacheEntry)) {
        gl.deleteTexture(textureCacheEntry.texture);
      }
    });
  }
  goog.base(this, 'disposeInternal');
};


/**
 * @param {ol.Map} map Map.
 * @param {ol.FrameState} frameState Frame state.
 * @private
 */
ol.renderer.webgl.Map.prototype.expireCache_ = function(map, frameState) {
  var gl = this.getGL();
  var key, textureCacheEntry;
  while (this.textureCache_.getCount() - this.textureCacheFrameMarkerCount_ >
      ol.WEBGL_TEXTURE_CACHE_HIGH_WATER_MARK) {
    textureCacheEntry = /** @type {?ol.renderer.webgl.TextureCacheEntry} */
        (this.textureCache_.peekLast());
    if (goog.isNull(textureCacheEntry)) {
      if (+this.textureCache_.peekLastKey() == frameState.time) {
        break;
      } else {
        --this.textureCacheFrameMarkerCount_;
      }
    } else {
      gl.deleteTexture(textureCacheEntry.texture);
    }
    this.textureCache_.pop();
  }
};


/**
 * @inheritDoc
 */
ol.renderer.webgl.Map.prototype.getCanvas = function() {
  return this.canvas_;
};


/**
 * @return {WebGLRenderingContext} GL.
 */
ol.renderer.webgl.Map.prototype.getGL = function() {
  return this.gl_;
};


/**
 * @param {ol.webgl.shader.Fragment} fragmentShaderObject Fragment shader.
 * @param {ol.webgl.shader.Vertex} vertexShaderObject Vertex shader.
 * @return {WebGLProgram} Program.
 */
ol.renderer.webgl.Map.prototype.getProgram = function(
    fragmentShaderObject, vertexShaderObject) {
  var programKey =
      goog.getUid(fragmentShaderObject) + '/' + goog.getUid(vertexShaderObject);
  if (programKey in this.programCache_) {
    return this.programCache_[programKey];
  } else {
    var gl = this.getGL();
    var program = gl.createProgram();
    gl.attachShader(program, this.getShader(fragmentShaderObject));
    gl.attachShader(program, this.getShader(vertexShaderObject));
    gl.linkProgram(program);
    if (goog.DEBUG) {
      if (!gl.getProgramParameter(program, goog.webgl.LINK_STATUS) &&
          !gl.isContextLost()) {
        this.logger.severe(gl.getProgramInfoLog(program));
        goog.asserts.assert(
            gl.getProgramParameter(program, goog.webgl.LINK_STATUS));
      }
    }
    this.programCache_[programKey] = program;
    return program;
  }
};


/**
 * @param {ol.webgl.Shader} shaderObject Shader object.
 * @return {WebGLShader} Shader.
 */
ol.renderer.webgl.Map.prototype.getShader = function(shaderObject) {
  var shaderKey = goog.getUid(shaderObject);
  if (shaderKey in this.shaderCache_) {
    return this.shaderCache_[shaderKey];
  } else {
    var gl = this.getGL();
    var shader = gl.createShader(shaderObject.getType());
    gl.shaderSource(shader, shaderObject.getSource());
    gl.compileShader(shader);
    if (goog.DEBUG) {
      if (!gl.getShaderParameter(shader, goog.webgl.COMPILE_STATUS) &&
          !gl.isContextLost()) {
        this.logger.severe(gl.getShaderInfoLog(shader));
        goog.asserts.assert(
            gl.getShaderParameter(shader, goog.webgl.COMPILE_STATUS));
      }
    }
    this.shaderCache_[shaderKey] = shader;
    return shader;
  }
};


/**
 * @param {goog.events.Event} event Event.
 * @protected
 */
ol.renderer.webgl.Map.prototype.handleWebGLContextLost = function(event) {
  if (goog.DEBUG) {
    this.logger.info('WebGLContextLost');
  }
  event.preventDefault();
  this.locations_ = null;
  this.bufferCache_ = {};
  this.shaderCache_ = {};
  this.programCache_ = {};
  this.textureCache_.clear();
  this.textureCacheFrameMarkerCount_ = 0;
  goog.object.forEach(this.layerRenderers, function(layerRenderer) {
    layerRenderer.handleWebGLContextLost();
  });
};


/**
 * @protected
 */
ol.renderer.webgl.Map.prototype.handleWebGLContextRestored = function() {
  if (goog.DEBUG) {
    this.logger.info('WebGLContextRestored');
  }
  this.initializeGL_();
  this.getMap().render();
};


/**
 * @private
 */
ol.renderer.webgl.Map.prototype.initializeGL_ = function() {
  var gl = this.gl_;
  gl.activeTexture(goog.webgl.TEXTURE0);
  gl.blendFunc(goog.webgl.SRC_ALPHA, goog.webgl.ONE_MINUS_SRC_ALPHA);
  gl.disable(goog.webgl.CULL_FACE);
  gl.disable(goog.webgl.DEPTH_TEST);
  gl.disable(goog.webgl.SCISSOR_TEST);
};


/**
 * @param {ol.Tile} tile Tile.
 * @return {boolean} Is tile texture loaded.
 */
ol.renderer.webgl.Map.prototype.isTileTextureLoaded = function(tile) {
  return this.textureCache_.containsKey(tile.getKey());
};


/**
 * @inheritDoc
 */
ol.renderer.webgl.Map.prototype.renderFrame = function(frameState) {

  var gl = this.getGL();

  if (goog.isNull(frameState)) {
    if (this.renderedVisible_) {
      goog.style.showElement(this.canvas_, false);
      this.renderedVisible_ = false;
    }
    return false;
  }

  this.textureCache_.set(frameState.time.toString(), null);
  ++this.textureCacheFrameMarkerCount_;

  goog.array.forEach(frameState.layersArray, function(layer) {
    var layerState = frameState.layerStates[goog.getUid(layer)];
    if (!layerState.visible || !layerState.ready) {
      return;
    }
    var layerRenderer = this.getLayerRenderer(layer);
    layerRenderer.renderFrame(frameState, layerState);
  }, this);

  var size = frameState.size;
  if (!this.canvasSize_.equals(size)) {
    this.canvas_.width = size.width;
    this.canvas_.height = size.height;
    this.canvasSize_ = size;
  }

  gl.bindFramebuffer(goog.webgl.FRAMEBUFFER, null);

  var clearColor = frameState.backgroundColor;
  gl.clearColor(clearColor.r / 255, clearColor.g / 255,
      clearColor.b / 255, clearColor.a);
  gl.clear(goog.webgl.COLOR_BUFFER_BIT);
  gl.enable(goog.webgl.BLEND);
  gl.viewport(0, 0, size.width, size.height);

  var program = this.getProgram(this.fragmentShader_, this.vertexShader_);
  gl.useProgram(program);
  if (goog.isNull(this.locations_)) {
    this.locations_ = {
      a_position: gl.getAttribLocation(
          program, ol.renderer.webgl.map.shader.attribute.a_position),
      a_texCoord: gl.getAttribLocation(
          program, ol.renderer.webgl.map.shader.attribute.a_texCoord),
      u_colorMatrix: gl.getUniformLocation(
          program, ol.renderer.webgl.map.shader.uniform.u_colorMatrix),
      u_texCoordMatrix: gl.getUniformLocation(
          program, ol.renderer.webgl.map.shader.uniform.u_texCoordMatrix),
      u_projectionMatrix: gl.getUniformLocation(
          program, ol.renderer.webgl.map.shader.uniform.u_projectionMatrix),
      u_opacity: gl.getUniformLocation(
          program, ol.renderer.webgl.map.shader.uniform.u_opacity),
      u_texture: gl.getUniformLocation(
          program, ol.renderer.webgl.map.shader.uniform.u_texture)
    };
  }

  this.bindBuffer(goog.webgl.ARRAY_BUFFER, this.arrayBuffer_);

  gl.enableVertexAttribArray(this.locations_.a_position);
  gl.vertexAttribPointer(
      this.locations_.a_position, 2, goog.webgl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(this.locations_.a_texCoord);
  gl.vertexAttribPointer(
      this.locations_.a_texCoord, 2, goog.webgl.FLOAT, false, 16, 8);
  gl.uniform1i(this.locations_.u_texture, 0);

  goog.array.forEach(frameState.layersArray, function(layer) {
    var layerState = frameState.layerStates[goog.getUid(layer)];
    if (!layerState.visible || !layerState.ready) {
      return;
    }
    var layerRenderer = this.getLayerRenderer(layer);
    gl.uniformMatrix4fv(
        this.locations_.u_texCoordMatrix, false,
        layerRenderer.getTexCoordMatrix());
    gl.uniformMatrix4fv(
        this.locations_.u_projectionMatrix, false,
        layerRenderer.getProjectionMatrix());
    gl.uniformMatrix4fv(
        this.locations_.u_colorMatrix, false, layerRenderer.getColorMatrix());
    gl.uniform1f(this.locations_.u_opacity, layer.getOpacity());
    gl.bindTexture(goog.webgl.TEXTURE_2D, layerRenderer.getTexture());
    gl.drawArrays(goog.webgl.TRIANGLE_STRIP, 0, 4);
  }, this);

  if (!this.renderedVisible_) {
    goog.style.showElement(this.canvas_, true);
    this.renderedVisible_ = true;
  }

  this.calculateMatrices2D(frameState);

  if (this.textureCache_.getCount() - this.textureCacheFrameMarkerCount_ >
      ol.WEBGL_TEXTURE_CACHE_HIGH_WATER_MARK) {
    frameState.postRenderFunctions.push(goog.bind(this.expireCache_, this));
  }

};
